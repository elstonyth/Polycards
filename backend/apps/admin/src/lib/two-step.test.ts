import { describe, expect, it } from 'vitest';
import { afterSignIn, digitsOnly, groupKey } from './two-step';

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
