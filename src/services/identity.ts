import type { LogtoUser } from '../logto/management.js';

export type IdentityDetails = {
  /** Telegram numeric user id (== private chat id). Present in `details.rawData.id`. */
  tgUserId?: number;
  /** Social identity id stored by Logto (the id_token `sub`). */
  socialUserId?: string;
  username?: string;
  name?: string;
  phone?: string;
  avatar?: string;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const coerceId = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
};

/**
 * Pull the useful fields out of a Logto social identity payload.
 *
 * Verified against auth.haori.ink (2026-10-31):
 *   identities.Telegram.details.rawData = {
 *     id: "1558159309",        <- Telegram numeric user id
 *     sub: "4893946124037248621",
 *     phone_number: "8615986137668",
 *     preferred_username: "XieXiLin",
 *     picture: "https://t.me/i/userpic/...",
 *     ...
 *   }
 * `details.id` mirrors `sub`, so `rawData.id` is the only reliable chat id.
 */
export const extractIdentity = (
  identities: LogtoUser['identities'] | undefined,
  target: string,
): IdentityDetails | undefined => {
  if (!identities) {
    return undefined;
  }

  const entry = identities[target] ?? identities[target.toLowerCase()];
  if (!entry) {
    return undefined;
  }

  const details = asRecord(entry.details) ?? {};
  const rawNested = asRecord(details.rawData);
  const raw =
    rawNested ??
    (() => {
      // Some Logto versions store `rawData` as a JSON string.
      const value = details.rawData;
      if (typeof value !== 'string') {
        return undefined;
      }
      try {
        return asRecord(JSON.parse(value));
      } catch {
        return undefined;
      }
    })() ??
    {};

  const tgUserId = coerceId(raw.id);
  const socialUserId = entry.userId ?? (typeof raw.sub === 'string' ? raw.sub : undefined);

  return {
    tgUserId,
    socialUserId,
    username: typeof raw.preferred_username === 'string' ? raw.preferred_username : undefined,
    name: typeof raw.name === 'string' ? raw.name : (typeof details.name === 'string' ? details.name : undefined),
    phone: typeof raw.phone_number === 'string' ? raw.phone_number : undefined,
    avatar:
      typeof raw.picture === 'string'
        ? raw.picture
        : typeof details.avatar === 'string'
          ? details.avatar
          : undefined,
  };
};
