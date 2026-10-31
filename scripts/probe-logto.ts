import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { LogtoManagement } from '../src/logto/management.js';
import { extractIdentity } from '../src/services/identity.js';
import { buildAuthorizationUrl } from '../src/services/loginLink.js';

/**
 * Read-only self check for the Logto side of the bot.
 *
 * Verifies, in order:
 *   1. environment parses
 *   2. Management API token (client_credentials) works
 *   3. users are readable and a Telegram identity can be resolved
 *   4. one-time tokens can be created and deleted
 *   5. roles are readable
 *
 * It never prints secrets: tokens are shown truncated.
 */
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

  const results: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name}: ${detail}`);
  };

  check('env', true, `endpoint=${config.logto.endpoint} idp=${config.logto.idpTarget}`);

  let tokenOk = false;
  try {
    const users = await management.request<{ id: string }[]>('/api/users?page=1&page_size=1');
    tokenOk = Array.isArray(users);
    check('management token', tokenOk, `GET /api/users -> ${users.length} row(s)`);
  } catch (error) {
    check('management token', false, (error as Error).message);
    process.exit(1);
  }

  const users = await management.request<
    { id: string; username?: string; primaryEmail?: string; identities?: Record<string, unknown> }[]
  >('/api/users?page=1&page_size=100');

  let identityChecked = false;
  for (const user of users) {
    const identities = user.identities as Parameters<typeof extractIdentity>[0];
    const identity = extractIdentity(identities, config.logto.idpTarget);
    if (identity?.tgUserId) {
      console.log(
        `   ↳ ${user.username ?? user.id}: tgUserId=${identity.tgUserId} sub=${identity.socialUserId} phone=${identity.phone ?? '-'}`,
      );
      identityChecked = true;
      break;
    }
  }
  check('telegram identity', identityChecked, identityChecked ? 'rawData.id present' : `no user with ${config.logto.idpTarget} identity`);

  const target = users.find((user) => Boolean(user.primaryEmail));
  if (target?.primaryEmail) {
    try {
      const ott = await management.createOneTimeToken({ email: target.primaryEmail, expiresIn: 120 });
      const url = buildAuthorizationUrl({
        endpoint: config.logto.endpoint,
        clientId: config.logto.loginAppClientId ?? 'MISSING',
        redirectUri: config.logto.loginRedirectUri,
        scope: 'openid profile',
        oneTimeToken: ott.token,
        loginHint: target.primaryEmail,
      });
      console.log(`   ↳ sample link: ${url.slice(0, 120)}…`);
      await management.deleteOneTimeToken(ott.id);
      check('one-time token', true, `created ${ott.id} then deleted`);
    } catch (error) {
      check('one-time token', false, (error as Error).message);
    }
  } else {
    check('one-time token', false, 'no user with an email address');
  }

  try {
    const roles = await management.listRoles();
    check('roles', true, roles.map((role) => role.name).join(', '));
  } catch (error) {
    check('roles', false, (error as Error).message);
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`}`);
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
