# 配置

所有配置走环境变量，启动时用 zod 校验（`src/config.ts`），出错立即退出并打印具体字段。`.env` 通过 Node 原生的 `--env-file-if-exists` 加载——**已存在的进程环境变量优先**，方便临时覆盖：

```bash
TELEGRAM_MODE=polling LOG_LEVEL=debug pnpm dev
```

参考模板：[`.env.example`](../.env.example)（含注释，建议 `chmod 600 .env`）。

## Logto

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `LOGTO_ENDPOINT` | ✅ | — | 租户地址，如 `https://auth.haori.ink`（末尾斜杠自动去除） |
| `LOGTO_M2M_CLIENT_ID` | 建议 | — | M2M 应用 id；缺失时 `/login` `/signup` `/sync` 不可用 |
| `LOGTO_M2M_CLIENT_SECRET` | 建议 | — | M2M 密钥 |
| `LOGTO_MANAGEMENT_RESOURCE` | | `https://default.logto.app/api` | Management API 资源指示符 |
| `LOGTO_WEBHOOK_SIGNING_KEY` | 建议 | — | 缺失时 `/hooks/logto` 一律 503（刻意为之） |
| `LOGTO_PROXY_URL` | | — | 仅作用 Management API；`http/https/socks5/socks5h` |
| `IDP_TARGET` | | `Telegram` | 社交连接器 target（`user.identities` 的键，**大小写敏感**） |
| `LOGIN_APP_CLIENT_ID` | `/login` 需要 | — | 登录落地应用（见 [logto-setup](logto-setup.md#3-登录落地应用login-的落点)） |
| `LOGIN_REDIRECT_URI` | | `https://auth.haori.ink/` | 该应用的 redirect_uri，**必须与 Console 一致** |
| `OTT_TTL` | | `600` | 一次性令牌有效期（秒） |

## Telegram

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | BotFather token |
| `TELEGRAM_MODE` | | `webhook` | `webhook` / `polling`（polling 下不注册 `/tg/webhook`，启动时 `deleteWebhook`） |
| `TELEGRAM_POLL_TIMEOUT` | | `30` | 长轮询 hold 秒数（1–120） |
| `TELEGRAM_WEBHOOK_SECRET` | 建议 | — | 传给 `setWebhook(secret_token)`；为空时启动告警 |
| `BOT_PUBLIC_URL` | webhook 需要 | — | `https://bot.example.com`，用于 webhook 注册与文案 |
| `TELEGRAM_PROXY_URL` | | — | Bot API 出站代理，`http/https/socks5/socks5h://[user:pass@]host:port` |
| `TELEGRAM_WS_RELAY` | | — | 出站 WS 中继地址（`wss://…`），优先级高于代理 |
| `TELEGRAM_WS_RELAY_TOKEN` | | — | 中继共享密钥 |
| `ADMIN_TG_IDS` | 建议 | — | 逗号分隔的 Telegram 用户 id；**只有这些人能配置任何东西** |

## 网络/代理

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROXY_USE_ENV_FALLBACK` | `true` | 未显式配置代理时回落到 `HTTPS_PROXY` / `https_proxy` / `ALL_PROXY` |
| `PROXY_NO_PROXY` | — | 逗号分隔直连白名单（也读 `NO_PROXY`） |

生效优先级：**`TELEGRAM_WS_RELAY` > `TELEGRAM_PROXY_URL` > 环境代理 > 直连**。启动日志会打印解析结果（不含凭据）。

## 本机控制通道

| 变量 | 默认 | 说明 |
|---|---|---|
| `WS_ENABLED` | `false` | 打开 `GET /ws` |
| `WS_TOKEN` | — | 控制通道 token；`WS_ENABLED=true` 但没 token 时会自动禁用并告警 |

## 运行时

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | HTTP 端口 |
| `HOST` | `0.0.0.0` | 监听地址（本机反代可设 `127.0.0.1`） |
| `DB_PATH` | `./data/bot.db` | SQLite 文件（WAL） |
| `LOG_LEVEL` | `info` | `fatal…trace/silent` |
| `DRY_RUN` | `false` | `true` 时不真正发 Telegram 消息，仅记录（本地演示/演练） |
| `NOTIFY_DEFAULTS` | `signin,password,security,account` | 新绑定用户默认开启的通知类别 |

`NOTIFY_DEFAULTS` 之外的未知值会被忽略；用户可用 `/settings` 自行开关。

## 角色映射文件（可选）

`config/apps.json`：`/login` 的落点清单（缺省时用 `LOGIN_APP_CLIENT_ID`）。

```json
{
  "defaultSlug": "account",
  "targets": {
    "account": {
      "label": "Logto 账户中心",
      "clientId": "cfxpfqlqtd0yr5i1yrvoc",
      "redirectUri": "https://auth.haori.ink/",
      "scope": "openid profile",
      "mode": "ott"
    }
  }
}
```

`config/roles.json`：**只在空库首次启动时导入**（DB 才是权威），格式见 `config/roles.example.json`。之后用 `/map`、`/export` 或 `pnpm cli config export|import` 管理。

## 敏感信息

* `.env` 建议 `chmod 600`，且已在 `.gitignore` 中。
* 日志已 redact `token` / `access_token` / `clientSecret` / `authorization`。
* WS 中继与控制的 token 用常数时间比较，日志只出现打码后的描述。
