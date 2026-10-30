import { describe, expect, it } from 'vitest';
import type { WithdrawBank } from '@/lib/actions/vault';
import { bankCountryGroups, REGIONAL_RAILS } from '../regional-rails';

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
    const THB = { bankCode: 'KBANKTH', bankName: 'Kasikorn', currency: 'THB' };
    expect(bankCountryGroups([THB])).toEqual([
      { country: 'THB', items: [THB] },
    ]);
  });

  it('groups USDT wallets under their own toggle with the Tether mark', () => {
    const TRC = {
      bankCode: 'USDTTRC20',
      bankName: 'USDT · TRC20 (Tron)',
      currency: 'USDT',
    };
    expect(bankCountryGroups([TRC])).toEqual([
      { country: 'USDT', flag: 'USDT', items: [TRC] },
    ]);
  });
});

// GlobePay365 production refuses ERC20 payins (2026-10-26); the backend
// allow-list (gateway.ts depositMethods) says the same.
describe('USDT top-up chains', () => {
  it('offers TRC20 only', () => {
    expect(REGIONAL_RAILS.USDT?.methods.map((m) => m.code)).toEqual(['UTRC']);
  });
});
