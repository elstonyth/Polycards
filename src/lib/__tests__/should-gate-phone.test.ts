import { describe, expect, test, vi } from 'vitest';
import { shouldGatePhone } from '@/lib/phone-gate';

// The account layout's required-phone gate condition. Pins the cohort (flag
// on + no phone + no password) and the property the layout comment promises:
// the account read is paid only by phoneless accounts.

const read = (hasPassword: boolean) => vi.fn(async () => hasPassword);

describe('shouldGatePhone', () => {
  test('enforcement off: never gates, never reads the account', async () => {
    const hasPassword = read(false);
    expect(
      await shouldGatePhone({ flag: false, phone: null, hasPassword }),
    ).toBe(false);
    expect(hasPassword).not.toHaveBeenCalled();
  });

  test('a phone on the row: no gate, no account read', async () => {
    const hasPassword = read(false);
    expect(
      await shouldGatePhone({ flag: true, phone: '+60123456789', hasPassword }),
    ).toBe(false);
    expect(hasPassword).not.toHaveBeenCalled();
  });

  test('phoneless password account: exempt (Settings flow instead)', async () => {
    expect(
      await shouldGatePhone({ flag: true, phone: '', hasPassword: read(true) }),
    ).toBe(false);
  });

  test('phoneless password-less account: gated', async () => {
    expect(
      await shouldGatePhone({
        flag: true,
        phone: null,
        hasPassword: read(false),
      }),
    ).toBe(true);
  });
});
