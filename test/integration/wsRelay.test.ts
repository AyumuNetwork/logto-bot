import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createRelayServer, type RelayServer } from '../../src/net/wsRelayServer.js';
import { WsRelayClient } from '../../src/net/wsRelayClient.js';

const logger = pino({ level: 'silent' });
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

const startUpstream = async (): Promise<{ port: number }> => {
  const server = createHttpServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, method: request.method, path: request.url, body }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port };
};

const startRelay = async (upstreamPort: number, token = 'secret'): Promise<RelayServer> => {
  const relay = createRelayServer({
    token,
    logger,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    allowPath: /^\//,
  });
  const port = await relay.listen(0, '127.0.0.1');
  cleanups.push(() => relay.close());
  return Object.assign(relay, { port });
};

describe('ws relay', () => {
  it('round-trips a Bot API call over a single wss connection', async () => {
    const upstream = await startUpstream();
    const relay = await startRelay(upstream.port);
    const port = (relay as unknown as { port: number }).port;

    const client = new WsRelayClient({
      url: `ws://127.0.0.1:${port}`,
      token: 'secret',
      logger,
    });
    cleanups.push(() => client.close());

    const response = await client.fetch('https://api.telegram.org/bot123:ABC/getMe', { method: 'GET' });
    const payload = (await response.json()) as { path: string; method: string };

    expect(response.status).toBe(200);
    expect(payload.path).toBe('/bot123:ABC/getMe');
    expect(payload.method).toBe('GET');
  });

  it('forwards request bodies', async () => {
    const upstream = await startUpstream();
    const relay = await startRelay(upstream.port);
    const port = (relay as unknown as { port: number }).port;

    const client = new WsRelayClient({ url: `ws://127.0.0.1:${port}`, token: 'secret', logger });
    cleanups.push(() => client.close());

    const response = await client.fetch('https://api.telegram.org/bot123/sendMessage', {
      method: 'POST',
      body: JSON.stringify({ chat_id: 1, text: 'hi' }),
      headers: { 'content-type': 'application/json' },
    });
    const payload = (await response.json()) as { body: string; method: string };

    expect(payload.method).toBe('POST');
    expect(JSON.parse(payload.body)).toEqual({ chat_id: 1, text: 'hi' });
  });

  it('rejects a wrong token and disallowed paths', async () => {
    const upstream = await startUpstream();
    const relay = await startRelay(upstream.port);
    const port = (relay as unknown as { port: number }).port;

    const badClient = new WsRelayClient({
      url: `ws://127.0.0.1:${port}`,
      token: 'nope',
      logger,
      connectTimeoutMs: 1_200,
    });
    cleanups.push(() => badClient.close());
    await expect(badClient.fetch('https://api.telegram.org/bot1/getMe')).rejects.toThrow();

    const strictRelay = createRelayServer({
      token: 'secret',
      logger,
      upstream: `http://127.0.0.1:${upstream.port}`,
    });
    const strictPort = await strictRelay.listen(0, '127.0.0.1');
    cleanups.push(() => strictRelay.close());

    const client = new WsRelayClient({ url: `ws://127.0.0.1:${strictPort}`, token: 'secret', logger });
    cleanups.push(() => client.close());

    await expect(client.fetch('https://api.telegram.org/v1/accounts')).rejects.toThrow(/path not allowed/);
  });

  it('reconnects after the relay restarts', async () => {
    const upstream = await startUpstream();
    const first = await startRelay(upstream.port);
    const port = (first as unknown as { port: number }).port;

    const client = new WsRelayClient({
      url: `ws://127.0.0.1:${port}`,
      token: 'secret',
      logger,
      maxReconnectDelayMs: 200,
    });
    cleanups.push(() => client.close());

    expect((await client.fetch('https://api.telegram.org/bot1/getMe')).status).toBe(200);

    // Drop the live sockets (simulates a relay restart) and let the client reconnect.
    for (const socket of first.wss.clients) {
      socket.terminate();
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await client.fetch('https://api.telegram.org/bot1/getMe')).status).toBe(200);
  });
});
