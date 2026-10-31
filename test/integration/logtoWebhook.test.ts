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

const SIGNING_KEY = 'test-signing-key';

const config = loadConfig({
  LOGTO_ENDPOINT: 'https://auth.haori.ink',
  LOGTO_WEBHOOK_SIGNING_KEY: SIGNING_KEY,
  TELEGRAM_BOT_TOKEN: '123456:TESTTOKEN',
  TELEGRAM_WEBHOOK_SECRET: 'tg-secret',
  IDP_TARGET: 'Telegram',
  DB_PATH: ':memory:',
} as NodeJS.ProcessEnv);

const logger = pino({ level: 'silent' });

const signInPayload = {
  hookId: 'hook_1',
  event: 'PostSignIn',
  createdAt: '2026-10-31T02:00:00.000Z',
  userAgent: 'Mozilla/5.0',
  ip: '203.0.113.7',
  userId: 'logto_user_1',
  application: { id: 'app_1', name: 'GitLab', type: 'Traditional' },
  user: {
    id: 'logto_user_1',
    primaryEmail: 'user@example.com',
    username: 'tester',
    identities: {
      Telegram: {
        userId: '4893946124037248621',
        details: { rawData: { id: '1558159309', sub: '4893946124037248621', preferred_username: 'tester' } },
      },
    },
  },
};

describe('POST /hooks/logto', () => {
  let db: Database;
  let repo: Repo;
  let outbox: Outbox;
  let app: ReturnType<typeof createServer> | undefined;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new Repo(db);
    const bot = new Bot('123456:TESTTOKEN');
    outbox = new Outbox({ repo, bot, config, logger });
    const management = {
      getUser: async () => {
        throw new Error('not used');
      },
      getIdentity: async () => {
        throw new Error('not used');
      },
    } as unknown as LogtoManagement;
    const binding = new BindingService({
      config,
      repo,
      management,
      logger,
      defaultFlags: { signin: true, password: true, security: true, account: true },
    });

    app = createServer({ config, repo, logger, management, binding, outbox, bot });
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  const post = async (payload: unknown, options: { signature?: string } = {}) => {
    const raw = JSON.stringify(payload);
    return app!.inject({
      method: 'POST',
      url: '/hooks/logto',
      headers: {
        'content-type': 'application/json',
        'logto-signature-sha-256': options.signature ?? computeSignature(SIGNING_KEY, raw),
      },
      payload: raw,
    });
  };

  const flush = () => new Promise((resolve) => setTimeout(resolve, 150));

  it('rejects an invalid signature', async () => {
    const response = await post(signInPayload, { signature: 'deadbeef' });
    expect(response.statusCode).toBe(401);
  });

  it('binds the user and queues a welcome + sign-in notification once', async () => {
    const response = await post(signInPayload);
    expect(response.statusCode).toBe(200);
    await flush();

    const user = repo.findByLogtoId('logto_user_1');
    expect(user?.tg_user_id).toBe(1558159309);
    expect(user?.logto_email).toBe('user@example.com');

    const queued = repo.claimDue(10);
    expect(queued).toHaveLength(2);
    const texts = queued.map((row) => JSON.parse(row.payload).text as string);
    expect(texts.some((text) => text.includes('已绑定'))).toBe(true);
    expect(texts.some((text) => text.includes('新的登录'))).toBe(true);
  });

  it('ignores duplicate deliveries of the same body', async () => {
    const first = await post(signInPayload);
    await flush();
    const second = await post(signInPayload);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, duplicate: true });
    await flush();
    expect(repo.claimDue(10)).toHaveLength(2);
  });

  it('skips notifications disabled by the user', async () => {
    repo.upsertBinding({
      tgUserId: 1558159309,
      logtoUserId: 'logto_user_1',
      email: 'user@example.com',
      source: 'auto',
      defaultFlags: { signin: false, password: true, security: true, account: true },
    });

    await post(signInPayload);
    await flush();
    expect(repo.claimDue(10)).toHaveLength(0);
  });

  it('unbinds when the account is deleted', async () => {
    repo.upsertBinding({
      tgUserId: 1558159309,
      logtoUserId: 'logto_user_1',
      email: 'user@example.com',
      source: 'auto',
      defaultFlags: { signin: true },
    });

    const response = await post({
      hookId: 'hook_1',
      event: 'User.Deleted',
      createdAt: '2026-10-31T02:00:00.000Z',
      userId: 'logto_user_1',
      data: null,
    });

    expect(response.statusCode).toBe(200);
    await flush();
    expect(repo.findByLogtoId('logto_user_1')).toBeUndefined();
  });
});
