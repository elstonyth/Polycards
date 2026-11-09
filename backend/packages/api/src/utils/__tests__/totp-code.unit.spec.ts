import { totpCode } from '../totp-code';

// RFC 6238 appendix B, SHA-1 key "12345678901234567890" (base32 below). The
// RFC lists 8 digits; an authenticator app shows the last 6.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // gitleaks:allow

describe('totpCode', () => {
  it.each([
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
  ])('matches the RFC 6238 vector at T=%is', (seconds, code) => {
    expect(totpCode(RFC_SECRET, seconds * 1000)).toBe(code);
  });

  it('refuses a secret that is not base32', () => {
    expect(() => totpCode('not-base32!')).toThrow('not base32');
  });
});
