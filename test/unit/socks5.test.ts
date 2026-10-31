import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, connect, type AddressInfo, type Socket } from 'node:net';

import { Agent, fetch as undiciFetch } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';

import { socksConnect } from '../../src/net/socks5.js';

type Closeable = { port: number; close: () => Promise<void> };

const startUpstream = async (): Promise<Closeable> => {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('hello-socks');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

/** Minimal SOCKS5 server: no-auth and user/password authentication. */
const startSocks = async (options: { auth?: { username: string; password: string } } = {}): Promise<Closeable> => {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', (greeting) => {
      const methods = [...greeting.subarray(2, 2 + (greeting[1] ?? 0))];
      if (options.auth) {
        if (!methods.includes(0x02)) {
          socket.end(Buffer.from([0x05, 0xff]));
          return;
        }
        socket.write(Buffer.from([0x05, 0x02]));
        socket.once('data', (auth) => {
          const userLength = auth[1] ?? 0;
          const username = auth.subarray(2, 2 + userLength).toString();
          const passwordLength = auth[2 + userLength] ?? 0;
          const password = auth.subarray(3 + userLength, 3 + userLength + passwordLength).toString();
          if (username !== options.auth!.username || password !== options.auth!.password) {
            socket.end(Buffer.from([0x01, 0x01]));
            return;
          }
          socket.write(Buffer.from([0x01, 0x00]));
          socket.once('data', (request) => handleRequest(socket, request));
        });
        return;
      }

      socket.write(Buffer.from([0x05, 0x00]));
      socket.once('data', (request) => handleRequest(socket, request));
    });
  });

  const handleRequest = (client: Socket, request: Buffer): void => {
    const atyp = request[3];
    let host: string;
    let offset: number;
    if (atyp === 0x01) {
      host = [...request.subarray(4, 8)].join('.');
      offset = 8;
    } else if (atyp === 0x03) {
      const length = request[4] ?? 0;
      host = request.subarray(5, 5 + length).toString();
      offset = 5 + length;
    } else {
      client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      return;
    }
    const port = request.readUInt16BE(offset);

    const upstream = connect(port, host, () => {
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
  };

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
};

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (closers.length > 0) {
    await closers.pop()?.();
  }
});

const fetchThroughSocks = async (input: {
  socksPort: number;
  url: string;
  username?: string;
  password?: string;
}): Promise<Response> => {
  const agent = new Agent({
    connect: ((options: { hostname: string; port: string | number }, callback: (error: Error | null, socket: Socket | null) => void) => {
      socksConnect({
        proxy: { host: '127.0.0.1', port: input.socksPort, username: input.username, password: input.password },
        destination: { host: options.hostname, port: Number(options.port) },
      })
        .then((socket) => callback(null, socket))
        .catch((error: Error) => callback(error, null));
    }) as never,
  });

  return undiciFetch(input.url, { dispatcher: agent }) as unknown as Promise<Response>;
};

describe('SOCKS5 tunnel', () => {
  it('fetches through a no-auth SOCKS5 proxy', async () => {
    const upstream = await startUpstream();
    const socks = await startSocks();
    closers.push(upstream.close, socks.close);

    const response = await fetchThroughSocks({
      socksPort: socks.port,
      url: `http://127.0.0.1:${upstream.port}/`,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello-socks');
  });

  it('authenticates with username/password', async () => {
    const upstream = await startUpstream();
    const socks = await startSocks({ auth: { username: 'user', password: 'pass' } });
    closers.push(upstream.close, socks.close);

    const response = await fetchThroughSocks({
      socksPort: socks.port,
      url: `http://127.0.0.1:${upstream.port}/`,
      username: 'user',
      password: 'pass',
    });

    expect(await response.text()).toBe('hello-socks');
  });

  it('rejects wrong credentials', async () => {
    const upstream = await startUpstream();
    const socks = await startSocks({ auth: { username: 'user', password: 'pass' } });
    closers.push(upstream.close, socks.close);

    await expect(
      fetchThroughSocks({
        socksPort: socks.port,
        url: `http://127.0.0.1:${upstream.port}/`,
        username: 'user',
        password: 'wrong',
      }),
    ).rejects.toThrow();
  });

  it('surfaces an unreachable proxy as an error', async () => {
    await expect(
      socksConnect({
        proxy: { host: '127.0.0.1', port: 1 },
        destination: { host: 'example.com', port: 80 },
        timeoutMs: 1000,
      }),
    ).rejects.toThrow();
  });
});
