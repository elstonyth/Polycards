import { payerAccountFor, payerOnFile } from '../payer-name';

// Which saved account a GMpay pay-in declares as the paying one. Only
// accounts at a bank the gateway serves count; here every Singapore SWIFT id
// ending in SGSG does.
jest.mock('../../../modules/packs/saved-accounts', () => ({
  ...jest.requireActual('../../../modules/packs/saved-accounts'),
  bankSupportedBy: (bankCode: string) => bankCode.endsWith('SGSG'),
}));

type Saved = {
  id: string;
  bankName: string;
  bankCode: string;
  accountNumber: string;
  accountHolderName: string;
  savedAt?: string;
};

const acct = (
  bankCode: string,
  accountNumber: string,
  accountHolderName: string,
  day?: number,
): Saved => ({
  id: `${bankCode}-${accountNumber}`,
  bankName: bankCode,
  bankCode,
  accountNumber,
  accountHolderName,
  ...(day
    ? { savedAt: `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z` }
    : {}),
});

describe('payerAccountFor', () => {
  it('declares the newest served account held in the payment name', () => {
    const saved = [
      acct('DBSSSGSG', '111', 'TAN AH KOW', 2),
      acct('OCBCSGSG', '222', 'Tan  Ah Kow', 9),
      acct('MBBEMYKL', '999', 'TAN AH KOW', 19),
    ];
    expect(payerAccountFor(saved, 'gmpay', 'tan ah kow')).toEqual({
      bankCode: 'OCBCSGSG',
      accountNumber: '222',
    });
  });

  it("never pairs the name with another person's account", () => {
    const saved = [acct('DBSSSGSG', '111', 'TAN AH KOW', 2)];
    expect(payerAccountFor(saved, 'gmpay', 'LIM MEI LING')).toBeUndefined();
  });

  it('no name, no account; an account with no number is skipped', () => {
    expect(
      payerAccountFor([acct('DBSSSGSG', '111', 'A')], 'gmpay', undefined),
    ).toBeUndefined();
    expect(
      payerAccountFor([acct('DBSSSGSG', ' ', 'A')], 'gmpay', 'A'),
    ).toBeUndefined();
  });
});

describe('payerOnFile', () => {
  const scopeWith = (saved: Saved[], realName: string | null) => {
    const packs = {
      savedBankAccountsFor: jest.fn(async () => saved),
      getVerificationState: jest.fn(async () => ({
        phoneVerified: true,
        realName,
      })),
    };
    return { packs, scope: { resolve: () => packs } as never };
  };

  it('a typed name wins, and its own account is declared', async () => {
    const { scope } = scopeWith(
      [
        acct('DBSSSGSG', '111', 'TAN AH KOW'),
        acct('OCBCSGSG', '222', 'LIM MEI LING'),
      ],
      'Tan Ah Kow',
    );
    expect(await payerOnFile(scope, 'cus_1', 'gmpay', 'LIM MEI LING')).toEqual({
      name: 'LIM MEI LING',
      account: { bankCode: 'OCBCSGSG', accountNumber: '222' },
    });
  });

  it('with no typed name, the holder on file and their account, from one read', async () => {
    const { scope, packs } = scopeWith(
      [acct('DBSSSGSG', '111', 'TAN AH KOW')],
      'Tan Ah Kow',
    );
    expect(await payerOnFile(scope, 'cus_1', 'gmpay', undefined)).toEqual({
      name: 'TAN AH KOW',
      account: { bankCode: 'DBSSSGSG', accountNumber: '111' },
    });
    expect(packs.savedBankAccountsFor).toHaveBeenCalledTimes(1);
    expect(packs.getVerificationState).toHaveBeenCalledTimes(1);
  });
});
