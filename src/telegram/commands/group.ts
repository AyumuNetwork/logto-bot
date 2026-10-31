import type { Bot } from 'grammy';

import { escapeMarkdown } from '../esc.js';
import { isBotAdmin, replyMarkdown as reply, type AppServices } from '../context.js';
import { desiredRoles } from '../../services/roleSync.js';

/**
 * Read-only, self-service group command.
 * Actual configuration lives in `groupConfig.ts` and is bot-admin only.
 */
export const registerGroupCommands = (bot: Bot, services: AppServices): void => {
  bot.command('role', async (ctx) => {
    if (ctx.chat.type === 'private') {
      await reply(ctx, '请在群里使用该命令。');
      return;
    }

    if (!services.roles.available) {
      await reply(ctx, '⚙️ 本群尚未启用角色同步（由 Bot 管理员配置）。');
      return;
    }

    const group = services.roles.findGroup(ctx.chat.id);
    const user = ctx.from ? services.repo.findByTgId(ctx.from.id) : undefined;

    if (!group) {
      await reply(ctx, '⚙️ 本群没有角色映射。');
      return;
    }

    let member;
    try {
      member = await ctx.api.getChatMember(ctx.chat.id, ctx.from!.id);
    } catch (error) {
      await reply(ctx, `读取群成员失败：${escapeMarkdown((error as Error).message)}`);
      return;
    }

    const desired = desiredRoles(group, {
      status: member.status,
      custom_title: 'custom_title' in member ? member.custom_title : undefined,
    });

    const currentRoles = user?.logto_user_id
      ? await services.management.getUserRoles(user.logto_user_id).catch(() => [])
      : [];

    const lines = [
      '🎭 *我的群角色映射*',
      `• 群内身份：${escapeMarkdown(member.status)}${'custom_title' in member && member.custom_title ? `（${escapeMarkdown(member.custom_title)}）` : ''}`,
      `• 目标角色：${desired.roles.map((id) => `\`${escapeMarkdown(id)}\``).join(', ') || '无'}`,
      `• 已绑定 Logto：${user?.logto_user_id ? '是' : '否（发送 /login 绑定）'}`,
      `• 当前角色：${currentRoles.map((role) => escapeMarkdown(role.name)).join(', ') || '无'}`,
    ];

    if (isBotAdmin(services, ctx.from?.id)) {
      lines.push('', '_你是 Bot 管理员：用 `/map` 配置映射、`/sync` 立即生效。_');
    }

    await reply(ctx, lines.join('\n'));
  });
};
