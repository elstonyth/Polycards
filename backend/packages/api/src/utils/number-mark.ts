import { createHmac, hkdfSync } from 'node:crypto';

/** A keyed fingerprint of a full bank number (security review 2026-11-04): an
 *  assistant card and the audit rows carry this, never the number. Keyed by
 *  the JWT secret, so last 4 + a fingerprint cannot be guessed back into the
 *  number. */
export function numberMarkWith(secret: string, accountKey: string): string {
  const key = Buffer.from(
    hkdfSync('sha256', secret, 'polycards-assistant', 'number-mark-v1', 32),
  );
  return createHmac('sha256', key).update(accountKey).digest('base64url');
}
