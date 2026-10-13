import { GET } from '../route';

// Does the S$ top-up sheet need to ask for the paying account's name? Only
// when no saved account at a bank A3Pay pays settles it — and the name on
// file itself never leaves the server.
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
  it('a saved Singapore account settles it: no question, and no name sent back', async () => {
    const { res, packs } = await run(
      [{ bankCode: 'DBSSSGSG', accountHolderName: 'TAN AH KOW' }],
      'Tan Ah Kow',
    );
    expect(res.body).toEqual({
      currency: 'SGD',
      name_on_file: true,
      real_name: 'Tan Ah Kow',
    });
    expect(JSON.stringify(res.body)).not.toContain('TAN AH KOW');
    expect(packs.savedBankAccountsFor).toHaveBeenCalledWith('cus_1');
  });

  it('no Singapore account: ask, pre-filled with the real name', async () => {
    const { res } = await run(
      [{ bankCode: 'MBBEMYKL', accountHolderName: 'AHMAD BIN ALI' }],
      'nickname',
    );
    expect(res.body).toMatchObject({
      name_on_file: false,
      real_name: 'nickname',
    });
  });

  it('nothing at all: ask, with nothing to pre-fill', async () => {
    const { res } = await run([], null);
    expect(res.body).toMatchObject({ name_on_file: false, real_name: null });
  });

  it('refuses a currency with no open rail', async () => {
    await expect(run([], null, 'EUR')).rejects.toThrow(
      /EUR top-ups are not available/,
    );
    await expect(run([], null, '')).rejects.toThrow(/not available/);
  });
});
