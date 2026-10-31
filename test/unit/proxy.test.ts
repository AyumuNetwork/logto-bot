import { describe, expect, it } from 'vitest';

import {
  describeProxy,
  parseProxyUrl,
  ProxyConfigError,
  resolveDestinationPort,
  resolveProxy,
} from '../../src/net/proxy.js';

describe('parseProxyUrl', () => {
  it('parses http, https, socks5 and socks5h with credentials', () => {
    expect(parseProxyUrl('http://127.0.0.1:7890')).toMatchObject({
      kind: 'http',
      host: '127.0.0.1',
      port: 7890,
    });

    expect(parseProxyUrl('https://proxy.example:8443')).toMatchObject({ kind: 'https', port: 8443 });

    const socks = parseProxyUrl('socks5://user:p%40ss@10.0.0.2:1080');
    expect(socks).toMatchObject({ kind: 'socks5', host: '10.0.0.2', port: 1080, username: 'user', password: 'p@ss' });

    expect(parseProxyUrl('socks5h://[::1]:1080')).toMatchObject({ kind: 'socks5h', host: '::1', port: 1080 });
  });

  it('defaults bare host:port to an http proxy and known ports', () => {
    expect(parseProxyUrl('proxy.local:3128')).toMatchObject({ kind: 'http', host: 'proxy.local', port: 3128 });
    expect(parseProxyUrl('socks5://proxy.local').port).toBe(1080);
  });

  it('rejects unsupported and malformed values', () => {
    expect(() => parseProxyUrl('')).toThrow(ProxyConfigError);
    expect(() => parseProxyUrl('ftp://host:21')).toThrow(/unsupported proxy protocol/);
    expect(() => parseProxyUrl('http://host:99999')).toThrow(/invalid proxy/);
  });

  it('never leaks credentials in the description', () => {
    expect(describeProxy(parseProxyUrl('socks5://user:secret@host:1080'))).toBe('socks5://host:1080 (auth)');
  });
});

describe('resolveDestinationPort', () => {
  it('derives the default port that undici omits', () => {
    expect(resolveDestinationPort('', 'https:')).toBe(443);
    expect(resolveDestinationPort(undefined, 'http:')).toBe(80);
    expect(resolveDestinationPort('', 'http:')).toBe(80);
    expect(resolveDestinationPort('8443', 'https:')).toBe(8443);
    expect(resolveDestinationPort(1234, 'https:')).toBe(1234);
  });
});

describe('resolveProxy', () => {
  it('prefers the explicit value', () => {
    const proxy = resolveProxy({
      explicit: 'socks5://127.0.0.1:1080',
      env: { HTTPS_PROXY: 'http://env:8080' },
      targetHost: 'api.telegram.org',
    });
    expect(proxy?.kind).toBe('socks5');
  });

  it('falls back to HTTPS_PROXY / ALL_PROXY', () => {
    expect(resolveProxy({ env: { HTTPS_PROXY: 'http://env:8080' }, targetHost: 'api.telegram.org' })?.port).toBe(8080);
    expect(resolveProxy({ env: { ALL_PROXY: 'socks5h://all:1080' }, targetHost: 'x' })?.kind).toBe('socks5h');
  });

  it('honours NO_PROXY', () => {
    const env = { HTTPS_PROXY: 'http://env:8080', NO_PROXY: 'localhost, .internal.example' };
    expect(resolveProxy({ env, targetHost: 'localhost' })).toBeUndefined();
    expect(resolveProxy({ env, targetHost: 'api.internal.example' })).toBeUndefined();
    expect(resolveProxy({ env, targetHost: 'api.telegram.org' })?.port).toBe(8080);
  });

  it('returns undefined without any configuration', () => {
    expect(resolveProxy({ env: {}, targetHost: 'api.telegram.org' })).toBeUndefined();
  });
});
