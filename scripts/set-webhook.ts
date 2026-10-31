import { loadConfig } from '../src/config.js';

/**
 * Register the Telegram webhook. Requires TELEGRAM_BOT_TOKEN and BOT_PUBLIC_URL.
 * `allowed_updates` must include `chat_member` for group role sync.
 */
const main = async (): Promise<void> => {
  const config = loadConfig();
  const publicUrl = config.telegram.publicUrl;

  if (!publicUrl) {
    console.error('BOT_PUBLIC_URL 未设置');
    process.exit(1);
  }

  const url = `${publicUrl.replace(/\/+$/, '')}/tg/webhook`;
  const body: Record<string, unknown> = {
    url,
    allowed_updates: ['message', 'callback_query', 'chat_member', 'my_chat_member'],
  };
  if (config.telegram.webhookSecret) {
    body.secret_token = config.telegram.webhookSecret;
  }

  const response = await fetch(`https://api.telegram.org/bot${config.telegram.token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as { ok: boolean; description?: string };
  if (!payload.ok) {
    console.error(`setWebhook 失败：${payload.description ?? 'unknown error'}`);
    process.exit(1);
  }

  console.log(`✅ webhook 已设置：${url}`);

  const info = await fetch(`https://api.telegram.org/bot${config.telegram.token}/getWebhookInfo`);
  const infoPayload = (await info.json()) as { result?: Record<string, unknown> };
  console.log(JSON.stringify(infoPayload.result, null, 2));
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
