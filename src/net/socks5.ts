import { createConnection, type Socket } from 'node:net';

const SOCKS_VERSION = 0x05;
const AUTH_NONE = 0x00;
const AUTH_USERNAME_PASSWORD = 0x02;
const AUTH_NO_ACCEPTABLE = 0xff;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

export type SocksProxy = {
  host: string;
  port: number;
  username?: string;
  password?: string;
};

export type SocksDestination = { host: string; port: number };

class SocksError extends Error {
  override name = 'SocksError';
}

const fail = (message: string, onError: (error: Error) => void): void => {
  onError(new SocksError(message));
};

/**
 * Minimal SOCKS5 CONNECT implementation (RFC 1928 + RFC 1929 user/password).
 * Returns a raw TCP socket ready for TLS; used by the undici `Agent.connect`
 * hook and by the WebSocket tunnel agent.
 */
export const socksConnect = (input: {
  proxy: SocksProxy;
  destination: SocksDestination;
  timeoutMs?: number;
  /** false = let the proxy resolve the hostname (socks5h, default) */
  resolveLocally?: boolean;
}): Promise<Socket> =>
  new Promise<Socket>((resolve, reject) => {
    const { proxy, destination } = input;
    const socket = createConnection({ host: proxy.host, port: proxy.port });
    socket.setNoDelay(true);

    let settled = false;
    let stage: 'greeting' | 'auth' | 'connect' = 'greeting';
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => {
      finish(new SocksError(`SOCKS5 handshake timed out after ${input.timeoutMs ?? 10_000}ms`));
    }, input.timeoutMs ?? 10_000);

    const finish = (error?: Error, value?: Socket): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(value as Socket);
      }
    };

    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new SocksError('SOCKS5 proxy closed the connection'));

    const sendGreeting = (): void => {
      const methods = proxy.username ? [AUTH_NONE, AUTH_USERNAME_PASSWORD] : [AUTH_NONE];
      socket.write(Buffer.from([SOCKS_VERSION, methods.length, ...methods]));
    };

    const sendAuth = (): void => {
      const user = Buffer.from(proxy.username ?? '', 'utf8');
      const pass = Buffer.from(proxy.password ?? '', 'utf8');
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
    };

    const sendConnect = (): void => {
      const host = destination.host;
      const port = destination.port;
      const chunks: Buffer[] = [Buffer.from([SOCKS_VERSION, CMD_CONNECT, 0x00])];

      const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
      if (ipv4 && !input.resolveLocally) {
        chunks.push(Buffer.from([ATYP_IPV4, ...ipv4.slice(1).map((part) => Number(part))]));
      } else if (host.includes(':')) {
        const parts = host.split(':').flatMap((segment) => {
          if (segment === '') return [0, 0];
          const value = Number.parseInt(segment, 16);
          return [(value >> 8) & 0xff, value & 0xff];
        });
        chunks.push(Buffer.from([ATYP_IPV6, ...parts.slice(0, 16)]));
      } else {
        const name = Buffer.from(host, 'utf8');
        chunks.push(Buffer.from([ATYP_DOMAIN, name.length]), name);
      }

      chunks.push(Buffer.from([(port >> 8) & 0xff, port & 0xff]));
      socket.write(Buffer.concat(chunks));
    };

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        const [version, method] = buffer as unknown as [number, number];
        if (version !== SOCKS_VERSION) {
          fail('SOCKS5: unexpected protocol version', finish);
          return;
        }
        if (method === AUTH_NO_ACCEPTABLE) {
          fail('SOCKS5: no acceptable authentication method', finish);
          return;
        }
        buffer = buffer.subarray(2);
        if (method === AUTH_USERNAME_PASSWORD) {
          stage = 'auth';
          sendAuth();
        } else {
          stage = 'connect';
          sendConnect();
        }
        return;
      }

      if (stage === 'auth') {
        if (buffer.length < 2) return;
        const status = buffer[1];
        if (status !== 0x00) {
          fail('SOCKS5: username/password rejected', finish);
          return;
        }
        buffer = buffer.subarray(2);
        stage = 'connect';
        sendConnect();
        return;
      }

      // CONNECT reply: VER REP RSV ATYP [BND.ADDR] BND.PORT
      if (buffer.length < 4) return;
      const reply = buffer[1];
      if (reply !== 0x00) {
        fail(`SOCKS5: connect rejected (code ${reply})`, finish);
        return;
      }
      const addressType = buffer[3];
      let offset = 4;
      if (addressType === ATYP_IPV4) {
        offset += 4;
      } else if (addressType === ATYP_DOMAIN) {
        if (buffer.length < 5) return;
        offset += 1 + (buffer[4] ?? 0);
      } else if (addressType === ATYP_IPV6) {
        offset += 16;
      } else {
        fail('SOCKS5: unsupported address type in reply', finish);
        return;
      }
      if (buffer.length < offset + 2) return;
      finish(undefined, socket);
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('connect', sendGreeting);
  });
