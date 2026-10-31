import { bootstrap } from '../src/app.js';

/**
 * Live smoke test: binds the Telegram chat that already logs in with Telegram,
 * then runs `/login` through the real update pipeline (real Bot API calls) and
 * verifies the produced Logto authorize URL is accepted by the tenant.
 *
 * Usage: node --env-file-if-exists=.env --import tsx scripts/smoke.ts <tgUserId>
 */
const TG_USER_ID = Number(process.argv[2] ?? 1558159309);
const TG_USERNAME = process.argv[3] ?? 'XieXiLin';

const main = async (): Promise<void> => {
  const instance = await bootstrap({ listen: false });
  const { bot, repo, logger, shutdown } = instance;

  logger.info({ tgUserId: TG_USER_ID }, 'smoke: binding via webhook payload');

  const binding = instance.binding;

  const logtoUserId = process.env.SMOKE_LOGTO_USER_ID ?? '58cf28ce-93eb-4eca-bd28-88e83ecc3e5a';
  const user = await instance.management.getUser(logtoUserId);
  const applied = await binding.applyWebhook({
    event: 'PostSignIn',
    userId: logtoUserId,
    user: { id: user.id, primaryEmail: user.primaryEmail ?? undefined, identities: user.identities },
    createdAt: new Date().toISOString(),
  });

  if (!applied) {
    console.error('❌ 未能从 Logto 用户解析出 Telegram 数字 id');
    await shutdown();
    process.exit(1);
  }

  console.log(`✅ 绑定：tg=${applied.user.tg_user_id} logto=${applied.user.logto_user_id} created=${applied.created}`);

  const update = {
    update_id: Math.floor(Date.now() / 1000),
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: TG_USER_ID, type: 'private' as const, first_name: TG_USERNAME },
      from: { id: TG_USER_ID, is_bot: false, first_name: TG_USERNAME, username: TG_USERNAME },
      text: '/login',
      entities: [{ type: 'bot_command' as const, offset: 0, length: 6 }],
    },
  };

  await bot.handleUpdate(update);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const [link] = repo.listLoginLinks(TG_USER_ID, 1);
  if (!link) {
    console.error('❌ 没有生成登录链接记录');
    await shutdown();
    process.exit(1);
  }

  console.log(`✅ 已发送 /login 消息：strategy=${link.strategy} expires=${new Date(link.expires_at * 1000).toISOString()}`);
  console.log(`   url=${link.url.slice(0, 110)}…`);

  const response = await fetch(link.url, { redirect: 'manual' });
  const location = response.headers.get('location') ?? '';
  console.log(`✅ 落地检查：HTTP ${response.status} → ${location.slice(0, 110)}`);

  const accepted = response.status >= 300 && response.status < 400 && location.includes('/sign-in');
  console.log(accepted ? '✅ 租户接受该授权请求（跳转登录/一次性令牌页）' : '⚠️ 未按预期跳转，请检查 client_id / redirect_uri');

  if (link.ott_id) {
    await instance.management.deleteOneTimeToken(link.ott_id).catch(() => undefined);
    console.log('🧹 已撤销测试用一次性令牌');
  }

  await shutdown();
  process.exit(accepted ? 0 : 2);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
