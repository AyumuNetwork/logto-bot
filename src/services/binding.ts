import type { AppConfig } from '../config.js';
import type { NotifyFlags, Repo, UserRow } from '../db/repo.js';
import type { Logger } from '../logger.js';
import type { LogtoManagement, LogtoUser } from '../logto/management.js';
import { extractIdentity, type IdentityDetails } from './identity.js';
import type { LogtoWebhookPayload } from './notifications.js';

export type BindOutcome = {
  user: UserRow;
  created: boolean;
  identity: IdentityDetails;
};

/**
 * Binds a Logto user to a Telegram chat using the social identity stored by the
 * OIDC connector. The Telegram numeric id lives in `details.rawData.id` and is
 * exactly the private chat id, so no deep link or code is needed.
 */
export class BindingService {
  constructor(
    private readonly deps: {
      config: AppConfig;
      repo: Repo;
      management: LogtoManagement;
      logger: Logger;
      defaultFlags: NotifyFlags;
    },
  ) {}

  private async loadIdentities(logtoUserId: string): Promise<LogtoUser['identities'] | undefined> {
    try {
      const user = await this.deps.management.getUser(logtoUserId);
      return user.identities;
    } catch (error) {
      this.deps.logger.warn({ logtoUserId, error: (error as Error).message }, 'failed to read logto user');
      return undefined;
    }
  }

  private async loadIdentityFallback(logtoUserId: string): Promise<IdentityDetails | undefined> {
    const { config, management, logger } = this.deps;
    try {
      const response = await management.getIdentity(logtoUserId, config.logto.idpTarget);
      const details = response.identity.details ?? {};
      return extractIdentity(
        { [config.logto.idpTarget]: { userId: response.identity.userId, details } },
        config.logto.idpTarget,
      );
    } catch (error) {
      logger.debug({ logtoUserId, error: (error as Error).message }, 'identity fallback failed');
      return undefined;
    }
  }

  /**
   * Resolve the Telegram chat id for a Logto user.
   * Order: webhook payload -> Management API user -> Management API identity.
   */
  async resolveIdentity(payload: LogtoWebhookPayload): Promise<{
    logtoUserId: string;
    email?: string;
    identity?: IdentityDetails;
  } | undefined> {
    const logtoUserId = payload.user?.id ?? payload.userId;
    if (!logtoUserId) {
      return undefined;
    }

    const email = payload.user?.primaryEmail ?? undefined;

    const fromPayload = extractIdentity(payload.user?.identities, this.deps.config.logto.idpTarget);
    if (fromPayload?.tgUserId) {
      return { logtoUserId, email, identity: fromPayload };
    }

    const identities = await this.loadIdentities(logtoUserId);
    const fromApi = extractIdentity(identities, this.deps.config.logto.idpTarget);
    if (fromApi?.tgUserId) {
      return { logtoUserId, email, identity: fromApi };
    }

    const fallback = await this.loadIdentityFallback(logtoUserId);
    return { logtoUserId, email, identity: fallback };
  }

  /** Apply a webhook delivery to the binding table (idempotent). */
  async applyWebhook(payload: LogtoWebhookPayload): Promise<BindOutcome | undefined> {
    const resolved = await this.resolveIdentity(payload);
    if (!resolved?.identity?.tgUserId) {
      this.deps.logger.debug(
        { event: payload.event, logtoUserId: resolved?.logtoUserId },
        'no telegram identity on logto user, nothing to bind',
      );
      return undefined;
    }

    const { row, created } = this.deps.repo.upsertBinding({
      tgUserId: resolved.identity.tgUserId,
      tgUsername: resolved.identity.username ?? null,
      logtoUserId: resolved.logtoUserId,
      email: resolved.email ?? null,
      source: 'auto',
      defaultFlags: this.deps.defaultFlags,
    });

    this.deps.logger.info(
      { tgUserId: row.tg_user_id, logtoUserId: row.logto_user_id, created },
      'binding applied from logto webhook',
    );

    return { user: row, created, identity: resolved.identity };
  }

  /** Remove the binding when Logto reports the account as deleted. */
  unbindByLogtoId(logtoUserId: string): boolean {
    const row = this.deps.repo.findByLogtoId(logtoUserId);
    if (!row) {
      return false;
    }
    const removed = this.deps.repo.unbind(row.tg_user_id);
    this.deps.logger.info({ tgUserId: row.tg_user_id, logtoUserId }, 'binding removed');
    return removed;
  }
}
