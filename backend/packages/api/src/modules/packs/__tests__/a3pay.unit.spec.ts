import { generateKeyPairSync } from 'node:crypto';
import {
  aesDecrypt,
  aesEncrypt,
  buildEnvelope,
  isOwnPublicKey,
  openCallback,
  payinState,
  payoutState,
  signPayload,
  verifySignature,
} from '../a3pay';

// Bare base64 SPKI / PKCS#8, the format keys are exchanged in with A3Pay.
function pair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKey: publicKey.toString('base64'),
    privateKey: privateKey.toString('base64'),
  };
}

const ours = pair();
const theirs = pair();
const AES = 'Abcd1234';

describe('a3pay AES', () => {
  it('round-trips a JSON payload', () => {
    const json = JSON.stringify({ MID: 'SGD00001', PayinAmount: '100.00' });
    expect(aesDecrypt(aesEncrypt(json, AES), AES)).toBe(json);
  });

  it('prepends a fresh IV, so equal plaintexts encrypt differently', () => {
    expect(aesEncrypt('x', AES)).not.toBe(aesEncrypt('x', AES));
  });

  it('fails under the wrong key and on a truncated payload', () => {
    expect(() => aesDecrypt(aesEncrypt('{"a":1}', AES), 'other')).toThrow();
    expect(() => aesDecrypt(Buffer.alloc(20).toString('base64'), AES)).toThrow(
      /too short/,
    );
  });
});

describe('a3pay RSA-SHA1', () => {
  it('signs and verifies the plaintext with unarmoured keys', () => {
    const sig = signPayload('{"a":1}', ours.privateKey);
    expect(verifySignature('{"a":1}', sig, ours.publicKey)).toBe(true);
    expect(verifySignature('{"a":2}', sig, ours.publicKey)).toBe(false);
    expect(verifySignature('{"a":1}', sig, theirs.publicKey)).toBe(false);
  });

  it('returns false, not a throw, on a malformed signature', () => {
    expect(verifySignature('{}', '@@not-base64@@', ours.publicKey)).toBe(false);
  });
});

describe('isOwnPublicKey', () => {
  it('spots our own public key in the slot for theirs', () => {
    expect(isOwnPublicKey(ours.publicKey, ours.privateKey)).toBe(true);
    // PEM-armoured on one side, bare base64 on the other: same key.
    const pem = `-----BEGIN PUBLIC KEY-----\n${ours.publicKey.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`;
    expect(isOwnPublicKey(pem, ours.privateKey)).toBe(true);
  });

  it('passes their real key, and answers false on junk', () => {
    expect(isOwnPublicKey(theirs.publicKey, ours.privateKey)).toBe(false);
    expect(isOwnPublicKey('not-a-key', ours.privateKey)).toBe(false);
    expect(isOwnPublicKey(theirs.publicKey, '')).toBe(false);
  });
});

describe('envelopes', () => {
  it('encrypts and signs the SAME serialized bytes', () => {
    const payload = { MID: 'SGD00001', MTransactionId: 'PC-1' };
    const env = buildEnvelope(payload, {
      merchantCode: 'SGD00001',
      aesKey: AES,
      privateKey: ours.privateKey,
    });
    expect(env.MerchantCode).toBe('SGD00001');
    expect(env.Version).toBe(0);
    const json = aesDecrypt(env.Data, AES);
    expect(JSON.parse(json)).toEqual(payload);
    expect(verifySignature(json, env.Signature, ours.publicKey)).toBe(true);
  });

  it('opens a callback signed by A3Pay and refuses one signed by anyone else', () => {
    const json = JSON.stringify({ MerchantTransactionId: 'PC-1', Status: 6 });
    const Data = aesEncrypt(json, AES);
    const good = { Data, Signature: signPayload(json, theirs.privateKey) };
    expect(
      openCallback(good, { aesKey: AES, publicKey: theirs.publicKey }),
    ).toEqual({ MerchantTransactionId: 'PC-1', Status: 6 });

    const forged = { Data, Signature: signPayload(json, ours.privateKey) };
    expect(() =>
      openCallback(forged, { aesKey: AES, publicKey: theirs.publicKey }),
    ).toThrow(/signature/);
  });
});

describe('status tables — 4 means opposite things', () => {
  it('payin: 6 success, 7 failed, 4 (Verify Fail) is NOT final', () => {
    expect(payinState(6)).toBe('success');
    expect(payinState(7)).toBe('failed');
    expect(payinState(4)).toBe('pending');
    expect(payinState('6')).toBe('success');
    expect(payinState(undefined)).toBe('pending');
  });

  it('payout: 4 success, 5 failed, anything else pending', () => {
    expect(payoutState(4)).toBe('success');
    expect(payoutState(5)).toBe('failed');
    expect(payoutState(6)).toBe('pending');
  });
});
