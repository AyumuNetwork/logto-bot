import { InputFile } from 'grammy';
import type { Bot, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';

import { escapeMarkdown } from '../esc.js';
import { parseArgs, flagList, flagNumber, flagString, flagBool } from '../args.js';
import { formatTime, replyMarkdown as reply, requireBotAdmin, type AppServices } from '../context.js';

const MAX_BROADCAST = 5000;

const panelKeyboard = (): InlineKeyboard =>
  new InlineKeyboard()
    .text('📊 概览', 'adm:stats')
    .text('👥 群组', 'adm:groups')
    .row()
    .text('📬 队列', 'adm:outbox')
    .text('📜 事件', 'adm:events')
    .row()
    .text('🧾 审计', 'adm:audit')
    .text('⛔ 关闭', 'adm:close');

/**
 * Admin surface: diagnostics, user lookup, manual role grants, queue/event
 * inspection, config reload and registration magic links.
 * Every command here is restricted to ADMIN_TG_IDS.
 */
export const registerAdminCommands = (bot: Bot, services: AppServices): void => {
  const { repo, config, outbox, audit, roleResolver, signup, store, logger, management } = services;

  const statsText = (): string => {
    const since = Math.floor(Date.now() / 1000) - 86_400;
    const events = repo.countEventsSince(since);
    const breakdown = repo
      .eventBreakdownSince(since, 5)
      .map((row) => `${row.event}:${row.count}`)
      .join('、');
    const queue = repo.outboxStats();

    return [
      '📊 *运行状态*',
      `• Bot：@${escapeMarkdown(bot.botInfo.username)}`,
      `• 已绑定用户：${repo.countUsers()}`,
      `• 24h 事件：${events}${breakdown ? `（${escapeMarkdown(breakdown)}）` : ''}`,
      `• 队列：pending ${queue.pending} / dead ${queue.dead} / sent ${queue.sent}`,
      queue.oldestPendingAt ? `• 最老待发：${escapeMarkdown(formatTime(queue.oldestPendingAt))}` : undefined,
      `• 群组配置：${store.groups().length} 个（版本 ${store.version()}）`,
      `• Logto：${escapeMarkdown(config.logto.endpoint)}`,
      `• 身份目标：${escapeMarkdown(config.logto.idpTarget)}`,
      `• OTT 有效期：${config.logto.ottTtl}s`,
      `• 管理员：${config.telegram.adminIds.join(', ') || '未配置'}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
  };

  const groupsText = (): string => {
    const groups = store.groups();
    if (groups.length === 0) {
      return '👥 还没有群组配置。\n在群里发 `/group on`。';
    }
    return [
      '👥 *群组配置*',
      ...groups.map((group) => {
        const mappings = store.mappings(group.chat_id).length;
        return `• \`${group.chat_id}\`${group.title ? ` (${escapeMarkdown(group.title)})` : ''} · ${group.enabled ? '启用' : '停用'} · ${mappings} 条映射`;
      }),
    ].join('\n');
  };

  const outboxText = (): string => {
    const queue = repo.outboxStats();
    return [
      '📬 *发送队列*',
      `• pending：${queue.pending}`,
      `• dead：${queue.dead}`,
      `• sent（未清理）：${queue.sent}`,
      '`/outbox retry` 重投 dead，`/outbox purge` 清理 sent',
    ].join('\n');
  };

  const eventsText = (limit: number): string => {
    const rows = repo.recentEvents(limit);
    if (rows.length === 0) {
      return '📜 暂无事件。';
    }
    return [
      '📜 *最近事件*',
      ...rows.map(
        (row) =>
          `• \`${escapeMarkdown(formatTime(row.received_at))}\` ${escapeMarkdown(row.event)} · ${escapeMarkdown(row.status)}`,
      ),
    ].join('\n');
  };

  const auditText = (): string => {
    const rows = audit.recent(12);
    if (rows.length === 0) {
      return '🧾 暂无审计记录。';
    }
    return [
      '🧾 *最近审计*',
      ...rows.map((row) => {
        const actor = row.actor_tg_id === 0 ? 'CLI' : String(row.actor_tg_id);
        return `• \`${escapeMarkdown(formatTime(row.at))}\` ${escapeMarkdown(actor)} · ${escapeMarkdown(row.action)}${row.target ? ` → ${escapeMarkdown(row.target)}` : ''}`;
      }),
    ].join('\n');
  };

  bot.command('admin', async (ctx) => {
    if (!(await requireBotAdmin(ctx, services))) return;
    await reply(ctx, `🛠 *Admin 面板*\n${statsText()}`, panelKeyboard());
  });

  bot.command('stats', async (ctx) => {
    if (!(await requireBotAdmin(ctx, services))) return;
    await reply(ctx, statsText());
  });

  bot.command('user', async (ctx) => {
    if (!(await requireBotAdmin(ctx, services))) return;

    const [key] = parseArgs(ctx.match).positional;
    if (!key) {
      await reply(ctx, '用法：`/user <tgId|@username|email|logtoUserId>`');
      return;
    }

    const [user] = repo.searchUser(key);
    if (!user) {
      await reply(ctx, '没有找到该用户（只查已绑定用户）。');
      return;
    }

    const roles = user.logto_user_id
      ? await management.getUserRoles(user.logto_user_id).catch(() => [])
      : [];
    const flags = repo.parseFlags(user);

    await reply(
      ctx,
      [
        '🔍 *用户*',
        `• Telegram：\`${user.tg_user_id}\`${user.tg_username ? ` (@${escapeMarkdown(user.tg_username)})` : ''}`,
        `• Logto：\`${escapeMarkdown(user.logto_user_id ?? '未绑定')}\``,
        `• 邮箱：${escapeMarkdown(user.logto_email ?? '无')}`,
        `• 绑定来源：${escapeMarkdown(user.bind_source)} · ${escapeMarkdown(formatTime(user.bound_at))}`,
        `• 投递：${user.notify_blocked ? '被阻止' : '正常'}`,
        `• 通知：${escapeMarkdown(Object.entries(flags).filter(([, on]) => on).map(([kind]) => kind).join(', ') || '无')}`,
        `• 角色：${roles.map((role) => escapeMarkdown(role.name)).join(', ') || '无'}`,
      ].join('\n'),
    );
  });

  const changeRoles = async (ctx: Context, action: 'grant' | 'revoke'): Promise<void> => {
    if (!(await requireBotAdmin(ctx, services))) return;

    const args = parseArgs(ctx.match);
    const [roleInput, userKey] = args.positional;
    if (!roleInput || !userKey) {
      await reply(ctx, `用法：\`/${action} <角色名> <tgId|@username|email>\``);
      return;
    }

    const resolved = await roleResolver.resolve(roleInput);
    if (!resolved.ok) {
      await reply(
        ctx,
        resolved.reason === 'ambiguous'
          ? `角色不唯一：${resolved.candidates.map((role) => `${role.name}(\`${role.id}\`)`).join('、')}`
          : '没有找到该角色，用 /roles 查看。',
      );
      return;
    }

    const [user] = repo.searchUser(userKey);
    if (!user?.logto_user_id) {
      await reply(ctx, '没有找到该绑定用户。');
      return;
    }

    const before = (await management.getUserRoles(user.logto_user_id).catch(() => [])).map((role) => role.id);

    if (action === 'grant') {
      await management.assignRoles(user.logto_user_id, [resolved.role.id]);
    } else {
      await management.removeRole(user.logto_user_id, resolved.role.id);
    }

    repo.logRoleSync({
      chatId: 0,
      tgUserId: user.tg_user_id,
      logtoUserId: user.logto_user_id,
      before,
      after: action === 'grant' ? [...new Set([...before, resolved.role.id])] : before.filter((id) => id !== resolved.role.id),
      reason: `manual:${action}`,
    });
    audit.record({
      actor: ctx.from!.id,
      action: `role.${action}`,
      target: user.tg_user_id,
      detail: { role: resolved.role.name, roleId: resolved.role.id },
    });

    await reply(ctx, `✅ 已${action === 'grant' ? '授予' : '移除'}角色 *${escapeMarkdown(resolved.role.name)}* → \`${user.tg_user_id}\``);
  };

  bot.command('grant', (ctx) => changeRoles(ctx, 'grant'));
  bot.command('revoke', (ctx) => changeRoles(ctx, 'revoke'));

  bot.command('events', async (ctx) => {
    if (!(await requireBotAdmin(ctx, services))) return;
    const limit = flagNumber(parseArgs(ctx.match), 'n') ?? 10;
    await reply(ctx, eventsText(Math.min(30, Math.max(1, limit))));
  });

  bot.command('outbox', async (ctx) => {
    if (!(await requireBotAdmin(ctx, services))) return;
    const [sub] = parseArgs(ctx.match).positional;

    if (sub === 'retry') {
      const count = repo.retryDeadOutbox();
      audit.record({ actor: ctx.from!.id, action: 'outbox.retry', detail: { count } });
      await reply(ctx, `♻️ 已重投 ${count} 条 dead 消息。`);
      return;
    }
    if (sub === 'purge') {
      const count = repo.purgeSentOutbox();
      audit.record({ actor: ctx.from!.id, action: 'outbox.purge', detail: { count } });
      await reply(ctx, `🧹 已清理 ${count} 条 sent 记录。`);
      return;
    }

    await reply(ctx, outboxText());
  });

  bot.command('export', async (ctx) => {
    if (!(await requireBotAdmin(ctx, services))) return;

    const payload = JSON.stringify(store.exportJson(), null, 2);
    audit.record({ actor: ctx.from!.id, action: 'config.export' });
    await ctx.replyWithDocument(
      new InputFile(Buffer.from(payload, 'utf8'), 'roles.json'),
      { caption: '角色配置导出（DB 为权威，文件仅备份）' },
    );
  });

  bot.command('broadcast', async (ctx) => {
    if (!(await requireBotAdmin(ctx, services))) return;

    const args = parseArgs(ctx.match);
    const text = args.positional.join(' ').trim();
    const roleName = flagString(args, 'role');
    const confirmed = flagBool(args, 'yes');

    if (!text) {
      await reply(ctx, '用法：`/broadcast [--role <角色>] --yes <消息>`');
      return;
    }
    if (!confirmed) {
      await reply(ctx, '⚠️ 广播会立即发送，确认请加 `--yes`。');
      return;
    }

    let targets = repo.listUsers(MAX_BROADCAST);
    if (roleName) {
      const resolved = await roleResolver.resolve(roleName);
      if (!resolved.ok) {
        await reply(ctx, '找不到该角色，用 /roles 查看。');
        return;
      }
      const matched: typeof targets = [];
      for (const user of targets) {
        if (!user.logto_user_id) continue;
        const roles = await management.getUserRoles(user.logto_user_id).catch(() => []);
        if (roles.some((role) => role.id === resolved.role.id)) {
          matched.push(user);
        }
      }
      targets = matched;
    }

    for (const user of targets) {
      outbox.enqueue(user.tg_user_id, `📣 *公告*\n${escapeMarkdown(text)}`);
    }
    audit.record({
      actor: ctx.from!.id,
      action: 'broadcast',
      detail: { count: targets.length, role: roleName ?? null, length: text.length },
    });

    await reply(ctx, `📣 已排入队列：${targets.length} 人${roleName ? `（角色 ${escapeMarkdown(roleName)}）` : ''}。`);
  });

  bot.command('reload', async (ctx) => {
    if (!(await requireBotAdmin(ctx, services))) return;

    const targets = services.reload();
    roleResolver.invalidate();
    store.bump();
    audit.record({
      actor: ctx.from!.id,
      action: 'config.reload',
      detail: { targets: Object.keys(targets.targets) },
    });

    await reply(
      ctx,
      `♻️ 已重载：登录落点 ${escapeMarkdown(Object.keys(targets.targets).join(', ') || '(none)')}；角色缓存已失效。`,
    );
  });

  // ------------------------------------------------------------ signup -----

  bot.command('signup', async (ctx) => {
    if (!(await requireBotAdmin(ctx, services))) return;

    const args = parseArgs(ctx.match);

    if (flagBool(args, 'list')) {
      const rows = signup.list(10);
      if (rows.length === 0) {
        await reply(ctx, '还没有生成过注册链接。');
        return;
      }
      const now = Date.now() / 1000;
      const lines = rows.map((row) => {
        const state = row.revoked_at ? '已撤销' : row.expires_at < now ? '已过期' : '有效';
        return `• \`${escapeMarkdown(row.email ?? '')}\` · ${escapeMarkdown(state)} · \`${escapeMarkdown(row.ott_id ?? '')}\``;
      });
      await reply(ctx, ['📨 *最近的注册链接*', ...lines, '', '撤销：`/signup --revoke <ottId>`'].join('\n'));
      return;
    }

    const revokeId = flagString(args, 'revoke');
    if (revokeId) {
      const ok = await signup.revoke(revokeId);
      audit.record({ actor: ctx.from!.id, action: 'signup.revoke', target: revokeId });
      await reply(ctx, ok ? '🗑 已撤销该注册令牌。' : '没有找到该 ottId。');
      return;
    }

    const emails = args.positional
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean);

    if (emails.length === 0) {
      await reply(
        ctx,
        [
          '📨 *注册 Magic Link*',
          '用法：`/signup a@example.com[,b@example.com] [--ttl 3600] [--org <id>]`',
          '可选：`--list` 查看历史、`--revoke <ottId>` 撤销、`/orgs` 查看组织 id',
        ].join('\n'),
      );
      return;
    }

    const ttl = flagNumber(args, 'ttl');
    const orgIds = flagList(args, 'org');
    const results = await signup.create({ emails, ttl, organizationIds: orgIds, actor: ctx.from!.id });

    audit.record({
      actor: ctx.from!.id,
      action: 'signup.create',
      detail: { emails: results.map((item) => item.email), ttl: signup.normalizeTtl(ttl), orgs: orgIds },
    });

    const lines: string[] = ['📨 *注册链接（一次性）*'];
    for (const item of results) {
      if (item.error) {
        lines.push(`• ${escapeMarkdown(item.email || '?')} ❌ ${escapeMarkdown(item.error)}`);
        continue;
      }
      lines.push(
        `• ${escapeMarkdown(item.email)}`,
        `  ${escapeMarkdown(item.url ?? '')}`,
        `  有效期至 ${escapeMarkdown(formatTime(item.expiresAt ?? 0))}`,
      );
    }
    if (orgIds.length > 0) {
      lines.push('', `_组织（JIT）：${escapeMarkdown(orgIds.join(', '))}_`);
    }

    await reply(ctx, lines.join('\n'));
  });

  bot.command('orgs', async (ctx) => {
    if (!(await requireBotAdmin(ctx, services))) return;

    try {
      const organizations = await management.listOrganizations();
      if (organizations.length === 0) {
        await reply(ctx, '租户里没有组织。');
        return;
      }
      const lines = organizations.map((org) => `• *${escapeMarkdown(org.name)}* \`${escapeMarkdown(org.id)}\``);
      await reply(ctx, ['🏢 *组织*', ...lines].join('\n'));
    } catch (error) {
      logger.warn({ error: (error as Error).message }, 'list organizations failed');
      await reply(ctx, `读取组织失败：${escapeMarkdown((error as Error).message)}`);
    }
  });

  // ------------------------------------------------------------ panel ------

  bot.callbackQuery(/^adm:/, async (ctx) => {
    if (!ctx.from || !services.config.telegram.adminIds.includes(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: '仅 Bot 管理员可用' });
      return;
    }

    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();

    if (data === 'adm:close') {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
      return;
    }

    const text =
      data === 'adm:groups'
        ? groupsText()
        : data === 'adm:outbox'
          ? outboxText()
          : data === 'adm:events'
            ? eventsText(10)
            : data === 'adm:audit'
              ? auditText()
              : statsText();

    await ctx
      .editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: panelKeyboard() })
      .catch(() => undefined);
  });
};
