import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { LogtoManagement } from '../src/logto/management.js';

/**
 * Idempotently create the Logto resources the bot needs:
 *   1. M2M application `rurino-bot` with the `Logto Management API access` role
 *   2. Traditional application `rurino-login` whose redirect URI lands on the
 *      Logto account center (verified working: redirect to the tenant root)
 *   3. Webhook pointing at BOT_PUBLIC_URL/hooks/logto (requires the env var)
 *
 * Run it once with the console token bootstrap, then paste the printed values
 * into .env. Nothing existing is modified.
 */
type Application = {
  id: string;
  name: string;
  type: string;
  secret?: string;
  oidcClientMetadata?: { redirectUris?: string[] };
};

const M2M_NAME = 'rurino-bot';
const LOGIN_APP_NAME = 'rurino-login';

const main = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger({ ...config, runtime: { ...config.runtime, logLevel: 'warn' } });
  const management = new LogtoManagement({
    endpoint: config.logto.endpoint,
    clientId: config.logto.m2mClientId,
    clientSecret: config.logto.m2mClientSecret,
    resource: config.logto.managementResource,
    logger,
  });

  if (!management.configured) {
    console.error('需要在 .env 里先提供 LOGTO_M2M_CLIENT_ID / LOGTO_M2M_CLIENT_SECRET（可用 Console 的临时凭据引导一次）。');
    process.exit(1);
  }

  const applications = await management.listApplications();
  const findByName = (name: string) => applications.find((app) => app.name === name);

  // ---------------------------------------------------------------- M2M app
  let m2m = findByName(M2M_NAME) as Application | undefined;
  if (!m2m) {
    m2m = await management.request<Application>('/api/applications', {
      method: 'POST',
      body: JSON.stringify({
        name: M2M_NAME,
        description: 'Telegram bot bridge (webhook notifications, binding, login links)',
        type: 'MachineToMachine',
      }),
    });
    console.log(`+ 创建 M2M 应用 ${M2M_NAME} (${m2m.id})`);
  } else {
    console.log(`= 复用 M2M 应用 ${M2M_NAME} (${m2m.id})`);
  }

  const roles = await management.listRoles();
  const managementRole = roles.find((role) => role.name === 'Logto Management API access');
  if (managementRole) {
    await management
      .request<void>(`/api/applications/${m2m.id}/roles`, {
        method: 'POST',
        body: JSON.stringify({ roleIds: [managementRole.id] }),
      })
      .catch((error: Error) => console.warn(`  角色授予失败（可能已存在）：${error.message}`));
    console.log(`  已授予角色：${managementRole.name}`);
  } else {
    console.warn('  未找到 `Logto Management API access` 角色，请手动授予');
  }

  // ------------------------------------------------------------ login app
  let loginApp = findByName(LOGIN_APP_NAME) as Application | undefined;
  if (!loginApp) {
    loginApp = await management.request<Application>('/api/applications', {
      method: 'POST',
      body: JSON.stringify({
        name: LOGIN_APP_NAME,
        description: 'Landing client for one-time login links (account center)',
        type: 'Traditional',
        oidcClientMetadata: {
          redirectUris: [config.logto.loginRedirectUri],
          postLogoutRedirectUris: [],
        },
      }),
    });
    console.log(`+ 创建登录落地应用 ${LOGIN_APP_NAME} (${loginApp.id}) → ${config.logto.loginRedirectUri}`);
  } else {
    console.log(`= 复用登录落地应用 ${LOGIN_APP_NAME} (${loginApp.id})`);
  }

  // -------------------------------------------------------------- webhook
  const hooks = await management.request<{ id: string; name: string; signingKey?: string }[]>('/api/hooks');
  const existingHook = hooks.find((hook) => hook.name === 'rurino-bot');
  const events = [
    'PostSignIn',
    'PostRegister',
    'PostResetPassword',
    'User.Created',
    'User.Data.Updated',
    'User.Deleted',
    'User.SuspensionStatus.Updated',
    'Identifier.Lockout',
    'TrustedDevice.Created',
    'TrustedDevice.Deleted',
    'Organization.Membership.Updated',
  ];

  if (!config.telegram.publicUrl) {
    console.log('! BOT_PUBLIC_URL 未设置，跳过 webhook 创建（设置后再跑一次本脚本）');
  } else if (existingHook) {
    console.log(`= 复用 webhook ${existingHook.id}`);
  } else {
    const hook = await management.request<{ id: string; signingKey: string }>('/api/hooks', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rurino-bot',
        events,
        config: { url: `${config.telegram.publicUrl.replace(/\/+$/, '')}/hooks/logto`, retries: 3 },
        enabled: true,
      }),
    });
    console.log(`+ 创建 webhook ${hook.id}`);
    console.log(`  LOGTO_WEBHOOK_SIGNING_KEY=${hook.signingKey}`);
  }

  console.log('\n把下面的值写入 .env：');
  console.log(`LOGTO_M2M_CLIENT_ID=${m2m.id}`);
  console.log(`LOGTO_M2M_CLIENT_SECRET=${m2m.secret ?? '(已存在，未返回，请在 Console 查看)'}`);
  console.log(`LOGIN_APP_CLIENT_ID=${loginApp.id}`);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
