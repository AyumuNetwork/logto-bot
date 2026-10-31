# 实测记录与已知边界

所有结论都来自对真实租户 `https://auth.haori.ink` 与真实 bot `@rurino_chan_bot` 的运行，不是推测。时间：2026-10-31（UTC+8）。

## 1. `pnpm probe`（Logto 侧自检）

```
✅ env: endpoint=https://auth.haori.ink idp=Telegram
✅ management token: GET /api/users -> 1 row(s)
   ↳ xiexilin: tgUserId=1558159309 sub=4893946124037248621 phone=8615986137668
✅ telegram identity: rawData.id present
   ↳ sample link: https://auth.haori.ink/oidc/auth?client_id=cfxpfqlqtd0yr5i1yrvoc&redirect_uri=…
✅ one-time token: created g23281tdvwq67stf3k7o8 then deleted
✅ roles: External Users, Internal Users, Very Internal Users, Admins, Logto Management API access
全部通过
```

## 2. `pnpm smoke`（真实链路）

```
✅ 绑定：tg=1558159309 logto=58cf28ce-… created=true
✅ 已发送 /login 消息：strategy=ott expires=…
✅ 落地检查：HTTP 303 → /sign-in?app_id=cfxpfqlqtd0yr5i1yrvoc&one_time_token=…&login_hint=…
✅ 租户接受该授权请求
🧹 已撤销测试用一次性令牌
```

`/login` 落地页面对照实验（临时应用，已删除）：

| redirect_uri | 结果 |
|---|---|
| `https://auth.haori.ink/account` | 卡 loading（SPA 把 code/state 当自己的回调） |
| `https://auth.haori.ink/account/` | 同上 |
| `https://auth.haori.ink/account/profile` | 404 |
| **`https://auth.haori.ink/`** | **落到 `/account/security`，已登录** |

## 3. `pnpm cli doctor`（网络层）

```
✅ env: endpoint=https://auth.haori.ink idp=Telegram
✅ transport: webhook via http://127.0.0.1:7897
✅ db: ./data/bot.db · users=1
✅ management api: 5 roles
✅ telegram bot: @rurino_chan_bot (1136ms)
✅ login targets: account
❌ webhook signing key: missing      ← 等公网域名
❌ telegram webhook url: missing     ← 等公网域名
✅ role config: groups=0 mappings=0
```

| 场景 | 结果 |
|---|---|
| `TELEGRAM_PROXY_URL` 未设，回落 `HTTPS_PROXY=127.0.0.1:7897` | `transport: http://127.0.0.1:7897`，getMe 1136ms |
| `TELEGRAM_PROXY_URL=socks5h://127.0.0.1:7897` | getMe 200（自实现 SOCKS5 + TLS） |
| 错误凭据的 SOCKS5 | 明确拒绝（RFC1929 失败） |
| `TELEGRAM_WS_RELAY=ws://127.0.0.1:8094` | getMe + getWebhookInfo 全部经单条 WS 完成（1957ms） |
| 中继 token 错误 | 客户端被拒；`doctor` 显示 `telegram bot ❌` |
| `TELEGRAM_MODE=polling` | 日志 `telegram long polling started`，`/tg/webhook` 返回 404 |
| `/ws` 控制通道 | `hello` → `stats{transport:"polling"}` → `send_test` 入队 → 实时 `outbox` 事件 → 消息真实送达 |

## 4. CLI 实测

`groups add / map set status / map set title / map list / groups list / config export / groups remove / signup --email / signup --list / signup --revoke / outbox stats / outbox retry / events tail / roles list / users list / doctor` 全部通过；演示群 `-1009999999999` 已删除，测试用 OTT 已撤销。

## 5. Bot 指令实测（真实发送到 Telegram）

`/admin` `/stats` `/group list` `/map list` `/user` `/events` `/outbox` `/whorole` `/signup` `/roles` `/help` 渲染正常（MarkdownV2 无 400）。

