import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

// The assistant's OpenRouter key at rest (spec 2026-10-29): AES-256-GCM under
// a key derived from the backend's JWT secret with HKDF, so no new deploy
// secret is needed. Rotating the JWT secret makes openKey() return null; the
// settings page then asks for the key again. Sealed form:
// v1:<iv b64>:<auth tag b64>:<ciphertext b64>.

const VERSION = 'v1';

const derive = (secret: string): Buffer =>
  Buffer.from(
    hkdfSync('sha256', secret, 'polycards-assistant', 'openrouter-key-v1', 32),
  );

export function sealKey(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(secret), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ct.toString('base64'),
  ].join(':');
}

/** The key, or null when it cannot be opened (another secret, tampering,
 *  not a sealed key). */
export function openKey(sealed: string, secret: string): string | null {
  const [version, iv, tag, ct] = sealed.split(':');
  if (version !== VERSION || !iv || !tag || !ct) return null;
  const ivBytes = Buffer.from(iv, 'base64');
  const tagBytes = Buffer.from(tag, 'base64');
  // A shorter tag would be checked only as far as it goes: sealKey writes 12 + 16.
  if (ivBytes.length !== 12 || tagBytes.length !== 16) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', derive(secret), ivBytes, {
      authTagLength: 16,
    });
    decipher.setAuthTag(tagBytes);
    return Buffer.concat([
      decipher.update(Buffer.from(ct, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

export const last4 = (plain: string): string => plain.slice(-4);
