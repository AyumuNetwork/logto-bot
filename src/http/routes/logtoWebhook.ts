import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../../config.js';
import type { Repo } from '../../db/repo.js';
import type { Logger } from '../../logger.js';
import type { LogtoManagement } from '../../logto/management.js';
import type { BindingService } from '../../services/binding.js';
import { planNotification, renderNotification, renderWelcome, type LogtoWebhookPayload } from '../../services/notifications.js';
import { verifyLogtoSignature } from '../../logto/webhookVerify.js';
import { eventBus } from '../../net/events.js';
import type { Outbox } from '../../telegram/send.js';

export type LogtoRouteDeps = {
  config: AppConfig;
  repo: Repo;
  logger: Logger;
  management: LogtoManagement;
  binding: BindingService;
  outbox: Outbox;
};

/** Events that can create or refresh a Telegram binding. */
const BINDING_EVENTS = new Set(['PostSignIn', 'PostRegister', 'User.Created', 'User.Data.Updated']);

export const sha256Hex = (input: Buffer | string): string =>
  createHash('sha256').update(input).digest('hex');

export const handleLogtoEvent = async (payload: LogtoWebhookPayload, deps: LogtoRouteDeps): Promise<void> => {
  const { repo, binding, outbox, logger } = deps;
  const logtoUserId = payload.user?.id ?? payload.userId;

  if (payload.event === 'User.Deleted' && logtoUserId) {
    const existing = repo.findByLogtoId(logtoUserId);
    binding.unbindByLogtoId(logtoUserId);
    if (existing) {
      outbox.enqueue(existing.tg_user_id, '🗑 你的 Logto 账号已删除，Telegram 绑定已解除。');
    }
    return;
  }

  let user = logtoUserId ? repo.findByLogtoId(logtoUserId) : undefined;
  let created = false;

  if (BINDING_EVENTS.has(payload.event)) {
    const outcome = await binding.applyWebhook(payload).catch((error: Error) => {
      logger.warn({ error: error.message, event: payload.event }, 'binding from webhook failed');
      return undefined;
    });
    if (outcome) {
      user = outcome.user;
      created = outcome.created;
    }
  }

  if (!user) {
    logger.debug({ event: payload.event, logtoUserId }, 'no bound telegram user for event');
    return;
  }

  if (created) {
    outbox.enqueue(user.tg_user_id, renderWelcome(user));
    eventBus.emit('binding', { tgUserId: user.tg_user_id, logtoUserId: user.logto_user_id, created: true });
  }

  const plan = planNotification(payload);
  if (plan.kind === 'none') {
    return;
  }

  const flags = repo.parseFlags(user);
  if (flags[plan.kind] === false) {
    logger.debug({ kind: plan.kind, tgUserId: user.tg_user_id }, 'notification disabled by user');
    return;
  }

  outbox.enqueue(user.tg_user_id, renderNotification(plan, user));
};

/**
 * Logto webhook receiver.
 *
 * Contract (https://docs.logto.io/developers/webhooks/secure-webhooks):
 *   header `logto-signature-sha-256` = hex(HMAC-SHA256(signingKey, raw body))
 * Always answer 2xx quickly, then process asynchronously; deliveries are
 * deduplicated by the SHA-256 of the raw body.
 */
export const registerLogtoWebhook = (app: FastifyInstance, deps: LogtoRouteDeps): void => {
  app.post('/hooks/logto', async (request, reply) => {
    const raw = (request as { rawBody?: Buffer }).rawBody;
    const signingKey = deps.config.logto.webhookSigningKey;

    if (!signingKey) {
      deps.logger.error('LOGTO_WEBHOOK_SIGNING_KEY is not configured');
      return reply.code(503).send({ error: 'signing key not configured' });
    }

    if (!raw) {
      return reply.code(400).send({ error: 'raw body unavailable' });
    }

    const valid = verifyLogtoSignature({
      signingKey,
      rawBody: raw,
      header: request.headers['logto-signature-sha-256'] as string | string[] | undefined,
    });

    if (!valid) {
      deps.logger.warn({ ip: request.ip }, 'rejected logto webhook with bad signature');
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const payload = request.body as LogtoWebhookPayload | undefined;
    if (!payload?.event) {
      return reply.code(400).send({ error: 'invalid payload' });
    }

    const dedupeKey = sha256Hex(raw);
    const inserted = deps.repo.recordEvent({
      dedupeKey,
      hookId: payload.hookId,
      event: payload.event,
      createdAtLogto: payload.createdAt,
      status: 'received',
      payload: raw.toString('utf8'),
    });

    if (!inserted) {
      deps.logger.debug({ event: payload.event, dedupeKey }, 'duplicate webhook delivery ignored');
      return reply.code(200).send({ ok: true, duplicate: true });
    }

    reply.code(200).send({ ok: true });
    eventBus.emit('logto_event', { event: payload.event, userId: payload.user?.id ?? payload.userId });

    setImmediate(() => {
      void handleLogtoEvent(payload, deps)
        .then(() => {
          try {
            deps.repo.updateEventStatus(dedupeKey, 'processed');
          } catch (error) {
            deps.logger.debug({ error: (error as Error).message }, 'could not persist event status');
          }
          eventBus.emit('logto_event', { event: payload.event, status: 'processed' });
        })
        .catch((error: Error) => {
          deps.logger.error({ error: error.message, event: payload.event }, 'logto event processing failed');
          try {
            deps.repo.updateEventStatus(dedupeKey, 'failed');
          } catch (updateError) {
            deps.logger.debug({ error: (updateError as Error).message }, 'could not persist event status');
          }
        });
    });
  });
};
