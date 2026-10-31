import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import type { Dispatcher } from 'undici';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import type { Logger } from '../logger.js';
import { createFetch, type FetchLike } from './httpClient.js';

export type RelayServerOptions = {
  token: string;
  logger: Logger;
  upstream?: string;
  maxBodyBytes?: number;
  maxConcurrent?: number;
  allowPath?: RegExp;
  /** Optional dispatcher (e.g. an outbound proxy) for upstream calls. */
  dispatcher?: Dispatcher;
  fetch?: FetchLike;
};

export type RelayServer = {
  server: Server;
  wss: WebSocketServer;
  listen: (port: number, host?: string) => Promise<number>;
  close: () => Promise<void>;
};

type RelReqFrame = {
  t: 'req';
  id: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

const DEFAULT_ALLOW_PATH = /^\/bot[^/]+\/[A-Za-z]+/;

const safeEqual = (a: string | undefined, b: string): boolean => {
  if (!a) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * WebSocket relay server: accepts `{t:'req'}` frames and forwards them to a
 * fixed allow-listed upstream (api.telegram.org). It never proxies arbitrary
 * hosts, and it enforces a shared token, body and concurrency limits.
 */
export const createRelayServer = (options: RelayServerOptions): RelayServer => {
  const upstream = (options.upstream ?? 'https://api.telegram.org').replace(/\/+$/, '');
  const allowPath = options.allowPath ?? DEFAULT_ALLOW_PATH;
  const maxBodyBytes = options.maxBodyBytes ?? 8 * 1024 * 1024;
  const maxConcurrent = options.maxConcurrent ?? 32;
  const upstreamFetch = options.fetch ?? createFetch({ dispatcher: options.dispatcher, timeoutMs: 0 });

  const server = createServer((request, response) => {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: maxBodyBytes });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://relay.local');
    const headerToken = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const token = url.searchParams.get('token') ?? headerToken;

    if (!safeEqual(token, options.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  wss.on('connection', (ws: WebSocket) => {
    let inFlight = 0;

    const send = (payload: unknown): void => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    };

    ws.on('message', (raw: RawData) => {
      let frame: RelReqFrame | { t: string };
      try {
        frame = JSON.parse(raw.toString()) as RelReqFrame;
      } catch {
        send({ t: 'err', id: '0', message: 'invalid frame' });
        return;
      }

      if ((frame as { t: string }).t === 'ping') {
        send({ t: 'pong' });
        return;
      }

      const request = frame as RelReqFrame;
      if (request.t !== 'req' || !request.id || !request.path) {
        send({ t: 'err', id: request.id ?? '0', message: 'invalid request frame' });
        return;
      }

      if (!allowPath.test(request.path)) {
        send({ t: 'err', id: request.id, message: 'path not allowed' });
        return;
      }

      if (inFlight >= maxConcurrent) {
        send({ t: 'err', id: request.id, message: 'too many concurrent requests' });
        return;
      }

      inFlight += 1;
      const body = request.body ? Buffer.from(request.body, 'base64') : undefined;
      if (body && body.length > maxBodyBytes) {
        inFlight -= 1;
        send({ t: 'err', id: request.id, message: 'body too large' });
        return;
      }

      void (async () => {
        try {
          const response = await upstreamFetch(`${upstream}${request.path}`, {
            method: request.method ?? 'GET',
            headers: request.headers ?? {},
            ...(body ? { body } : {}),
            signal: AbortSignal.timeout(request.timeoutMs ?? 35_000),
          });
          const buffer = Buffer.from(await response.arrayBuffer());
          send({
            t: 'res',
            id: request.id,
            status: response.status,
            headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
            body: buffer.toString('base64'),
          });
        } catch (error) {
          options.logger.warn({ error: (error as Error).message }, 'relay upstream request failed');
          send({ t: 'err', id: request.id, message: (error as Error).message });
        } finally {
          inFlight -= 1;
        }
      })();
    });

    ws.on('error', (error) => {
      options.logger.debug({ error: (error as Error).message }, 'relay socket error');
    });
  });

  const listen = (port: number, host = '0.0.0.0'): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { server, wss, listen, close };
};
