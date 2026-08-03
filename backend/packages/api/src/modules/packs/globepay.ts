import {
  createCipheriv,
  createDecipheriv,
  createSign,
  createVerify,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';

// GlobePay365 wire format (Merchant Integration Guide v1.0.0, §1.11–1.16).
// Pure functions, keys injected — same shape as topup.ts so the rules stay
// unit-testable without a container or a live gateway.
//
// Every request/callback is the same envelope:
//   { MerchantCode, Data, Signature, Version }
// where Data is AES(json) and Signature is RSA-SHA1 over the SAME json
// PLAINTEXT — not over the ciphertext. §1.16 is explicit: decrypt first, then
// verify. Signing the ciphertext instead is the classic way to fail this
// integration with a useless error message.

/** Their API version field. Only 0 exists today. */
export const GLOBEPAY_VERSION = 0;

/**
 * AES key derivation, §1.11. The password AND the salt are both the raw AES
 * key string — that is not a typo in the doc, all three of their samples
 * (C# Rfc2898DeriveBytes, Java PBKDF2WithHmacSHA1, PHP hash_pbkdf2 sha1) do
 * it. 1000 iterations is C#'s Rfc2898DeriveBytes default, spelled out
 * explicitly in the Java and PHP samples.
 */
function deriveAesKey(aesKey: string): Buffer {
  return pbkdf2Sync(aesKey, aesKey, 1000, 32, 'sha1');
}

/**
 * AES-256-CBC + PKCS7, random 16-byte IV PREPENDED to the ciphertext, all
 * base64 (§1.11.1). The IV is not sent separately — it is the first 16 bytes
 * of the decoded payload.
 */
export function aesEncrypt(plainText: string, aesKey: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', deriveAesKey(aesKey), iv);
  return Buffer.concat([
    iv,
    cipher.update(plainText, 'utf8'),
    cipher.final(),
  ]).toString('base64');
}

/** Inverse of aesEncrypt (§1.11.2): split the leading IV, decrypt the rest. */
export function aesDecrypt(encryptedBase64: string, aesKey: string): string {
  const raw = Buffer.from(encryptedBase64, 'base64');
  // Below 17 bytes there is no ciphertext block after the IV at all. Guard
  // here rather than letting createDecipheriv throw a key-length error that
  // reads like a config problem when it is really a malformed callback.
  if (raw.length < 32) {
    throw new Error('GlobePay365: encrypted payload too short to contain IV + block.');
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

/** Wrap a bare base64 key body in PEM armor. Their keys travel unarmored. */
function toPem(key: string, label: 'PUBLIC KEY' | 'PRIVATE KEY'): string {
  if (key.includes('-----BEGIN')) return key;
  const body = key.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

/**
 * Sign the Data JSON with OUR private key, RSA-SHA1 / PKCS#1 v1.5, base64
 * (§1.14.1 — `SHA1withRSA`, `OPENSSL_ALGO_SHA1`). Node's 'RSA-SHA1' defaults
 * to PKCS#1 v1.5 padding, which is what all three samples use.
 */
export function signPayload(json: string, privateKey: string): string {
  return createSign('RSA-SHA1')
    .update(json, 'utf8')
    .sign(toPem(privateKey, 'PRIVATE KEY'), 'base64');
}

/**
 * Verify an inbound callback signature with THEIR public key (§1.14.2). Never
 * trust a single field of a callback before this returns true — the callback
 * is what moves money into a customer's balance.
 *
 * Returns false instead of throwing: a malformed base64 signature from a
 * hostile caller is a failed verification, not a 500.
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
 * UNVERIFIED CASING (confirm on the first live call). The doc is inconsistent:
 * the SubmitDeposit request sample (§1.1.2) is lowercase `merchantCode` /
 * `data` / `signature` / `version`, while the callback (§1.2.2) is capitalized
 * `TransactionId` / `Data` / `Signature`. Lowercase is used here because that
 * is what their request sample shows. If SubmitDeposit rejects with a
 * signature/validation error that makes no sense, try PascalCase first — a
 * casing mismatch fails silently on their side with a useless message.
 */
export type GlobePayEnvelope = {
  merchantCode: string;
  data: string;
  signature: string;
  version: number;
};

/**
 * Build the outbound envelope for any of their endpoints (SubmitDeposit,
 * SubmitWithdrawal, requery, CheckBalance — all identical in shape, §1.1.2).
 *
 * `payload` is serialized ONCE and that exact string is both encrypted and
 * signed. Serializing twice would be a latent bug the day key order differs
 * between the two calls: they verify against the JSON they decrypt, so the
 * bytes must match.
 */
export function buildEnvelope(
  payload: Record<string, unknown>,
  keys: { merchantCode: string; aesKey: string; privateKey: string },
): GlobePayEnvelope {
  const json = JSON.stringify(payload);
  return {
    merchantCode: keys.merchantCode,
    data: aesEncrypt(json, keys.aesKey),
    signature: signPayload(json, keys.privateKey),
    version: GLOBEPAY_VERSION,
  };
}

/**
 * Open an inbound callback: verify first, then hand back the parsed Data.
 * Throws on a bad signature so no caller can accidentally use the payload of
 * an unverified callback.
 */
export function openCallback<T = Record<string, unknown>>(
  callback: { Data: string; Signature: string },
  keys: { aesKey: string; publicKey: string },
): T {
  const json = aesDecrypt(callback.Data, keys.aesKey);
  if (!verifySignature(json, callback.Signature, keys.publicKey)) {
    throw new Error('GlobePay365: callback signature verification failed.');
  }
  return JSON.parse(json) as T;
}

// Transaction status codes (§1.24, §1.25). Anything not listed is "still
// processing" — treat unknown as pending, NEVER as failure, or a slow-but-good
// deposit gets written off.
export const DEPOSIT_STATUS = { VERIFY_FAIL: 4, SUCCESS: 6, FAIL: 7 } as const;
export const WITHDRAWAL_STATUS = { SUCCESS: 4, FAIL: 5 } as const;

export type SettlementState = 'success' | 'failed' | 'pending';

/**
 * Deposit status 4 ("Verify Fail") is explicitly NOT a final status in the
 * doc — it can still settle. Mapping it to 'failed' would strand real money.
 */
export function depositState(status: number): SettlementState {
  if (status === DEPOSIT_STATUS.SUCCESS) return 'success';
  if (status === DEPOSIT_STATUS.FAIL) return 'failed';
  return 'pending';
}

export function withdrawalState(status: number): SettlementState {
  if (status === WITHDRAWAL_STATUS.SUCCESS) return 'success';
  if (status === WITHDRAWAL_STATUS.FAIL) return 'failed';
  return 'pending';
}

/**
 * Their callbacks arrive from a fixed set of source addresses (doc "Outgoing
 * IP"). Defence in depth only — the signature is the real gate, since behind a
 * tunnel or a load balancer the observed source IP is not theirs.
 */
export const GLOBEPAY_CALLBACK_IPS = {
  production: '13.159.14.239',
  staging: '160.250.92.219',
} as const;
