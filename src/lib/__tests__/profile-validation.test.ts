import { describe, expect, it } from 'vitest';
import { normalizePhone, NAME_MAX } from '@/lib/profile-validation';

describe('normalizePhone', () => {
  it('normalizes MY local, country-coded and E.164 shapes to +60…', () => {
    expect(normalizePhone('0107667787')).toBe('+60107667787');
    expect(normalizePhone('60107667787')).toBe('+60107667787');
    expect(normalizePhone('+60 10-766 7787')).toBe('+60107667787');
    expect(normalizePhone('010-766 7787')).toBe('+60107667787');
  });

  it('accepts other countries via E.164 or an explicit country', () => {
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('020 7946 0958', 'GB')).toBe('+442079460958');
    expect(normalizePhone('+65 6123 4567')).toBe('+6561234567');
  });

  it('rejects malformed or wrong-length input', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('01123')).toBeNull();
    expect(normalizePhone('011123456789012')).toBeNull();
    // Valid-looking prefix, invalid length for GB.
    expect(normalizePhone('+44 123')).toBeNull();
  });

  it('exports a sane name cap', () => {
    expect(NAME_MAX).toBeGreaterThan(0);
    expect(NAME_MAX).toBeLessThanOrEqual(120);
  });
});
