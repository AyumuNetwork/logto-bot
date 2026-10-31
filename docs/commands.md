# Bot 指令

## 权限模型（一句话）

**只有 `ADMIN_TG_IDS` 里的人能配置任何东西。** 群里的 `creator/administrator` 身份不授予配置权，普通成员只能看自己的映射。

| 范围 | 指令 |
|---|---|
| 所有人（私聊） | `/start` `/help` `/login [slug]` `/whoami` `/settings` `/sessions` `/unbind` |
| 所有人（群里） | `/role`（只读，看自己） |
| Bot 管理员 | `/admin` `/stats` `/group` `/map` `/sync` `/roles` `/whorole` `/signup` `/orgs` `/user` `/grant` `/revoke` `/events` `/outbox` `/export` `/broadcast` `/reload` |

非管理员触发管理指令时统一回复「仅 Bot 管理员可用（ADMIN_TG_IDS）」，且**不改动数据库**。

## 登录与绑定

### `/login [slug]`

生成一次性登录链接（`POST /api/one-time-tokens` + `/oidc/auth?...&one_time_token=…`）。

* 默认落点 `account`（Account Center）；`/login <slug>` 用 `config/apps.json` 里的其它目标。
* **只能在私聊发送**：群里调用时链接走私聊，群里只回「已私聊」。
* 无 `primaryEmail` 的账号退化为 `direct_sign_in=social:Telegram` 快捷链接，并标注"非一次性"。

```
🔗 Logto 账户中心 一次性登录链接
• 类型：一次性（点开即登录，二次点击会失效）
• 有效期至：2026/10/31 22:31:53
https://auth.haori.ink/oidc/auth?client_id=…&one_time_token=…
```

### `/whoami` `/sessions` `/settings` `/unbind`

* `/whoami`：Telegram id、Logto 用户、邮箱、绑定来源、绑定时间、开启的通知、投递状态。
* `/sessions`：最近 8 条登录链接（`有效 / 已过期 / 已撤销`），可逐条撤销（同时删 Logto 侧令牌）。
* `/settings`：内联键盘切换 `登录提醒 / 改密通知 / 安全告警 / 账号变更`。
* `/unbind`：二次确认后解除绑定。

### 绑定是怎么发生的

1. 用户用 Telegram 登录 Logto → Logto 触发 `PostSignIn`。
2. bot 读取 `identities.<IDP_TARGET>.details.rawData.id`（= Telegram 数字 id = 私聊 chat_id），写入绑定。
3. 首次绑定发送欢迎语（依赖 `telegram:bot_access`，可免 `/start`；403 则标记"投递被阻止"）。

用户没绑定时发任意消息，bot 会引导先 `/login` 登录一次——登录成功即自动绑定。

## 群身份 → 角色

### `/role`（所有人，只读）

显示：群内身份、目标角色、是否已绑定 Logto、当前角色。

### `/group [chatId] on|off|show|leave`、`/group list`

| 子命令 | 作用 |
|---|---|
| `on` / `off` | 启用/停用该群的同步（写 `role_groups`） |
| `show` | chat_id、开关、退群是否移除角色、全部映射、**bot 是否群管理员** |
| `leave`（=`remove`/`del`） | 二次确认后删除该群的全部配置 |
| `list` | 所有已配置群组 |

群里直接发即可；私聊里必须带 chatId：`/group -1001234567890 on`。

### `/map` 角色映射

```
/map status administrator Admins           # 状态 → 角色
/map status creator "Very Internal Users"  # 名称含空格也行
/map title 核心成员 Admins                  # 自定义头衔 → 角色
/map title --title "核心成员" --role "Admins"
/map list
/map del status administrator
/map del title 核心成员
```

* 状态取值：`creator` `administrator` `member` `restricted`。
* 角色参数支持：**role id** → **名称精确** → **大小写不敏感** → **唯一子串**；有歧义时返回候选列表（不会猜）。
* 一个状态/头衔对应一个角色（同一键重复设置即覆盖）。
* 写入会同时记 `admin_audit`。

### `/sync [chatId]`

对账：`getChatAdministrators` 拿管理员 + 逐个探测已知绑定用户的 `getChatMember`（30ms 间隔，单批 ≤500），按映射增删角色，写 `role_sync_log`，返回检查数/变更数/失败数与前 10 条明细。同一群有并发锁，重复触发回「正在同步」。

### `/whorole [用户]`

对比"群内身份推出的目标角色"与"用户在 Logto 里实际的角色"，用于排查映射写错。

### `/roles`

列出租户里的用户角色（名称 + id + 默认标记），供 `/map` 引用。缓存 5 分钟，`/reload` 可强制刷新。

## 注册 Magic Link

```
/signup someone@example.com
/signup a@b.com,c@d.com --ttl 3600 --org org_xxx
/signup --list
/signup --revoke <ottId>
```

* 走 OTT `context.interactionEvent = Register`；`--org` 可重复，透传为 `jitOrganizationIds`。
* `--ttl` 60–86400 秒（默认 3600）；一次最多 10 个邮箱，自动去重、校验格式。
* 单次有效、可撤销；bot **不发邮件**，链接由管理员转发。
* `/orgs` 列出组织 id 供 `--org` 使用。

## 运维指令（管理员）

| 指令 | 说明 |
|---|---|
| `/admin` | inline 面板：概览 / 群组 / 队列 / 事件 / 审计 |
| `/stats` | 用户数、24h 事件分类、队列 pending/dead/sent、配置版本、租户信息 |
| `/user <tgId\|@username\|email\|logtoUserId>` | 绑定详情 + Logto 角色 + 通知状态 |
| `/grant <角色> <用户>` / `/revoke <角色> <用户>` | 手动调整角色（写 `role_sync_log` reason=`manual:*` 与审计） |
| `/events [-n 20]` | 最近 webhook 事件（事件名/状态/时间） |
| `/outbox` / `/outbox retry` / `/outbox purge` | 队列状态 / 重投 dead / 清理 sent |
| `/export` | 以文件形式导出角色配置 JSON（DB 为权威，文件仅备份） |
| `/broadcast [--role <角色>] --yes <文本>` | 二次确认（必须带 `--yes`）后群发；可按角色过滤 |
| `/reload` | 重载 `config/apps.json`、角色缓存与配置版本（不重启进程） |

## 回调命名空间

内联按钮的 `callback_data` 前缀彼此隔离，避免串线：

| 前缀 | 用途 |
|---|---|
| `toggle:<kind>` | `/settings` 通知开关 |
| `revoke:<linkId>` | `/sessions` 撤销登录链接 |
| `unbind:confirm` / `unbind:cancel` | `/unbind` 二次确认 |
| `adm:<panel>` | `/admin` 面板切换 |
| `gc:del:<chatId>` / `gc:cancel` | `/group leave` 二次确认 |

## 文案与容错

* 全部消息用 MarkdownV2，动态内容统一转义；**解析失败会自动降级为纯文本重发**，不会丢消息（真实踩过的坑：`/login <平台>` 的尖括号）。
* 长消息按行切分到 4096 以内。
* 出站经 outbox：全局 30 msg/s、单聊 1 msg/s、429 按 `retry_after` 重排、403 标记 `notify_blocked` 且不再重试。
