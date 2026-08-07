import {
  GET,
  POST,
  DELETE,
  parseSavedBankAccounts,
  savedBankAccountId,
  MAX_SAVED_BANK_ACCOUNTS,
} from '../route';

// Saved payout accounts live in customer.metadata.bank_accounts and are the
// picker source for the withdraw form. Three properties matter enough to pin:
// the merge must never clobber sibling metadata keys (avatar_url et al share
// the blob), the validation must be the SAME gate as the payout submit so the
// picker can never offer an account the withdraw path refuses, and both writes
// must go through the locked metadata mutator rather than reading the blob here
// and writing it back.

const retrieveCustomer = jest.fn();
const updateCustomers = jest.fn();

// Stand-in for PacksModuleService.mutateCustomerMetadata. It reproduces the
// real method's ORDER — read, then mutate, then write (or skip the write on
// null) — against the same customer-module mocks, so the assertions below stay
// about what the ROUTE does. That the real one wraps this in a
// `metadata:<customer>` advisory lock, and that the read happens after the lock
// statement, is pinned separately in
// modules/packs/__tests__/customer-metadata-lock.unit.spec.ts — a route spec
// cannot execute two transactions against a Postgres lock.
const mutateCustomerMetadata = jest.fn(
  async (input: {
    customerId: string;
    customers: { retrieveCustomer: jest.Mock; updateCustomers: jest.Mock };
    mutate: (
      m: Record<string, unknown>,
    ) => Record<string, unknown> | null;
  }) => {
    const customer = await input.customers.retrieveCustomer(input.customerId);
    const current = (customer.metadata ?? {}) as Record<string, unknown>;
    const next = input.mutate(current);
    if (next === null) return current;
    await input.customers.updateCustomers(input.customerId, { metadata: next });
    return next;
  },
);

const scope = {
  resolve: jest.fn((key: string) =>
    key === 'packs'
      ? { mutateCustomerMetadata }
      : { retrieveCustomer, updateCustomers },
  ),
};

const mkRes = () => {
  const res = { json: jest.fn(), status: jest.fn(), setHeader: jest.fn() };
  res.status.mockReturnValue(res);
  return res as never;
};

/** Every handler serves full account numbers — assert none are cacheable. */
const expectNoStore = (res: never) =>
  expect((res as { setHeader: jest.Mock }).setHeader).toHaveBeenCalledWith(
    'Cache-Control',
    'no-store',
  );

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

/** A saved list already at the cap. */
const fullList = () =>
  Array.from({ length: MAX_SAVED_BANK_ACCOUNTS }, (_, i) =>
    savedShape({ id: `id_${i}`, accountNumber: `900000000${i}` }),
  );

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
  mutateCustomerMetadata.mockClear();
  retrieveCustomer.mockResolvedValue({ metadata: {} });
  updateCustomers.mockResolvedValue({});
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
    expectNoStore(res);
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
      metadata: { bank_accounts: fullList() },
    });
    await expect(POST(mkReq(VALID_BODY), mkRes())).rejects.toThrow(
      /remove one first/i,
    );
    expect(updateCustomers).not.toHaveBeenCalled();
    // Exactly one read, and it is the mutator's. A second read would mean a
    // caller-side copy of the blob exists to go stale.
    expect(retrieveCustomer).toHaveBeenCalledTimes(1);
  });

  // The discriminating form of the cap test: the two possible sources of truth
  // are made to DISAGREE. The locked read sees a full list; anything read
  // outside the mutator sees an empty one. A handler that decided from its own
  // read would happily save a sixth account here.
  it('enforces the cap against the blob the MUTATOR supplies, not one read outside it', async () => {
    retrieveCustomer.mockResolvedValue({ metadata: { bank_accounts: [] } });
    mutateCustomerMetadata.mockImplementationOnce(async (input) => {
      const next = input.mutate({ bank_accounts: fullList() });
      return next ?? {};
    });
    await expect(POST(mkReq(VALID_BODY), mkRes())).rejects.toThrow(
      /remove one first/i,
    );
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('goes through the locked mutator rather than writing metadata itself', async () => {
    await POST(mkReq(VALID_BODY), mkRes());
    expect(mutateCustomerMetadata).toHaveBeenCalledTimes(1);
    expect(mutateCustomerMetadata.mock.calls[0][0].customerId).toBe('cus_1');
  });

  // Contract: the response is the list that LANDED, not the one this handler
  // proposed. Under the lock those can differ (a concurrent writer wins), and
  // echoing the proposal would tell the customer something untrue.
  it('echoes the list as written, not as proposed', async () => {
    const landed = savedShape({ accountHolderName: 'What Actually Landed' });
    mutateCustomerMetadata.mockImplementationOnce(async (input) => {
      input.mutate({});
      return { bank_accounts: [landed] };
    });
    const res = mkRes();
    await POST(mkReq(VALID_BODY), res);
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      accounts: [landed],
    });
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
    expectNoStore(res);
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
    expectNoStore(res);
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      accounts: [savedShape()],
    });
  });
});
