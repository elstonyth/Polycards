import { generateKeyPairSync } from 'node:crypto';
import {
  aesDecrypt,
  aesEncrypt,
  buildEnvelope,
  depositState,
  openCallback,
  signPayload,
  verifySignature,
  withdrawalState,
} from '../globepay';

// GlobePay365 wire format. The gateway is 1024-bit RSA + SHA1 by contract, so
// the fixtures are too — testing with 2048/SHA256 would prove nothing about
// what actually goes on the wire.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Bare base64 bodies — the format both sides actually exchange (no PEM armor).
const bareKey = (pem: string) =>
  pem
    .split('\n')
    .filter((l) => l && !l.startsWith('-----'))
    .join('');

// Throwaway. PBKDF2 accepts any string, so the provider's real key would buy
// these tests nothing and put a live secret in a public repo.
const AES_KEY = 'test-aes-key';

describe('globepay AES (§1.11)', () => {
  it('roundtrips a JSON payload', () => {
    const json = JSON.stringify({ MerchantCode: 'MYR00001', Amount: '100.00' });
    expect(aesDecrypt(aesEncrypt(json, AES_KEY), AES_KEY)).toBe(json);
  });

  it('prepends a fresh random IV, so the same plaintext encrypts differently', () => {
    const a = aesEncrypt('{"a":1}', AES_KEY);
    const b = aesEncrypt('{"a":1}', AES_KEY);
    expect(a).not.toBe(b);
    expect(aesDecrypt(a, AES_KEY)).toBe(aesDecrypt(b, AES_KEY));
    // First 16 bytes are the IV, not ciphertext.
    expect(Buffer.from(a, 'base64').subarray(0, 16)).not.toEqual(
      Buffer.from(b, 'base64').subarray(0, 16),
    );
  });

  it('fails to decrypt under the wrong key', () => {
    const enc = aesEncrypt('{"a":1}', AES_KEY);
    expect(() => aesDecrypt(enc, 'wrong-key')).toThrow();
  });

  it('rejects a payload too short to hold IV + a block', () => {
    expect(() => aesDecrypt(Buffer.alloc(8).toString('base64'), AES_KEY)).toThrow(
      /too short/,
    );
  });
});

describe('globepay RSA-SHA1 (§1.14)', () => {
  it('signs and verifies the plaintext JSON', () => {
    const json = '{"MerchantTransactionId":"T1"}';
    const sig = signPayload(json, privateKey);
    expect(verifySignature(json, sig, publicKey)).toBe(true);
  });

  it('accepts unarmored base64 keys, as exchanged with the gateway', () => {
    const json = '{"MerchantTransactionId":"T1"}';
    const sig = signPayload(json, bareKey(privateKey));
    expect(verifySignature(json, sig, bareKey(publicKey))).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const sig = signPayload('{"Amount":"10.00"}', privateKey);
    expect(verifySignature('{"Amount":"1000.00"}', sig, publicKey)).toBe(false);
  });

  it('returns false (not throws) on a malformed signature', () => {
    expect(verifySignature('{}', 'not-base64-!!', publicKey)).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const other = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const json = '{"a":1}';
    expect(
      verifySignature(json, signPayload(json, other.privateKey), publicKey),
    ).toBe(false);
  });
});

describe('buildEnvelope / openCallback', () => {
  const keys = { merchantCode: 'MYR00001', aesKey: AES_KEY, privateKey };

  it('encrypts and signs the SAME serialized bytes', () => {
    const payload = { MerchantCode: 'MYR00001', Amount: '100.00' };
    const env = buildEnvelope(payload, keys);
    // What they do on receipt: decrypt Data, then verify Signature over it.
    const json = aesDecrypt(env.data, AES_KEY);
    expect(JSON.parse(json)).toEqual(payload);
    expect(verifySignature(json, env.signature, publicKey)).toBe(true);
    expect(env.version).toBe(0);
    expect(env.merchantCode).toBe('MYR00001');
  });

  it('opens a well-formed callback', () => {
    const body = { MerchantTransactionId: 'T1', Status: 6, Amount: 100 };
    const json = JSON.stringify(body);
    const opened = openCallback(
      { Data: aesEncrypt(json, AES_KEY), Signature: signPayload(json, privateKey) },
      { aesKey: AES_KEY, publicKey },
    );
    expect(opened).toEqual(body);
  });

  it('throws on a callback whose signature does not match — money must not move', () => {
    const json = JSON.stringify({ Status: 6, Amount: 999999 });
    expect(() =>
      openCallback(
        {
          Data: aesEncrypt(json, AES_KEY),
          // Valid signature, but over DIFFERENT content: the forged-amount case.
          Signature: signPayload('{"Status":6,"Amount":1}', privateKey),
        },
        { aesKey: AES_KEY, publicKey },
      ),
    ).toThrow(/signature/i);
  });
});

describe('settlement status mapping (§1.24, §1.25)', () => {
  it('maps deposit statuses, treating verify-fail (4) as NOT final', () => {
    expect(depositState(6)).toBe('success');
    expect(depositState(7)).toBe('failed');
    expect(depositState(4)).toBe('pending');
    expect(depositState(99)).toBe('pending');
  });

  it('maps withdrawal statuses', () => {
    expect(withdrawalState(4)).toBe('success');
    expect(withdrawalState(5)).toBe('failed');
    expect(withdrawalState(0)).toBe('pending');
  });
});
