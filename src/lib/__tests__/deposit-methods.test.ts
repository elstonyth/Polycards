import { describe, it, expect } from 'vitest';
import {
  DEPOSIT_METHODS,
  DEFAULT_DEPOSIT_METHOD,
  enabledDepositMethods,
  isDepositMethod,
} from '@/lib/deposit-methods';

// This list is a trust boundary on a money path, not a labels file. The backend
// allow-list is the gateway's whole MYR set (FPX/DN/BQR/OB), so DN and FPX pass
// validation there and reach the cashier, where they fail — the guard here is
// the only thing keeping them out of a customer's hands.
describe('deposit method allow-list', () => {
  it('accepts the two provisioned channels', () => {
    expect(isDepositMethod('BQR')).toBe(true);
    expect(isDepositMethod('OB')).toBe(true);
  });

  it('rejects the codes the BACKEND would accept but the merchant lacks', () => {
    // GetSupportedBanks answers 400 Not found for both on merchant Polycard.
    // This is the assertion with content: nothing downstream refuses them.
    expect(isDepositMethod('DN')).toBe(false);
    expect(isDepositMethod('FPX')).toBe(false);
  });

  it('rejects a missing or non-string method', () => {
    expect(isDepositMethod(undefined)).toBe(false);
    expect(isDepositMethod('')).toBe(false);
    expect(isDepositMethod(0)).toBe(false);
  });

  it('offers the default channel', () => {
    // A default that is not on the list would be preselected in the sheet and
    // then refused by the server action — a top-up nobody can complete.
    expect(isDepositMethod(DEFAULT_DEPOSIT_METHOD)).toBe(true);
  });
});

describe('enabledDepositMethods (runtime retract switch)', () => {
  const codes = (raw: string | undefined) =>
    enabledDepositMethods(raw).map((method) => method.code);

  it('offers everything when unset', () => {
    expect(codes(undefined)).toEqual(DEPOSIT_METHODS.map((m) => m.code));
  });

  it('retracts a channel by name', () => {
    expect(codes('BQR')).toEqual(['BQR']);
    expect(codes('OB')).toEqual(['OB']);
  });

  it('tolerates spacing and case', () => {
    expect(codes(' bqr , ob ')).toEqual(['BQR', 'OB']);
  });

  it('falls back to everything rather than leaving no way to pay', () => {
    // A typo must not silently strand every customer. Killing top-ups outright
    // is GLOBEPAY_ENABLED's job on the backend, not this switch's.
    expect(codes('')).toEqual(DEPOSIT_METHODS.map((m) => m.code));
    expect(codes('FPX')).toEqual(DEPOSIT_METHODS.map((m) => m.code));
  });

  it('ignores an un-provisioned code riding along with a real one', () => {
    expect(codes('BQR,FPX')).toEqual(['BQR']);
  });
});
