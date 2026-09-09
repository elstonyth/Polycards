import { describe, expect, test, vi } from 'vitest';
import { shouldGatePhone } from '@/lib/phone-gate';

// The account layout's required-phone gate condition. Pins the cohort (flag
// on + no phone + no password + no partner-group exemption) and the property
// the layout comment promises: the account reads are paid only by phoneless
// accounts.

const read = (value: boolean) => vi.fn(async () => value);

describe('shouldGatePhone', () => {
  test('enforcement off: never gates, never reads the account', async () => {
    const hasPassword = read(false);
    const exempt = read(false);
    expect(
      await shouldGatePhone({ flag: false, phone: null, hasPassword, exempt }),
    ).toBe(false);
    expect(hasPassword).not.toHaveBeenCalled();
    expect(exempt).not.toHaveBeenCalled();
  });

  test('a phone on the row: no gate, no account read', async () => {
    const hasPassword = read(false);
    const exempt = read(true);
    expect(
      await shouldGatePhone({
        flag: true,
        phone: '+60123456789',
        hasPassword,
        exempt,
      }),
    ).toBe(false);
    expect(hasPassword).not.toHaveBeenCalled();
    expect(exempt).not.toHaveBeenCalled();
  });

  test('phoneless password account: exempt (Settings flow instead)', async () => {
    expect(
      await shouldGatePhone({
        flag: true,
        phone: '',
        hasPassword: read(true),
        exempt: read(false),
      }),
    ).toBe(false);
  });

  test('phoneless password-less account: gated', async () => {
    expect(
      await shouldGatePhone({
        flag: true,
        phone: null,
        hasPassword: read(false),
        exempt: read(false),
      }),
    ).toBe(true);
  });

  // Partner groups (spec 2026-09-09): the group's verification_exempt is the
  // one thing that lifts the gate for the gated cohort — the backend money
  // paths already pass them, so the modal would demand a phone for nothing.
  test('verification-exempt account: never gated', async () => {
    expect(
      await shouldGatePhone({
        flag: true,
        phone: null,
        hasPassword: read(false),
        exempt: read(true),
      }),
    ).toBe(false);
  });
});
