import {
  MY_BANKS,
  SG_BANKS,
  TGPAY_SANDBOX_BANK,
  banksFor,
  findBank,
  gatewayBankCode,
} from '../banks';
import { withdrawalDetailsError } from '../gateway-withdrawal';

const ALL_BANKS = [...MY_BANKS, ...SG_BANKS, TGPAY_SANDBOX_BANK];
const check = (bankCode: string, accountNumber: string) =>
  withdrawalDetailsError({
    bankCode,
    accountNumber,
    accountHolderName: 'Test Holder',
  });

it('keeps only unverified Alliance SG and proxy-only ShopeePay without account rules', () => {
  expect(
    ALL_BANKS.filter((bank) => !bank.accountLengths?.length).map(
      (bank) => bank.id,
    ),
  ).toEqual(['SHOPEEPAYMY', 'ALLIANCESG']);
});

describe.each(ALL_BANKS)('$id account formats', (bank) => {
  it('accepts every declared length, with leading zeroes preserved for bank accounts', () => {
    for (const length of bank.accountLengths ?? []) {
      const number = `${bank.id === 'PAYNOWSG' ? '6' : '0'}${'1'.repeat(length - 1)}`;
      expect(check(bank.id, number)).toBeNull();
      for (const alias of bank.legacyAliases)
        expect(check(alias, number)).toBeNull();
    }
  });

  it('rejects wrong lengths and nondigits through canonical ids and legacy aliases', () => {
    const lengths = bank.accountLengths ?? [];
    const numbers = lengths.length
      ? [
          '1'.repeat(Math.min(...lengths) - 1),
          '1'.repeat(Math.max(...lengths) + 1),
          '12345abc67890',
        ]
      : ['123456789012'];
    for (const alias of [bank.id, ...bank.legacyAliases]) {
      for (const number of numbers) expect(check(alias, number)).not.toBeNull();
    }
  });
});

it.each(['ALLIANCESG', 'SHOPEEPAYMY'])(
  'keeps %s resolvable but unavailable for payments',
  (id) => {
    expect(findBank(id)).not.toBeNull();
    expect(check(id, '123456789012')).toMatch(/unavailable/i);
    for (const gateway of ['tgpay', 'the7pay', 'fake', 'a3pay'] as const) {
      expect(gatewayBankCode(id, gateway)).toBeNull();
      expect(banksFor(gateway).map((bank) => bank.bankCode)).not.toContain(id);
    }
  },
);

it('never offers a payout bank without verified account lengths', () => {
  for (const gateway of ['tgpay', 'the7pay', 'fake', 'a3pay'] as const) {
    for (const bank of banksFor(gateway, {
      sandbox: true,
      env: { TNG_PAYOUTS_ENABLED: 'true' },
    })) {
      expect(findBank(bank.bankCode)?.accountLengths?.length).toBeGreaterThan(
        0,
      );
    }
  }
});

it.each(['SCBLMYKX', 'BOFAMY'])(
  'accepts published five-digit %s accounts',
  (id) => {
    expect(check(id, '12345')).toBeNull();
  },
);

it.each(['BSNAMYK1', 'AGOBMYKL', 'OCBCSGSG', 'HSBCSGSG'])(
  'does not reject a valid 16-digit %s format on a card-number heuristic',
  (id) => expect(check(id, '4111111111111111')).toBeNull(),
);

it.each(['91234567', '6591234567', '60123456789', '442079460123'])(
  'accepts local or foreign PayNow mobile %s',
  (number) => expect(check('PAYNOWSG', number)).toBeNull(),
);

it.each(['0123456789', '123456', '1234567890123456'])(
  'rejects malformed PayNow mobile %s with its field hint',
  (number) =>
    expect(check('PAYNOWSG', number)).toMatch(/mobile number linked to PayNow/),
);

it('retains the documented sandbox sample', () => {
  expect(check('DUMMYBANKVERIFIED', '543478924652')).toBeNull();
});
