import {
  MY_BANKS,
  TGPAY_SANDBOX_BANK,
  banksFor,
  canonicalBankCode,
  findBank,
  gatewayBankCode,
} from '../banks';

describe('bank registry', () => {
  it('ids are unique, uppercase alphanumeric (the withdrawal validator admits nothing else)', () => {
    const ids = MY_BANKS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Z0-9]{2,20}$/);
  });

  it('no gateway code is claimed by two banks', () => {
    const seen = new Map<string, string>();
    for (const b of MY_BANKS) {
      for (const [gw, c] of Object.entries(b.codes)) {
        const key = `${gw}:${c.code}`;
        expect(seen.get(key)).toBeUndefined();
        seen.set(key, b.id);
      }
    }
  });

  it('covers every GlobePay MYR payout bank and every TGPay SWIFT row', () => {
    const globepay = MY_BANKS.filter((b) => b.codes.globepay).length;
    const tgpay = MY_BANKS.filter((b) => b.codes.tgpay).length;
    expect(globepay).toBe(31);
    expect(tgpay).toBe(20);
  });

  it('resolves canonical ids and any gateway code, case-insensitively', () => {
    expect(findBank('MBBEMYKL')?.name).toBe('Maybank');
    expect(findBank('MYMB2U')?.id).toBe('MBBEMYKL');
    expect(findBank('mymb2u')?.id).toBe('MBBEMYKL');
    expect(canonicalBankCode('MYCIMB')).toBe('CIBBMYKL');
    expect(findBank('MBB')).toBeNull();
    expect(findBank(undefined)).toBeNull();
  });

  it('translates a bank to each gateway, with that gateway\'s own name pairing', () => {
    // Saved under GlobePay, paid by TGPay after a switch.
    expect(gatewayBankCode('MYMB2U', 'tgpay')).toEqual({
      code: 'MBBEMYKL',
      name: 'Maybank / Malayan Banking Berhad',
    });
    // Saved under TGPay, paid by GlobePay after a switch back.
    expect(gatewayBankCode('MBBEMYKL', 'globepay')).toEqual({
      code: 'MYMB2U',
      name: 'Maybank Berhad',
    });
    // A bank only one gateway serves.
    expect(gatewayBankCode('BOOSTMY', 'globepay')?.code).toBe('BODE');
    expect(gatewayBankCode('BOOSTMY', 'tgpay')).toBeNull();
    expect(gatewayBankCode('CITIMYKL', 'globepay')).toBeNull();
  });

  it('picker lists carry canonical ids and neutral names; the dummy bank only on the TGPay sandbox', () => {
    const tgpay = banksFor('tgpay');
    expect(tgpay).toHaveLength(20);
    expect(tgpay[0]).toEqual({ bankCode: 'PHBMMYKL', bankName: 'Affin Bank' });
    expect(banksFor('tgpay', { sandbox: true })[0].bankCode).toBe(
      TGPAY_SANDBOX_BANK.id,
    );
    expect(banksFor('globepay')).toHaveLength(31);
    expect(banksFor('globepay').some((b) => b.bankCode === 'DUMMYBANKVERIFIED')).toBe(false);
  });
});
