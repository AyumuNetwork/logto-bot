import type { Bot, Context } from 'grammy';
import type { InlineKeyboard } from 'grammy';

import type { AppConfig } from '../config.js';
import type { LoginTargets } from '../config/apps.js';
import type { Repo } from '../db/repo.js';
import type { Logger } from '../logger.js';
import type { LogtoManagement } from '../logto/management.js';
import type { AdminAudit } from '../services/adminAudit.js';
import type { LoginLinkService } from '../services/loginLink.js';
import type { RoleConfigStore } from '../services/roleConfigStore.js';
import type { RoleResolver } from '../services/roles.js';
import type { RoleSyncService } from '../services/roleSync.js';
import type { SignupService } from '../services/signup.js';
import type { Outbox } from './send.js';

export type AppServices = {
  config: AppConfig;
  repo: Repo;
  logger: Logger;
  management: LogtoManagement;
  loginLink: LoginLinkService;
  roles: RoleSyncService;
  store: RoleConfigStore;
  audit: AdminAudit;
  roleResolver: RoleResolver;
  signup: SignupService;
  outbox: Outbox;
  targets: () => LoginTargets;
  reload: () => LoginTargets;
  bot: Bot;
};

/**
 * Single source of truth for privileged access: only ids listed in
 * ADMIN_TG_IDS may configure anything. Group admin status grants nothing.
 */
export const isBotAdmin = (services: AppServices, userId?: number): boolean =>
  userId !== undefined && services.config.telegram.adminIds.includes(userId);

/**
 * Send a MarkdownV2 message. If Telegram rejects the entity parsing (a stray
 * reserved character in dynamic content), the message is retried as plain text
 * instead of being dropped — operators still get the information.
 */
export const replyMarkdown = async (
  ctx: Context,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<unknown> => {
  const extra = {
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: keyboard } : {}),
  };

  try {
    return await ctx.reply(text, { parse_mode: 'MarkdownV2', ...extra });
  } catch (error) {
    const description = (error as { description?: string }).description ?? '';
    if (!description.includes("can't parse entities")) {
      throw error;
    }
    const plain = text.replace(/\\([_*\[\]()~`>#+\-=|{}.!])/g, '$1');
    return ctx.reply(plain, extra);
  }
};

export const formatTime = (seconds: number): string =>
  new Date(seconds * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

export const DENY_MESSAGE = '仅 Bot 管理员可用（ADMIN_TG_IDS）';

/** Returns true when the caller is a bot admin; otherwise replies and returns false. */
export const requireBotAdmin = async (ctx: Context, services: AppServices): Promise<boolean> => {
  if (isBotAdmin(services, ctx.from?.id)) {
    return true;
  }
  await replyMarkdown(ctx, `⛔ ${DENY_MESSAGE}`);
  return false;
};
