import { createHmac } from 'node:crypto';

// The 6-digit code an authenticator app shows: RFC 6238 TOTP, SHA-1, 30-second
// steps, as Medusa's totp provider checks it. Written out rather than taken
// from Medusa, so the specs prove a phone app's codes are the ones accepted.
//
// Dependency-free on purpose: the integration specs, seed-e2e-fixtures, the
// Playwright suite (tests/e2e) and scripts/qa-free-pack.mjs all load this one
// file, the last two straight from the repo root.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const base32Decode = (text: string): Buffer => {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error(`not base32: ${ch}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

export function totpCode(secret: string, now: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac('sha1', base32Decode(secret))
    .update(counter)
    .digest();
  // RFC 4226 dynamic truncation: 31 bits from the offset the last nibble names.
  const offset = hmac.readUInt8(hmac.length - 1) & 0xf;
  const value = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, '0');
}
