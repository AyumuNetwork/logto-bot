import type { Bot, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';

import type { NotificationKind } from '../../config.js';
import type { UserRow } from '../../db/repo.js';
import { escapeMarkdown } from '../esc.js';
import { formatTime, isBotAdmin, replyMarkdown as reply, type AppServices } from '../context.js';

const helpText = (admin: boolean): string =>
  [
    '🤖 *可用命令*',
    '/login — 获取一次性登录链接（私聊发送）',
    '`/login <平台>` — 指定落点，例如 `/login account`',
    '/whoami — 查看绑定信息',
    '/settings — 通知开关',
    '/sessions — 查看/撤销已发出的登录链接',
    '/unbind — 解除 Telegram 绑定',
    '/role — 群里查看自己的角色映射',
    '/help — 显示这条帮助',
    ...(admin
      ? [
          '',
          '*管理员*',
          '/admin — 面板 · /stats — 状态',
          '/group · /map · /roles · /sync — 群组与角色配置',
          '/signup — 注册 Magic Link · /orgs — 组织列表',
          '/user · /grant · /revoke · /events · /outbox · /export · /broadcast · /reload',
        ]
      : []),
  ].join('\n');

export const registerUserCommands = (bot: Bot, services: AppServices): void => {
  const { repo, loginLink } = services;

  type SendText = (text: string) => Promise<unknown>;

  const sendLoginLink = async (send: SendText, user: UserRow, slug?: string): Promise<void> => {
    const result = await loginLink.issue({ user, slug });

    if (!result.ok) {
      await send(`⚠️ ${escapeMarkdown(result.message)}`);
      return;
    }

    const lines = [
      `🔗 *${escapeMarkdown(result.label)}* 一次性登录链接`,
      result.strategy === 'ott'
        ? '• 类型：一次性（点开即登录，二次点击会失效）'
        : '• 类型：快捷登录（未找到邮箱，无法签发一次性令牌）',
      `• 有效期至：${escapeMarkdown(formatTime(result.expiresAt))}`,
      '',
      escapeMarkdown(result.url),
    ];

    if (result.strategy !== 'ott') {
      lines.push('', '_建议先在 Logto 账户中心绑定邮箱，之后即可使用真正的一次性链接。_');
    }

    await send(lines.join('\n'));
  };

  bot.command(['start', 'help'], async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await reply(ctx, '请私聊我使用 `/login` 等命令。');
      return;
    }

    const user = ctx.from ? repo.findByTgId(ctx.from.id) : undefined;

    if (!user) {
      await reply(
        ctx,
        [
          '👋 你好，我是 Logto 通知机器人。',
          '',
          '当前*尚未绑定*。绑定方式：发送 /login 拿到链接，用 Telegram 登录一次即自动绑定。',
          '',
          helpText(isBotAdmin(services, ctx.from?.id)),
        ].join('\n'),
      );
      return;
    }

    await reply(
      ctx,
      [
        '👋 已绑定',
        `• 账号：${escapeMarkdown(user.logto_email ?? user.logto_user_id ?? '未知')}`,
        '',
        helpText(isBotAdmin(services, ctx.from?.id)),
      ].join('\n'),
    );
  });

  bot.command('whoami', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await reply(ctx, '请私聊使用该命令。');
      return;
    }
    const user = ctx.from ? repo.findByTgId(ctx.from.id) : undefined;
    if (!user) {
      await reply(ctx, '当前未绑定。发送 /login 获取登录链接后自动绑定。');
      return;
    }

    const flags = repo.parseFlags(user);
    const enabled = Object.entries(flags)
      .filter(([, value]) => value)
      .map(([key]) => key)
      .join(', ');

    await reply(
      ctx,
      [
        '🪪 *绑定信息*',
        `• Telegram：\`${user.tg_user_id}\`${user.tg_username ? ` (@${escapeMarkdown(user.tg_username)})` : ''}`,
        `• Logto 用户：\`${escapeMarkdown(user.logto_user_id ?? '未知')}\``,
        `• 邮箱：${escapeMarkdown(user.logto_email ?? '未设置')}`,
        `• 绑定来源：${escapeMarkdown(user.bind_source)}`,
        `• 绑定时间：${escapeMarkdown(formatTime(user.bound_at))}`,
        `• 已开启通知：${escapeMarkdown(enabled || '无')}`,
        `• 消息投递：${user.notify_blocked ? '被阻止（请先与 Bot 对话解除）' : '正常'}`,
      ].join('\n'),
    );
  });

  bot.command('login', async (ctx) => {
    const user = ctx.from ? repo.findByTgId(ctx.from.id) : undefined;
    const slug = (ctx.match ?? '').trim() || undefined;

    if (!user) {
      await reply(ctx, '尚未绑定。请先发送 /start，按提示登录一次完成绑定。');
      return;
    }

    if (ctx.chat.type !== 'private') {
      const sendToDm: SendText = (text) =>
        ctx.api.sendMessage(ctx.from!.id, text, {
          parse_mode: 'MarkdownV2',
          link_preview_options: { is_disabled: true },
        });
      await sendLoginLink(sendToDm, user, slug);
      await reply(ctx, '🔒 登录链接已私聊发送。');
      return;
    }

    await sendLoginLink((text) => reply(ctx, text), user, slug);
  });

  bot.command('settings', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await reply(ctx, '请私聊使用该命令。');
      return;
    }
    const user = ctx.from ? repo.findByTgId(ctx.from.id) : undefined;
    if (!user) {
      await reply(ctx, '当前未绑定。');
      return;
    }

    const flags = repo.parseFlags(user);
    const kinds: NotificationKind[] = ['signin', 'password', 'security', 'account'];
    const keyboard = new InlineKeyboard();
    const labels: Record<string, string> = {
      signin: '登录提醒',
      password: '改密通知',
      security: '安全告警',
      account: '账号变更',
    };
    for (const kind of kinds) {
      keyboard
        .text(`${flags[kind] === false ? '⬜️' : '✅'} ${labels[kind] ?? kind}`, `toggle:${kind}`)
        .row();
    }

    await reply(ctx, '⚙️ *通知开关*（点击切换）', keyboard);
  });

  bot.command('sessions', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await reply(ctx, '请私聊使用该命令。');
      return;
    }
    const user = ctx.from ? repo.findByTgId(ctx.from.id) : undefined;
    if (!user) {
      await reply(ctx, '当前未绑定。');
      return;
    }

    const links = repo.listLoginLinks(user.tg_user_id, 8);
    if (links.length === 0) {
      await reply(ctx, '还没有生成过登录链接。发送 /login 试试。');
      return;
    }

    const keyboard = new InlineKeyboard();
    const rows = links.map((link) => {
      const state = link.revoked_at
        ? '已撤销'
        : link.expires_at * 1000 < Date.now()
          ? '已过期'
          : '有效';
      if (!link.revoked_at && link.expires_at * 1000 >= Date.now()) {
        keyboard.text(`撤销 #${link.id}`, `revoke:${link.id}`).row();
      }
      return `• \\#${link.id} ${escapeMarkdown(link.strategy)} · ${escapeMarkdown(state)} · 至 ${escapeMarkdown(formatTime(link.expires_at))}`;
    });

    await reply(ctx, ['🔗 *最近的登录链接*', ...rows].join('\n'), keyboard);
  });

  bot.command('unbind', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await reply(ctx, '请私聊使用该命令。');
      return;
    }
    const user = ctx.from ? repo.findByTgId(ctx.from.id) : undefined;
    if (!user) {
      await reply(ctx, '当前未绑定。');
      return;
    }

    const keyboard = new InlineKeyboard().text('确认解绑', 'unbind:confirm').text('取消', 'unbind:cancel');
    await reply(ctx, '⚠️ 确认解除 Telegram 与 Logto 的绑定？解绑后将不再收到通知。', keyboard);
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const tgId = ctx.from.id;
    const user = repo.findByTgId(tgId);

    if (data.startsWith('toggle:')) {
      if (!user) {
        await ctx.answerCallbackQuery({ text: '未绑定' });
        return;
      }
      const kind = data.slice('toggle:'.length);
      const flags = repo.parseFlags(user);
      flags[kind] = flags[kind] === false;
      repo.setFlags(tgId, flags);
      await ctx.answerCallbackQuery({ text: `${kind}: ${flags[kind] === false ? '关闭' : '开启'}` });

      const kinds: NotificationKind[] = ['signin', 'password', 'security', 'account'];
      const labels: Record<string, string> = {
        signin: '登录提醒',
        password: '改密通知',
        security: '安全告警',
        account: '账号变更',
      };
      const keyboard = new InlineKeyboard();
      for (const item of kinds) {
        keyboard
          .text(`${flags[item] === false ? '⬜️' : '✅'} ${labels[item] ?? item}`, `toggle:${item}`)
          .row();
      }
      await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch(() => undefined);
      return;
    }

    if (data.startsWith('revoke:')) {
      if (!user) {
        await ctx.answerCallbackQuery({ text: '未绑定' });
        return;
      }
      const id = Number.parseInt(data.slice('revoke:'.length), 10);
      const ok = await loginLink.revoke({ user, linkId: id });
      await ctx.answerCallbackQuery({ text: ok ? '已撤销' : '未找到该链接' });
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
      return;
    }

    if (data.startsWith('unbind:')) {
      if (data.endsWith('cancel')) {
        await ctx.answerCallbackQuery({ text: '已取消' });
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
        return;
      }
      const removed = repo.unbind(tgId);
      await ctx.answerCallbackQuery({ text: removed ? '已解绑' : '未绑定' });
      await reply(ctx, removed ? '✅ 已解绑。发送 /login 可重新绑定。' : '当前没有绑定。');
    }
  });
};
