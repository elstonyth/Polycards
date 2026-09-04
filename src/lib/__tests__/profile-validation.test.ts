import { describe, expect, it } from 'vitest';
import {
  normalizePhone,
  usernameError,
  NAME_MAX,
} from '@/lib/profile-validation';

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

// The username is the public profile URL (/profile/<username>), so these rules
// decide what a URL can contain — and they MUST stay in step with USERNAME_RE
// in backend/packages/api/src/utils/profile-handle.ts. A form that accepts what
// the API refuses just moves the error to a worse moment: after the OTP.
describe('usernameError', () => {
  it('accepts the shapes real display names take', () => {
    for (const ok of [
      'MOONBREON',
      'ash_red',
      'EvOlViNg_CrIeS',
      'Wei-Nguan',
      'Collector4809',
      '  Kenji  ', // trimmed before checking
    ]) {
      expect(usernameError(ok)).toBeNull();
    }
  });

  it('names the actual problem instead of "invalid"', () => {
    // Someone with a space in their name learns what to do next; "invalid
    // username" would leave them guessing.
    expect(usernameError('Wei Nguan')).toMatch(/space/i);
    expect(usernameError('ab')).toMatch(/at least/i);
    expect(usernameError('')).toMatch(/choose/i);
    expect(usernameError('x'.repeat(NAME_MAX + 1))).toMatch(/or fewer/i);
    expect(usernameError('爱动漫的')).toMatch(/letters, numbers/i);
  });

  it('rejects everything that would not survive a URL intact', () => {
    for (const bad of ['a/b', 'a?b', 'a#b', 'a%b', 'a.b', 'a@b', 'a+b']) {
      expect(usernameError(bad)).not.toBeNull();
    }
  });
});
