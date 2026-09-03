import {
  generateReferralCode,
  normalizeReferralCode,
  REFERRAL_CODE_RE,
} from '../referral-code';

describe('referral-code', () => {
  it('generates 8 symbols from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateReferralCode();
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
      expect(REFERRAL_CODE_RE.test(code)).toBe(true);
    }
  });

  it('does not repeat within a batch', () => {
    const codes = new Set(Array.from({ length: 1000 }, () => generateReferralCode()));
    expect(codes.size).toBe(1000);
  });

  it('normalizes pasted input and rejects non-codes', () => {
    expect(normalizeReferralCode(' f42b-0700 ')).toBe('F42B0700');
    expect(normalizeReferralCode('F42B 0700')).toBe('F42B0700');
    expect(normalizeReferralCode('F42B070')).toBeNull(); // 7 chars
    expect(normalizeReferralCode('F42B07001')).toBeNull(); // 9 chars
    expect(normalizeReferralCode('F42B_700')).toBeNull();
    expect(normalizeReferralCode('')).toBeNull();
    expect(normalizeReferralCode(42)).toBeNull();
    expect(normalizeReferralCode(null)).toBeNull();
    expect(normalizeReferralCode(undefined)).toBeNull();
  });
});
