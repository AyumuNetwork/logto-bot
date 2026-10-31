import { pino } from 'pino';
import type { Logger as PinoLogger } from 'pino';

import type { AppConfig } from './config.js';

export type Logger = PinoLogger;

const REDACT_PATHS = [
  'token',
  'access_token',
  'accessToken',
  'clientSecret',
  'client_secret',
  '*.token',
  '*.access_token',
  'req.headers.authorization',
];

export const createLogger = (config: AppConfig): Logger =>
  pino({
    level: config.runtime.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'logto-bot' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
