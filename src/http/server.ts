import Fastify, { type FastifyInstance } from 'fastify';
import type { Bot } from 'grammy';
import { webhookCallback } from 'grammy';

import type { AppConfig } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { Logger } from '../logger.js';
import { registerLogtoWebhook, type LogtoRouteDeps } from './routes/logtoWebhook.js';

export type ServerDeps = LogtoRouteDeps & {
  bot: Bot;
  /** `polling` skips the Telegram webhook route (updates arrive via getUpdates). */
  telegramMode?: 'webhook' | 'polling';
};

const BODY_LIMIT = 256 * 1024;

export const createServer = (deps: ServerDeps): FastifyInstance => {
  const app = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: BODY_LIMIT,
    trustProxy: true,
  }) as unknown as FastifyInstance;

  // Keep the raw payload so the Logto HMAC can be verified byte-for-byte.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    (request as { rawBody?: Buffer }).rawBody = body as Buffer;
    try {
      const parsed = (body as Buffer).length === 0 ? {} : JSON.parse((body as Buffer).toString('utf8'));
      done(null, parsed);
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  // grammY throws if a webhook handler is created while the bot is already
  // long-polling, so the callback is only built in webhook mode.
  if (deps.telegramMode !== 'polling') {
    const telegramHandler = webhookCallback(deps.bot, 'fastify', {
      secretToken: deps.config.telegram.webhookSecret,
      timeoutMilliseconds: 30_000,
    });
    app.post('/tg/webhook', telegramHandler as never);
  }

  registerLogtoWebhook(app, deps);

  app.get('/healthz', async () => ({
    ok: true,
    users: deps.repo.countUsers(),
    dryRun: deps.config.runtime.dryRun,
  }));

  return app;
};

export type { AppConfig, Repo };
