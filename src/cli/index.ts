#!/usr/bin/env node
/**
 * Operator CLI. Shares the database and service layer with the bot process, so
 * `map set` here and `/map` in Telegram are the same write path (audited).
 *
 * Examples:
 *   pnpm cli groups list
 *   pnpm cli groups add -1001234567890 --title 主群
 *   pnpm cli map set status administrator Admins --chat -1001234567890
 *   pnpm cli signup --email a@example.com --ttl 3600 --json
 *   pnpm cli doctor
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Bot } from 'grammy';

import { loadConfig } from '../config.js';
import { loadLoginTargets } from '../config/apps.js';
import { createLogger } from '../logger.js';
import { openDatabase } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { LogtoManagement } from '../logto/management.js';
import { AdminAudit, CLI_ACTOR } from '../services/adminAudit.js';
import { RoleConfigStore } from '../services/roleConfigStore.js';
import { RoleResolver } from '../services/roles.js';
import { RoleSyncService, type TelegramMemberApi } from '../services/roleSync.js';
import { SignupService } from '../services/signup.js';
import { parseArgs, flagNumber, flagString, flagList, flagBool } from '../telegram/args.js';
import { createPlatformFetch } from '../telegram/bot.js';
import { createTelegramTransport } from '../net/transport.js';
import type { RoleSyncConfig } from '../services/roleSync.js';

const argv = process.argv.slice(2);
const [group, action, ...rest] = argv;
// `pnpm cli signup --list` puts the flag into `action`; merge it back so flag-only
// invocations parse like any other argument list.
const args = parseArgs([action?.startsWith('--') ? action : undefined, ...rest].filter(Boolean).join(' '));

const config = loadConfig();
const logger = createLogger({ ...config, runtime: { ...config.runtime, logLevel: 'silent' } });
const db = openDatabase(config.runtime.dbPath);
const repo = new Repo(db);
const management = new LogtoManagement({
  endpoint: config.logto.endpoint,
  clientId: config.logto.m2mClientId,
  clientSecret: config.logto.m2mClientSecret,
  resource: config.logto.managementResource,
  logger,
});
const targets = loadLoginTargets(resolve('config/apps.json'), logger);
const store = new RoleConfigStore({ repo, logger });
const audit = new AdminAudit(repo);
const resolver = new RoleResolver({ management, logger });
const signup = new SignupService({ config, repo, management, targets: () => targets, logger });

const transport = createTelegramTransport(config, logger);
const bot = new Bot(config.telegram.token, {
  client: { fetch: createPlatformFetch(transport.fetch) as never },
});
const memberApi: TelegramMemberApi = {
  getChatMember: async (chatId, userId) => {
    const member = await bot.api.getChatMember(chatId, userId);
    return {
      status: member.status,
      custom_title: 'custom_title' in member ? member.custom_title : undefined,
    };
  },
  getChatAdministrators: async (chatId) => {
    const admins = await bot.api.getChatAdministrators(chatId);
    return admins.map((admin) => ({
      user: { id: admin.user.id },
      status: admin.status,
      custom_title: 'custom_title' in admin ? admin.custom_title : undefined,
    }));
  },
};
const roles = new RoleSyncService({ store, repo, management, api: memberApi, logger });

const out = (value: unknown): void => {
  if (flagBool(args, 'json')) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === 'string') {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
};

const usage = (): void => {
  console.log(
    [
      '用法: pnpm cli <group> <action> [args]',
      '',
      'groups list | add <chatId> [--title] | enable <chatId> | disable <chatId> | remove <chatId>',
      'map list [--chat] | map set status <status> <role> [--chat] | map set title <title> <role> [--chat]',
      'map del status|title <key> [--chat]',
      'roles list',
      'users list [--limit] | users show <key> | users unbind <key>',
      'sync <chatId> [--apply]',
      'signup --email a,b [--ttl s] [--org id] [--json] | signup --list | signup --revoke <ottId>',
      'orgs list',
      'outbox stats|retry|purge',
      'events tail [-n 20]',
      'config export [--out file] | config import <file>',
      'doctor',
      '',
      '环境变量：TELEGRAM_PROXY_URL / LOGTO_PROXY_URL / TELEGRAM_MODE=polling / TELEGRAM_WS_RELAY',
    ].join('\n'),
  );
};

const chatIdArg = (): number | undefined => {
  const fromFlag = flagNumber(args, 'chat');
  if (fromFlag !== undefined) return fromFlag;
  const [first] = args.positional;
  return first && /^-?\d+$/.test(first) ? Number(first) : undefined;
};

const run = async (): Promise<number> => {
  switch (group) {
    case 'groups': {
      if (action === 'list' || action === undefined) {
        out(
          store.groups().map((row) => ({
            chatId: row.chat_id,
            title: row.title,
            enabled: row.enabled === 1,
            removeOnLeave: row.remove_on_leave === 1,
            mappings: store.mappings(row.chat_id).length,
          })),
        );
        return 0;
      }

      const chatId = chatIdArg();
      if (chatId === undefined) {
        console.error('需要 chatId');
        return 1;
      }

      if (action === 'add') {
        store.upsertGroup({ chatId, enabled: true, title: flagString(args, 'title') ?? null, actor: CLI_ACTOR });
        audit.record({ actor: CLI_ACTOR, action: 'group.create', target: chatId, detail: { via: 'cli' } });
        out(`✅ 已添加群 ${chatId}`);
        return 0;
      }
      if (action === 'enable' || action === 'disable') {
        store.upsertGroup({ chatId, enabled: action === 'enable', actor: CLI_ACTOR });
        audit.record({ actor: CLI_ACTOR, action: 'group.setEnabled', target: chatId, detail: { enabled: action === 'enable' } });
        out(`✅ 群 ${chatId} → ${action === 'enable' ? '启用' : '停用'}`);
        return 0;
      }
      if (action === 'remove') {
        const removed = store.removeGroup(chatId);
        audit.record({ actor: CLI_ACTOR, action: 'group.delete', target: chatId });
        out(removed ? `🗑 已删除群 ${chatId}` : '该群不存在');
        return 0;
      }
      usage();
      return 1;
    }

    case 'map': {
      if (action === 'list' || action === undefined) {
        const chatId = chatIdArg();
        out(
          store.mappings(chatId).map((row) => ({
            chatId: row.chat_id,
            kind: row.kind,
            key: row.key,
            roleId: row.role_id,
          })),
        );
        return 0;
      }

      const chatId = chatIdArg();
      if (chatId === undefined) {
        console.error('需要 --chat <chatId>');
        return 1;
      }

      if (action === 'set') {
        const [kind, key, ...roleParts] = args.positional.filter((value) => !/^-?\d+$/.test(value));
        const roleInput = flagString(args, 'role') ?? roleParts.join(' ');

        if (kind !== 'status' && kind !== 'title') {
          console.error('kind 必须是 status 或 title');
          return 1;
        }
        if (!key || !roleInput) {
          console.error('需要 key 与 role');
          return 1;
        }

        const resolved = await resolver.resolve(roleInput);
        if (!resolved.ok) {
          console.error(
            resolved.reason === 'ambiguous'
              ? `角色不唯一：${resolved.candidates.map((role) => `${role.name}(${role.id})`).join(', ')}`
              : `找不到角色 ${roleInput}`,
          );
          return 1;
        }

        if (!store.group(chatId)) {
          store.upsertGroup({ chatId, enabled: true, actor: CLI_ACTOR });
        }
        store.setMapping({ chatId, kind, key, roleId: resolved.role.id, actor: CLI_ACTOR });
        audit.record({ actor: CLI_ACTOR, action: 'map.set', target: chatId, detail: { kind, key, role: resolved.role.name } });
        out(`✅ ${chatId} ${kind}.${key} → ${resolved.role.name} (${resolved.role.id})`);
        return 0;
      }

      if (action === 'del') {
        const [kind, key] = args.positional.filter((value) => !/^-?\d+$/.test(value));
        if ((kind !== 'status' && kind !== 'title') || !key) {
          console.error('用法: map del status|title <key> --chat <id>');
          return 1;
        }
        const removed = store.deleteMapping(chatId, kind, key);
        audit.record({ actor: CLI_ACTOR, action: 'map.delete', target: chatId, detail: { kind, key } });
        out(removed ? '🗑 已删除' : '不存在');
        return 0;
      }

      usage();
      return 1;
    }

    case 'roles': {
      const list = await resolver.listUserRoles(true);
      out(list.map((role) => ({ id: role.id, name: role.name, isDefault: role.isDefault })));
      return 0;
    }

    case 'users': {
      if (action === 'list' || action === undefined) {
        const limit = flagNumber(args, 'limit') ?? 20;
        out(
          repo.listUsers(limit).map((user) => ({
            tgUserId: user.tg_user_id,
            username: user.tg_username,
            logtoUserId: user.logto_user_id,
            email: user.logto_email,
            source: user.bind_source,
          })),
        );
        return 0;
      }

      const key = args.positional[0];
      if (!key) {
        console.error('需要用户键（tgId/@username/email/logtoUserId）');
        return 1;
      }

      if (action === 'show') {
        const [user] = repo.searchUser(key);
        if (!user) {
          console.error('未找到');
          return 1;
        }
        const userRoles = user.logto_user_id
          ? await management.getUserRoles(user.logto_user_id).catch(() => [])
          : [];
        out({ ...user, roles: userRoles.map((role) => role.name) });
        return 0;
      }

      if (action === 'unbind') {
        const [user] = repo.searchUser(key);
        if (!user) {
          console.error('未找到');
          return 1;
        }
        repo.unbind(user.tg_user_id);
        audit.record({ actor: CLI_ACTOR, action: 'user.unbind', target: user.tg_user_id });
        out(`✅ 已解绑 ${user.tg_user_id}`);
        return 0;
      }

      usage();
      return 1;
    }

    case 'sync': {
      const chatId = chatIdArg();
      if (chatId === undefined) {
        console.error('需要 chatId');
        return 1;
      }

      const apply = flagBool(args, 'apply');
      if (!apply) {
        const groupConfig = store.group(chatId);
        const mappings = store.mappings(chatId);
        out({
          dryRun: true,
          chatId,
          configured: Boolean(groupConfig),
          enabled: groupConfig?.enabled === 1,
          mappings: mappings.map((row) => ({ kind: row.kind, key: row.key, roleId: row.role_id })),
          hint: '加 --apply 才会真正写入 Logto',
        });
        return 0;
      }

      const report = await roles.syncChat({ chatId, reason: 'cli:sync' });
      if (report === 'busy') {
        console.error('已有同步在进行');
        return 1;
      }
      audit.record({
        actor: CLI_ACTOR,
        action: 'sync.run',
        target: chatId,
        detail: { checked: report.checked, changed: report.changed.length, failed: report.failed.length },
      });
      out(report);
      return 0;
    }

    case 'signup': {
      if (flagBool(args, 'list')) {
        out(
          signup.list(10).map((row) => ({
            email: row.email,
            ottId: row.ott_id,
            strategy: row.strategy,
            expiresAt: row.expires_at,
            revoked: Boolean(row.revoked_at),
          })),
        );
        return 0;
      }

      const revokeId = flagString(args, 'revoke');
      if (revokeId) {
        const ok = await signup.revoke(revokeId);
        audit.record({ actor: CLI_ACTOR, action: 'signup.revoke', target: revokeId });
        out(ok ? '🗑 已撤销' : '未找到');
        return ok ? 0 : 1;
      }

      const emails = (flagString(args, 'email') ?? args.positional.join(','))
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      if (emails.length === 0) {
        console.error('用法: signup --email a@b.com[,c@d.com] [--ttl 3600] [--org <id>]');
        return 1;
      }

      const results = await signup.create({
        emails,
        ttl: flagNumber(args, 'ttl'),
        organizationIds: flagList(args, 'org'),
        actor: CLI_ACTOR,
      });
      audit.record({ actor: CLI_ACTOR, action: 'signup.create', detail: { emails } });
      out(results);
      return results.some((item) => item.error) ? 1 : 0;
    }

    case 'orgs': {
      out(await management.listOrganizations());
      return 0;
    }

    case 'outbox': {
      if (action === 'retry') {
        const count = repo.retryDeadOutbox();
        audit.record({ actor: CLI_ACTOR, action: 'outbox.retry', detail: { count } });
        out(`♻️ 重投 ${count} 条`);
        return 0;
      }
      if (action === 'purge') {
        const count = repo.purgeSentOutbox();
        audit.record({ actor: CLI_ACTOR, action: 'outbox.purge', detail: { count } });
        out(`🧹 清理 ${count} 条`);
        return 0;
      }
      out(repo.outboxStats());
      return 0;
    }

    case 'events': {
      out(repo.recentEvents(flagNumber(args, 'n') ?? 20));
      return 0;
    }

    case 'config': {
      if (action === 'export') {
        const json = JSON.stringify(store.exportJson(), null, 2);
        const outFile = flagString(args, 'out');
        if (outFile) {
          writeFileSync(resolve(outFile), json, 'utf8');
          audit.record({ actor: CLI_ACTOR, action: 'config.export', target: outFile });
          out(`✅ 已导出到 ${outFile}`);
        } else {
          console.log(json);
        }
        return 0;
      }

      if (action === 'import') {
        const file = args.positional[0];
        if (!file) {
          console.error('用法: config import <file>');
          return 1;
        }
        const parsed = JSON.parse(readFileSync(resolve(file), 'utf8')) as RoleSyncConfig;
        const counts = store.importJson(parsed, CLI_ACTOR);
        audit.record({ actor: CLI_ACTOR, action: 'config.import', target: file, detail: counts });
        out(`✅ 导入 ${counts.groups} 个群、${counts.mappings} 条映射`);
        return 0;
      }

      usage();
      return 1;
    }

    case 'doctor': {
      const checks: { name: string; ok: boolean; detail: string }[] = [];
      const add = (name: string, ok: boolean, detail: string): void => {
        checks.push({ name, ok, detail });
      };

      add('env', true, `endpoint=${config.logto.endpoint} idp=${config.logto.idpTarget}`);
      add('transport', true, `${config.telegram.mode} via ${transport.describe}`);
      add('db', true, `${config.runtime.dbPath} · users=${repo.countUsers()}`);

      try {
        const list = await management.listRoles();
        add('management api', true, `${list.length} roles`);
      } catch (error) {
        add('management api', false, (error as Error).message);
      }

      try {
        const startedAt = Date.now();
        const me = await bot.api.getMe();
        add('telegram bot', true, `@${me.username} (${Date.now() - startedAt}ms)`);
      } catch (error) {
        add('telegram bot', false, (error as Error).message);
      }

      if (config.telegram.relayUrl) {
        try {
          const info = await bot.api.getWebhookInfo();
          add('ws relay', true, `${config.telegram.relayUrl}${info.url ? ` (webhook set: ${info.url})` : ''}`);
        } catch (error) {
          add('ws relay', false, (error as Error).message);
        }
      }

      add('login targets', Object.keys(targets.targets).length > 0, Object.keys(targets.targets).join(', ') || '(none)');
      add('webhook signing key', Boolean(config.logto.webhookSigningKey), config.logto.webhookSigningKey ? 'set' : 'missing');
      add('telegram webhook url', Boolean(config.telegram.publicUrl), config.telegram.publicUrl ?? 'missing');
      add('role config', true, `groups=${store.groups().length} mappings=${store.mappings().length}`);

      if (flagBool(args, 'json')) {
        out(checks);
      } else {
        for (const check of checks) {
          console.log(`${check.ok ? '✅' : '❌'} ${check.name}: ${check.detail}`);
        }
      }

      return checks.every((check) => check.ok) ? 0 : 1;
    }

    default:
      usage();
      return 1;
  }
};

run()
  .then((code) => {
    transport.close();
    db.close();
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    transport.close();
    db.close();
    process.exit(1);
  });
