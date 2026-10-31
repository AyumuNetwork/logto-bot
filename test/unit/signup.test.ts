import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { Repo } from '../../src/db/repo.js';
import { SignupService } from '../../src/services/signup.js';
import type { LoginTargets } from '../../src/config/apps.js';
import type { LogtoManagement } from '../../src/logto/management.js';

const config = loadConfig({
  LOGTO_ENDPOINT: 'https://auth.haori.ink',
  LOGIN_APP_CLIENT_ID: 'loginapp',
  LOGIN_REDIRECT_URI: 'https://auth.haori.ink/',
  TELEGRAM_BOT_TOKEN: '123:abc',
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
  },
};

const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as never;

const setup = () => {
  const db = openDatabase(':memory:');
  const repo = new Repo(db);
  const management = {
    createOneTimeToken: vi.fn(async (input: { email: string }) => ({
      id: `ott_${input.email}`,
      email: input.email,
      token: `tok_${input.email}`,
      status: 'active' as const,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    })),
    deleteOneTimeToken: vi.fn(async () => undefined),
  } as unknown as LogtoManagement;

  const service = new SignupService({ config, repo, management, targets, logger });
  return { service, management, repo };
};

describe('SignupService', () => {
  it('creates a registration token with interactionEvent=Register', async () => {
    const { service, management, repo } = setup();
    const [link] = await service.create({ emails: ['invite@example.com'], ttl: 3600, actor: 111 });

    expect(link?.error).toBeUndefined();
    expect(link?.url).toContain('one_time_token=tok_invite%40example.com');
    expect(link?.url).toContain('login_hint=invite%40example.com');

    expect(management.createOneTimeToken).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'invite@example.com', expiresIn: 3600, interactionEvent: 'Register' }),
    );

    const row = repo.listSignupLinks(1)[0];
    expect(row?.strategy).toBe('ott_register');
    expect(row?.context_json).toContain('"interactionEvent":"Register"');
  });

  it('passes jitOrganizationIds through', async () => {
    const { service, management } = setup();
    await service.create({ emails: ['a@b.co'], organizationIds: ['org_1', 'org_2'], actor: 1 });

    expect(management.createOneTimeToken).toHaveBeenCalledWith(
      expect.objectContaining({ jitOrganizationIds: ['org_1', 'org_2'] }),
    );
  });

  it('clamps ttl into 60..86400 and defaults to 3600', async () => {
    const { service, management } = setup();
    expect(service.normalizeTtl(undefined)).toBe(3600);
    expect(service.normalizeTtl(5)).toBe(60);
    expect(service.normalizeTtl(999_999)).toBe(86_400);

    await service.create({ emails: ['a@b.co'], ttl: 5, actor: 1 });
    expect(management.createOneTimeToken).toHaveBeenCalledWith(expect.objectContaining({ expiresIn: 60 }));
  });

  it('rejects bad emails and oversized batches', async () => {
    const { service, management } = setup();
    const [bad] = await service.create({ emails: ['not-an-email'], actor: 1 });
    expect(bad?.error).toContain('邮箱格式不正确');
    expect(management.createOneTimeToken).not.toHaveBeenCalled();

    const emails = Array.from({ length: 11 }, (_, index) => `u${index}@example.com`);
    const [tooMany] = await service.create({ emails, actor: 1 });
    expect(tooMany?.error).toContain('最多');
  });

  it('deduplicates emails', async () => {
    const { service, management } = setup();
    const result = await service.create({ emails: ['a@b.co', 'A@B.CO', ' a@b.co '], actor: 1 });
    expect(result).toHaveLength(1);
    expect(management.createOneTimeToken).toHaveBeenCalledTimes(1);
  });

  it('revokes locally and in Logto', async () => {
    const { service, management } = setup();
    const [link] = await service.create({ emails: ['a@b.co'], actor: 1 });
    const ok = await service.revoke(link!.ottId!);
    expect(ok).toBe(true);
    expect(management.deleteOneTimeToken).toHaveBeenCalledWith(link!.ottId);
  });
});
