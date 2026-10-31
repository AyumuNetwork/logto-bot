# 运维手册

## 首次接入清单（按顺序）

```bash
# 1. 装依赖、写配置
pnpm install
cp .env.example .env && chmod 600 .env
#    至少要填：LOGTO_ENDPOINT / TELEGRAM_BOT_TOKEN / LOGTO_M2M_CLIENT_ID / LOGTO_M2M_CLIENT_SECRET

# 2. Logto 侧资源
pnpm logto:setup

# 3. 自检（M2M / identities / OTT / roles）
pnpm probe

# 4. 本地起服务，先不接 webhook
pnpm dev
curl -s localhost:8080/healthz

# 5. 有公网域名后：建 webhook 拿签名密钥 → 写回 .env → 注册 Telegram webhook
BOT_PUBLIC_URL=https://bot.example.com pnpm logto:setup
pnpm tg:webhook
pnpm cli doctor          # 应该全绿

# 6. 端到端
#    a) 用 Telegram 登录你的应用 → bot 自动私聊"已绑定"
#    b) /login → 点开 → 落到 Account Center
#    c) /signup someone@example.com → 注册链接
```

没有公网域名时：在第 5 步改为

```bash
TELEGRAM_MODE=polling pnpm dev        # 或先起 relay 再设 TELEGRAM_WS_RELAY
```

Logto webhook 仍需入站 HTTPS（Logto 主动回调），这一条无法用同法绕开。

## 切换传输方式

| 从 → 到 | 操作 |
|---|---|
| webhook → polling | `.env` 设 `TELEGRAM_MODE=polling`；重启；启动时会 `deleteWebhook` |
| polling → webhook | 设 `TELEGRAM_MODE=webhook`；确保 `BOT_PUBLIC_URL` 可达；`pnpm tg:webhook` |
| 直连 → 代理 | 设 `TELEGRAM_PROXY_URL`；重启；`doctor` 看 `transport` 行 |
| 直连 → WS 中继 | 起中继 → 设 `TELEGRAM_WS_RELAY`/`_TOKEN` → 重启 |
| 中继 → 直连 | 清空 `TELEGRAM_WS_RELAY` → 重启 |

切换后务必跑一次 `pnpm cli doctor`，`transport` 行会明确显示生效方式。

## 密钥轮换

| 密钥 | 步骤 |
|---|---|
| M2M secret | Console 里给 `rurino-bot` 加新 secret → 更新 `.env` → 重启 → 删除旧 secret |
| Webhook 签名 | Console 里 update signing key → 同步 `.env` → 重启（中间失败的投递会被幂等表挡住重复处理） |
| Telegram bot token | BotFather `/revoke` → 更新 `.env` → 重启 → `pnpm tg:webhook`（`secret_token` 未变可略） |
| `WS_TOKEN` | 直接改 `.env` 重启；已连接客户端会重连失败（401） |
| `TELEGRAM_WS_RELAY_TOKEN` | 先改中继再改 bot（或反之，短暂断连会自动重连） |

## 日常操作

```bash
pnpm cli doctor                     # 健康总览
pnpm cli users list --limit 50      # 谁绑定了
pnpm cli users show @alice          # 单人详情 + Logto 角色
pnpm cli outbox stats               # 投递积压
pnpm cli outbox retry               # 重投 dead
pnpm cli events tail -n 30          # 最近 webhook
pnpm cli config export --out roles.json   # 角色配置备份
```

Bot 侧等价入口：`/admin` `/stats` `/user` `/outbox` `/events` `/export`。

审计：`admin_audit` 表（`actor_tg_id=0` 表示 CLI），bot 内 `/admin → 审计`。SQL 直接查：

```bash
sqlite3 data/bot.db "select datetime(at,'unixepoch','localtime'), actor_tg_id, action, target from admin_audit order by id desc limit 20;"
```

## 故障处理

| 症状 | 处理 |
|---|---|
| `/hooks/logto` 全 401 | 签名密钥不一致：比对 Console 与 `.env`；确认反代没改写 body |
| `/hooks/logto` 全 503 | `LOGTO_WEBHOOK_SIGNING_KEY` 为空（默认拒绝而不是裸跑） |
| `/hooks/logto` 全 400 | payload 缺 `event`，或 body 被压缩/改写 |
| bot 收不到消息 | `doctor` 看 `transport`；webhook 模式查 `getWebhookInfo`（`last_error_message`）；polling 模式看日志 `telegram long polling started` |
| 409 Conflict | webhook 与 polling 同时存在：`deleteWebhook` 或切单一模式 |
| 用户收不到通知（403） | 用户拉黑 bot 或未授权 `bot_access`；`users.notify_blocked=1`，等用户下次发言自动恢复 |
| 大量 429 | 触到 Telegram 限速；看 `outbox.last_error`，`retry_after` 已自动排期 |
| 角色不同步 | `/whorole <用户>` 对比目标/实际；确认 bot 是群管理员（`/group show` 会显示）；`/roles` 确认映射角色 id 存在 |
| `/login` 报未配置 | `LOGIN_APP_CLIENT_ID` 缺失；`pnpm logto:setup` |
| 一次性链接"令牌已被使用" | 正常（单次）；如需重发，重新 `/login` |
| WS 中继连不上 | 中继日志 + `doctor`；token/端口/TLS 证书；`ws://` 不能配 `https.Agent`（代码已按 scheme 处理） |
| `/ws` 404/401 | 未开 `WS_ENABLED`；或 `WS_TOKEN` 不匹配 |

## 数据清理

```bash
pnpm cli outbox purge                       # 清 sent
sqlite3 data/bot.db "delete from logto_events where received_at < strftime('%s','now','-30 days');"
sqlite3 data/bot.db "delete from admin_audit where at < strftime('%s','now','-180 days');"
```

`login_links` 只存我们签发的记录（不含明文令牌以外的东西），可同样按时间清理。历史 `role_sync_log` 建议保留 90 天以上用于回溯。

## 演练（不影响真实用户）

```bash
DRY_RUN=true pnpm dev          # 出站消息只记日志
pnpm smoke <tgUserId>          # 真实链路快速自检（会真的发一条消息）
```
