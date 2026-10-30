import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';
import type { SettlementState } from './gateway-types';

// A3Pay wire format (Merchant Web Integration Handbook v3.3.5, SGD) — pure
// functions, keys injected, so the rules stay unit-testable without a
// container or a live gateway.
//
// Every request and callback is the same envelope:
//   { MerchantCode, Data, Signature, Version }
// where Data is AES(json) and Signature is RSA-SHA1 over the SAME json
// PLAINTEXT, not over the ciphertext ("Decrypt Encrypted Data to get Json
// Data, then use the A3pay Public Key to verify signature").
//
// This is the same platform the retired GlobePay365 integration spoke
// (removed 2026-09-06, #559): identical AES derivation, signature scheme,
// status numbers and payout-verification step. That code ran live against
// production, which is why this file is a port of it rather than a rewrite.
// The handbook's own sample ciphertexts and signatures do NOT verify under its
// sample keys (checked 2026-10-06) — they are illustrative, not test vectors.

/** Their API version field. Only 0 exists. */
export const A3PAY_VERSION = 0;

/**
 * AES key derivation ("AES Method"). The password AND the salt are both the
 * raw AES key string — all three samples (C# Rfc2898DeriveBytes, Java
 * PBKDF2WithHmacSHA1, PHP hash_pbkdf2 sha1) do it; 1000 rounds is C#'s
 * Rfc2898DeriveBytes default, spelled out in the Java and PHP samples.
 *
 * Memoised per key STRING: a callback must decrypt before it can verify, so
 * every anonymous POST to /hooks/a3pay/* would otherwise pay a fresh 1000-round
 * PBKDF2 on the event loop before anything authenticated it. The map is
 * bounded by configuration (config.aesKey), never by request input. Returns a
 * copy. Never log the key or the derived buffer.
 */
const aesKeyCache = new Map<string, Buffer>();

function deriveAesKey(aesKey: string): Buffer {
  let derived = aesKeyCache.get(aesKey);
  if (!derived) {
    derived = pbkdf2Sync(aesKey, aesKey, 1000, 32, 'sha1');
    aesKeyCache.set(aesKey, derived);
  }
  return Buffer.from(derived);
}

/** AES-256-CBC + PKCS7, random 16-byte IV prepended, all base64. */
export function aesEncrypt(plainText: string, aesKey: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', deriveAesKey(aesKey), iv);
  return Buffer.concat([
    iv,
    cipher.update(plainText, 'utf8'),
    cipher.final(),
  ]).toString('base64');
}

/** Inverse of aesEncrypt: split the leading IV, decrypt the rest. */
export function aesDecrypt(encryptedBase64: string, aesKey: string): string {
  const raw = Buffer.from(encryptedBase64, 'base64');
  // IV + at least one block. Guarded here so a malformed callback reads as
  // malformed, not as a key-length config problem.
  if (raw.length < 32) {
    throw new Error(
      'A3Pay: encrypted payload too short to contain IV + block.',
    );
  }
  const decipher = createDecipheriv(
    'aes-256-cbc',
    deriveAesKey(aesKey),
    raw.subarray(0, 16),
  );
  return Buffer.concat([
    decipher.update(raw.subarray(16)),
    decipher.final(),
  ]).toString('utf8');
}

/** Wrap a bare base64 key body in PEM armour. Their keys travel unarmoured. */
function toPem(key: string, label: 'PUBLIC KEY' | 'PRIVATE KEY'): string {
  if (key.includes('-----BEGIN')) return key;
  const body =
    key
      .replace(/\s+/g, '')
      .match(/.{1,64}/g)
      ?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

/** Sign with OUR private key (PKCS#8): RSA-SHA1, PKCS#1 v1.5, base64. */
export function signPayload(json: string, privateKey: string): string {
  return createSign('RSA-SHA1')
    .update(json, 'utf8')
    .sign(toPem(privateKey, 'PRIVATE KEY'), 'base64');
}

/**
 * Verify with THEIR public key (X.509 SPKI). False instead of a throw: a
 * malformed signature from a hostile caller is a failed verification, not a
 * 500. Nothing in a callback may be trusted before this returns true.
 */
export function verifySignature(
  json: string,
  signature: string,
  publicKey: string,
): boolean {
  try {
    return createVerify('RSA-SHA1')
      .update(json, 'utf8')
      .verify(toPem(publicKey, 'PUBLIC KEY'), signature, 'base64');
  } catch {
    return false;
  }
}

/**
 * True when the key configured as THEIRS is the public half of OUR private
 * key. No signature of theirs can ever verify against it, so every callback
 * and payout verification is refused — GlobePay365 from go-live to 2026-10-26,
 * because GP365_PUBLIC_KEY was copied from a GLOBEPAY_PUBLIC_KEY that held our
 * own merchant key. Names the cause only: false on any parse error, never a
 * gate.
 */
export function isOwnPublicKey(publicKey: string, privateKey: string): boolean {
  try {
    const theirs = createPublicKey(toPem(publicKey, 'PUBLIC KEY'));
    const ours = createPublicKey(
      createPrivateKey(toPem(privateKey, 'PRIVATE KEY')),
    );
    return theirs
      .export({ type: 'spki', format: 'der' })
      .equals(ours.export({ type: 'spki', format: 'der' }));
  } catch {
    return false;
  }
}

export type A3payEnvelope = {
  MerchantCode: string;
  Data: string;
  Signature: string;
  Version: number;
};

/**
 * The outbound envelope for every POST endpoint. `payload` is serialised ONCE
 * and that exact string is both encrypted and signed — they verify against the
 * JSON they decrypt, so the bytes must match.
 */
export function buildEnvelope(
  payload: Record<string, unknown>,
  keys: { merchantCode: string; aesKey: string; privateKey: string },
): A3payEnvelope {
  const json = JSON.stringify(payload);
  return {
    MerchantCode: keys.merchantCode,
    Data: aesEncrypt(json, keys.aesKey),
    Signature: signPayload(json, keys.privateKey),
    Version: A3PAY_VERSION,
  };
}

/**
 * Open an inbound message (callback or payout verification): decrypt, verify,
 * parse. Throws on a bad signature so no caller can use an unverified payload.
 * `AdditionalInformationData` is not covered by the signature and is never
 * read for money decisions.
 */
export function openCallback<T = Record<string, unknown>>(
  message: { Data: string; Signature: string },
  keys: { aesKey: string; publicKey: string },
): T {
  const json = aesDecrypt(message.Data, keys.aesKey);
  if (!verifySignature(json, message.Signature, keys.publicKey)) {
    throw new Error('A3Pay: signature verification failed.');
  }
  return JSON.parse(json) as T;
}

// Transaction status appendix. NOTE the two tables disagree on 4: a PAYIN 4
// is "Verify Fail" and explicitly NOT final, a PAYOUT 4 is Success. Anything
// unlisted is still processing — unknown is pending, never failure, or a
// slow-but-good payment gets written off.
export const PAYIN_STATUS = { VERIFY_FAIL: 4, SUCCESS: 6, FAIL: 7 } as const;
export const PAYOUT_STATUS = { SUCCESS: 4, FAIL: 5 } as const;

export function payinState(status: unknown): SettlementState {
  const n = Number(status);
  if (n === PAYIN_STATUS.SUCCESS) return 'success';
  if (n === PAYIN_STATUS.FAIL) return 'failed';
  return 'pending';
}

export function payoutState(status: unknown): SettlementState {
  const n = Number(status);
  if (n === PAYOUT_STATUS.SUCCESS) return 'success';
  if (n === PAYOUT_STATUS.FAIL) return 'failed';
  return 'pending';
}
