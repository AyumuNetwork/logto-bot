# 开发

## 环境与脚本

```bash
pnpm install
pnpm dev            # tsx 直跑 + --env-file-if-exists=.env
pnpm typecheck      # tsc --noEmit（含 test/、scripts/）
pnpm test           # vitest run（87 cases）
pnpm test:watch
pnpm build          # dist/（src → dist，含 relayMain.js、cli/index.js）
pnpm probe          # 真实租户自检
pnpm smoke <tgId>   # 真实链路冒烟（会真的发消息）
pnpm cli …          # 运维 CLI
pnpm ws-relay       # 本地跑中继
```

`tsconfig.json` 面向全仓库（含测试），`tsconfig.build.json` 只编译 `src/`。Node 24 + ESM + `module: NodeNext`，相对导入要带 `.js` 后缀。

## 代码不变量（改代码前先读）

1. **DB 是角色配置的唯一权威**：任何 `role_groups`/`role_mappings` 写入都必须走 `RoleConfigStore`（它负责 `bump()` 失效缓存与审计），不要在别处直接写 repo。
2. **权限只有一个入口**：`isBotAdmin()`（`telegram/context.ts`）。新命令若涉及写操作，必须 `await requireBotAdmin(...)` 开头。
3. **管理动作必须审计**：`audit.record({ actor, action, target, detail })`，`actor=0` 表示 CLI。
4. **出站一律经 outbox**，不要在 handler 里直接 `bot.api.sendMessage`（限速/重试/审计都在 outbox）。命令回复走 `replyMarkdown`。
5. **Logto 数据模型不要"猜"**：绑定键是 `identities[IDP_TARGET].details.rawData.id`；`details.id` 与 `sub` 是同一值，不是 chat id。
6. **HTTP 面保持最小**：新增入口要能说清为什么不能由 webhook/命令/CLI 完成。
7. **异步不要悬空**：webhook 里 `setImmediate` 的 promise 必须 `void … .catch()`；DB 关闭时不能让 rejection 冒泡（已有防御，但别新增裸 await）。

## 常见改动配方

### 加一个 bot 命令

1. 在 `src/telegram/commands/*.ts` 里 `bot.command('<name>', async (ctx) => {...})`；参数用 `parseArgs(ctx.match)`。
2. 需要权限就 `if (!(await requireBotAdmin(ctx, services))) return;`。
3. 输出用 `replyMarkdown(ctx, text, keyboard?)`（内部已做 MarkdownV2 + 纯文本降级）。
4. 在 `src/telegram/bot.ts` 的 `USER_COMMANDS` / `ADMIN_COMMANDS` 里登记（`/admin` 之外的用户可见命令还要同步 `app.ts` 里的 `setMyCommands` 列表）。
5. 加测试：`test/integration/adminCommands.test.ts` 的模式（fake fetch + `bot.handleUpdate`）。

### 加一个 CLI 命令

1. `src/cli/index.ts` 的 `run()` 里加 `case '<group>'`，需要群上下文用 `chatIdArg()`。
2. 写操作 → `audit.record({ actor: CLI_ACTOR, ... })`。
3. 输出统一用 `out()`（支持 `--json`），退出码 0/1。
4. 用法字符串同步到 `usage()`。

### 处理新的 Logto 事件

1. `services/notifications.ts` 的 `planNotification()` 里加 `case '<Event>'`，返回 `{kind, title, lines, emoji}`；不想打扰就 `kind:'none'`。
2. 需要触发绑定的加入 `http/routes/logtoWebhook.ts` 的 `BINDING_EVENTS`。
3. 需要改绑定状态的（如删除）在 `handleLogtoEvent` 里单独处理。
4. 在 Console webhook 的事件清单里勾上，并更新 `scripts/create-logto-resources.ts` 的 `events` 数组。

### 加一个 `/ws` 事件

`eventBus.emit('<name>', data)`（先扩展 `BusEvent['name']` 联合类型），并在 `docs/network.md` 的帧示例里补充。订阅端用 `?topics=` 过滤。

### 数据库变更

在 `src/db/schema.ts` 追加 `CREATE TABLE IF NOT EXISTS`；加列则在 `src/db/index.ts` 的 `COLUMN_MIGRATIONS` 里登记（幂等，启动自动执行）。不要写破坏性 DDL。

## 测试布局

| 文件 | 覆盖 |
|---|---|
| `unit/webhookVerify` | HMAC 计算/比较/篡改检测 |
| `unit/identity` | `rawData.id` 提取、字符串 rawData、缺失场景 |
| `unit/loginLink` | URL 构造、OTT 降级、slug 解析、撤销 |
| `unit/signup` | Register/jit 组织、TTL 夹取、去重、批量上限 |
| `unit/roles` / `unit/roleConfigStore` | 角色解析（含歧义）、缓存失效、导入导出 |
| `unit/roleSync` | `desiredRoles()` 纯函数矩阵 |
| `unit/notifications` | 事件映射、MarkdownV2 转义、切分 |
| `unit/proxy` / `unit/socks5` | 代理 URL 解析、端口补全、SOCKS5 端到端（含认证/错误凭据） |
| `unit/args` | 命令参数解析 |
| `integration/logtoWebhook` | 验签/幂等/绑定/解绑/开关过滤 |
| `integration/adminCommands` | 权限拒绝、`/group` `/map` `/sync`、`/signup`、面板 |
| `integration/serverModes` | webhook↔polling 路由差异 |
| `integration/wsRelay` | 中继 round-trip、错误 token、路径白名单、断线重连 |
| `integration/wsControl` | 401、hello、命令、事件过滤 |

辅助：

* `test/helpers/fakeTelegram.ts`：记录 Bot API 调用并返回合理结果，测试里用 `createBot(services, { fetch: fake.fetch })` 注入。
* 内存库：`openDatabase(':memory:')`。
* 命令级测试用 `bot.handleUpdate(...)` 走真实中间件，断言 `fake.calls` 与 DB。

## 踩过的坑（别再踩）

1. **grammY 的 fetch shim**：其 `AbortSignal` 不是平台实例，且不认环境代理。`createPlatformFetch()` 负责桥接并向内层传平台 signal；不要在别处直接给 grammY 传 `globalThis.fetch`。
2. **undici 自定义 connect 收到 `port: ""`、`servername: null`**：必须 `resolveDestinationPort()` 补 443/80，否则 SOCKS 会连 0 端口。
3. **polling 模式下不能构造 `webhookCallback()`**：grammY 会抛 "Bot is already running via long polling"。判定放在 `createServer` 内部。
4. **`https.Agent` 不能用于 `ws://`**：中继客户端按 `url.protocol` 决定是否带 agent（本机 `ws://` 测试会暴露）。
5. **MarkdownV2 的 `<`/`>`**：不在代码段里就必须转义；`replyMarkdown` 已做纯文本降级，但模板该修还得修。
6. **webhook 异步处理晚于 DB 关闭**：测试里 `app.close()` 后 `setImmediate` 仍会跑，`updateEventStatus` 已 try/catch，新增异步回调也要如此。
7. **`logto_events` 没有 `id` 列**：按 `received_at, rowid` 排序，别写 `ORDER BY id`。
8. **Vault/Console 凭据只用于本地探测**：不要写进仓库任何文件。

## 风格

* 纯函数优先（`desiredRoles`、`buildAuthorizationUrl`、`parseArgs`），副作用集中在 service。
* 外部输入（Telegram 文本、Logto payload）都当不可信数据；日志里只打 id 与状态。
* 注释解释"为什么"，不解释"做了什么"；对外行为变化要同时更新 `docs/`。
