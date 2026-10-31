import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { Repo } from '../../src/db/repo.js';
import { LogtoManagement } from '../../src/logto/management.js';
import { buildAuthorizationUrl, LoginLinkService } from '../../src/services/loginLink.js';
import type { LoginTargets } from '../../src/config/apps.js';

const config = loadConfig({
  LOGTO_ENDPOINT: 'https://auth.haori.ink',
  LOGIN_APP_CLIENT_ID: 'loginapp',
  LOGIN_REDIRECT_URI: 'https://auth.haori.ink/',
  TELEGRAM_BOT_TOKEN: '123:abc',
  OTT_TTL: '600',
} as NodeJS.ProcessEnv);

const targets: LoginTargets = {
  defaultSlug: 'account',
  targets: {
    account: {
      label: 'Logto 账户中心',
      clientId: 'loginapp',
      redirectUri: 'https://auth.haori.ink/',
      scope: 'openid profile',
      mode: 'ott',
    },
    git: {
      label: 'GitLab',
      clientId: 'gitlabapp',
      redirectUri: 'https://git.haori.ink/users/auth/openid_connect/callback',
      scope: 'openid profile email',
      mode: 'ott',
    },
  },
};

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as never;

const setup = (hasEmail: boolean) => {
  const db = openDatabase(':memory:');
  const repo = new Repo(db);
  const management = {
    createOneTimeToken: vi.fn(async () => ({
      id: 'ott_1',
      email: 'user@example.com',
      token: 'SECRET_TOKEN',
      status: 'active' as const,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
    })),
    deleteOneTimeToken: vi.fn(async () => undefined),
  } as unknown as LogtoManagement;

  const service = new LoginLinkService({ config, repo, management, targets, logger });
  const user = repo.upsertBinding({
    tgUserId: 1558159309,
    logtoUserId: 'logto_user_1',
    email: hasEmail ? 'user@example.com' : null,
    source: 'auto',
    defaultFlags: { signin: true },
  }).row;

  return { repo, management, service, user };
};

describe('buildAuthorizationUrl', () => {
  it('builds a Logto authorize url with the one-time token', () => {
    const url = new URL(
      buildAuthorizationUrl({
        endpoint: 'https://auth.haori.ink',
        clientId: 'loginapp',
        redirectUri: 'https://auth.haori.ink/',
        scope: 'openid profile',
        state: 'state123',
        oneTimeToken: 'tok',
        loginHint: 'user@example.com',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://auth.haori.ink/oidc/auth');
    expect(url.searchParams.get('client_id')).toBe('loginapp');
    expect(url.searchParams.get('redirect_uri')).toBe('https://auth.haori.ink/');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('one_time_token')).toBe('tok');
    expect(url.searchParams.get('login_hint')).toBe('user@example.com');
    expect(url.searchParams.get('state')).toBe('state123');
  });

  it('generates a random state when omitted', () => {
    const a = new URL(
      buildAuthorizationUrl({ endpoint: 'https://x', clientId: 'c', redirectUri: 'https://r', scope: 'openid' }),
    );
    const b = new URL(
      buildAuthorizationUrl({ endpoint: 'https://x', clientId: 'c', redirectUri: 'https://r', scope: 'openid' }),
    );
    expect(a.searchParams.get('state')).not.toBe(b.searchParams.get('state'));
  });
});

describe('LoginLinkService', () => {
  it('issues a one-time link for users with an email', async () => {
    const { service, user, repo } = setup(true);
    const result = await service.issue({ user });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategy).toBe('ott');
    expect(result.url).toContain('one_time_token=SECRET_TOKEN');
    expect(result.url).toContain('login_hint=user%40example.com');
    expect(repo.listLoginLinks(user.tg_user_id)).toHaveLength(1);
  });

  it('degrades to direct social sign-in without an email', async () => {
    const { service, user, management } = setup(false);
    const result = await service.issue({ user });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategy).toBe('direct_sign_in');
    expect(result.url).toContain('direct_sign_in=social%3ATelegram');
    expect(result.url).not.toContain('one_time_token');
    expect(management.createOneTimeToken).not.toHaveBeenCalled();
  });

  it('rejects unknown slugs', async () => {
    const { service, user } = setup(true);
    const result = await service.issue({ user, slug: 'nope' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-target');
  });

  it('uses the per-slug client id', async () => {
    const { service, user } = setup(true);
    const result = await service.issue({ user, slug: 'git' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toContain('client_id=gitlabapp');
    expect(result.label).toBe('GitLab');
  });

  it('revokes the link and the Logto token', async () => {
    const { service, user, management, repo } = setup(true);
    const issued = await service.issue({ user });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const revoked = await service.revoke({ user, linkId: issued.linkId });
    expect(revoked).toBe(true);
    expect(management.deleteOneTimeToken).toHaveBeenCalledWith('ott_1');
    expect(repo.listLoginLinks(user.tg_user_id)[0]?.revoked_at).toBeGreaterThan(0);
  });
});
