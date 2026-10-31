# 网络与传输

```
                 ┌──────── 出站 WS（wss://，单连接多路复用）────────┐
Bot 主机 ────────┤ getMe / sendMessage / getUpdates …               ├──► 中继 ──► api.telegram.org
   │             └────────────────────────────────────────────────────┘
   ├─(可选) HTTP/SOCKS5 代理 ──► api.telegram.org
   ├─(可选) 长轮询 getUpdates（Telegram 侧不需要公网入口）
   └─ Logto webhook 仍需要入站 HTTPS（与 Telegram 链路无关）
```

## 1. 代理

| 协议 | 实现 |
|---|---|
| `http://` / `https://` | undici `ProxyAgent`（支持 `user:pass@` Basic 认证） |
| `socks5://` | 自实现 SOCKS5 CONNECT；**本地解析**域名后发 IP |
| `socks5h://` | 同上，但把域名交给代理解析 |

```bash
TELEGRAM_PROXY_URL=socks5h://user:pass@127.0.0.1:1080 pnpm dev
LOGTO_PROXY_URL=http://127.0.0.1:7890 pnpm dev
```

优先级：`TELEGRAM_WS_RELAY` > `TELEGRAM_PROXY_URL` > `HTTPS_PROXY`/`ALL_PROXY`（`PROXY_USE_ENV_FALLBACK=true` 时）> 直连。`PROXY_NO_PROXY` / `NO_PROXY` 支持 `localhost`、`.example.com`、`*`。

> 已知坑（已修）：undici 的自定义 `connect` 会收到 `port: ""`、`servername: null`。代码里用 `resolveDestinationPort(port, protocol)` 补 443/80，否则 SOCKS 会连到 0 端口、TLS 直接被 RST。

## 2. 收消息方式

| `TELEGRAM_MODE` | 行为 | 适用 |
|---|---|---|
| `webhook`（默认） | 注册 `POST /tg/webhook`，需公网 HTTPS | 有域名/反代 |
| `polling` | 启动时 `deleteWebhook` 并 `getUpdates` 长轮询；**不注册** `/tg/webhook` | 只有出站能力 |

polling 与 webhook 不能同时使用（Telegram 会 409）；`doctor` 会同时打印 `transport` 与 webhook 状态。

## 3. 出站 WS 中继

一条 `wss://` 承载所有 Bot API 调用，适合"只能出站"或被中间设备拦截的机房。

### 部署

```bash
# 中继主机（能直连 Telegram；RELAY_PROXY 可选，让它自己再走代理）
RELAY_PORT=8081 RELAY_TOKEN=<shared> pnpm ws-relay

# Caddy（自动 TLS，得到 wss://relay.example.com）
relay.example.com {
    reverse_proxy 127.0.0.1:8081
}

# Bot 侧
TELEGRAM_WS_RELAY=wss://relay.example.com
TELEGRAM_WS_RELAY_TOKEN=<shared>
```

也可以用 compose 的 profile：

```bash
docker compose --profile relay up -d relay
```

中继环境变量：`RELAY_PORT`(8081) `RELAY_HOST`(0.0.0.0) `RELAY_TOKEN`(必填) `RELAY_UPSTREAM`(https://api.telegram.org) `RELAY_PROXY`。

### 协议（JSON 文本帧，body 用 base64）

```jsonc
// client → relay
{ "t":"req", "id":"7f3a", "method":"POST", "path":"/bot<token>/sendMessage",
  "headers":{"content-type":"application/json"}, "body":"<base64>", "timeoutMs":34000 }

// relay → client
{ "t":"res", "id":"7f3a", "status":200,
  "headers":{"content-type":"application/json"}, "body":"<base64>" }
{ "t":"err", "id":"7f3a", "message":"upstream timeout" }

// 心跳
{ "t":"ping" } / { "t":"pong" }
```

* 客户端：多路复用（`id → resolver`），30s 心跳，断线指数退避（0.5s→30s，带抖动），连接断开时未完成请求**拒绝而不重发**（`sendMessage` 不幂等，交由 outbox 重试）。
* `getUpdates` 单独放宽超时（`pollTimeout + 15s`）。
* 服务端：只接受 `^/bot<token>/<method>` 路径转发到**固定上游**；共享 token（`?token=` 或 `Authorization: Bearer`，常数时间比较）；单帧 ≤8 MiB、并发 ≤32、每请求 `AbortSignal.timeout`。
* 中继重启后客户端自动重连（已用集成测试覆盖）。

## 4. `/ws` 本地控制通道

```bash
WS_ENABLED=true WS_TOKEN=<random> pnpm dev   # 然后连 wss://bot.example.com/ws?token=…
```

### 帧

```jsonc
// 服务端 → 客户端（连接建立即发）
{ "t":"hello", "topics":["outbox"], "recent":[{ "name":"logto_event","at":1793…,"data":{…} }] }
{ "t":"event", "name":"outbox",  "at":1793…, "data":{ "status":"sent","chatId":123 } }
{ "t":"event", "name":"binding", "at":1793…, "data":{ "tgUserId":…,"logtoUserId":"…","created":true } }
{ "t":"event", "name":"role_sync","at":1793…, "data":{ "chatId":…,"added":["role_x"],"removed":[] } }
{ "t":"event", "name":"error",   "at":1793…, "data":{…} }

// 客户端 → 服务端
{ "t":"cmd", "id":"1", "name":"stats" }
{ "t":"cmd", "id":"2", "name":"recent_events", "args":{ "limit":5 } }
{ "t":"cmd", "id":"3", "name":"send_test", "args":{ "chatId":1558159309, "text":"hi" } }
{ "t":"cmd", "id":"4", "name":"reload" }

// 结果
{ "t":"result", "id":"3", "ok":true, "data":{ "queued":true, "chatId":1558159309 } }
{ "t":"result", "id":"4", "ok":false, "error":"unknown command: …" }
```

* 断开/鉴权失败：`HTTP 401`（升级阶段），错误 token 不会进入 WS。
* `topics` 支持 `logto_event,outbox,binding,role_sync,error`；不传则全订阅。
* 环形缓冲保留最近 100 条，`hello.recent` 默认给 20 条，便于面板冷启动。
* `send_test` 走 outbox（同样受限速与重试约束）。

最小客户端：

```js
const ws = new WebSocket('ws://127.0.0.1:8080/ws?token=testtoken&topics=outbox');
ws.onopen = () => ws.send(JSON.stringify({ t: 'cmd', id: '1', name: 'stats' }));
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

## 5. 排错

| 现象 | 定位 |
|---|---|
| `telegram bot: Network request for 'getMe' failed!` | `doctor` 的 `transport` 行；分别试 `TELEGRAM_PROXY_URL=socks5h://…` 与直连 |
| 代理可 curl 但 bot 不通 | 是否 `NODE_USE_ENV_PROXY` 只对全局 fetch 生效？本项目统一走 undici + dispatcher，环境代理由 `PROXY_USE_ENV_FALLBACK` 显式读取 |
| `409 Conflict: terminated by other getUpdates` | 同时开了 webhook 与 polling；跑 `pnpm tg:webhook --delete` 或切回单一模式 |
| WS 中继 `ws relay not connected` | 中继未启动/端口不通/token 不一致；看中继日志与 `doctor` |
| `/ws` 404 | 该进程未开 `WS_ENABLED`，或运行的是没有 `/ws` 的旧构建 |
| `/ws` 401 | `WS_TOKEN` 不匹配（query 与 header 都支持） |
| 大量 `400 can't parse entities` | 动态内容未转义；`replyMarkdown` 已自动降级纯文本，仍应修模板 |
