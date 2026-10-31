import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { LoginTargets } from '../../src/config/apps.js';
import { openDatabase, type Database } from '../../src/db/index.js';
import { Repo } from '../../src/db/repo.js';
import { AdminAudit } from '../../src/services/adminAudit.js';
import { LoginLinkService } from '../../src/services/loginLink.js';
import { RoleConfigStore } from '../../src/services/roleConfigStore.js';
import { RoleResolver } from '../../src/services/roles.js';
import { RoleSyncService } from '../../src/services/roleSync.js';
import { SignupService } from '../../src/services/signup.js';
import { createBot } from '../../src/telegram/bot.js';
import { createFakeTelegramFetch } from '../helpers/fakeTelegram.js';
import type { LogtoManagement } from '../../src/logto/management.js';

const ADMIN_ID = 111;
const MEMBER_ID = 222;
const CHAT_ID = -1001234567890;

const config = loadConfig({
  LOGTO_ENDPOINT: 'https://auth.haori.ink',
  LOGIN_APP_CLIENT_ID: 'loginapp',
  LOGIN_REDIRECT_URI: 'https://auth.haori.ink/',
  TELEGRAM_BOT_TOKEN: '123456:TESTTOKEN',
  ADMIN_TG_IDS: String(ADMIN_ID),
  DB_PATH: ':memory:',
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

const logger = pino({ level: 'silent' });

const ROLES = [
  { id: 'role_admin', name: 'Admins', type: 'User' as const, isDefault: false },
  { id: 'role_member', name: 'External Users', type: 'User' as const, isDefault: true },
];

const groupUpdate = (text: string, fromId: number) => ({
  update_id: Math.floor(Math.random() * 100000),
  message: {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: CHAT_ID, type: 'supergroup' as const, title: 'Test Group' },
    from: { id: fromId, is_bot: false, first_name: `U${fromId}` },
    text,
    entities: [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }],
  },
});

const privateUpdate = (text: string, fromId: number) => ({
  update_id: Math.floor(Math.random() * 100000),
  message: {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: fromId, type: 'private' as const, first_name: `U${fromId}` },
    from: { id: fromId, is_bot: false, first_name: `U${fromId}` },
    text,
    entities: [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }],
  },
});

