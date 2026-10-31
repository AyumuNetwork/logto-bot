# Logto 侧配置

本 bot 依赖 Logto 的四样东西：**一个 OIDC 社交连接器**、**一个 M2M 应用**、**一个登录落地应用**、**一个 Webhook**。全部可以用 Console 手工配置，也可以跑 `pnpm logto:setup`（幂等，只增不改）。

## 1. 社交连接器：Telegram（OIDC，不是 OAuth2）

> **关键点**：Telegram 的 OIDC **没有 `userinfo_endpoint`**（见 `https://oauth.telegram.org/.well-known/openid-configuration`），而 Logto 的 *OAuth 2.0 (Social)* 连接器把 `userInfoEndpoint` 设为必填、必然调用。因此必须用 **OIDC (Social)** 连接器——它只解析 `id_token` 并用 JWKS 验签。

在 BotFather 里为 bot 打开 **Login Widget → Allowed URLs**（含租户域名）和 **Request Direct Messages**，然后创建 OIDC 社交连接器：

```json
{
  "authorizationEndpoint": "https://oauth.telegram.org/auth",
  "tokenEndpoint": "https://oauth.telegram.org/token",
  "clientId": "<BotFather 的 Client ID>",
  "clientSecret": "<BotFather 的 Client Secret>",
  "tokenEndpointAuthMethod": "client_secret_basic",
  "scope": "openid profile phone telegram:bot_access",
  "idTokenVerificationConfig": {
    "jwksUri": "https://oauth.telegram.org/.well-known/jwks.json",
    "issuer": "https://oauth.telegram.org"
  },
  "acceptStringTypedBooleanClaims": true
}
```

* **IdP name / target**：本租户里叫 `Telegram`（**大写 T**），必须与 `.env` 的 `IDP_TARGET` 完全一致——它是 `user.identities` 的键。
* `telegram:bot_access`：Telegram 文档语义是"登录后允许 bot 主动私聊用户"，这正是"网页登录即绑定、不用先 `/start`"的基础。
* `phone` scope 拿到了也不会进 Logto 用户资料：Logto 只认标准 `phone` claim，而 Telegram 给的是 `phone_number`（会留在 `rawData` 里）。
* 建议把 `issuer` 加上（默认只校验 `jwksUri` + `aud`）。

### 身份数据长什么样（实测）

```jsonc
// GET /api/users/{id}/identities/Telegram
{
  "identity": {
    "userId": "4893946124037248621",        // = id_token.sub
    "details": {
      "id": "4893946124037248621",
      "rawData": {
        "id": "1558159309",                 // ← Telegram 数字 user id = 私聊 chat_id
        "sub": "4893946124037248621",
        "phone_number": "8615986137668",
        "preferred_username": "XieXiLin",
        "picture": "https://t.me/i/userpic/..."
      }
    }
  }
}
```

**绑定靠 `rawData.id`**，不是 `details.id`，也不是 `sub`。见 `src/services/identity.ts`。

## 2. M2M 应用（Management API）

* 类型：`MachineToMachine`，名称 `rurino-bot`
* 角色：`Logto Management API access`
* 资源指示符：`https://default.logto.app/api`（`.env` 的 `LOGTO_MANAGEMENT_RESOURCE`）
* 取得 `clientId` / secret：Console → 应用详情；或在 Logto v1.4+ 用 `GET /api/applications/{id}/secrets`

用到的 Management API：

| 用途 | 接口 |
|---|---|
| 读用户 / 身份 | `GET /api/users/{id}`、`GET /api/users/{id}/identities/{target}` |
| 一次性令牌 | `POST/GET/DELETE /api/one-time-tokens` |
| 角色 | `GET /api/roles`、`GET /api/users/{id}/roles`、`POST /api/users/{id}/roles`、`DELETE /api/users/{id}/roles/{roleId}` |
| 组织 | `GET /api/organizations` |

## 3. 登录落地应用（`/login`、`/signup` 的落点）

