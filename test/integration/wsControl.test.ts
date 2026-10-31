import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { pino } from 'pino';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { EventBus } from '../../src/net/events.js';
import { attachControlChannel } from '../../src/net/wsControl.js';

const logger = pino({ level: 'silent' });
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

const startChannel = async (bus: EventBus, token = 'ws-secret') => {
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.end('ok');
  });
  const detach = attachControlChannel(server, {
    token,
    logger,
    bus,
    handlers: {
      stats: () => ({ users: 7, transport: 'ws-relay' }),
      recentEvents: (limit) => [{ event: 'PostSignIn', limit }],
      sendTest: (chatId, text) => ({ queued: true, chatId, text }),
      reload: () => ({ targets: ['account'] }),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    detach();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port };
};

type Opened = {
  socket: WebSocket;
  nextJson: () => Promise<Record<string, unknown>>;
  opened: Promise<void>;
};

/**
 * Attach the frame collector *before* awaiting `open`: the server may deliver
 * `hello` in the same tick as the handshake, so a late listener would drop it.
 */
const open = (port: number, token = 'ws-secret', topics?: string): Opened => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}${topics ? `&topics=${topics}` : ''}`);
  const nextJson = collector(socket);
  const opened = new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
    socket.once('error', reject);
  });
  return { socket, nextJson, opened };
};

/** Buffered reader: frames that arrive before we await are queued, not lost. */
const collector = (socket: WebSocket): (() => Promise<Record<string, unknown>>) => {
  const queue: Record<string, unknown>[] = [];
  const waiters: ((value: Record<string, unknown>) => void)[] = [];

  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(frame);
    } else {
      queue.push(frame);
    }
  });

  return () =>
    queue.length > 0
      ? Promise.resolve(queue.shift() as Record<string, unknown>)
      : new Promise((resolve) => waiters.push(resolve));
};

describe('ws control channel', () => {
  it('rejects a wrong token with 401', async () => {
    const bus = new EventBus();
    const { port } = await startChannel(bus);
    await expect(open(port, 'wrong').opened).rejects.toThrow('HTTP 401');
  });

  it('sends a hello frame with recent events', async () => {
    const bus = new EventBus();
    bus.emit('logto_event', { event: 'PostSignIn' });
    const { port } = await startChannel(bus);

    const { socket, nextJson, opened } = open(port);
    cleanups.push(() => socket.close());
    await opened;
    const hello = await nextJson();

    expect(hello.t).toBe('hello');
    expect(Array.isArray(hello.recent)).toBe(true);
    expect((hello.recent as unknown[]).length).toBe(1);
  });

  it('answers commands', async () => {
    const bus = new EventBus();
    const { port } = await startChannel(bus);
    const { socket, nextJson, opened } = open(port);
    cleanups.push(() => socket.close());
    await opened;
    await nextJson(); // hello

    socket.send(JSON.stringify({ t: 'cmd', id: '1', name: 'stats' }));
    const stats = await nextJson();
    expect(stats).toMatchObject({ t: 'result', id: '1', ok: true });
    expect(stats.data).toMatchObject({ users: 7 });

    socket.send(JSON.stringify({ t: 'cmd', id: '2', name: 'send_test', args: { chatId: 42, text: 'hi' } }));
    const sent = await nextJson();
    expect(sent.data).toMatchObject({ queued: true, chatId: 42 });

    socket.send(JSON.stringify({ t: 'cmd', id: '3', name: 'nope' }));
    const unknown = await nextJson();
    expect(unknown).toMatchObject({ ok: false });
  });

  it('streams events, honouring the topics filter', async () => {
    const bus = new EventBus();
    const { port } = await startChannel(bus);
    const { socket, nextJson, opened } = open(port, 'ws-secret', 'outbox');
    cleanups.push(() => socket.close());
    await opened;
    await nextJson(); // hello

    bus.emit('logto_event', { event: 'ignored' });
    bus.emit('outbox', { status: 'sent' });

    const event = await nextJson();
    expect(event).toMatchObject({ t: 'event', name: 'outbox' });
  });
});
