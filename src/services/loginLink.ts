import { randomBytes } from 'node:crypto';

import type { AppConfig } from '../config.js';
import type { LoginTarget, LoginTargets } from '../config/apps.js';
import type { Repo, UserRow } from '../db/repo.js';
import type { Logger } from '../logger.js';
import type { LogtoManagement } from '../logto/management.js';

export type LoginLinkResult =
  | {
      ok: true;
      url: string;
      strategy: 'ott' | 'direct_sign_in' | 'sso';
      expiresAt: number;
      ottId?: string;
      target: string;
      label: string;
      email?: string;
      linkId: number;
    }
  | { ok: false; reason: 'no-email' | 'not-configured' | 'unknown-target'; message: string };

/**
 * Resolve the account-center target: `config/apps.json` default first, then the
 * env fallback (LOGIN_APP_CLIENT_ID / LOGIN_REDIRECT_URI).
 */
export const resolveDefaultTarget = (
  config: AppConfig,
  targets: LoginTargets,
): LoginTarget | undefined => {
  const fromConfig = targets.targets[targets.defaultSlug];
  if (fromConfig) {
    return fromConfig;
  }

  if (config.logto.loginAppClientId) {
    return {
      label: 'Logto 账户中心',
      clientId: config.logto.loginAppClientId,
      redirectUri: config.logto.loginRedirectUri,
      scope: 'openid profile',
      mode: 'ott',
    };
  }

  return undefined;
};

export const buildAuthorizationUrl = (input: {
  endpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state?: string;
  oneTimeToken?: string;
  loginHint?: string;
  directSignIn?: string;
  prompt?: string;
}): string => {
  const url = new URL(`${input.endpoint}/oidc/auth`);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', input.scope);
  url.searchParams.set('state', input.state ?? randomBytes(16).toString('base64url'));
  if (input.oneTimeToken) url.searchParams.set('one_time_token', input.oneTimeToken);
  if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);
  if (input.directSignIn) url.searchParams.set('direct_sign_in', input.directSignIn);
  if (input.prompt) url.searchParams.set('prompt', input.prompt);
  return url.toString();
};

/**
 * Issues one-time login links.
 *
 * Verified on auth.haori.ink (2026-10-31): `POST /api/one-time-tokens` -> build
 * `/oidc/auth?...&one_time_token=...&login_hint=...`, redirect to
 * `https://auth.haori.ink/` and Logto lands the user in the Account Center
 * (`/account/security`) already signed in. The trailing `code` is ignored by
 * the account center, so no exchange is needed on our side.
 */
export class LoginLinkService {
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

  resolveTarget(slug?: string): LoginTarget | undefined {
    const targets = this.currentTargets();
    const key = slug ?? targets.defaultSlug;
    return targets.targets[key];
  }

  private defaultTarget(): LoginTarget | undefined {
    return resolveDefaultTarget(this.deps.config, this.currentTargets());
  }

  async issue(input: { user: UserRow; slug?: string }): Promise<LoginLinkResult> {
    const { config, repo, management, logger } = this.deps;
    const target = input.slug ? this.resolveTarget(input.slug) : this.defaultTarget();

    if (input.slug && !target) {
      const known = Object.keys(this.currentTargets().targets).join(', ') || '(none)';
      return {
        ok: false,
        reason: 'unknown-target',
        message: `未知平台 \`${input.slug}\`。可用：${known}`,
      };
    }

    if (!target) {
      return {
        ok: false,
        reason: 'not-configured',
        message: '尚未配置登录应用（LOGIN_APP_CLIENT_ID / config/apps.json）。',
      };
    }

    const email = input.user.logto_email ?? undefined;
    const base = {
      endpoint: config.logto.endpoint,
      clientId: target.clientId,
      redirectUri: target.redirectUri,
      scope: target.scope,
    };

    if (!email) {
      // No email -> Logto one-time tokens are impossible (Logto only supports
      // email identifiers). Degrade to a direct social sign-in shortcut.
      const url = buildAuthorizationUrl({
        ...base,
        directSignIn: `social:${config.logto.idpTarget}`,
      });
      const expiresAt = Math.floor(Date.now() / 1000) + config.logto.ottTtl;
      const link = repo.insertLoginLink({
        tgUserId: input.user.tg_user_id,
        logtoUserId: input.user.logto_user_id,
        email: null,
        strategy: 'direct_sign_in',
        url,
        expiresAt,
      });
      logger.info({ tgUserId: input.user.tg_user_id, target: input.slug ?? 'default' }, 'issued direct sign-in link');
      return {
        ok: true,
        url,
        strategy: 'direct_sign_in',
        expiresAt,
        target: input.slug ?? this.currentTargets().defaultSlug,
        label: target.label,
        linkId: link.id,
      };
    }

    const ott = await management.createOneTimeToken({ email, expiresIn: config.logto.ottTtl });
    const url = buildAuthorizationUrl({ ...base, oneTimeToken: ott.token, loginHint: email });
    const link = repo.insertLoginLink({
      tgUserId: input.user.tg_user_id,
      logtoUserId: input.user.logto_user_id,
      email,
      ottId: ott.id,
      strategy: 'ott',
      url,
      expiresAt: Math.floor(ott.expiresAt / 1000),
    });

    logger.info(
      { tgUserId: input.user.tg_user_id, target: input.slug ?? 'default', ottId: ott.id },
      'issued one-time login link',
    );

    return {
      ok: true,
      url,
      strategy: 'ott',
      expiresAt: Math.floor(ott.expiresAt / 1000),
      ottId: ott.id,
      target: input.slug ?? this.currentTargets().defaultSlug,
      label: target.label,
      email,
      linkId: link.id,
    };
  }

  async revoke(input: { user: UserRow; linkId: number }): Promise<boolean> {
    const { repo, management } = this.deps;
    const link = repo.findLoginLink(input.linkId, input.user.tg_user_id);
    if (!link) {
      return false;
    }

    repo.revokeLoginLink(input.linkId, input.user.tg_user_id);

    if (link.ott_id) {
      await management.deleteOneTimeToken(link.ott_id).catch(() => undefined);
    }

    return true;
  }
}
