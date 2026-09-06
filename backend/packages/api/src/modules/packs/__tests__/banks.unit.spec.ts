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

  it('no alias resolves to two banks — ids, gateway codes and legacy aliases share ONE lookup namespace', () => {
    // findBank() keys canonical ids, every gateway code and every legacy
    // alias in a single case-insensitive map, so a collision across those
    // categories would silently make one bank resolve as another. The same
    // bank may reuse a key across categories (a SWIFT id that is also its
    // TGPay code); only a different owner is a fault.
    const owner = new Map<string, string>();
    for (const b of [...MY_BANKS, TGPAY_SANDBOX_BANK]) {
      const keys = [
        b.id,
        ...Object.values(b.codes).map((c) => c.code),
        ...b.legacyAliases,
      ].map((k) => k.toUpperCase());
      for (const key of keys) {
        const prior = owner.get(key);
        expect(prior === undefined || prior === b.id).toBe(true);
        owner.set(key, b.id);
      }
    }
  });

  it('covers every TGPay SWIFT row and keeps every retired-gateway code as an alias', () => {
    const tgpay = MY_BANKS.filter((b) => b.codes.tgpay).length;
    const aliased = MY_BANKS.filter((b) => b.legacyAliases.length).length;
    expect(tgpay).toBe(20);
    expect(aliased).toBe(31);
  });

  it('resolves canonical ids and any legacy code, case-insensitively', () => {
    expect(findBank('MBBEMYKL')?.name).toBe('Maybank');
    expect(findBank('MYMB2U')?.id).toBe('MBBEMYKL');
    expect(findBank('mymb2u')?.id).toBe('MBBEMYKL');
    expect(canonicalBankCode('MYCIMB')).toBe('CIBBMYKL');
    expect(findBank('MBB')).toBeNull();
    // Saved under the retired gateway, paid by TGPay today.
    expect(gatewayBankCode('MYMB2U', 'tgpay')).toEqual({
      code: 'MBBEMYKL',
      name: 'Maybank / Malayan Banking Berhad',
    });
    // A wallet TGPay has no payout code for still resolves (so a saved
    // account under it reads as "not available", never as unknown).
    expect(gatewayBankCode('BOOSTMY', 'tgpay')).toBeNull();
    expect(findBank('BODE')?.id).toBe('BOOSTMY');
  });

  it('picker lists carry canonical ids and neutral names; the dummy bank only on the TGPay sandbox', () => {
    const tgpay = banksFor('tgpay');
    expect(tgpay).toHaveLength(20);
    expect(tgpay[0]).toEqual({ bankCode: 'PHBMMYKL', bankName: 'Affin Bank' });
    expect(banksFor('tgpay', { sandbox: true })[0].bankCode).toBe(
      TGPAY_SANDBOX_BANK.id,
    );
    expect(tgpay.some((b) => b.bankCode === 'DUMMYBANKVERIFIED')).toBe(false);
  });
});
