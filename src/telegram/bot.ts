import { Bot } from 'grammy';

import { Outbox } from './send.js';
import { registerAdminCommands } from './commands/admin.js';
import { registerGroupCommands } from './commands/group.js';
import { registerGroupConfigCommands } from './commands/groupConfig.js';
import { registerUserCommands } from './commands/user.js';
import type { AppServices } from './context.js';

/**
 * Adapter between grammY's node-fetch shim and Node's global fetch:
 * a foreign AbortSignal is bridged onto a platform AbortController, and the
 * platform fetch keeps HTTP(S)_PROXY / NODE_USE_ENV_PROXY working.
 */
export const createPlatformFetch =
  (platformFetch: typeof fetch = globalThis.fetch): typeof fetch =>
  async (input, init) => {
    const next: RequestInit = { ...(init ?? {}) };
    const outerSignal = (init as { signal?: AbortSignal } | undefined)?.signal;

    if (outerSignal && !(outerSignal instanceof AbortSignal)) {
      const foreign = outerSignal as unknown as {
        aborted?: boolean;
        addEventListener?: (type: string, listener: () => void) => void;
      };
      const controller = new AbortController();
      if (foreign.aborted) {
        controller.abort();
      } else {
        foreign.addEventListener?.('abort', () => controller.abort());
      }
      next.signal = controller.signal;
    }

    return platformFetch(input as Parameters<typeof fetch>[0], next);
  };

const platformFetch = createPlatformFetch();

export const USER_COMMANDS = [
  { command: 'start', description: '开始 / 使用说明' },
  { command: 'login', description: '获取一次性登录链接' },
  { command: 'whoami', description: '查看绑定信息' },
  { command: 'settings', description: '通知开关' },
  { command: 'sessions', description: '查看/撤销登录链接' },
  { command: 'unbind', description: '解除绑定' },
  { command: 'role', description: '查看我在本群的角色映射' },
  { command: 'help', description: '帮助' },
];

export const ADMIN_COMMANDS = [
  { command: 'admin', description: 'Admin 面板' },
  { command: 'group', description: '群组配置（仅管理员）' },
  { command: 'map', description: '角色映射配置（仅管理员）' },
  { command: 'sync', description: '立即同步群角色（仅管理员）' },
  { command: 'roles', description: '列出 Logto 角色（仅管理员）' },
  { command: 'signup', description: '生成注册 Magic Link（仅管理员）' },
  { command: 'orgs', description: '列出组织（仅管理员）' },
  { command: 'user', description: '查询用户（仅管理员）' },
  { command: 'grant', description: '授予角色（仅管理员）' },
  { command: 'revoke', description: '移除角色（仅管理员）' },
  { command: 'stats', description: '运行状态（仅管理员）' },
];

export const createBot = (
  services: Omit<AppServices, 'bot' | 'outbox'>,
  options: { fetch?: typeof fetch } = {},
): { bot: Bot; outbox: Outbox; services: AppServices } => {
  const baseFetch = options.fetch ?? platformFetch;
  const bot = new Bot(services.config.telegram.token, {
    client: { fetch: (options.fetch ? createPlatformFetch(baseFetch) : platformFetch) as never },
  });

  const outbox = new Outbox({
    repo: services.repo,
    bot,
    config: services.config,
    logger: services.logger,
  });

  const full: AppServices = { ...services, bot, outbox };

  registerUserCommands(bot, full);
  registerGroupCommands(bot, full);
  registerGroupConfigCommands(bot, full);
  registerAdminCommands(bot, full);

  bot.catch((error) => {
    services.logger.error(
      { error: error.message, update: error.ctx.update.update_id },
      'telegram update failed',
    );
  });

  bot.on('chat_member', async (ctx) => {
    if (!full.roles.available) {
      return;
    }
    const update = ctx.chatMember;
    const member = update.new_chat_member;
    await full.roles
      .syncMember({
        chatId: update.chat.id,
        tgUserId: member.user.id,
        reason: `chat_member:${member.status}`,
        member: { status: member.status, custom_title: 'custom_title' in member ? member.custom_title : undefined },
      })
      .catch((error: Error) => {
        services.logger.warn({ error: error.message }, 'chat_member sync failed');
      });
  });

  return { bot, outbox, services: full };
};
