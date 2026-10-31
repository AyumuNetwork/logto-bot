import type { AppConfig } from '../config.js';
import type { LoginTargets } from '../config/apps.js';
import type { LoginLinkRow, Repo } from '../db/repo.js';
import type { Logger } from '../logger.js';
import type { LogtoManagement, OneTimeTokenResponse } from '../logto/management.js';
import { buildAuthorizationUrl, resolveDefaultTarget } from './loginLink.js';

export type SignupLink = {
  email: string;
  url?: string;
  expiresAt?: number;
  ottId?: string;
  error?: string;
};

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_SIGNUP_BATCH = 10;
export const MIN_TTL = 60;
export const MAX_TTL = 86_400;

/**
 * Registration ("invite") magic links.
 *
 * Logto one-time tokens accept `context.interactionEvent = 'Register'` and
 * `context.jitOrganizationIds`, so a single token can both pull a brand-new user
 * through the registration flow and provision them into organizations.
 * Verified against auth.haori.ink: `POST /api/one-time-tokens` returns the token
 * which is then appended to the `rurino-login` authorize URL.
 */
export class SignupService {
  constructor(
    private readonly deps: {
      config: AppConfig;
      repo: Repo;
      management: LogtoManagement;
      targets: LoginTargets | (() => LoginTargets);
      logger: Logger;
    },
  ) {}

  private currentTargets(): LoginTargets {
    const { targets } = this.deps;
    return typeof targets === 'function' ? targets() : targets;
  }

  normalizeTtl(ttl?: number): number {
    if (!ttl || Number.isNaN(ttl)) {
      return 3600;
    }
    return Math.min(MAX_TTL, Math.max(MIN_TTL, Math.trunc(ttl)));
  }

  async create(input: {
    emails: string[];
    ttl?: number;
    organizationIds?: string[];
    actor: number;
  }): Promise<SignupLink[]> {
    const { config, repo, management, logger } = this.deps;
    const emailList = [...new Set(input.emails.map((email) => email.trim().toLowerCase()))].filter(
      Boolean,
    );

    if (emailList.length === 0) {
      return [{ email: '', error: '没有提供邮箱' }];
    }
    if (emailList.length > MAX_SIGNUP_BATCH) {
      return [{ email: '', error: `一次最多 ${MAX_SIGNUP_BATCH} 个邮箱` }];
    }

    const invalid = emailList.filter((email) => !EMAIL_PATTERN.test(email));
    if (invalid.length > 0) {
      return [{ email: '', error: `邮箱格式不正确：${invalid.join(', ')}` }];
    }

    const target = resolveDefaultTarget(config, this.currentTargets());
    if (!target) {
      return [{ email: '', error: '尚未配置登录落地应用（LOGIN_APP_CLIENT_ID / config/apps.json）' }];
    }

    const expiresIn = this.normalizeTtl(input.ttl);
    const results: SignupLink[] = [];

    for (const email of emailList) {
      try {
        const ott: OneTimeTokenResponse = await management.createOneTimeToken({
          email,
          expiresIn,
          interactionEvent: 'Register',
          jitOrganizationIds: input.organizationIds,
        });

        const url = buildAuthorizationUrl({
          endpoint: config.logto.endpoint,
          clientId: target.clientId,
          redirectUri: target.redirectUri,
          scope: target.scope,
          oneTimeToken: ott.token,
          loginHint: email,
        });

        repo.insertLoginLink({
          tgUserId: input.actor,
          email,
          ottId: ott.id,
          strategy: 'ott_register',
          url,
          expiresAt: Math.floor(ott.expiresAt / 1000),
          contextJson: JSON.stringify({
            interactionEvent: 'Register',
            jitOrganizationIds: input.organizationIds ?? [],
            target: target.label,
          }),
        });

        logger.info(
          { email, ottId: ott.id, actor: input.actor, orgs: input.organizationIds?.length ?? 0 },
          'created registration magic link',
        );

        results.push({ email, url, expiresAt: Math.floor(ott.expiresAt / 1000), ottId: ott.id });
      } catch (error) {
        const message = (error as Error).message;
        logger.warn({ email, error: message }, 'failed to create registration link');
        results.push({ email, error: message });
      }
    }

    return results;
  }

  async revoke(ottId: string): Promise<boolean> {
    const { repo, management } = this.deps;
    const link = repo.findLoginLinkByOttId(ottId);
    if (!link) {
      return false;
    }
    repo.revokeLoginLink(link.id, link.tg_user_id);
    await management.deleteOneTimeToken(ottId).catch(() => undefined);
    return true;
  }

  list(limit = 10): LoginLinkRow[] {
    return this.deps.repo.listSignupLinks(limit);
  }
}
