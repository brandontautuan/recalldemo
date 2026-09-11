/** Verifies Recall/Svix webhook signatures against the untouched raw request body. */
import crypto from 'node:crypto';

export function verifyRecallRequest(secret, headers, rawBody) {
  const id = headers['webhook-id'] ?? headers['svix-id'];
  const timestamp = headers['webhook-timestamp'] ?? headers['svix-timestamp'];
  const signatures = headers['webhook-signature'] ?? headers['svix-signature'];
  if (!id || !timestamp || !signatures || !secret?.startsWith('whsec_')) return false;
  const expected = crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  return signatures.split(' ').some((value) => {
    const [version, signature] = value.split(',');
    if (version !== 'v1' || !signature) return false;
    const actualBytes = Buffer.from(signature, 'base64');
    const expectedBytes = Buffer.from(expected, 'base64');
    return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
  });
}
