# 架构

## 分层与职责

```
src/index.ts ──► src/app.ts (bootstrap，唯一装配入口)
                    │
   ┌────────────────┼───────────────────────────────┬──────────────────┐
   ▼                ▼                               ▼                  ▼
config/logger   db + repo                     services/*            http/server.ts
                   │                               │                     │
             node:sqlite(WAL)          binding / loginLink /      /tg/webhook
             role_groups/mappings      signup / notifications /   /hooks/logto
             outbox/events/audit       roleSync / roleStore /     /healthz
                                       roles / adminAudit         /ws（可选）
                    │                               │
                    └──────────► net/* ◄────────────┘
                     proxy(socks5/http) · transport · wsRelay
                     wsControl · events(bus)
```

`bootstrap()` 依次完成：解析配置 → 建立网络传输（代理/中继）→ 打开 DB → 构造 Logto 客户端 → 装配各 service → 创建 bot（`createBot`）→ `bot.init()` → 按 `TELEGRAM_MODE` 注册 webhook 或启动长轮询 → 建 Fastify → 可选挂 `/ws` → 监听 → `outbox.start()`。返回的 `shutdown()` 负责逆序收尾（停 outbox → 断控制通道 → 关中继 → 停轮询 → 关 HTTP → 关 DB）。

## 四条主链路

### 1. 一次性登录链接

