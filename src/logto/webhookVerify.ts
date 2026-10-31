import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Logto sends `logto-signature-sha-256: <hex>` where hex is
 * HMAC-SHA256(signingKey, rawRequestBody).
 * Docs: https://docs.logto.io/developers/webhooks/secure-webhooks
 */
export const computeSignature = (signingKey: string, rawBody: Buffer | string): string => {
  const hmac = createHmac('sha256', signingKey);
  hmac.update(rawBody);
  return hmac.digest('hex');
};

export const verifyLogtoSignature = (input: {
  signingKey: string;
  rawBody: Buffer | string;
  header: string | string[] | undefined;
}): boolean => {
  const { signingKey, rawBody, header } = input;
  const received = Array.isArray(header) ? header[0] : header;

  if (!signingKey || !received) {
    return false;
  }

  const expected = computeSignature(signingKey, rawBody);
  const receivedBuffer = Buffer.from(received.trim().toLowerCase(), 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(receivedBuffer, expectedBuffer);
};
