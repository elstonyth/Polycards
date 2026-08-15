import { describe, it, expect } from 'vitest';
import { elapsedLabel, reasonLabel, signedRm } from '@/lib/transactions';

describe('reasonLabel', () => {
  it('maps each reason to a human label', () => {
    expect(reasonLabel('topup')).toBe('Top-up');
    expect(reasonLabel('pack_open')).toBe('Pack open');
    expect(reasonLabel('buyback')).toBe('Sell-back');
    expect(reasonLabel('adjustment')).toBe('Adjustment');
  });
  it('labels the VIP commission reasons the backend now emits', () => {
    expect(reasonLabel('direct_referral')).toBe('Referral commission');
    expect(reasonLabel('team_override')).toBe('Team override');
    expect(reasonLabel('commission_reversal')).toBe('Commission reversal');
    expect(reasonLabel('cashout')).toBe('Cashout');
  });

  // Audit 2026-07-07 #11: a backend reason added before the storefront
  // redeploys has no REASON_LABEL entry — it must still render a readable
  // generic label, not `undefined` / a thrown lookup.
  it('falls back to a prettified label for an unknown reason', () => {
    expect(reasonLabel('refund_x')).toBe('Refund x');
    expect(reasonLabel('some_new_reason')).toBe('Some new reason');
  });
});

describe('signedRm', () => {
  it('prefixes a sign and formats the magnitude', () => {
    expect(signedRm(48)).toBe('+RM 48.00');
    expect(signedRm(-25)).toBe('-RM 25.00');
    expect(signedRm(0)).toBe('RM 0.00');
  });
});

describe('elapsedLabel', () => {
  const minutes = (n: number) => n * 60_000;

  it('reads in minutes, and never says "0 minutes"', () => {
    const now = 1_000_000_000;
    expect(elapsedLabel(now - 1_000, now)).toBe('just now');
    expect(elapsedLabel(now - minutes(1), now)).toBe('1 minute ago');
    expect(elapsedLabel(now - minutes(2), now)).toBe('2 minutes ago');
    expect(elapsedLabel(now - minutes(7) - 30_000, now)).toBe('7 minutes ago');
  });

  // A clock skew must not render someone's payment as starting in the future.
  it('clamps a start instant that is ahead of now', () => {
    const now = 1_000_000_000;
    expect(elapsedLabel(now + minutes(5), now)).toBe('just now');
  });
});
