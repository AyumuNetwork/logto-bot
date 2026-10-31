import { Bot } from 'grammy';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { openDatabase, type Database } from '../../src/db/index.js';
import { Repo } from '../../src/db/repo.js';
import { createServer } from '../../src/http/server.js';
import { computeSignature } from '../../src/logto/webhookVerify.js';
import { BindingService } from '../../src/services/binding.js';
import { Outbox } from '../../src/telegram/send.js';
import type { LogtoManagement } from '../../src/logto/management.js';
import { createFakeTelegramFetch } from '../helpers/fakeTelegram.js';

const SIGNING_KEY = 'mode-test-key';

const baseEnv = {
  LOGTO_ENDPOINT: 'https://auth.haori.ink',
  LOGTO_WEBHOOK_SIGNING_KEY: SIGNING_KEY,
  TELEGRAM_BOT_TOKEN: '123456:TESTTOKEN',
  TELEGRAM_WEBHOOK_SECRET: 'tg-secret',
  DB_PATH: ':memory:',
} as NodeJS.ProcessEnv;

const logger = pino({ level: 'silent' });

describe('server transport modes', () => {
  let db: Database;
  let repo: Repo;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new Repo(db);
  });

  afterEach(() => {
    db.close();
  });

  const build = async (mode: 'webhook' | 'polling') => {
    const config = loadConfig({ ...baseEnv, TELEGRAM_MODE: mode } as NodeJS.ProcessEnv);
    const fake = createFakeTelegramFetch();
    const bot = new Bot('123456:TESTTOKEN', { client: { fetch: fake.fetch } });
    await bot.init();
    const outbox = new Outbox({ repo, bot, config, logger });
    const management = {
      getUser: async () => {
        throw new Error('unused');
      },
      getIdentity: async () => {
        throw new Error('unused');
      },
    } as unknown as LogtoManagement;
    const binding = new BindingService({
      config,
      repo,
      management,
      logger,
      defaultFlags: { signin: true },
    });
    const app = createServer({ config, repo, logger, management, binding, outbox, bot, telegramMode: mode });
    return { app, config };
  };

  it('registers /tg/webhook in webhook mode', async () => {
    const { app } = await build('webhook');
    const response = await app.inject({
      method: 'POST',
      url: '/tg/webhook',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'tg-secret' },
      payload: JSON.stringify({ update_id: 1 }),
    });
    // grammY rejects an update without a message/known field with 400, but the
    // route exists (not 404), which is what this test asserts.
    expect(response.statusCode).not.toBe(404);
    await app.close();
  });

  it('does not register /tg/webhook in polling mode', async () => {
    const { app } = await build('polling');
    const response = await app.inject({
      method: 'POST',
      url: '/tg/webhook',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'tg-secret' },
      payload: JSON.stringify({ update_id: 1 }),
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('keeps the logto webhook available in polling mode', async () => {
    const { app } = await build('polling');
    const raw = JSON.stringify({ event: 'PostSignIn', userId: 'u1' });
    const response = await app.inject({
      method: 'POST',
      url: '/hooks/logto',
      headers: {
        'content-type': 'application/json',
        'logto-signature-sha-256': computeSignature(SIGNING_KEY, raw),
      },
      payload: raw,
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
