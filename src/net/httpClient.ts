import { fetch as undiciFetch, type Dispatcher } from 'undici';

export type FetchLike = typeof globalThis.fetch;

const mergeSignals = (outer: AbortSignal | null | undefined, timeoutMs?: number): AbortSignal | undefined => {
  const timeout = timeoutMs && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;

  if (outer && timeout) {
    return AbortSignal.any([outer, timeout]);
  }
  return outer ?? timeout ?? undefined;
};

/**
 * `fetch` bound to a specific dispatcher (proxy / socks / direct) with an
 * optional per-request timeout. undici's fetch is used so the dispatcher type
 * always matches the implementation.
 */
export const createFetch = (options: { dispatcher?: Dispatcher; timeoutMs?: number } = {}): FetchLike =>
  (async (input, init) => {
    const requestInit = (init ?? {}) as RequestInit & { dispatcher?: Dispatcher };
    const signal = mergeSignals(requestInit.signal, options.timeoutMs);

    return undiciFetch(input as never, {
      ...(requestInit as Record<string, unknown>),
      ...(signal ? { signal } : {}),
      ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
    } as never) as unknown as Response;
  }) as FetchLike;

const isGetUpdates = (input: Parameters<FetchLike>[0]): boolean => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
  return url.includes('/getUpdates');
};

/**
 * Telegram flavour: long-polling calls must outlive the server-side hold
 * (`timeout` parameter) instead of hitting the default request timeout.
 */
export const createTelegramFetch = (options: {
  dispatcher?: Dispatcher;
  timeoutMs?: number;
  pollTimeoutSeconds?: number;
}): FetchLike => {
  const standard = createFetch({ dispatcher: options.dispatcher, timeoutMs: options.timeoutMs ?? 35_000 });
  const polling = createFetch({
    dispatcher: options.dispatcher,
    timeoutMs: ((options.pollTimeoutSeconds ?? 30) + 15) * 1000,
  });

  return (async (input, init) => (isGetUpdates(input) ? polling(input, init) : standard(input, init))) as FetchLike;
};
