# CLI

与 bot 共用同一个数据库和服务层，可以并行运行（SQLite WAL + `busy_timeout=5000`）。所有写操作记 `admin_audit`，`actor_tg_id = 0` 表示 CLI。

```bash
pnpm cli <group> <action> [args]
pnpm cli doctor                 # 最常用的自检
pnpm cli map list --chat -1001234567890 --json
```

通用规则：

* `--json` 输出机器可读结果。
* 需要群的命令用 `--chat <chatId>`；`sync`/`groups` 也接受位置参数。
* 角色参数支持 id / 名称 / 唯一子串（与 `/map` 一致），歧义时报候选并退出码 1。
* 退出码：`0` 成功，`1` 参数或业务错误。

## groups

```bash
pnpm cli groups list
pnpm cli groups add -1001234567890 --title 主群
pnpm cli groups enable  -1001234567890
pnpm cli groups disable -1001234567890
pnpm cli groups remove  -1001234567890      # 连同该群映射一起删除
```

## map

```bash
pnpm cli map list --chat -1001234567890
pnpm cli map set status administrator Admins --chat -1001234567890
pnpm cli map set status creator "Very Internal Users" --chat -1001234567890
pnpm cli map set title 核心成员 Admins --chat -1001234567890
pnpm cli map set title --role "Admins" --title "核心成员" --chat -1001234567890
pnpm cli map del status administrator --chat -1001234567890
pnpm cli map del title 核心成员 --chat -1001234567890
```

首次 `map set` 会自动创建该群配置（启用状态）。

## roles / users / orgs

```bash
pnpm cli roles list
pnpm cli users list --limit 20
pnpm cli users show @alice
pnpm cli users show alice@example.com
pnpm cli users show 1558159309
pnpm cli users unbind @alice
pnpm cli orgs list
```

`users show` 会额外拉取该用户在 Logto 的角色（需要 M2M 凭据）。

## sync

```bash
pnpm cli sync -1001234567890            # 默认 dry-run：只打印配置与提示
pnpm cli sync -1001234567890 --apply    # 真正写 Logto
```

`--apply` 等价于群里的 `/sync`：管理员 + 已知绑定用户逐个 `getChatMember`，30ms 间隔，单批 ≤500 人；结果写 `role_sync_log` 与审计。

## signup（注册 Magic Link）

```bash
pnpm cli signup --email a@example.com
pnpm cli signup --email a@b.com,c@d.com --ttl 3600 --org org_xxx --json
pnpm cli signup --list
pnpm cli signup --revoke <ottId>
```

输出示例：

```json
[
  {
    "email": "a@b.com",
    "url": "https://auth.haori.ink/oidc/auth?client_id=…&one_time_token=…",
    "expiresAt": 1793457078,
    "ottId": "s5mz9j63hzi2gaozufwho"
  }
]
```

## outbox / events

```bash
pnpm cli outbox stats
pnpm cli outbox retry      # 把 dead 重新置为 pending（attempts 归零）
pnpm cli outbox purge      # 清理 sent 记录
pnpm cli events tail -n 20
```

## config

```bash
pnpm cli config export                 # stdout，可直接重定向成 roles.json
pnpm cli config export --out roles.json
pnpm cli config import roles.json      # 合并写入（不删除未提及的群/映射）
```

格式与 `config/roles.json` 相同；DB 始终是权威，文件只用于备份/搬迁。

## doctor

```bash
pnpm cli doctor
pnpm cli doctor --json
```

检查项：

```
✅ env: endpoint=https://auth.haori.ink idp=Telegram
✅ transport: webhook via http://127.0.0.1:7897      # 或 direct / socks5h:// / ws-relay wss://…
✅ db: ./data/bot.db · users=1
✅ management api: 5 roles
✅ telegram bot: @rurino_chan_bot (1136ms)            # 真实 getMe，含耗时
✅ ws relay: wss://relay.example.com                   # 仅配置了中继时出现
✅ login targets: account
❌ webhook signing key: missing
❌ telegram webhook url: missing
✅ role config: groups=0 mappings=0
```

* `transport` 直接反映代理/中继/polling 的实际生效方式——排查"连不上 Telegram"先看这一行。
* `telegram bot` 的耗时能区分"代理慢"和"代理不通"。
