import { describe, expect, it } from 'vitest';
import { adjustCreditVars, isBonusGrant } from './credit-kind';

describe('operator credit kind', () => {
  it('defaults a grant to bonus and a deduction to withdrawable credit', () => {
    expect(isBonusGrant(null, '')).toBe(true);
    expect(isBonusGrant(null, '50')).toBe(true);
    expect(isBonusGrant(null, ' -50 ')).toBe(false);
  });

  it('lets an explicit choice win over the default', () => {
    expect(isBonusGrant(false, '50')).toBe(false);
    expect(isBonusGrant(true, '-50')).toBe(true);
  });

  it('sends kind bonus only for a bonus adjustment', () => {
    expect(adjustCreditVars('cus_1', 15, 'Giveaway', true)).toEqual({
      id: 'cus_1',
      amount: 15,
      note: 'Giveaway',
      kind: 'bonus',
    });
    expect(adjustCreditVars('cus_1', -15, 'Fix', false).kind).toBeUndefined();
  });
});
