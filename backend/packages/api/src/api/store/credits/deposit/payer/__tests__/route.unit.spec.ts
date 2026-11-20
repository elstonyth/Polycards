import { GET } from '../route';

// The name the S$ top-up sheet shows for the paying account: a saved
// account's holder at a bank A3Pay pays (shown with "Change"), else nothing
// saved and the real name to pre-fill.
const A3PAY_ENV = {
  GATEWAY_ENABLED: 'true',
  A3PAY_ENABLED: 'true',
  A3PAY_API_BASE: 'https://mapi.example.test',
  A3PAY_MERCHANT_CODE: 'SGD00001',
  A3PAY_AES_KEY: 'k',
  A3PAY_MERCHANT_PRIVATE_KEY: 'priv',
  A3PAY_PUBLIC_KEY: 'pub',
};
const ORIGINAL = { ...process.env };
beforeEach(() => {
  process.env = { ...ORIGINAL, ...A3PAY_ENV };
});
afterAll(() => {
  process.env = ORIGINAL;
});

function run(
  accounts: { bankCode: string; accountHolderName: string }[],
  realName: string | null,
  currency: unknown = 'sgd',
) {
  const packs = {
    savedBankAccountsFor: jest.fn(async () => accounts),
    getVerificationState: jest.fn(async () => ({
      phoneVerified: true,
      realName,
    })),
  };
  const res = {
    body: undefined as unknown,
    setHeader: jest.fn(),
    json(payload: unknown) {
      this.body = payload;
    },
  };
  const req = {
    scope: { resolve: () => packs },
    query: { currency },
    auth_context: { actor_id: 'cus_1' },
  };
  return GET(req as never, res as never).then(() => ({ res, packs }));
}

describe('GET /store/credits/deposit/payer', () => {
  it('a saved Singapore account: its holder, as the bank spells it', async () => {
    const { res, packs } = await run(
      [{ bankCode: 'DBSSSGSG', accountHolderName: 'TAN AH KOW' }],
      'Tan Ah Kow',
    );
    expect(res.body).toEqual({
      currency: 'SGD',
      saved_name: 'TAN AH KOW',
      real_name: 'Tan Ah Kow',
      fixed_name: false,
      blocked_reason: null,
    });
    expect(packs.savedBankAccountsFor).toHaveBeenCalledWith('cus_1');
  });

  it('no Singapore account: nothing saved, the real name to pre-fill', async () => {
    const { res } = await run(
      [{ bankCode: 'MBBEMYKL', accountHolderName: 'AHMAD BIN ALI' }],
      'nickname',
    );
    expect(res.body).toMatchObject({ saved_name: null, real_name: 'nickname' });
  });

  it('nothing at all: nothing to pre-fill', async () => {
    const { res } = await run([], null);
    expect(res.body).toMatchObject({ saved_name: null, real_name: null });
  });

  it('refuses a currency with no open rail, and says RM needs no payer name', async () => {
    await expect(run([], null, 'EUR')).rejects.toThrow(
      /EUR top-ups are not available/,
    );
    await expect(run([], null, '')).rejects.toThrow(/not available/);
    await expect(run([], null, 'MYR')).rejects.toThrow(
      /MYR top-ups need no payer name/,
    );
  });
});

describe('GET /store/credits/deposit/payer — GMpay', () => {
  const GMPAY_ENV = {
    GATEWAY_ENABLED: 'true',
    GMPAY_ENABLED: 'true',
    GMPAY_API_BASE: 'https://xapi.example.test/v3',
    GMPAY_CLIENT_ID: 'client-1',
    GMPAY_SECRET_KEY: 'secret',
  };
  beforeEach(() => {
    process.env = { ...ORIGINAL, ...GMPAY_ENV };
  });
  const acct = (holder: string) => [
    {
      bankCode: 'DBSSSGSG',
      accountHolderName: holder,
      accountNumber: '0123456789',
    },
  ];

  it('a full name on file: fixed, nothing in the way', async () => {
    const { res } = await run(acct('TAN AH KOW'), 'TAN AH KOW');
    expect(res.body).toEqual({
      currency: 'SGD',
      saved_name: 'TAN AH KOW',
      real_name: 'TAN AH KOW',
      fixed_name: true,
      blocked_reason: null,
    });
  });

  it('initials on file: says support must correct the name before paying', async () => {
    const { res } = await run(acct('lkm'), 'lkm');
    expect(res.body).toMatchObject({
      saved_name: 'lkm',
      fixed_name: true,
      blocked_reason: "Singapore top-ups are matched to the full name on your bank account, and the name on your Polycards account is incomplete. Contact support to update it to your full name exactly as your bank shows it.",
    });
  });

  it('no Singapore account: says to save the paying account first', async () => {
    const { res } = await run([], 'TAN AH KOW');
    expect(res.body).toMatchObject({
      saved_name: null,
      fixed_name: true,
      blocked_reason: "Save the bank account you pay from first, on the Withdraw page. Singapore top-ups are matched to it.",
    });
  });
});
