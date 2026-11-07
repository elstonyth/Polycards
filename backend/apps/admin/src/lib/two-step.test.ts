import { describe, expect, it } from 'vitest';
import {
  afterSignIn,
  digitsOnly,
  groupKey,
  keepEnrollment,
  keptEnrollment,
} from './two-step';

describe('digitsOnly', () => {
  it('keeps the six digits of a pasted code', () => {
    expect(digitsOnly('123 456')).toBe('123456');
    expect(digitsOnly('12-34-56-78')).toBe('123456');
    expect(digitsOnly('abc')).toBe('');
  });
});

describe('afterSignIn', () => {
  it('goes back to the page asked for inside the admin', () => {
    expect(afterSignIn('/players?q=ace')).toBe('/players?q=ace');
  });

  it('never leaves the admin, and never loops back to sign-in', () => {
    for (const bad of [
      null,
      '',
      'https://evil.example',
      '//evil.example',
      'players',
      '/sign-in',
      '/two-step-setup',
    ]) {
      expect(afterSignIn(bad)).toBe('/');
    }
  });
});

describe('groupKey', () => {
  it('shows the key in groups of four, as authenticator apps take it', () => {
    expect(groupKey('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
  });
});

describe('keptEnrollment / keepEnrollment', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
  };
  const setup = {
    factorId: 'authmfa_1',
    secret: 'JBSWY3DPEHPK3PXP',
    otpauthUrl: 'otpauth://totp/Polycards%20Admin:a%40b.c?secret=JBSWY3DPEHPK3PXP',
  };

  it('gives a reload the same setup, until it is confirmed', () => {
    const store = memory();
    expect(keptEnrollment(store)).toBeNull();
    keepEnrollment(store, setup);
    expect(keptEnrollment(store)).toEqual(setup);
    keepEnrollment(store, null);
    expect(keptEnrollment(store)).toBeNull();
  });

  it('ignores missing storage and anything malformed', () => {
    expect(keptEnrollment(null)).toBeNull();
    expect(() => keepEnrollment(null, setup)).not.toThrow();
    const store = memory();
    store.setItem('pc.twoStep.enrollment', '{"factorId":1}');
    expect(keptEnrollment(store)).toBeNull();
    store.setItem('pc.twoStep.enrollment', 'not json');
    expect(keptEnrollment(store)).toBeNull();
  });
});
