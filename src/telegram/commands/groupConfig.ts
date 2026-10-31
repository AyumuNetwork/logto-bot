import type { Bot, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';

import { escapeMarkdown } from '../esc.js';
import { parseArgs, flagString, type ParsedArgs } from '../args.js';
import { formatTime, replyMarkdown as reply, requireBotAdmin, type AppServices } from '../context.js';
import { desiredRoles } from '../../services/roleSync.js';

const STATUS_KEYS = ['creator', 'administrator', 'member', 'restricted'] as const;

const resolveChatId = (ctx: Context, args: ParsedArgs): number | undefined => {
  const first = args.positional[0];
  if (first && /^-?\d+$/.test(first)) {
    return Number(first);
  }
  return ctx.chat?.type === 'private' ? undefined : ctx.chat?.id;
};

const stripChatArg = (args: ParsedArgs): ParsedArgs => {
  const [first, ...rest] = args.positional;
  if (first && /^-?\d+$/.test(first)) {
    return { ...args, positional: rest };
  }
  return args;
};

const roleLabel = (services: AppServices, roleId: string): string => {
  const cached = services.store.mappings().find((mapping) => mapping.role_id === roleId);
  void cached;
  return roleId.length > 10 ? `${roleId.slice(0, 6)}…${roleId.slice(-4)}` : roleId;
};

/**
 * Group/role configuration commands. All of them require a bot admin
 * (`ADMIN_TG_IDS`); group admin status grants nothing.
 */
export const registerGroupConfigCommands = (bot: Bot, services: AppServices): void => {
  const { store, roles, roleResolver, audit, repo, logger } = services;

  const ensureGroup = (chatId: number, actor: number, title?: string | null): void => {
    if (!store.group(chatId)) {
      store.upsertGroup({ chatId, enabled: true, removeOnLeave: true, title: title ?? null, actor });
      audit.record({ actor, action: 'group.create', target: chatId, detail: { title } });
    }
  };

  const renderMappings = (chatId: number): string => {
    const mappings = store.mappings(chatId);
    if (mappings.length === 0) {
      return '_尚未配置映射_';
    }
    return mappings
      .map(
        (mapping) =>
          `• ${mapping.kind === 'status' ? '状态' : '头衔'} \`${escapeMarkdown(mapping.key)}\` → \`${escapeMarkdown(roleLabel(services, mapping.role_id))}\``,
      )
      .join('\n');
  };

  bot.command('group', async (ctx) => {
    if (!(await requireBotAdmin(ctx, services))) return;

    const args = parseArgs(ctx.match);
    const chatId = resolveChatId(ctx, args);
    const sub = (chatId ? stripChatArg(args).positional[0] : args.positional[0]) ?? 'show';

    if (sub === 'list') {
      const groups = store.groups();
      if (groups.length === 0) {
        await reply(ctx, '还没有任何群组配置。在群里发 `/group on` 或 `/group <chatId> on`。');
        return;
      }
      const lines = groups.map(
        (group) =>
          `• \`${group.chat_id}\`${group.title ? ` (${escapeMarkdown(group.title)})` : ''} · ${group.enabled ? '启用' : '停用'} · 移除于退群：${group.remove_on_leave ? '是' : '否'}`,
      );
      await reply(ctx, ['👥 *已配置群组*', ...lines].join('\n'));
      return;
    }

    if (!chatId) {
      await reply(ctx, '请在群里执行，或指定 chatId：`/group -1001234567890 show`。');
      return;
    }

    if (sub === 'on' || sub === 'off') {
      ensureGroup(chatId, ctx.from!.id);
      store.upsertGroup({ chatId, enabled: sub === 'on', actor: ctx.from!.id });
      audit.record({ actor: ctx.from!.id, action: 'group.setEnabled', target: chatId, detail: { enabled: sub === 'on' } });
      await reply(ctx, `✅ 群 \`${chatId}\` 角色同步已${sub === 'on' ? '启用' : '停用'}。`);
      return;
    }

    if (sub === 'leave' || sub === 'remove' || sub === 'del') {
      const keyboard = new InlineKeyboard()
        .text('确认删除', `gc:del:${chatId}`)
        .text('取消', 'gc:cancel');
      await reply(ctx, `⚠️ 确认删除群 \`${chatId}\` 的全部角色配置？`, keyboard);
      return;
    }

    if (sub === 'show') {
      const group = store.group(chatId);
      if (!group) {
        await reply(ctx, `群 \`${chatId}\` 尚未配置。用 \`/group ${chatId} on\` 启用。`);
        return;
      }

      let botState = '未知';
      try {
        const me = await ctx.api.getChatMember(chatId, ctx.me.id);
        botState = ['administrator', 'creator'].includes(me.status) ? '是' : '否（将无法读取成员状态）';
      } catch (error) {
        botState = `读取失败：${(error as Error).message}`;
      }

      const lines = [
        `⚙️ *群组配置* \`${chatId}\``,
        group.title ? `• 备注：${escapeMarkdown(group.title)}` : undefined,
        `• 同步：${group.enabled ? '启用' : '停用'}`,
        `• 退群移除角色：${group.remove_on_leave ? '是' : '否'}`,
        `• Bot 是管理员：${escapeMarkdown(botState)}`,
        `• 配置时间：${escapeMarkdown(formatTime(group.created_at))}`,
        '',
        '*映射*',
        renderMappings(chatId),
      ].filter((line): line is string => Boolean(line));
      await reply(ctx, lines.join('\n'));
      return;
    }

    await reply(
      ctx,
      '用法：`/group [chatId] on|off|show|leave`、`/group list`',
    );
  });

  bot.command('map', async (ctx) => {
    if (!(await requireBotAdmin(ctx, services))) return;

    const args = parseArgs(ctx.match);
    const chatId = resolveChatId(ctx, args);
    const stripped = chatId ? stripChatArg(args) : args;
    const [kind, ...rest] = stripped.positional;

    if (!chatId) {
      await reply(ctx, '请在群里执行，或指定 chatId：`/map -1001234567890 status administrator Admins`。');
      return;
    }

    if (kind === 'list' || kind === undefined) {
      await reply(ctx, [`📋 *映射* \`${chatId}\``, renderMappings(chatId)].join('\n'));
      return;
    }

    if (kind === 'del' || kind === 'remove') {
      const [target, key] = rest;
      if (!target || !key) {
        await reply(ctx, '用法：`/map del status administrator` 或 `/map del title 核心成员`');
        return;
      }
      const mappingKind = target === 'title' ? 'title' : 'status';
      const removed = store.deleteMapping(chatId, mappingKind, key);
      audit.record({ actor: ctx.from!.id, action: 'map.delete', target: chatId, detail: { kind: mappingKind, key } });
      await reply(ctx, removed ? `🗑 已删除映射 \`${escapeMarkdown(key)}\`。` : '没有找到该映射。');
      return;
    }

    const resolveRoleInput = (fallbackIndex: number): string => {
      const explicit = flagString(stripped, 'role');
      if (explicit) {
        return explicit;
      }
      return rest.slice(fallbackIndex).join(' ');
    };

    if (kind === 'status') {
      const status = rest[0];
      if (!status || !STATUS_KEYS.includes(status as (typeof STATUS_KEYS)[number])) {
        await reply(ctx, `状态必须是：${STATUS_KEYS.join(' / ')}`);
        return;
      }
      const roleInput = resolveRoleInput(1);
      if (!roleInput) {
        await reply(ctx, '用法：`/map status administrator <角色名或ID>`');
        return;
      }

      const resolved = await roleResolver.resolve(roleInput);
      if (!resolved.ok) {
        await reply(ctx, renderResolutionError(roleInput, resolved));
        return;
      }

      ensureGroup(chatId, ctx.from!.id);
      store.setMapping({ chatId, kind: 'status', key: status, roleId: resolved.role.id, actor: ctx.from!.id });
      audit.record({
        actor: ctx.from!.id,
        action: 'map.set',
        target: chatId,
        detail: { kind: 'status', key: status, role: resolved.role.name, roleId: resolved.role.id },
      });
      await reply(
        ctx,
        `✅ \`${status}\` → *${escapeMarkdown(resolved.role.name)}*（\`${escapeMarkdown(resolved.role.id)}\`）\n执行 \`/sync ${chatId}\` 立即生效。`,
      );
      return;
    }

    if (kind === 'title') {
      const title = flagString(stripped, 'title') ?? rest[0];
      const roleInput = resolveRoleInput(flagString(stripped, 'title') ? 0 : 1);
      if (!title || !roleInput) {
        await reply(ctx, '用法：`/map title 核心成员 <角色>` 或 `/map title --title "核心成员" --role "Admins"`');
        return;
      }

      const resolved = await roleResolver.resolve(roleInput);
      if (!resolved.ok) {
        await reply(ctx, renderResolutionError(roleInput, resolved));
        return;
      }

      ensureGroup(chatId, ctx.from!.id);
      store.setMapping({ chatId, kind: 'title', key: title, roleId: resolved.role.id, actor: ctx.from!.id });
      audit.record({
        actor: ctx.from!.id,
        action: 'map.set',
        target: chatId,
        detail: { kind: 'title', key: title, role: resolved.role.name, roleId: resolved.role.id },
      });
      await reply(
        ctx,
        `✅ 头衔 \`${escapeMarkdown(title)}\` → *${escapeMarkdown(resolved.role.name)}*\n执行 \`/sync ${chatId}\` 立即生效。`,
      );
      return;
    }

    await reply(ctx, '用法：`/map list`、`/map status <status> <role>`、`/map title <头衔> <role>`、`/map del …`');
  });

  bot.command('roles', async (ctx) => {
    if (!(await requireBotAdmin(ctx, services))) return;

    try {
      const list = await roleResolver.listUserRoles(true);
      if (list.length === 0) {
        await reply(ctx, '租户里没有用户角色。');
        return;
      }
      const lines = list.map(
        (role) => `• *${escapeMarkdown(role.name)}* \`${escapeMarkdown(role.id)}\`${role.isDefault ? ' _默认_' : ''}`,
      );
      await reply(ctx, ['🎭 *Logto 用户角色*', ...lines].join('\n'));
    } catch (error) {
      logger.warn({ error: (error as Error).message }, 'list roles failed');
      await reply(ctx, `读取角色失败：${escapeMarkdown((error as Error).message)}`);
    }
  });

  bot.command('sync', async (ctx) => {
    if (!(await requireBotAdmin(ctx, services))) return;

    const args = parseArgs(ctx.match);
    const chatId = resolveChatId(ctx, args);
    if (!chatId) {
      await reply(ctx, '请在群里执行，或指定 chatId：`/sync -1001234567890`。');
      return;
    }
    if (!store.group(chatId)) {
      await reply(ctx, `群 \`${chatId}\` 尚未配置，先 \`/group ${chatId} on\`。`);
      return;
    }

    await reply(ctx, `⏳ 开始同步 \`${chatId}\`（管理员 + 已知绑定用户）…`);
    const report = await roles.syncChat({ chatId, reason: 'command:sync' }).catch((error: Error) => {
      logger.warn({ error: error.message }, 'sync failed');
      return undefined;
    });

    if (!report) {
      await reply(ctx, '同步失败，详见日志。');
      return;
    }
    if (report === 'busy') {
      await reply(ctx, '该群已有同步任务在跑，稍后再试。');
      return;
    }

    audit.record({
      actor: ctx.from!.id,
      action: 'sync.run',
      target: chatId,
      detail: { checked: report.checked, changed: report.changed.length, failed: report.failed.length },
    });

    const changed = report.changed
      .slice(0, 10)
      .map(
        (item) =>
          `• \`${item.tgUserId}\` ${item.status} ＋${item.added.length}/－${item.removed.length}`,
      );

    await reply(
      ctx,
      [
        '✅ *同步完成*',
        `• 检查：${report.checked} 人`,
        `• 变更：${report.changed.length} 人`,
        `• 跳过/失败：${report.failed.length} 次`,
        ...(changed.length > 0 ? ['', '*明细（前 10）*', ...changed.map((line) => escapeMarkdown(line).replace('\\*', '*'))] : []),
      ].join('\n'),
    );
  });

  bot.command('whorole', async (ctx) => {
    if (!(await requireBotAdmin(ctx, services))) return;

    const args = parseArgs(ctx.match);
    const target = args.positional[0] ?? (ctx.message?.reply_to_message?.from?.id?.toString() ?? '');
    const chatId = resolveChatId(ctx, args);

    const users = target ? repo.searchUser(target) : [];
    const user = users[0];
    if (!user) {
      await reply(ctx, '用法：`/whorole <tgId|@username|email>`（或回复某人的消息）');
      return;
    }
    if (!chatId || !store.group(chatId)) {
      await reply(ctx, '需要群上下文：在群里执行，或带上 chatId。');
      return;
    }

    const group = store.getConfig().groups.find((item) => item.chatId === chatId);
    if (!group) {
      await reply(ctx, '该群没有启用映射。');
      return;
    }

    let member;
    try {
      member = await ctx.api.getChatMember(chatId, user.tg_user_id);
    } catch (error) {
      await reply(ctx, `读取群成员失败：${escapeMarkdown((error as Error).message)}`);
      return;
    }

    const desired = desiredRoles(group, {
      status: member.status,
      custom_title: 'custom_title' in member ? member.custom_title : undefined,
    });
    const current = user.logto_user_id ? await services.management.getUserRoles(user.logto_user_id).catch(() => []) : [];

    await reply(
      ctx,
      [
        '🔍 *角色对照*',
        `• 用户：\`${user.tg_user_id}\`${user.logto_user_id ? ` ↔ \`${escapeMarkdown(user.logto_user_id)}\`` : ' _未绑定 Logto_ '}`,
        `• 群内身份：${escapeMarkdown(member.status)}${'custom_title' in member && member.custom_title ? `（${escapeMarkdown(member.custom_title)}）` : ''}`,
        `• 目标角色：${desired.roles.map((id) => roleLabel(services, id)).join(', ') || '无'}`,
        `• 当前角色：${current.map((role) => escapeMarkdown(role.name)).join(', ') || '无'}`,
      ].join('\n'),
    );
  });

  bot.callbackQuery(/^gc:/, async (ctx) => {
    if (!requireBotAdminSync(ctx, services)) {
      await ctx.answerCallbackQuery({ text: '仅 Bot 管理员可用' });
      return;
    }

    const data = ctx.callbackQuery.data;
    if (data === 'gc:cancel') {
      await ctx.answerCallbackQuery({ text: '已取消' });
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
      return;
    }

    const match = /^gc:del:(-?\d+)$/.exec(data);
    if (!match) {
      await ctx.answerCallbackQuery({ text: '无效操作' });
      return;
    }

    const chatId = Number(match[1]);
    const removed = store.removeGroup(chatId);
    audit.record({ actor: ctx.from!.id, action: 'group.delete', target: chatId });
    await ctx.answerCallbackQuery({ text: removed ? '已删除' : '不存在' });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
    await reply(ctx, removed ? `🗑 已删除群 \`${chatId}\` 的角色配置。` : '该群没有配置。');
  });
};

const requireBotAdminSync = (ctx: Context, services: AppServices): boolean =>
  ctx.from !== undefined && services.config.telegram.adminIds.includes(ctx.from.id);

const renderResolutionError = (
  input: string,
  result: { reason: string; candidates: { name: string; id: string }[] },
): string => {
  if (result.reason === 'ambiguous') {
    const list = result.candidates
      .map((role) => `• ${escapeMarkdown(role.name)} \`${escapeMarkdown(role.id)}\``)
      .join('\n');
    return `角色 \`${escapeMarkdown(input)}\` 有多个匹配，请指定 id：\n${list}`;
  }
  if (result.reason === 'unavailable') {
    return '无法读取角色列表（检查 M2M 凭据）。';
  }
  return `没有找到角色 \`${escapeMarkdown(input)}\`。用 /roles 查看可选项。`;
};