describe('admin + group configuration commands', () => {
  let db: Database;
  let repo: Repo;
  let store: RoleConfigStore;
  let bot: ReturnType<typeof createBot>['bot'];
  let calls: ReturnType<typeof createFakeTelegramFetch>['calls'];
  let assignRoles: ReturnType<typeof viFn>;

  function viFn() {
    const calls: unknown[][] = [];
    const fn = async (...args: unknown[]) => {
      calls.push(args);
      return undefined;
    };
    return Object.assign(fn, { calls });
  }

  beforeEach(async () => {
    db = openDatabase(':memory:');
    repo = new Repo(db);
    store = new RoleConfigStore({ repo, logger });
    const audit = new AdminAudit(repo);

    assignRoles = viFn();
    const management = {
      listRoles: async () => ROLES,
      getUserRoles: async () => [],
      assignRoles,
      removeRole: async () => undefined,
      createOneTimeToken: async (input: { email: string }) => ({
        id: 'ott_1',
        email: input.email,
        token: 'SECRET',
        status: 'active',
        createdAt: Date.now(),
        expiresAt: Date.now() + 600_000,
      }),
      deleteOneTimeToken: async () => undefined,
      listOrganizations: async () => [],
      getUser: async () => {
        throw new Error('unused');
      },
      getIdentity: async () => {
        throw new Error('unused');
      },
    } as unknown as LogtoManagement;

    const loginLink = new LoginLinkService({ config, repo, management, targets, logger });
    const resolver = new RoleResolver({ management, logger });
    const signup = new SignupService({ config, repo, management, targets: () => targets, logger });
    const roles = new RoleSyncService({
      store,
      repo,
      management,
      logger,
      requestDelayMs: 0,
      api: {
        getChatMember: async () => ({ status: 'member' }),
        getChatAdministrators: async () => [{ user: { id: ADMIN_ID }, status: 'creator' }],
      },
    });

    const fake = createFakeTelegramFetch({ chatMemberStatus: 'creator' });
    calls = fake.calls;

    const built = createBot(
      {
        config,
        repo,
        logger,
        management,
        loginLink,
        roles,
        store,
        audit,
        roleResolver: resolver,
        signup,
        targets: () => targets,
        reload: () => targets,
      },
      { fetch: fake.fetch },
    );
    bot = built.bot;
    await bot.init();
  });

  afterEach(() => {
    db.close();
  });

  const lastMessage = (): string => {
    const sends = calls.filter((call) => call.method === 'sendMessage');
    const last = sends[sends.length - 1];
    return String(last?.payload.text ?? '');
  };

  it('rejects /map for non-admins and writes nothing', async () => {
    await bot.handleUpdate(groupUpdate('/map status administrator Admins', MEMBER_ID));

    expect(lastMessage()).toContain('仅 Bot 管理员');
    expect(store.mappings(CHAT_ID)).toHaveLength(0);
    expect(repo.listAudit(5)).toHaveLength(0);
  });

  it('lets a bot admin enable a group and map a status to a role', async () => {
    await bot.handleUpdate(groupUpdate('/group on', ADMIN_ID));
    expect(store.group(CHAT_ID)?.enabled).toBe(1);

    await bot.handleUpdate(groupUpdate('/map status administrator Admins', ADMIN_ID));
    const mapping = store.mappings(CHAT_ID)[0];
    expect(mapping).toMatchObject({ kind: 'status', key: 'administrator', role_id: 'role_admin' });
    expect(lastMessage()).toContain('Admins');

    const audit = repo.listAudit(10).map((row) => row.action);
    expect(audit).toContain('group.create');
    expect(audit).toContain('map.set');
  });

  it('maps a custom title and reports ambiguity', async () => {
    await bot.handleUpdate(groupUpdate('/map title 核心成员 Admins', ADMIN_ID));
    expect(store.mappings(CHAT_ID).find((row) => row.kind === 'title')?.key).toBe('核心成员');

    // "s" matches both "Admins" and "External Users" -> ambiguous, must not write.
    await bot.handleUpdate(groupUpdate('/map status creator s', ADMIN_ID));
    expect(store.mappings(CHAT_ID).some((row) => row.key === 'creator')).toBe(false);
    expect(lastMessage()).toContain('多个匹配');
  });

  it('syncs mapped roles for bound administrators', async () => {
    repo.upsertBinding({
      tgUserId: ADMIN_ID,
      logtoUserId: 'logto_admin',
      email: 'admin@example.com',
      source: 'auto',
      defaultFlags: {},
    });

    await bot.handleUpdate(groupUpdate('/group on', ADMIN_ID));
    await bot.handleUpdate(groupUpdate('/map status creator Admins', ADMIN_ID));
    await bot.handleUpdate(groupUpdate('/sync', ADMIN_ID));

    expect(assignRoles.calls.length).toBeGreaterThan(0);
    expect(assignRoles.calls[0]?.[0]).toBe('logto_admin');
    expect(assignRoles.calls[0]?.[1]).toEqual(['role_admin']);
    expect(lastMessage()).toContain('同步完成');
  });

  it('generates a registration magic link for admins only', async () => {
    await bot.handleUpdate(privateUpdate('/signup newbie@example.com', MEMBER_ID));
    expect(lastMessage()).toContain('仅 Bot 管理员');
    expect(repo.listSignupLinks(5)).toHaveLength(0);

    await bot.handleUpdate(privateUpdate('/signup newbie@example.com --ttl 600', ADMIN_ID));
    expect(repo.listSignupLinks(5)).toHaveLength(1);
    const row = repo.listSignupLinks(1)[0]!;
    expect(row.url).toContain('https://auth.haori.ink/oidc/auth');
    expect(row.strategy).toBe('ott_register');
    // Telegram bodies are MarkdownV2 escaped, hence the backslashes.
    expect(lastMessage()).toContain('注册链接');
    expect(lastMessage()).toContain('newbie@example\\.com');
  });

  it('shows the admin panel and stats', async () => {
    await bot.handleUpdate(privateUpdate('/admin', ADMIN_ID));
    expect(lastMessage()).toContain('Admin 面板');
    await bot.handleUpdate(privateUpdate('/stats', MEMBER_ID));
    expect(lastMessage()).toContain('仅 Bot 管理员');
  });
});
