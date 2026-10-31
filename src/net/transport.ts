import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { createFetch, createTelegramFetch, type FetchLike } from './httpClient.js';
import { createDispatcher, createTunnelAgent, describeProxy, resolveProxy, type ProxyConfig } from './proxy.js';
import { WsRelayClient } from './wsRelayClient.js';

export type TelegramTransport = {
  fetch: FetchLike;
  relay?: WsRelayClient;
  proxy?: ProxyConfig;
  /** human readable: `direct`, `socks5h://host:1080`, `ws-relay wss://…` */
  describe: string;
  close: () => void;
};

export const proxyEnvFor = (config: AppConfig): NodeJS.ProcessEnv => {
  const base = config.runtime.proxyEnvFallback ? process.env : {};
  return config.runtime.noProxy ? { ...base, NO_PROXY: config.runtime.noProxy } : { ...base };
};

/**
 * Single place that decides how Bot API traffic leaves the process:
 * WS relay > explicit/env proxy > direct. Also used by the CLI and doctor.
 */
export const createTelegramTransport = (config: AppConfig, logger: Logger): TelegramTransport => {
  const proxy = resolveProxy({
    explicit: config.telegram.proxyUrl,
    env: proxyEnvFor(config),
    targetHost: 'api.telegram.org',
  });

  if (config.telegram.relayUrl) {
    const isSecureRelay = config.telegram.relayUrl.startsWith('wss:');
    const relay = new WsRelayClient({
      url: config.telegram.relayUrl,
      token: config.telegram.relayToken,
      logger,
      // An https.Agent only makes sense for wss://; plain ws:// (local tests)
      // must connect directly.
      agent: proxy && isSecureRelay ? createTunnelAgent(proxy) : undefined,
    });
    relay.start();

    return {
      fetch: relay.fetch,
      relay,
      proxy,
      describe: `ws-relay ${config.telegram.relayUrl}${proxy ? ` via ${describeProxy(proxy)}` : ''}`,
      close: () => relay.close(),
    };
  }

  const fetchImpl = createTelegramFetch({
    dispatcher: proxy ? createDispatcher(proxy) : undefined,
    pollTimeoutSeconds: config.telegram.pollTimeout,
  });

  return {
    fetch: fetchImpl,
    proxy,
    describe: proxy ? describeProxy(proxy) : 'direct',
    close: () => undefined,
  };
};

export const createLogtoFetch = (config: AppConfig): FetchLike => {
  const proxy = resolveProxy({
    explicit: config.logto.proxyUrl,
    env: proxyEnvFor(config),
    targetHost: new URL(config.logto.endpoint).hostname,
  });

  return createFetch({
    dispatcher: proxy ? createDispatcher(proxy) : undefined,
    timeoutMs: 20_000,
  });
};

export { createFetch, createTelegramFetch };
