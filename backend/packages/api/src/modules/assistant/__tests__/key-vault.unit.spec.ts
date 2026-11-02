import { last4, openKey, sealKey } from '../key-vault';

const SECRET = 'jwt-secret-for-tests-only-0123456789';
// A made-up key for the tests, not a credential.
const KEY = 'sk-or-v1-0123456789abcdefabcd1234'; // gitleaks:allow

describe('key vault', () => {
  it('opens what it sealed', () => {
    expect(openKey(sealKey(KEY, SECRET), SECRET)).toBe(KEY);
  });

  it('never stores the key in the clear', () => {
    expect(sealKey(KEY, SECRET)).not.toContain('0123456789abcdef');
  });

  it('seals the same key differently each time (random IV)', () => {
    expect(sealKey(KEY, SECRET)).not.toBe(sealKey(KEY, SECRET));
  });

  it('gives null under another secret (the JWT secret was rotated)', () => {
    expect(openKey(sealKey(KEY, SECRET), 'another-secret')).toBeNull();
  });

  it('gives null when the sealed text was tampered with', () => {
    const sealed = sealKey(KEY, SECRET);
    const parts = sealed.split(':');
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] ^= 1;
    parts[3] = ct.toString('base64');
    expect(openKey(parts.join(':'), SECRET)).toBeNull();
  });

  it('gives null for a cut-down auth tag (GCM would check only its bytes)', () => {
    const parts = sealKey(KEY, SECRET).split(':');
    parts[2] = Buffer.from(parts[2], 'base64')
      .subarray(0, 12)
      .toString('base64');
    expect(openKey(parts.join(':'), SECRET)).toBeNull();
  });

  it('gives null for text that is not a sealed key', () => {
    expect(openKey('not-sealed', SECRET)).toBeNull();
    expect(openKey('v1:a:b', SECRET)).toBeNull();
  });

  it('last4 shows only the end of the key', () => {
    expect(last4(KEY)).toBe('1234');
    expect(last4('abc')).toBe('abc');
  });
});
