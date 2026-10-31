import { randomUUID } from 'node:crypto';

import { WebSocket } from 'ws';

import type { Logger } from '../logger.js';
import type { FetchLike } from './httpClient.js';

type Resolved = { status: number; headers: Record<string, string>; body: Buffer };
type Pending = {
  resolve: (value: Resolved) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type RelayClientOptions = {
  url: string;
  token?: string;
  logger: Logger;
  /** optional https.Agent (e.g. built from a proxy) */
  agent?: import('node:https').Agent;
  requestTimeoutMs?: number;
  heartbeatMs?: number;
  maxReconnectDelayMs?: number;
  /** how long `fetch` waits for the connection before failing */
  connectTimeoutMs?: number;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isGetUpdates = (input: string): boolean => input.includes('/getUpdates');

/**
 * Outbound-only WebSocket relay: every Bot API call is multiplexed over a
 * single `wss://` connection, which is all you need when the bot host has no
 * inbound port and/or cannot reach api.telegram.org directly.
 *
 * Frames are JSON; request/response bodies are base64.
 */
export class WsRelayClient {
  private socket?: WebSocket;
  private started = false;
  private connected = false;
  private waiters: { resolve: () => void }[] = [];
  private closed = false;
  private attempts = 0;
  private heartbeatTimer?: NodeJS.Timeout;
  private lastPongAt = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly base: URL;

  constructor(private readonly options: RelayClientOptions) {
    this.base = new URL(options.url);
  }

  /** Start the reconnect loop (idempotent). */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.run();
  }

  private async run(): Promise<void> {
    while (!this.closed) {
      try {
        await this.openOnce();
        await this.waitForClose();
        this.options.logger.warn('ws relay connection closed');
      } catch (error) {
        this.options.logger.warn({ error: (error as Error).message }, 'ws relay connection failed');
      }

      if (this.closed) break;
      this.attempts += 1;
      const delay =
        Math.min(this.options.maxReconnectDelayMs ?? 30_000, 500 * 2 ** Math.min(this.attempts, 6)) +
        Math.random() * 250;
      await sleep(delay);
    }
  }

  private openOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = new URL(this.base);
      if (this.options.token) {
        url.searchParams.set('token', this.options.token);
      }

      const socket = new WebSocket(url, {
        ...(this.options.agent && url.protocol === 'wss:' ? { agent: this.options.agent } : {}),
        handshakeTimeout: 15_000,
      });
      this.socket = socket;

      const onOpen = (): void => {
        this.attempts = 0;
        this.connected = true;
        this.lastPongAt = Date.now();
        this.startHeartbeat();
        this.options.logger.info({ relay: this.base.origin }, 'ws relay connected');
        for (const waiter of this.waiters.splice(0)) {
          waiter.resolve();
        }
        resolve();
      };

      socket.once('open', onOpen);
      socket.once('error', (error) => {
        socket.removeListener('open', onOpen);
        reject(error as Error);
      });
      socket.on('message', (data) => this.handleMessage(data));
      socket.on('close', () => {
        this.connected = false;
        this.stopHeartbeat();
        this.socket = undefined;
        this.rejectAll('ws relay connection lost');
      });
    });
  }

  private closeSignal?: () => void;

  private waitForClose(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.closeSignal = resolve;
      this.socket?.once('close', () => resolve());
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.options.heartbeatMs ?? 30_000;
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPongAt > interval * 2.5) {
        this.options.logger.warn('ws relay heartbeat timed out, reconnecting');
        this.socket.terminate();
        return;
      }
      this.socket.send(JSON.stringify({ t: 'ping' }));
    }, interval);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let frame: { t?: string; id?: string; status?: number; headers?: Record<string, string>; body?: string; message?: string };
    try {
      frame = JSON.parse(raw.toString()) as typeof frame;
    } catch {
      return;
    }

    if (frame.t === 'pong') {
      this.lastPongAt = Date.now();
      return;
    }

    if (frame.t === 'ping') {
      this.socket?.send(JSON.stringify({ t: 'pong' }));
      return;
    }

    if (!frame.id) return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);

    if (frame.t === 'err') {
      pending.reject(new Error(frame.message ?? 'relay error'));
      return;
    }

    pending.resolve({
      status: frame.status ?? 502,
      headers: frame.headers ?? {},
      body: Buffer.from(frame.body ?? '', 'base64'),
    });
  }

  private rejectAll(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.pending.delete(id);
    }
  }

  private async ensureReady(timeoutMs = this.options.connectTimeoutMs ?? 15_000): Promise<void> {
    this.start();
    if (this.connected && this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.resolve !== wrapped);
        reject(new Error('ws relay not connected'));
      }, timeoutMs);

      const wrapped = (): void => {
        clearTimeout(timer);
        resolve();
      };

      this.waiters.push({ resolve: wrapped });
    });

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('ws relay not connected');
    }
  }

  fetch: FetchLike = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const parsed = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const bodyBuffer =
      typeof init?.body === 'string'
        ? Buffer.from(init.body)
        : init?.body && Buffer.isBuffer(init.body)
          ? init.body
          : init?.body
            ? Buffer.from(String(init.body))
            : undefined;

    await this.ensureReady();

    const id = randomUUID();
    const timeoutMs = isGetUpdates(url) ? 75_000 : (this.options.requestTimeoutMs ?? 40_000);

    const response = await new Promise<Resolved>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ws relay request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      this.socket!.send(
        JSON.stringify({
          t: 'req',
          id,
          method,
          path: `${parsed.pathname}${parsed.search}`,
          headers: {
            'content-type': (init?.headers as Record<string, string> | undefined)?.['content-type'] ?? 'application/json',
          },
          body: bodyBuffer ? bodyBuffer.toString('base64') : undefined,
          timeoutMs: timeoutMs - 1_000,
        }),
      );
    });

    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  }) as FetchLike;

  close(): void {
    this.closed = true;
    this.closeSignal?.();
    this.stopHeartbeat();
    this.rejectAll('ws relay closed');
    this.socket?.close();
    this.socket = undefined;
  }
}
