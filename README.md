# logto-bot

Telegram 与 **Logto**（自建租户 `https://auth.haori.ink`）之间的桥：

* **Logto webhook → Telegram 私聊通知**（登录 / 注册 / 改密 / 资料变更 / 封禁 / 锁定 / 组织变更）
* **自动绑定**：用户用 Telegram 登录一次 Logto，webhook 里读 `identities.<target>.details.rawData.id` 即完成绑定，不需要先 `/start`
* **一次性登录链接**：`/login` 直接返回 Logto `/oidc/auth?...&one_time_token=…`，落地在 Account Center，单次有效
* **注册 Magic Link**：`/signup` 用 Logto OTT `interactionEvent=Register`（可选 `jitOrganizationIds`）生成邀请链接
* **群身份 → Logto 角色**：`/map` `/group` `/sync` 或 `pnpm cli` 配置，`chat_member` 增量同步
* **运维表面**：`/admin` 面板、`/user` `/grant` `/revoke` `/events` `/outbox` `/export` `/broadcast` `/reload`，以及功能对齐的 CLI

对外只有两个 HTTP 入口（+ 可选探活/控制通道）：

```
POST /tg/webhook     Telegram（X-Telegram-Bot-Api-Secret-Token）
POST /hooks/logto    Logto（logto-signature-sha-256 = hex(HMAC-SHA256(key, raw body))）
GET  /healthz        探活
GET  /ws             （可选）本地 WebSocket 控制通道
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/logto-setup.md](docs/logto-setup.md) | Logto 侧：OIDC 连接器配置、M2M 应用、登录落地应用、Webhook、OTT 语义 |
| [docs/configuration.md](docs/configuration.md) | 全部环境变量、默认值、优先级 |
| [docs/commands.md](docs/commands.md) | Bot 指令、权限矩阵、角色映射语义 |
| [docs/cli.md](docs/cli.md) | `pnpm cli` 全部命令与示例 |
| [docs/network.md](docs/network.md) | 代理（http/https/socks5）、polling、WS 中继协议、`/ws` 控制通道 |
| [docs/deployment.md](docs/deployment.md) | Docker/Caddy、systemd、备份、升级、拓扑 |
| [docs/operations.md](docs/operations.md) | 首次接入清单、切换传输、密钥轮换、故障排查表 |
| [docs/architecture.md](docs/architecture.md) | 模块地图、数据流、数据表、事件总线、安全模型 |
| [docs/development.md](docs/development.md) | 代码不变量、如何加命令/事件/CLI、测试布局、踩过的坑 |
| [docs/verification.md](docs/verification.md) | 实测记录（probe / smoke / CLI / 网络层）、已知边界 |

## 快速开始

```bash
cp .env.example .env && chmod 600 .env    # 填 LOGTO_* / TELEGRAM_*
pnpm install
pnpm probe          # 自检：M2M / identities / OTT / roles
pnpm dev            # 本地起服务（默认 127.0.0.1:8080，由反代转发）
```

首次接入 Logto 需要的资源（只增不改，幂等）：

```bash
pnpm logto:setup                                  # M2M 应用 + 登录落地应用
BOT_PUBLIC_URL=https://bot.example.com pnpm logto:setup   # 再跑一次建 webhook，打印签名密钥
pnpm tg:webhook                                   # 注册 Telegram webhook（含 chat_member）
```

没有公网入口也能收消息（Telegram 侧）：

```bash
TELEGRAM_MODE=polling pnpm dev                    # 或
TELEGRAM_WS_RELAY=wss://relay.example.com pnpm dev
```

## 技术栈

Node 24 · TypeScript(ESM) · Fastify 5 · grammY（webhook / long polling / WS 中继）· 内置 `node:sqlite`(WAL) · pino · zod · undici · ws · vitest。

## 状态

* `pnpm test` → **87 passed / 16 files**；`pnpm typecheck`、`pnpm build` 均通过
* 已在真实租户与真实 Telegram 上验证：webhook 绑定、`/login` OTT、`/signup`、CLI 全命令、HTTP 代理、SOCKS5、WS 中继、polling、`/ws`
* 详见 [docs/verification.md](docs/verification.md)

## 目录结构

```
src/
  app.ts                # 唯一装配入口（bootstrap）
  index.ts              # 进程入口
  cli/index.ts          # 运维 CLI
  relayMain.ts          # WS 中继服务端入口（dist/relayMain.js）
  config.ts logger.ts
  db/{schema,index,repo}.ts
  http/{server.ts,routes/*}
  logto/{management,webhookVerify}.ts
  net/{proxy,socks5,httpClient,transport,wsRelayClient,wsRelayServer,wsControl,events}.ts
  services/{binding,identity,loginLink,signup,notifications,roleSync,roleConfigStore,roles,adminAudit}.ts
  telegram/{bot,send,esc,args,context,commands/*}
test/{unit,integration,helpers}/   scripts/   config/   docs/
```
