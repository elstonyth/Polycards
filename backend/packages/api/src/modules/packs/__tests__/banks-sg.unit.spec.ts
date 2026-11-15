import {
  MY_BANKS,
  SG_BANKS,
  TGPAY_SANDBOX_BANK,
  banksFor,
  findBank,
  gatewayBankCode,
} from '../banks';

const ALL = [...MY_BANKS, ...SG_BANKS, TGPAY_SANDBOX_BANK];

describe('Singapore banks (A3Pay) beside the Malaysian registry', () => {
  it('every lookup alias resolves to the bank that owns it, never a namesake', () => {
    for (const bank of ALL) {
      const aliases = [
        bank.id,
        ...Object.values(bank.codes).map((c) => c.code),
        ...bank.legacyAliases,
      ];
      for (const alias of aliases) {
        const found = findBank(alias);
        // Absent is fine (SG gateway codes are deliberately not aliases);
        // resolving to ANOTHER bank is the bug.
        if (found) expect(found.id).toBe(bank.id);
      }
      expect(findBank(bank.id)?.id).toBe(bank.id);
    }
  });

  it('canonical ids pass the withdrawal validator ([A-Z0-9]{2,20})', () => {
    for (const bank of SG_BANKS) expect(bank.id).toMatch(/^[A-Z0-9]{2,20}$/);
  });

  it('bare A3Pay codes are NOT aliases — a saved "CIMB" never re-homes to Singapore', () => {
    for (const code of ['CIMB', 'UOB', 'OCBC', 'RHB', 'HLB', 'BOC', 'SDBS']) {
      expect(findBank(code)).toBeNull();
    }
    expect(findBank('UOVBSGSG')?.name).toBe('UOB (SG)');
    expect(findBank('UOVBMYKL')?.id).toBe('UOVBMYKL');
    expect(findBank('MYOCBC')?.id).toBe('OCBCMYKL');
  });

  it('A3Pay pays only Singapore banks; TGPay only Malaysian ones', () => {
    expect(gatewayBankCode('DBSSSGSG', 'a3pay')).toEqual({
      code: 'SDBS',
      name: 'DBS Bank Singapore',
    });
    expect(gatewayBankCode('POSBSG', 'a3pay')?.code).toBe('POSB');
    expect(gatewayBankCode('MBBEMYKL', 'a3pay')).toBeNull();
    expect(gatewayBankCode('DBSSSGSG', 'tgpay')).toBeNull();
    expect(banksFor('a3pay').map((b) => b.bankCode)).toEqual(
      SG_BANKS.filter((b) => b.id !== 'ALLIANCESG').map((b) => b.id),
    );
    expect(banksFor('tgpay').some((b) => b.bankCode.endsWith('SG'))).toBe(
      false,
    );
  });
});
