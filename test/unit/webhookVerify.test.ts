import { describe, expect, it } from 'vitest';

import { computeSignature, verifyLogtoSignature } from '../../src/logto/webhookVerify.js';

describe('logto webhook signature', () => {
  const key = 'signing-key';
  const body = Buffer.from(JSON.stringify({ event: 'PostSignIn', userId: 'abc' }));

  it('computes a hex HMAC-SHA256 over the raw body', () => {
    expect(computeSignature(key, body)).toBe(
      // node -e "crypto.createHmac('sha256','signing-key').update('{\"event\":\"PostSignIn\",\"userId\":\"abc\"}').digest('hex')"
      '7b81ad0a59856bc4094fb288ba02bd726cbe87fade1238e540265c2c6739f9b5',
    );
  });

  it('accepts a matching signature', () => {
    const signature = computeSignature(key, body);
    expect(verifyLogtoSignature({ signingKey: key, rawBody: body, header: signature })).toBe(true);
    expect(verifyLogtoSignature({ signingKey: key, rawBody: body, header: signature.toUpperCase() })).toBe(true);
  });

  it('rejects a mismatched, missing or truncated signature', () => {
    const signature = computeSignature(key, body);
    expect(verifyLogtoSignature({ signingKey: key, rawBody: body, header: 'deadbeef' })).toBe(false);
    expect(verifyLogtoSignature({ signingKey: key, rawBody: body, header: undefined })).toBe(false);
    expect(
      verifyLogtoSignature({ signingKey: key, rawBody: body, header: signature.slice(0, 10) }),
    ).toBe(false);
    expect(verifyLogtoSignature({ signingKey: '', rawBody: body, header: signature })).toBe(false);
  });

  it('detects body tampering', () => {
    const signature = computeSignature(key, body);
    const tampered = Buffer.from(JSON.stringify({ event: 'PostSignIn', userId: 'abcd' }));
    expect(verifyLogtoSignature({ signingKey: key, rawBody: tampered, header: signature })).toBe(false);
  });
});
