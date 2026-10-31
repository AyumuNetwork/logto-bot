# 部署

## 前置

* 一台能访问 `api.telegram.org`（或能走代理/中继）的机器；Node 24 或 Docker
* 公网 HTTPS 域名（**仅 Telegram webhook 与 Logto webhook 需要**；用 polling/中继时 Telegram 侧可省）
* Logto 侧资源已完成：[logto-setup](logto-setup.md)

## 目录与进程

| 进程 | 命令 | 说明 |
|---|---|---|
| bot | `node dist/index.js`（或 `pnpm dev`） | HTTP + outbox + 各服务 |
| relay（可选） | `node dist/relayMain.js` | 只在需要"只出站"部署时运行 |
| CLI | `node dist/cli/index.js …` | 一次性运维，可与 bot 并行 |

数据目录：`./data`（SQLite WAL：`bot.db`、`bot.db-wal`、`bot.db-shm`）。**只有 bot 进程写库**，CLI 短事务写入；单实例部署，不要多副本同时挂同一个 DB 文件。

## Docker

```bash
docker build -t logto-bot .
docker run -d --name logto-bot \
  --env-file .env \
  -v "$PWD/data:/app/data" \
  -p 127.0.0.1:8080:8080 \
  logto-bot
```

镜像内置 `HEALTHCHECK`（打 `/healthz`）。`dist/` 里同时包含 `index.js`、`cli/index.js`、`relayMain.js`。

## compose（bot + Caddy + 可选 relay）

```bash
docker compose up -d --build            # bot + caddy
docker compose --profile relay up -d    # 额外起中继（需要 TELEGRAM_WS_RELAY_TOKEN）
```

`Caddyfile`：

```
bot.example.com {
    encode zstd gzip
    reverse_proxy bot:8080
}
```

`docker-compose.yml` 里 relay 使用同一镜像、覆盖 command 为 `node dist/relayMain.js`，`RELAY_TOKEN` 取 `${TELEGRAM_WS_RELAY_TOKEN}`，并把 `HTTPS_PROXY` 透传成 `RELAY_PROXY`。

## systemd

```ini
# /etc/systemd/system/logto-bot.service
[Unit]
Description=logto-bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/logto-bot
EnvironmentFile=/opt/logto-bot/.env
ExecStart=/usr/bin/node /opt/logto-bot/dist/index.js
Restart=always
RestartSec=3
# 只允许写数据目录
ReadWritePaths=/opt/logto-bot/data
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

## 反代要求

1. **透传原始 body**：Logto 签名基于原始字节，任何改写（重编码 JSON、压缩）都会导致 401。
2. **WebSocket 升级**：若启用 `/ws`，反代需支持 `Upgrade`（Caddy 默认支持；Nginx 需要 `proxy_http_version 1.1` + `Upgrade`/`Connection` 头）。
3. **请求体上限**：服务端限制 256 KiB（Logto payload 远小于此）。
4. `trustProxy` 已开启，`/hooks/logto` 记录 `request.ip` 时以后置反代为准。

Nginx 片段：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_request_buffering off;
}
```

## 备份与恢复

```bash
# 热备份（WAL 安全）
sqlite3 data/bot.db ".backup 'backup/bot-$(date +%F).db'"
# 或停服后直接拷 bot.db + bot.db-wal
```

恢复：停服 → 放回文件 → 起服（schema 迁移是幂等的，只加表/加列）。

## 升级

```bash
git pull && pnpm install && pnpm test && pnpm build && systemctl restart logto-bot
```

DB 迁移只做 `CREATE TABLE IF NOT EXISTS` 与幂等 `ALTER TABLE ... ADD COLUMN`，可直接覆盖旧库。

## 可观测性

* 日志：pino JSON 到 stdout；`LOG_LEVEL=debug` 可看 Management API 刷新、角色同步细节。
* `/healthz` → `{ ok, users, dryRun }`。
* `/stats`（bot）与 `pnpm cli doctor` 覆盖同一组指标。
* `/ws` 订阅 `outbox` 可以实时看到投递失败。

## 资源

单实例、长连接少量、SQLite：典型 50–80 MB 常驻内存；CPU 空闲时接近 0（outbox 每 800ms 一次空转）。
