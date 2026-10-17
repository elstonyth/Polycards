import { describe, expect, it } from 'vitest';
import type { WithdrawBank } from '@/lib/actions/vault';
import { bankCountryGroups } from '../regional-rails';

describe('bankCountryGroups', () => {
  const MAYBANK = { bankCode: 'MBB', bankName: 'Maybank', currency: 'MYR' };
  // An older backend sends no currency: RM.
  const OLD_BACKEND: WithdrawBank = { bankCode: 'CIMB', bankName: 'CIMB Bank' };
  const DBS = { bankCode: 'DBS', bankName: 'DBS Bank', currency: 'SGD' };

  it('puts Malaysia first and Singapore after, in list order', () => {
    expect(bankCountryGroups([DBS, MAYBANK, OLD_BACKEND])).toEqual([
      { country: 'Malaysia', flag: 'MY', items: [MAYBANK, OLD_BACKEND] },
      { country: 'Singapore', flag: 'SG', items: [DBS] },
    ]);
  });

  it('leaves out a country with no banks', () => {
    expect(bankCountryGroups([MAYBANK])).toEqual([
      { country: 'Malaysia', flag: 'MY', items: [MAYBANK] },
    ]);
    expect(bankCountryGroups([DBS])).toEqual([
      { country: 'Singapore', flag: 'SG', items: [DBS] },
    ]);
    expect(bankCountryGroups([])).toEqual([]);
  });

  it('keeps a bank in a currency this build has no rail for, with no flag', () => {
    const USDT = { bankCode: 'TRC20', bankName: 'USDT', currency: 'USDT' };
    expect(bankCountryGroups([USDT])).toEqual([
      { country: 'USDT', items: [USDT] },
    ]);
  });
});
