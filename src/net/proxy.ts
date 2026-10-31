import { Agent as HttpsAgent } from 'node:https';
import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';

import { Agent, ProxyAgent, type Dispatcher } from 'undici';

import { socksConnect } from './socks5.js';

export type ProxyKind = 'http' | 'https' | 'socks5' | 'socks5h';

export type ProxyConfig = {
  kind: ProxyKind;
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** original string, for logging (never includes credentials) */
  source: string;
};

export class ProxyConfigError extends Error {
  override name = 'ProxyConfigError';
}

const DEFAULT_PORTS: Record<ProxyKind, number> = { http: 8080, https: 443, socks5: 1080, socks5h: 1080 };

/**
 * Parse `http://`, `https://`, `socks5://`, `socks5h://` (credentials allowed).
 * A bare `host:port` is treated as an HTTP proxy.
 */
export const parseProxyUrl = (raw: string): ProxyConfig => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ProxyConfigError('empty proxy url');
  }

  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ProxyConfigError(`invalid proxy url: ${trimmed}`);
  }

  const protocol = url.protocol.replace(':', '').toLowerCase();
  const kind = (['http', 'https', 'socks5', 'socks5h'].includes(protocol) ? protocol : undefined) as
    | ProxyKind
    | undefined;

  if (!kind) {
    throw new ProxyConfigError(`unsupported proxy protocol: ${protocol} (use http/https/socks5/socks5h)`);
  }

  const port = url.port ? Number(url.port) : DEFAULT_PORTS[kind];
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new ProxyConfigError(`invalid proxy port: ${url.port}`);
  }

  return {
    kind,
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    source: `${kind}://${url.hostname}:${port}`,
  };
};

/** Never log credentials. */
/**
 * undici passes an empty string for the default port (`''`) and `null` for the
 * servername, so both must be derived from the request protocol/host.
 */
export const resolveDestinationPort = (port: string | number | undefined, protocol: string): number =>
  Number(port) || (protocol === 'https:' ? 443 : 80);

export const describeProxy = (proxy: ProxyConfig): string =>
  `${proxy.kind}://${proxy.host}:${proxy.port}${proxy.username ? ' (auth)' : ''}`;

const hostMatchesNoProxy = (host: string, noProxy?: string): boolean => {
  if (!noProxy) return false;
  return noProxy
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') return true;
      const candidate = host.toLowerCase();
      return candidate === entry || candidate.endsWith(`.${entry.replace(/^\./, '')}`);
    });
};

/**
 * Resolve the effective proxy for a target host:
 * explicit config -> HTTPS_PROXY/ALL_PROXY -> none, honouring NO_PROXY.
 */
export const resolveProxy = (input: {
  explicit?: string;
  env?: NodeJS.ProcessEnv;
  targetHost: string;
}): ProxyConfig | undefined => {
  const env = input.env ?? process.env;
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  if (hostMatchesNoProxy(input.targetHost, noProxy)) {
    return undefined;
  }

  const candidate =
    input.explicit ??
    env.HTTPS_PROXY ??
    env.https_proxy ??
    env.ALL_PROXY ??
    env.all_proxy;

  return candidate ? parseProxyUrl(candidate) : undefined;
};

type ConnectOptions = ConnectionOptions & { socket?: Socket };

/** Build the raw TCP socket for a destination, tunnelling through the proxy. */
const connectThroughProxy = (
  proxy: ProxyConfig,
  destination: { host: string; port: number },
): Promise<Socket> => {
  if (proxy.kind === 'socks5' || proxy.kind === 'socks5h') {
    return socksConnect({
      proxy: { host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password },
      destination,
      resolveLocally: proxy.kind === 'socks5',
    });
  }

  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host: proxy.host, port: proxy.port });
    const auth = proxy.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}\r\n`
      : '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new ProxyConfigError('proxy CONNECT timed out'));
    }, 10_000);

    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };

    const onError = (error: Error): void => finish(error);
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('latin1');
      const index = buffer.indexOf('\r\n\r\n');
      if (index === -1) return;
      const statusLine = buffer.split('\r\n')[0] ?? '';
      if (!/^HTTP\/1\.[01] 2\d\d/.test(statusLine)) {
        finish(new ProxyConfigError(`proxy CONNECT rejected: ${statusLine}`));
        return;
      }
      finish();
    };

    socket.once('connect', () => {
      socket.write(
        `CONNECT ${destination.host}:${destination.port} HTTP/1.1\r\n` +
          `Host: ${destination.host}:${destination.port}\r\n` +
          auth +
          '\r\n',
      );
    });
    socket.on('data', onData);
    socket.once('error', onError);
  });
};

const wrapTls = (
  socket: Socket,
  options: { servername: string; alpn?: string[] },
): Promise<Socket> =>
  new Promise<Socket>((resolve, reject) => {
    const tls = tlsConnect({
      socket,
      servername: options.servername,
      ALPNProtocols: options.alpn ?? ['http/1.1'],
    });
    tls.once('secureConnect', () => resolve(tls));
    tls.once('error', reject);
  });

/**
 * undici dispatcher for the given proxy. `http(s)` proxies use ProxyAgent,
 * SOCKS5 uses a custom connector (with TLS when the destination is https).
 */
export const createDispatcher = (proxy: ProxyConfig, options: { connections?: number } = {}): Dispatcher => {
  if (proxy.kind === 'http' || proxy.kind === 'https') {
    return new ProxyAgent({
      uri: `${proxy.kind}://${proxy.host}:${proxy.port}`,
      ...(proxy.username
        ? {
            token: `Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}`,
          }
        : {}),
      ...(options.connections ? { connections: options.connections } : {}),
    });
  }

  const connect = (
    opts: {
      hostname: string;
      port: string | number;
      protocol: string;
      servername?: string | null;
    },
    callback: (error: Error | null, socket: Socket | null) => void,
  ): void => {
    const port = resolveDestinationPort(opts.port, opts.protocol);
    connectThroughProxy(proxy, { host: opts.hostname, port })
      .then(async (socket) => {
        if (opts.protocol === 'https:') {
          const tls = await wrapTls(socket, { servername: opts.servername || opts.hostname });
          callback(null, tls);
          return;
        }
        callback(null, socket);
      })
      .catch((error: Error) => callback(error, null));
  };

  return new Agent({
    connect: connect as never,
    ...(options.connections ? { connections: options.connections } : {}),
  });
};

/**
 * `https.Agent` for libraries that speak `http.Agent` only (the `ws` client).
 * The socket is tunnelled through the proxy and TLS-wrapped by us.
 */
export const createTunnelAgent = (proxy: ProxyConfig): HttpsAgent => {
  const options = {
    keepAlive: true,
    createConnection: (
      opts: ConnectOptions,
      callback: (error: Error | null, socket?: Socket) => void,
    ) => {
      const host = opts.host ?? opts.servername ?? 'localhost';
      const port = resolveDestinationPort(opts.port, 'https:');
      connectThroughProxy(proxy, { host, port })
        .then((socket) => wrapTls(socket, { servername: opts.servername ?? host }))
        .then((tls) => callback(null, tls))
        .catch((error: Error) => callback(error));
    },
  } as unknown as ConstructorParameters<typeof HttpsAgent>[0];

  return new HttpsAgent(options);
};
