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

describe('AES key derivation is memoized (plan 089)', () => {
  // `openCallback` MUST decrypt before it can verify (§1.16), so every
  // unauthenticated POST /hooks/globepay/* used to force a fresh 1000-round
  // pbkdf2Sync on the event loop — the deposit route twice. These count real
  // derivations through the exact module object globepay.ts calls into (a
  // wildcard `import * as` can compile to a COPY under this repo's swc
  // transform, and spying on a copy would silently count nothing).
  const nodeCrypto = require('node:crypto') as typeof import('node:crypto');

  let pbkdf2Spy: jest.SpyInstance;
  beforeEach(() => {
    pbkdf2Spy = jest.spyOn(nodeCrypto, 'pbkdf2Sync');
  });
  afterEach(() => {
    pbkdf2Spy.mockRestore();
  });

  // Every assertion reads `.mock.calls.length` and never the mock itself:
  // a matcher on the mock (toHaveBeenCalledTimes) pretty-prints its recorded
  // arguments, which here are AES key material, into CI output. Public repo.
  // Deltas, not absolutes — the memo is module-level, so earlier tests in this
  // file have already warmed it for their own keys.

  it('derives once per distinct key, however many times that key is used', () => {
    const key = 'memo-key-single';
    const before = pbkdf2Spy.mock.calls.length;
    const cipher = aesEncrypt('{"a":1}', key);
    aesEncrypt('{"a":2}', key);
    aesDecrypt(cipher, key);
    // 3 uses of one key. Unmemoized this is 3; memoized it is 1.
    expect(pbkdf2Spy.mock.calls.length - before).toBe(1);
  });

  it('does not share one derivation between two different keys', () => {
    const plaintext = '{"a":1}';
    const before = pbkdf2Spy.mock.calls.length;
    const enc = aesEncrypt(plaintext, 'memo-key-a');

    // The wrong-key decrypt is here to FORCE a second derivation, not to prove
    // rejection — and it must not assert one. aes-256-cbc is unauthenticated,
    // so a wrong key only rejects when PKCS#7 unpadding happens to fail: about
    // 255 times in 256, re-rolled every run by the random IV. `.toThrow()`
    // therefore failed CI at random (2026-08-24, run 32717061178) on a tree
    // that was green locally, and the failure never had anything to do with
    // the change under review. Do not put it back.
    //
    // What IS deterministic is that the wrong key never reproduces the
    // plaintext, so that is what gets asserted. Both outcomes — a throw or
    // garbage — are correct.
    let recovered: string | null = null;
    try {
      recovered = aesDecrypt(enc, 'memo-key-b');
    } catch {
      // Expected on the ~255/256 path. The derivation still happened before
      // the unpad failed, so the delta below is 2 either way.
    }
    expect(recovered).not.toBe(plaintext);

    // Also the liveness check for the spy above: a delta of 0 here would mean
    // the spy never reached the call site, which would make the memo test
    // green for the wrong reason.
    expect(pbkdf2Spy.mock.calls.length - before).toBe(2);
    const [a, b] = pbkdf2Spy.mock.results
      .slice(-2)
      .map((r) => r.value as Buffer);
    // `.equals` and not toEqual: a Buffer matcher dumps derived key bytes into
    // the failure output.
    expect(a.equals(b)).toBe(false);
  });

  it('round-trips repeatedly on the cached buffer (a mutated cache would not)', () => {
    const key = 'memo-key-roundtrip';
    const json = JSON.stringify({ MerchantTransactionId: 'T9', Amount: '25.00' });
    expect(aesDecrypt(aesEncrypt(json, key), key)).toBe(json);
    // Second pass runs entirely off the cached derivation.
    expect(aesDecrypt(aesEncrypt(json, key), key)).toBe(json);
  });

  it('openCallback still rejects a forged signature once the key is cached', () => {
    const key = 'memo-key-callback';
    const forged = JSON.stringify({ Status: 6, Amount: 999999 });
    aesEncrypt(forged, key); // warm the cache, so this exercises the memo path
    expect(() =>
      openCallback(
        {
          Data: aesEncrypt(forged, key),
          Signature: signPayload('{"Status":6,"Amount":1}', privateKey),
        },
        { aesKey: key, publicKey },
      ),
    ).toThrow(/signature/i);

    const genuine = JSON.stringify({ MerchantTransactionId: 'T9', Status: 6 });
    expect(
      openCallback(
        {
          Data: aesEncrypt(genuine, key),
          Signature: signPayload(genuine, privateKey),
        },
        { aesKey: key, publicKey },
      ),
    ).toEqual(JSON.parse(genuine));
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
