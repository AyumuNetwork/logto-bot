import { resolve } from 'node:path';

import type { Bot } from 'grammy';
import type { FastifyInstance } from 'fastify';

import { loadConfig, type AppConfig } from './config.js';
import { loadLoginTargets } from './config/apps.js';
import { createLogger, type Logger } from './logger.js';
import { openDatabase, type Database } from './db/index.js';
import { Repo } from './db/repo.js';
import { LogtoManagement } from './logto/management.js';
import { AdminAudit } from './services/adminAudit.js';
import { BindingService } from './services/binding.js';
import { LoginLinkService } from './services/loginLink.js';
import { RoleConfigStore } from './services/roleConfigStore.js';
import { RoleResolver } from './services/roles.js';
import { RoleSyncService, type TelegramMemberApi } from './services/roleSync.js';
import { SignupService } from './services/signup.js';
import { createBot } from './telegram/bot.js';
import { createServer } from './http/server.js';
import { createLogtoFetch, createTelegramTransport, proxyEnvFor } from './net/transport.js';
import { describeProxy, resolveProxy } from './net/proxy.js';
import type { WsRelayClient } from './net/wsRelayClient.js';
import { attachControlChannel } from './net/wsControl.js';
import { eventBus } from './net/events.js';
import type { AppServices } from './telegram/context.js';
import type { LoginTargets } from './config/apps.js';
import type { Outbox } from './telegram/send.js';

export type BootstrapOptions = {
  config?: AppConfig;
  logger?: Logger;
  /** When false the HTTP server is created but not listening (tests, smoke runs). */
  listen?: boolean;
};

export type NetworkInfo = {
  telegramMode: 'webhook' | 'polling';
  telegramProxy?: string;
  logtoProxy?: string;
  relayUrl?: string;
};

export type Bootstrapped = {
  config: AppConfig;
  logger: Logger;
  db: Database;
  repo: Repo;
  management: LogtoManagement;
  binding: BindingService;
  targets: LoginTargets;
  services: AppServices;
  bot: Bot;
  outbox: Outbox;
  app: FastifyInstance;
  network: NetworkInfo;
  listen: () => Promise<string>;
  shutdown: () => Promise<void>;
};

const buildProxyEnv = (config: AppConfig): NodeJS.ProcessEnv => {
  const base = config.runtime.proxyEnvFallback ? process.env : {};
  return config.runtime.noProxy ? { ...base, NO_PROXY: config.runtime.noProxy } : { ...base };
};

/**
 * Wire the whole application: config -> network -> db -> logto -> services ->
 * bot -> http. Shared by `src/index.ts`, the CLI and scripts so there is
 * exactly one composition root.
 */