## 6. 测试与构建

```
pnpm test       → 87 passed / 16 files
pnpm typecheck  → 无错误
pnpm build      → dist/{index,relayMain,cli/index}.js 均产出
```

| 文件 | 用例 |
|---|---|
| unit/webhookVerify | 4 |
| unit/identity | 4 |
| unit/loginLink | 7 |
| unit/signup | 6 |
| unit/roles | 6 |
| unit/roleConfigStore | 6 |
| unit/roleSync | 5 |
| unit/notifications | 9 |
| unit/proxy | 9 |
| unit/socks5 | 4 |
| unit/args | 5 |
| integration/logtoWebhook | 5 |
| integration/adminCommands | 6 |
| integration/serverModes | 3 |
| integration/wsRelay | 4 |
| integration/wsControl | 4 |

## 7. 实测中发现并修掉的 bug

1. **grammY fetch shim**：其 `AbortSignal` 非平台实例（`Expected signal … to be an instance of AbortSignal`）且不认 `HTTP(S)_PROXY` → 新增 `createPlatformFetch()` 桥接 + 平台 fetch。
2. **undici 自定义 connect 收到 `port: ""` / `servername: null`** → SOCKS 连到 0 端口、TLS 被 RST；新增 `resolveDestinationPort()`。
3. **polling 模式构造 `webhookCallback()` 抛错**（"Bot is already running via long polling"）→ 仅 webhook 模式构造。
4. **`/help` 的 `/login <平台>` 未转义** → Telegram 400 `can't parse entities`；修模板 + `replyMarkdown` 纯文本降级。
5. **`events tail` 用了不存在的 `logto_events.id`** → 改 `ORDER BY received_at, rowid`。
6. **`ws://` 中继配了 `https.Agent`** → 按 URL scheme 决定是否带 agent。

## 8. 已知边界（不是待办，是平台事实）

1. **Logto 一次性令牌只支持 email**：纯 Telegram 账号没有邮箱 → `/login` 退化为 `direct_sign_in=social:Telegram`（非一次性），文案会标注。
2. **绑定键是 `rawData.id`**：Logto 的身份 id 取 `sub`，Telegram 数字 id 只在 id_token 的 `id` claim 里；`details.id` 等于 `sub`。
3. **`phone` scope 不进 Logto 资料**：连接器只认标准 `phone`，Telegram 给的是 `phone_number`（保留在 `rawData`）。
4. **Bot API 无法枚举群成员**：角色同步靠 `chat_member` 增量 + `getChatAdministrators` + 对已知绑定用户逐个 `getChatMember`；历史成员需一次发言/被探测。
5. **`sendMessage` 403** 表示用户未授权 `bot_access` 或拉黑 bot：标记 `notify_blocked`，不再重试，等用户下次发言恢复。
6. **直连应用 callback 的 `/login <slug>` 会踩 state 校验**：GitLab / Logto SDK 等应用会拒绝外来 `state`；默认只提供 Account Center 落点。
7. **单实例**：SQLite 单文件，多副本共用一个 DB 文件不安全；CLI 可并行（短事务），中继是无状态可多副本。
8. **Logto webhook 必须入站**：Logto 主动回调，无法用 polling/中继绕过；Telegram 侧则可以用 polling/中继省掉公网入口。
9. **中继是新增信任边界**：只允许 `/bot<token>/<method>` 到固定上游，token 泄露等于该 bot 的 Bot API 权限。

## 9. 探测产物清理

* 探测期间创建的临时 Logto 应用（`rurino-login-probe`）、临时用户、10+ 个测试 OTT 已全部删除；22 个既有应用 / 46 个用户 / 连接器配置未改动。
* 本机 `~/.cache/logto-bot-probe`（含 Console 会话、token、vault dump）已删除。
* 保留在租户里的正式资源只有：M2M 应用 `rurino-bot`、Traditional 应用 `rurino-login`、（域名就绪后）webhook。