建一个 **Traditional** 应用 `rurino-login`，`redirectUris` 只填一个：

```
https://auth.haori.ink/
```

**为什么是租户根路径？**（实测对比）

| redirect_uri | 点击一次性链接后的结果 |
|---|---|
| `https://auth.haori.ink/account` | 卡在 loading（SPA 把 `code/state` 当自己的回调） |
| `https://auth.haori.ink/account/` | 同上 |
| `https://auth.haori.ink/account/profile` | 404 |
| **`https://auth.haori.ink/`** | **落到 `/account/security`，Account Center 已登录** |

授权回跳带的 `code` 会被 SPA 忽略，**不需要交换**；用户此时已获得 Logto 会话，之后打开任意接入应用会被 SSO 静默放行。

`.env` 对应：`LOGIN_APP_CLIENT_ID` + `LOGIN_REDIRECT_URI`（也可写在 `config/apps.json` 的 `targets.account`）。

> 直连某个具体应用的 callback（`/login <slug>`）也能用，但回跳带的是**我们**的 `state`，用 state 校验的应用（GitLab / Logto SDK 等）会拒绝——实测如此，所以默认只保留 Account Center 落点。

## 4. Webhook

`pnpm logto:setup` 会在 `BOT_PUBLIC_URL` 存在时创建，否则手工在 Console 建：

* URL：`https://<BOT_PUBLIC_URL>/hooks/logto`
* 签名：header `logto-signature-sha-256`，值为 `hex(HMAC-SHA256(signingKey, rawBody))`；`signingKey` 在 Console 的 webhook 详情页
* 建议事件：

```
PostSignIn  PostRegister  PostResetPassword
User.Created  User.Data.Updated  User.Deleted  User.SuspensionStatus.Updated
Identifier.Lockout
TrustedDevice.Created  TrustedDevice.Deleted
Organization.Membership.Updated
```

处理约定：**先 200 再异步**，用 `sha256(rawBody)` 去重；`Role.*`、`Message.RateLimited`、`Grant.LimitExceeded` 只入库不打扰用户。

## 5. 一次性令牌（Magic Link）语义

`POST /api/one-time-tokens`

```jsonc
// 登录
{ "email": "user@example.com", "expiresIn": 600 }
// 注册 / 邀请（可选直接进组织）
{ "email": "invitee@example.com", "expiresIn": 3600,
  "context": { "interactionEvent": "Register", "jitOrganizationIds": ["org_xxx"] } }
```

* **只支持 email 标识符**（手机号/用户名不支持）。纯 Telegram 账号没有邮箱时，`/login` 会退化为 `direct_sign_in=social:Telegram` 快捷链接。
* 令牌**单次**：二次点击 Logto 返回"令牌已被使用"。
* `interactionEvent: Register` 只决定验证令牌后进入哪条流程；邮箱已存在时按登录处理。
* 新账号仍要过 Logto 的密码 / passkey / MFA onboarding（这是 SIE 策略，不是 bot 的行为）。
* 生成链接**不发邮件**；链接由管理员转发。

## 6. 排错

| 现象 | 原因 / 处理 |
|---|---|
| 登录报 `userinfo` 相关错误 | 用错连接器类型（OAuth2），换成 OIDC |
| `rawData.id` 缺失 | 连接器 scope 缺 `profile`，或该用户是用旧 connector 登录的 |
| 绑定不到 Telegram | 检查 `IDP_TARGET` 大小写（本租户是 `Telegram`） |
| `/login` 报 `LOGIN_APP_CLIENT_ID` 未配置 | 跑 `pnpm logto:setup` 或手填 |
| 一次性链接落地 404/卡住 | `redirectUris` 不是 `https://auth.haori.ink/` |
| webhook 全部 401 | `LOGTO_WEBHOOK_SIGNING_KEY` 与 Console 不一致 |
| webhook 全部 503 | 未配置签名密钥（刻意拒绝，避免裸跑） |
