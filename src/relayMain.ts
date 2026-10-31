import { pino } from 'pino';

import { createDispatcher, parseProxyUrl } from './net/proxy.js';
import { createRelayServer } from './net/wsRelayServer.js';

/**
 * Standalone WebSocket relay entry point (compiled to `dist/relayMain.js` so it
 * ships in the Docker image; `scripts/ws-relay.ts` just imports it).
 *
 * Env: RELAY_PORT (8081), RELAY_HOST (0.0.0.0), RELAY_TOKEN (required),
 *      RELAY_UPSTREAM (https://api.telegram.org), RELAY_PROXY (optional).
 */
export const runRelay = async (): Promise<void> => {
  const token = process.env.RELAY_TOKEN ?? '';
  if (!token) {
    console.error('RELAY_TOKEN is required');
    process.exit(1);
  }

  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'ws-relay' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

  const proxyUrl = process.env.RELAY_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY;
  const relay = createRelayServer({
    token,
    logger,
    upstream: process.env.RELAY_UPSTREAM ?? 'https://api.telegram.org',
    dispatcher: proxyUrl ? createDispatcher(parseProxyUrl(proxyUrl)) : undefined,
  });

  const port = await relay.listen(Number(process.env.RELAY_PORT ?? 8081), process.env.RELAY_HOST ?? '0.0.0.0');
  logger.info({ port, proxy: proxyUrl ? parseProxyUrl(proxyUrl).source : 'direct' }, 'ws relay listening');

  const shutdown = async (): Promise<void> => {
    await relay.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
};
