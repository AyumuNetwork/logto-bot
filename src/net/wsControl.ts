import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';

import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import type { Logger } from '../logger.js';
import type { BusEvent, EventBus } from './events.js';

export type ControlHandlers = {
  stats: () => unknown;
  recentEvents: (limit: number) => unknown;
  sendTest: (chatId: number, text: string) => Promise<unknown> | unknown;
  reload: () => Promise<unknown> | unknown;
};

export type ControlOptions = {
  token: string;
  logger: Logger;
  bus: EventBus;
  handlers: ControlHandlers;
  path?: string;
};

const safeEqual = (left: string | undefined, right: string): boolean => {
  if (!left) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Local control channel (`GET /ws?token=…&topics=logto_event,outbox`).
 *
 * Server -> client: `{t:'event', name, at, data}` plus a `hello` frame with the
 * recent ring buffer.
 * Client -> server: `{t:'cmd', id, name, args}` where name is one of
 * `stats` | `recent_events` | `send_test` | `reload`.
 */
export const attachControlChannel = (server: Server, options: ControlOptions): (() => void) => {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const path = options.path ?? '/ws';
  const unsubscribe: (() => void)[] = [];

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://bot.local');
    if (url.pathname !== path) {
      return;
    }

    const headerToken = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const token = url.searchParams.get('token') ?? headerToken;
    if (!safeEqual(token, options.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, url);
    });
  });

  wss.on('connection', (ws: WebSocket, _request: IncomingMessage, url: URL) => {
    const topics = (url.searchParams.get('topics') ?? '').split(',').map((topic) => topic.trim()).filter(Boolean);
    const subscribed = (event: BusEvent): boolean => topics.length === 0 || topics.includes(event.name);

    const send = (payload: unknown): void => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    };

    // Subscribe before greeting: an event emitted right after the handshake
    // must not be lost between the hello frame and the subscription.
    const recent = options.bus.recent(topics, 20);
    unsubscribe.push(
      options.bus.onEvent((event) => {
        if (subscribed(event)) {
          send({ t: 'event', ...event });
        }
      }),
    );

    send({ t: 'hello', topics, recent });

    ws.on('message', (raw: RawData) => {
      let frame: { t?: string; id?: string; name?: string; args?: Record<string, unknown> };
      try {
        frame = JSON.parse(raw.toString()) as typeof frame;
      } catch {
        send({ t: 'result', id: '0', ok: false, error: 'invalid json' });
        return;
      }

      if (frame.t === 'cmd' && frame.name) {
        void handleCommand(frame, send);
        return;
      }

      if (frame.t === 'ping') {
        send({ t: 'pong' });
      }
    });
  });

  return () => {
    for (const off of unsubscribe) off();
    wss.close();
  };

  async function handleCommand(
    frame: { id?: string; name?: string; args?: Record<string, unknown> },
    send: (payload: unknown) => void,
  ): Promise<void> {
    const id = frame.id ?? '0';
    try {
      switch (frame.name) {
        case 'stats':
          send({ t: 'result', id, ok: true, data: options.handlers.stats() });
          return;
        case 'recent_events':
          send({
            t: 'result',
            id,
            ok: true,
            data: options.handlers.recentEvents(Number(frame.args?.limit ?? 20)),
          });
          return;
        case 'send_test': {
          const chatId = Number(frame.args?.chatId);
          const text = String(frame.args?.text ?? 'ws test');
          if (!Number.isFinite(chatId)) {
            send({ t: 'result', id, ok: false, error: 'chatId required' });
            return;
          }
          const result = await options.handlers.sendTest(chatId, text);
          send({ t: 'result', id, ok: true, data: result });
          return;
        }
        case 'reload':
          send({ t: 'result', id, ok: true, data: await options.handlers.reload() });
          return;
        default:
          send({ t: 'result', id, ok: false, error: `unknown command: ${frame.name}` });
      }
    } catch (error) {
      options.logger.warn({ error: (error as Error).message, command: frame.name }, 'ws control command failed');
      send({ t: 'result', id, ok: false, error: (error as Error).message });
    }
  }
};