```
/login ─► LoginLinkService
           ├─ 有 email：POST /api/one-time-tokens {email, expiresIn}
           │            └─► {LOGTO}/oidc/auth?client_id=…&redirect_uri=…&one_time_token=…&login_hint=…
           └─ 无 email：…&direct_sign_in=social:Telegram（非一次性，文案标注）
         └─ 写 login_links(url, ott_id, expires_at)  ── /sessions 可撤销（同时 DELETE OTT）
```
落地应用 `rurino-login` 的 `redirect_uri` 是租户根路径，登录后直接进 Account Center（[原因](logto-setup.md#3-登录落地应用login-的落点)）。

### 2. 自动绑定 + 通知

```
Logto ──PostSignIn──► POST /hooks/logto
                        ├─ 验签（HMAC-SHA256 over raw body，常数时间比较）
                        ├─ 体积上限 256KiB → 无 raw body 则 400
                        ├─ recordEvent(sha256(body)) 幂等；重复直接 200 {duplicate:true}
                        ├─ 立即 200
                        └─ setImmediate:
                             ├─ BindingService.applyWebhook → rawData.id → upsert users
                             ├─ 首次绑定 → 入队欢迎语（+ 事件总线 binding）
                             └─ planNotification → 用户开关过滤 → 入队 outbox
Outbox worker（800ms tick）: 全局 30 msg/s、单聊 1 msg/s、429 retry_after、403 → notify_blocked
```

`User.Deleted` 走解绑分支；`Message.RateLimited`/`Grant.LimitExceeded`/`Role.*` 只入库不发消息。

### 3. 群身份 → 角色

```
chat_member 更新 ─┐
/role /whorole   ├─► RoleSyncService.syncMember
/sync、CLI sync  ─┘        ├─ 读取 RoleConfigStore.getConfig()（60s 缓存 + 版本号失效）
                           ├─ desiredRoles(group, {status, custom_title})
                           ├─ 与 GET /api/users/{id}/roles 求差
                           ├─ POST/DELETE 角色（只增删本群映射里出现过的角色）
                           └─ role_sync_log + 事件总线 role_sync
```
`syncChat()` 额外扫一遍已知绑定用户（Bot API 无法枚举全员），带互斥锁与 30ms 间隔。

### 4. 网络层

```
createTelegramTransport()
  ├─ TELEGRAM_WS_RELAY  → WsRelayClient.fetch（单条 wss，多路复用；wss 才带隧道 agent）
  ├─ TELEGRAM_PROXY_URL → createDispatcher（ProxyAgent / 自实现 SOCKS5 Agent）
  └─ 否则直连
createLogtoFetch() 同理（LOGTO_PROXY_URL）
grammY 拿到的是 createPlatformFetch(transport.fetch)：桥接其 node-fetch 的 AbortSignal
```
中继协议与控制通道协议见 [network.md](network.md)。

## 数据表

| 表 | 关键列 | 用途 |
|---|---|---|
| `users` | `tg_user_id` UNIQUE / `logto_user_id` UNIQUE / `logto_email` / `notify_flags` JSON / `bind_source` / `notify_blocked` | 绑定关系与用户偏好 |
| `login_links` | `tg_user_id` `ott_id` `strategy`(`ott`/`ott_register`/`direct_sign_in`) `url` `expires_at` `revoked_at` `context_json` | 登录/注册链接审计与撤销 |
| `bind_codes` | `code_hash` PK `expires_at` `used_at` | 兜底确认码（极少用到） |
| `group_members` | `(chat_id, tg_user_id)` PK | 增量缓存的群成员状态 |
| `role_groups` | `chat_id` PK `enabled` `remove_on_leave` | 群配置（权威） |
| `role_mappings` | `(chat_id, kind, key)` UNIQUE → `role_id` | 状态/头衔 → 角色（权威） |
| `role_sync_log` | `before_roles` `after_roles` `reason` | 每次同步的 diff |
| `logto_events` | `dedupe_key` PK(=sha256 body) `event` `status` `payload` | webhook 幂等与审计 |
| `outbox` | `status`(`pending`/`sent`/`dead`) `attempts` `next_at` `last_error` | durable 发送队列 |
| `admin_audit` | `actor_tg_id`(0=CLI) `action` `target` `detail` | 管理操作审计 |
| `settings` | `key`/`value` | 版本号、`roles_imported_at` 等 |

迁移策略：`CREATE TABLE IF NOT EXISTS` + 幂等 `ALTER TABLE ADD COLUMN`（见 `db/index.ts`）。

## 事件总线（`/ws` 数据源）

| 事件 | 触发点 | 载荷 |
|---|---|---|
| `logto_event` | webhook 收到/处理完成 | `{event, userId}` / `{event, status}` |
| `binding` | 首次绑定成功 | `{tgUserId, logtoUserId, created}` |
| `outbox` | 发送成功/失败/被拦 | `{status, chatId, code?, attempts?}` |
| `role_sync` | 角色实际变化 | `{chatId, tgUserId, added, removed, reason}` |

环形缓冲保留 100 条，`hello.recent` 给最近 20 条。

## 安全模型

* **入站**：Telegram `secret_token`（grammY 校验）+ Logto HMAC-SHA256（`timingSafeEqual`）+ 256 KiB 体积上限；无签名密钥时 webhook 一律 503（不裸跑）。
* **权限**：所有配置类操作只认 `ADMIN_TG_IDS`；群管理员身份不授予任何配置权。
* **密钥**：`.env`（600，gitignore）；日志 redact `token`/`clientSecret`/`authorization`；中继 token 常数时间比较，日志只显示打码描述。
* **令牌**：OTT 单次、默认 600s、可撤销；我们自己的记录只存 `ott_id` 与 URL（用于审计/撤销），`/sessions` 只对本 chat 生效。
* **审计**：`admin_audit` 覆盖 bot 与 CLI 的全部写操作；角色变更有 `role_sync_log` 的 before/after。
* **中继信任边界**：只转发 `^/bot<token>/<method>` 到固定上游，阻断任意 URL 代理；单帧 8 MiB、并发 32、超时可调。

## 关键设计取舍

| 决策 | 理由 |
|---|---|
| DB 是角色配置唯一权威，文件只做种子/备份 | 避免"改了文件不生效"；`/export` 与 CLI 导出同格式 |
| 不做自建落地页 / 绑定页 | 实测 `redirect_uri = 租户根路径` 即可进 Account Center，少一个需要运维的 HTTP 面 |
| 绑定读 `rawData.id` | Logto 的身份 id 取 `sub`；Telegram 数字 id 只在 id_token 的 `id` claim 里 |
| 配置权只给 bot 管理员 | 群管理员身份可伪造/转让，权限面更容易收敛 |
| 单实例 + SQLite | 规模（数万用户）足够；避免引入 Postgres/Redis 运维成本；WAL 允许 CLI 并行 |
| `sendMessage` 失败不自动重发 | 非幂等；交给 outbox 的重试与 `notify_blocked` 策略 |
| 中继而非自建 MTProto | Bot API 已够用；WS 中继只需一条出站连接，部署成本最低 |
