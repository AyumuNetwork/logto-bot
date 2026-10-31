import { z } from 'zod';

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const boolish = z
  .string()
  .optional()
  .transform((value) => value === '1' || value?.toLowerCase() === 'true');

const optionalString = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  });

const envSchema = z.object({
  LOGTO_ENDPOINT: z
    .string()
    .min(1, 'LOGTO_ENDPOINT is required')
    .transform((value) => value.replace(/\/+$/, '')),
  LOGTO_M2M_CLIENT_ID: optionalString,
  LOGTO_M2M_CLIENT_SECRET: optionalString,
  LOGTO_MANAGEMENT_RESOURCE: z.string().default('https://default.logto.app/api'),
  LOGTO_PROXY_URL: optionalString,
  LOGTO_WEBHOOK_SIGNING_KEY: optionalString,
  IDP_TARGET: z.string().default('Telegram'),
  LOGIN_APP_CLIENT_ID: optionalString,
  LOGIN_REDIRECT_URI: z.string().default('https://auth.haori.ink/'),
  OTT_TTL: z.coerce.number().int().positive().default(600),

  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_PROXY_URL: optionalString,
  TELEGRAM_MODE: z.enum(['webhook', 'polling']).default('webhook'),
  TELEGRAM_POLL_TIMEOUT: z.coerce.number().int().positive().max(120).default(30),
  TELEGRAM_WS_RELAY: optionalString,
  TELEGRAM_WS_RELAY_TOKEN: optionalString,
  TELEGRAM_WEBHOOK_SECRET: optionalString,
  BOT_PUBLIC_URL: optionalString,
  ADMIN_TG_IDS: csv,

  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DB_PATH: z.string().default('./data/bot.db'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DRY_RUN: boolish,
  PROXY_USE_ENV_FALLBACK: z
    .string()
    .optional()
    .transform((value) => value === undefined || value === '' || value === '1' || value.toLowerCase() === 'true'),
  PROXY_NO_PROXY: optionalString,
  WS_ENABLED: boolish,
  WS_TOKEN: optionalString,
  NOTIFY_DEFAULTS: csv,
});

export type AppConfig = {
  logto: {
    endpoint: string;
    m2mClientId?: string;
    m2mClientSecret?: string;
    managementResource: string;
    proxyUrl?: string;
    webhookSigningKey?: string;
    idpTarget: string;
    loginAppClientId?: string;
    loginRedirectUri: string;
    ottTtl: number;
  };
  telegram: {
    token: string;
    webhookSecret?: string;
    publicUrl?: string;
    adminIds: number[];
    proxyUrl?: string;
    mode: 'webhook' | 'polling';
    pollTimeout: number;
    relayUrl?: string;
    relayToken?: string;
  };
  ws: { enabled: boolean; token?: string };
  runtime: {
    port: number;
    host: string;
    dbPath: string;
    logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
    dryRun: boolean;
    notifyDefaults: string[];
    proxyEnvFallback: boolean;
    noProxy?: string;
  };
};

export const NOTIFICATION_KINDS = ['signin', 'password', 'security', 'account', 'role'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Parse and validate the process environment. Fails fast with a readable list
 * of problems instead of exploding on the first undefined value.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment: ${details}`);
  }

  const value = parsed.data;
  const adminIds = value.ADMIN_TG_IDS.map((raw) => Number.parseInt(raw, 10)).filter((id) =>
    Number.isSafeInteger(id),
  );

  const notifyDefaults = value.NOTIFY_DEFAULTS.filter((kind): kind is NotificationKind =>
    (NOTIFICATION_KINDS as readonly string[]).includes(kind),
  );

  return {
    logto: {
      endpoint: value.LOGTO_ENDPOINT,
      m2mClientId: value.LOGTO_M2M_CLIENT_ID,
      m2mClientSecret: value.LOGTO_M2M_CLIENT_SECRET,
      managementResource: value.LOGTO_MANAGEMENT_RESOURCE,
      proxyUrl: value.LOGTO_PROXY_URL,
      webhookSigningKey: value.LOGTO_WEBHOOK_SIGNING_KEY,
      idpTarget: value.IDP_TARGET,
      loginAppClientId: value.LOGIN_APP_CLIENT_ID,
      loginRedirectUri: value.LOGIN_REDIRECT_URI,
      ottTtl: value.OTT_TTL,
    },
    telegram: {
      token: value.TELEGRAM_BOT_TOKEN,
      webhookSecret: value.TELEGRAM_WEBHOOK_SECRET,
      publicUrl: value.BOT_PUBLIC_URL,
      adminIds,
      proxyUrl: value.TELEGRAM_PROXY_URL,
      mode: value.TELEGRAM_MODE,
      pollTimeout: value.TELEGRAM_POLL_TIMEOUT,
      relayUrl: value.TELEGRAM_WS_RELAY,
      relayToken: value.TELEGRAM_WS_RELAY_TOKEN,
    },
    ws: { enabled: value.WS_ENABLED, token: value.WS_TOKEN },
    runtime: {
      port: value.PORT,
      host: value.HOST,
      dbPath: value.DB_PATH,
      logLevel: value.LOG_LEVEL,
      dryRun: value.DRY_RUN,
      notifyDefaults: notifyDefaults.length > 0 ? notifyDefaults : ['signin', 'password', 'security', 'account'],
      proxyEnvFallback: value.PROXY_USE_ENV_FALLBACK,
      noProxy: value.PROXY_NO_PROXY,
    },
  };
};

/** Token part used for logging, e.g. `9220371633:***`. */
export const maskBotToken = (token: string): string => {
  const [id] = token.split(':');
  return `${id ?? 'unknown'}:***`;
};