export const bootstrap = async (options: BootstrapOptions = {}): Promise<Bootstrapped> => {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config);

  if (!config.telegram.webhookSecret && config.telegram.mode === 'webhook') {
    logger.warn('TELEGRAM_WEBHOOK_SECRET is empty: /tg/webhook accepts unsigned updates');
  }
  if (!config.logto.webhookSigningKey) {
    logger.warn('LOGTO_WEBHOOK_SIGNING_KEY is empty: /hooks/logto will reject every delivery');
  }
  if (!config.logto.m2mClientId) {
    logger.warn('LOGTO_M2M_CLIENT_ID is empty: /login cannot issue one-time tokens');
  }
  if (config.ws.enabled && !config.ws.token) {
    logger.warn('WS_ENABLED without WS_TOKEN: control channel disabled');
  }

  // ---------------------------------------------------------------- network
  const transport = createTelegramTransport(config, logger);
  const telegramFetch = transport.fetch;
  const relay: WsRelayClient | undefined = transport.relay;

  const logtoProxy = resolveProxy({
    explicit: config.logto.proxyUrl,
    env: proxyEnvFor(config),
    targetHost: new URL(config.logto.endpoint).hostname,
  });
  const logtoFetch = createLogtoFetch(config);

  const network: NetworkInfo = {
    telegramMode: config.telegram.mode,
    telegramProxy: transport.proxy ? describeProxy(transport.proxy) : undefined,
    logtoProxy: logtoProxy ? describeProxy(logtoProxy) : undefined,
    relayUrl: config.telegram.relayUrl,
  };

  logger.info(
    {
      transport: transport.describe,
      mode: config.telegram.mode,
      logtoProxy: network.logtoProxy ?? 'direct',
    },
    'outbound network configured',
  );

  // --------------------------------------------------------------- storage
  const db = openDatabase(config.runtime.dbPath);
  const repo = new Repo(db);

  const management = new LogtoManagement({
    endpoint: config.logto.endpoint,
    clientId: config.logto.m2mClientId,
    clientSecret: config.logto.m2mClientSecret,
    resource: config.logto.managementResource,
    logger,
    fetch: logtoFetch,
  });

  let targets = loadLoginTargets(resolve('config/apps.json'), logger);
  if (Object.keys(targets.targets).length === 0) {
    logger.info('config/apps.json not found: /login falls back to LOGIN_APP_CLIENT_ID');
  }
  const getTargets = (): LoginTargets => targets;

  const defaultFlags = Object.fromEntries(config.runtime.notifyDefaults.map((kind) => [kind, true]));
  const binding = new BindingService({ config, repo, management, logger, defaultFlags });
  const loginLink = new LoginLinkService({ config, repo, management, targets: getTargets, logger });

  const store = new RoleConfigStore({ repo, logger });
  store.bootstrapFromFile(resolve('config/roles.json'));

  const audit = new AdminAudit(repo);
  const roleResolver = new RoleResolver({ management, logger });
  const signup = new SignupService({ config, repo, management, targets: getTargets, logger });

  const botHolder: { bot?: Bot } = {};
  const memberApi: TelegramMemberApi = {
    getChatMember: async (chatId, userId) => {
      const member = await botHolder.bot!.api.getChatMember(chatId, userId);
      return {
        status: member.status,
        custom_title: 'custom_title' in member ? member.custom_title : undefined,
      };
    },
    getChatAdministrators: async (chatId) => {
      const admins = await botHolder.bot!.api.getChatAdministrators(chatId);
      return admins.map((admin) => ({
        user: { id: admin.user.id },
        status: admin.status,
        custom_title: 'custom_title' in admin ? admin.custom_title : undefined,
      }));
    },
  };

  const roles = new RoleSyncService({
    store,
    repo,
    management,
    api: memberApi,
    logger,
  });

  const reload = (): LoginTargets => {
    targets = loadLoginTargets(resolve('config/apps.json'), logger);
    roleResolver.invalidate();
    store.bump();
    logger.info({ targets: Object.keys(targets.targets) }, 'configuration reloaded');
    return targets;
  };

  const { bot, outbox } = createBot(
    {
      config,
      repo,
      logger,
      management,
      loginLink,
      roles,
      store,
      audit,
      roleResolver,
      signup,
      targets: getTargets,
      reload,
    },
    { fetch: telegramFetch },
  );
  botHolder.bot = bot;

  await bot.init();
  logger.info({ username: bot.botInfo.username, transport: relay ? 'ws-relay' : config.telegram.mode }, 'telegram bot initialised');

  if (config.telegram.mode === 'polling') {
    await bot.api
      .deleteWebhook({ drop_pending_updates: false })
      .catch((error: Error) => logger.warn({ error: error.message }, 'deleteWebhook failed'));
    void bot
      .start({
        allowed_updates: ['message', 'callback_query', 'chat_member', 'my_chat_member'],
        drop_pending_updates: false,
        onStart: () => logger.info('telegram long polling started'),
      })
      .catch((error: Error) => logger.error({ error: error.message }, 'long polling failed'));
  } else {
    await bot.api
      .setMyCommands([
        { command: 'start', description: '开始 / 使用说明' },
        { command: 'login', description: '获取一次性登录链接' },
        { command: 'whoami', description: '查看绑定信息' },
        { command: 'settings', description: '通知开关' },
        { command: 'sessions', description: '查看/撤销登录链接' },
        { command: 'unbind', description: '解除绑定' },
        { command: 'help', description: '帮助' },
      ])
      .catch((error: Error) => logger.warn({ error: error.message }, 'setMyCommands failed'));
  }

  const app = createServer({
    config,
    repo,
    logger,
    management,
    binding,
    outbox,
    bot,
    telegramMode: config.telegram.mode,
  });

  const listen = async (): Promise<string> => {
    const address = await app.listen({ port: config.runtime.port, host: config.runtime.host });
    logger.info({ address }, 'http server listening');
    return address;
  };

  let detachControl: (() => void) | undefined;
  if (config.ws.enabled && config.ws.token) {
    detachControl = attachControlChannel(app.server, {
      token: config.ws.token,
      logger,
      bus: eventBus,
      handlers: {
        stats: () => ({
          users: repo.countUsers(),
          outbox: repo.outboxStats(),
          events24h: repo.countEventsSince(Math.floor(Date.now() / 1000) - 86_400),
          transport: relay ? 'ws-relay' : config.telegram.mode,
          telegramProxy: network.telegramProxy ?? 'direct',
          logtoProxy: network.logtoProxy ?? 'direct',
          roleGroups: store.groups().length,
        }),
        recentEvents: (limit) => repo.recentEvents(limit),
        sendTest: (chatId, text) => {
          outbox.enqueue(chatId, text);
          return { queued: true, chatId };
        },
        reload: () => {
          const reloaded = reload();
          return { targets: Object.keys(reloaded.targets) };
        },
      },
    });
    logger.info('ws control channel enabled at /ws');
  }

  if (options.listen !== false) {
    await listen();
  }

  outbox.start();

  const shutdown = async (): Promise<void> => {
    outbox.stop();
    detachControl?.();
    transport.close();
    if (config.telegram.mode === 'polling') {
      await bot.stop().catch(() => undefined);
    }
    await app.close().catch(() => undefined);
    db.close();
  };

  return {
    config,
    logger,
    db,
    repo,
    management,
    binding,
    targets,
    services: {
      config,
      repo,
      logger,
      management,
      loginLink,
      roles,
      store,
      audit,
      roleResolver,
      signup,
      targets: getTargets,
      reload,
      bot,
      outbox,
    },
    bot,
    outbox,
    app,
    network,
    listen,
    shutdown,
  };
};
