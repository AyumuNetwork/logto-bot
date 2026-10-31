import { describe, expect, it } from 'vitest';

import { extractIdentity } from '../../src/services/identity.js';

/**
 * Real payload captured from auth.haori.ink on 2026-10-31 for a Telegram login
 * through the OIDC connector (`identities.Telegram.details.rawData`).
 */
const REAL_PAYLOAD = {
  Telegram: {
    userId: '4893946124037248621',
    details: {
      id: '4893946124037248621',
      name: 'XieXiLin',
      avatar: 'https://t.me/i/userpic/320/example.jpg',
      rawData: {
        id: '1558159309',
        aud: '9220371633',
        exp: 1793300574,
        iat: 1793300544,
        iss: 'https://oauth.telegram.org',
        sub: '4893946124037248621',
        name: 'XieXiLin',
        nonce: '69xt3tom02y61jkrpmzs1',
        picture: 'https://t.me/i/userpic/320/example.jpg',
        given_name: 'XieXiLin',
        family_name: '',
        phone_number: '8615986137668',
        preferred_username: 'XieXiLin',
        phone_number_verified: true,
      },
    },
  },
};

describe('extractIdentity', () => {
  it('reads the telegram numeric id (chat id) from rawData', () => {
    const identity = extractIdentity(REAL_PAYLOAD, 'Telegram');
    expect(identity?.tgUserId).toBe(1558159309);
    expect(identity?.socialUserId).toBe('4893946124037248621');
    expect(identity?.username).toBe('XieXiLin');
    expect(identity?.phone).toBe('8615986137668');
    expect(identity?.avatar).toContain('userpic');
  });

  it('accepts a JSON-string rawData', () => {
    const identity = extractIdentity(
      { Telegram: { userId: '1', details: { rawData: JSON.stringify({ id: '42' }) } } },
      'Telegram',
    );
    expect(identity?.tgUserId).toBe(42);
  });

  it('returns undefined when the target identity is absent', () => {
    expect(extractIdentity({ github: { userId: 'x' } }, 'Telegram')).toBeUndefined();
    expect(extractIdentity(undefined, 'Telegram')).toBeUndefined();
  });

  it('does not trust details.id when rawData is missing', () => {
    const identity = extractIdentity({ Telegram: { userId: '99', details: { id: '99' } } }, 'Telegram');
    expect(identity?.tgUserId).toBeUndefined();
    expect(identity?.socialUserId).toBe('99');
  });
});
