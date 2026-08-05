import {
  GET,
  POST,
  DELETE,
  parseSavedBankAccounts,
  savedBankAccountId,
  MAX_SAVED_BANK_ACCOUNTS,
} from '../route';

// Saved payout accounts live in customer.metadata.bank_accounts and are the
// picker source for the withdraw form. Two properties matter enough to pin:
// the merge must never clobber sibling metadata keys (avatar_url et al share
// the blob), and the validation must be the SAME gate as the payout submit so
// the picker can never offer an account the withdraw path refuses.

const retrieveCustomer = jest.fn();
const updateCustomers = jest.fn();

const scope = {
  resolve: jest.fn(() => ({ retrieveCustomer, updateCustomers })),
};

const mkRes = () => {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  return res as never;
};

const mkReq = (body: Record<string, unknown> | null = null) =>
  ({
    auth_context: { actor_id: 'cus_1' },
    body,
    scope,
  }) as never;

const VALID_BODY = {
  bank_code: 'MBB',
  bank_name: 'Maybank',
  account_number: '1234567890',
  account_holder_name: 'Tan Ah Kow',
};

const savedShape = (over: Partial<Record<string, unknown>> = {}) => ({
  id: savedBankAccountId('MBB', '1234567890'),
  bankCode: 'MBB',
  bankName: 'Maybank',
  accountNumber: '1234567890',
  accountHolderName: 'Tan Ah Kow',
  ...over,
});

beforeEach(() => {
  retrieveCustomer.mockReset();
  updateCustomers.mockReset();
  retrieveCustomer.mockResolvedValue({ metadata: {} });
});

describe('parseSavedBankAccounts', () => {
  it('drops malformed entries instead of crashing the list', () => {
    expect(
      parseSavedBankAccounts([
        savedShape(),
        null,
        'junk',
        { id: 'x' }, // missing fields
        42,
      ]),
    ).toEqual([savedShape()]);
  });

  it('returns [] for a non-array blob', () => {
    expect(parseSavedBankAccounts(undefined)).toEqual([]);
    expect(parseSavedBankAccounts({ not: 'an array' })).toEqual([]);
  });
});

describe('POST /store/credits/withdraw/accounts', () => {
  it('saves a valid account and MERGES around sibling metadata keys', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { avatar_url: 'https://cdn/x.webp' },
    });
    const res = mkRes();
    await POST(mkReq(VALID_BODY), res);
    expect(updateCustomers).toHaveBeenCalledWith('cus_1', {
      metadata: {
        avatar_url: 'https://cdn/x.webp',
        bank_accounts: [savedShape()],
      },
    });
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      accounts: [savedShape()],
    });
  });

  it('refuses what the payout submit would refuse (shared validation gate)', async () => {
    await expect(
      POST(mkReq({ ...VALID_BODY, account_number: 'not-digits' }), mkRes()),
    ).rejects.toThrow(/valid account number/i);
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('refuses a missing or blank bank name (its own gate, not the shared one)', async () => {
    await expect(
      POST(mkReq({ ...VALID_BODY, bank_name: ' ' }), mkRes()),
    ).rejects.toThrow(/choose a bank/i);
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('401s a register-phase token (empty actor_id) before touching the DB', async () => {
    const req = {
      auth_context: { actor_id: '' },
      body: VALID_BODY,
      scope,
    } as never;
    await expect(POST(req, mkRes())).rejects.toThrow(/unauthorized/i);
    expect(retrieveCustomer).not.toHaveBeenCalled();
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('re-adding the same bank+number updates in place, no duplicate', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [savedShape()] },
    });
    await POST(
      mkReq({ ...VALID_BODY, account_holder_name: 'Tan A. Kow' }),
      mkRes(),
    );
    const written = updateCustomers.mock.calls[0][1].metadata.bank_accounts;
    expect(written).toHaveLength(1);
    expect(written[0].accountHolderName).toBe('Tan A. Kow');
  });

  it(`refuses account #${MAX_SAVED_BANK_ACCOUNTS + 1}`, async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: Array.from({ length: MAX_SAVED_BANK_ACCOUNTS }, (_, i) =>
          savedShape({
            id: `id_${i}`,
            accountNumber: `900000000${i}`,
          }),
        ),
      },
    });
    await expect(POST(mkReq(VALID_BODY), mkRes())).rejects.toThrow(
      /remove one first/i,
    );
    expect(updateCustomers).not.toHaveBeenCalled();
  });
});

describe('DELETE /store/credits/withdraw/accounts', () => {
  it('removes by id and keeps the rest', async () => {
    const other = savedShape({ id: 'other', accountNumber: '9999999999' });
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [savedShape(), other], avatar_url: 'a' },
    });
    const res = mkRes();
    await DELETE(mkReq({ id: savedShape().id }), res);
    expect(updateCustomers).toHaveBeenCalledWith('cus_1', {
      metadata: { avatar_url: 'a', bank_accounts: [other] },
    });
  });

  it('is idempotent — deleting a gone id succeeds without a write', async () => {
    retrieveCustomer.mockResolvedValue({ metadata: { bank_accounts: [] } });
    const res = mkRes();
    await DELETE(mkReq({ id: 'nope' }), res);
    expect(updateCustomers).not.toHaveBeenCalled();
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      accounts: [],
    });
  });
});

describe('GET /store/credits/withdraw/accounts', () => {
  it('lists the parsed accounts', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [savedShape(), 'junk'] },
    });
    const res = mkRes();
    await GET(mkReq(), res);
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      accounts: [savedShape()],
    });
  });
});
