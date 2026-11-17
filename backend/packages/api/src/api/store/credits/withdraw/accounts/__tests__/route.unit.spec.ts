import {
  GET,
  POST,
  DELETE,
  parseSavedBankAccounts,
  savedBankAccountId,
  SHARED_PAYOUT_ACCOUNT_MESSAGE,
  SHARED_SAVE_MESSAGE,
} from '../route';
import type {
  FakeFacet,
  CustomerWallet,
  PayoutDestinations,
} from '../../../../../../modules/packs/facets';
import { DEFAULT_WITHDRAWAL_CONTROLS } from '../../../../../../modules/packs/withdrawal-controls';

// Saved payout accounts live in customer.metadata.bank_accounts and are the
// picker source for the withdraw form. Three properties matter enough to pin:
// the merge must never clobber sibling metadata keys (avatar_url et al share
// the blob), the validation must be the SAME gate as the payout submit so the
// picker can never offer an account the withdraw path refuses, and the write
// must go through the locked metadata mutator rather than reading the blob here
// and writing it back.

const retrieveCustomer = jest.fn();
const updateCustomers = jest.fn();

// Stand-in for PacksModuleService.mutateCustomerMetadata. The real one does the
// read and the write as raw SQL on its own locked transaction, so there is
// nothing here for a route spec to observe — this fake reproduces only the
// contract the ROUTE depends on: mutate is handed the current blob exactly
// once, `null` means no write, and the return value is what landed. The lock
// itself, the read-after-lock ordering and the single-connection property are
// pinned in modules/packs/__tests__/customer-metadata-lock.unit.spec.ts.
//
// `retrieveCustomer` / `updateCustomers` below therefore stand in for the SQL,
// which keeps the pre-existing merge assertions meaningful.
const mutateCustomerMetadata = jest.fn(
  async (input: {
    customerId: string;
    mutate: (m: Record<string, unknown>) => Record<string, unknown> | null;
  }) => {
    const customer = await retrieveCustomer(input.customerId);
    const current = (customer.metadata ?? {}) as Record<string, unknown>;
    const next = input.mutate(current);
    if (next === null) return current;
    await updateCustomers(input.customerId, { metadata: next });
    return next;
  },
);

// The Payout Destination reads (payout-destination.ts; their SQL is pinned in
// payout-destination.integration.spec): banned numbers, other holders and
// names used elsewhere (owner, 2026-11-03). Clean by default.
const payoutNumberStanding = jest.fn();
const payoutNameStanding = jest.fn();
const standing = (
  holders: { customerId: string; paid?: boolean }[] = [],
  over: Record<string, unknown> = {},
) => ({
  bankId: 'MBBEMYKL',
  key: '123456789012',
  forms: ['123456789012'],
  banned: false,
  bannedForPlayer: false,
  holders: holders.map((h) => ({ paid: false, verified: false, ...h })),
  ...over,
});

// The account's real name, which a bank is saved under (owner, 2026-11-16).
let realName: string | null = 'Tan Ah Kow';
const getVerificationState = jest.fn(async (_id: string) => ({
  phoneVerified: true,
  realName,
}));

// The admin withdrawal controls; open by default.
const withdrawalControls = jest.fn(async () => DEFAULT_WITHDRAWAL_CONTROLS);

const createNotifications = jest.fn();
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const scope = {
  resolve: jest.fn((key: string) => {
    if (key === 'packs')
      return {
        getVerificationState,
        mutateCustomerMetadata,
        payoutNameStanding,
        payoutNumberStanding,
        withdrawalControls,
      } satisfies FakeFacet<CustomerWallet & PayoutDestinations>;
    if (key === 'notification') return { createNotifications };
    if (key === 'logger') return logger;
    return { retrieveCustomer, updateCustomers };
  }),
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
  ({ auth_context: { actor_id: 'cus_1' }, body, scope }) as never;

// No holder name: a bank is saved in the real name (getVerificationState).
const VALID_BODY = {
  bank_code: 'MBBEMYKL',
  bank_name: 'Maybank',
  account_number: '123456789012',
};

/** A fixed, long-past save time, so `usableFrom` is deterministic and these
 *  fixtures are already outside the cooling-off window. */
const SAVED_AT = '2026-01-01T00:00:00.000Z';

const savedShape = (over: Partial<Record<string, unknown>> = {}) => ({
  id: savedBankAccountId('MBBEMYKL', '123456789012'),
  bankCode: 'MBBEMYKL',
  bankName: 'Maybank',
  accountNumber: '123456789012',
  accountHolderName: 'Tan Ah Kow',
  savedAt: SAVED_AT,
  ...over,
});

/** What a handler RETURNS for a stored account: the row plus the server's
 *  verdict on when it may receive money. The storefront renders that verdict
 *  rather than recomputing the window, so it is part of the response contract. */
const viewOf = (account: Record<string, unknown>) => ({
  ...account,
  // Maybank is payable on every gateway, so the view marks it supported —
  // and it is paid in RM (a Singapore bank would read SGD, via A3Pay).
  supported: true,
  // Banks carry no floor of their own (only Touch 'n Go does).
  minRm: null,
  currency: 'MYR',
  usableFrom:
    typeof account.savedAt === 'string'
      ? new Date(
          new Date(account.savedAt).getTime() + 24 * 60 * 60 * 1000,
        ).toISOString()
      : null,
});

beforeEach(() => {
  retrieveCustomer.mockReset();
  updateCustomers.mockReset();
  mutateCustomerMetadata.mockClear();
  createNotifications.mockReset();
  payoutNumberStanding.mockReset();
  // At the bank asked about, as the real read reports it.
  payoutNumberStanding.mockImplementation(
    async (_id: string, n: { bankCode: string }) =>
      standing([], { bankId: n.bankCode }),
  );
  payoutNameStanding.mockReset();
  payoutNameStanding.mockResolvedValue({ holders: [], blocking: [] });
  logger.warn.mockReset();
  logger.error.mockReset();
  realName = 'Tan Ah Kow';
  getVerificationState.mockClear();
  retrieveCustomer.mockResolvedValue({ metadata: {} });
  updateCustomers.mockResolvedValue({});
  createNotifications.mockResolvedValue(undefined);
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

  // The rows that predate the cooling-off window. Dropping them would empty a
  // customer's picker; keeping them un-stamped is what the "not usable until
  // re-saved" rule is built on.
  it('keeps a row that has no savedAt, without inventing one', () => {
    const { savedAt: _dropped, ...noTimestamp } = savedShape();
    const [parsed] = parseSavedBankAccounts([noTimestamp]);
    expect(parsed).toEqual(noTimestamp);
    expect(parsed).not.toHaveProperty('savedAt');
  });

  it('discards a non-string savedAt rather than trusting it', () => {
    const [parsed] = parseSavedBankAccounts([savedShape({ savedAt: 12345 })]);
    expect(parsed).not.toHaveProperty('savedAt');
  });
});

// POST maps HTTP onto the save (payout-destination-save.ts): the token's
// customer, the body's bank and number, the list as written back as views. The
// rules, the lock, the re-checks and the notice are pinned in
// modules/packs/__tests__/payout-destination-save.unit.spec.
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
        bank_accounts: [savedShape({ savedAt: expect.any(String) })],
      },
    });
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      accounts: [
        savedShape({
          savedAt: expect.any(String),
          usableFrom: expect.any(String),
          supported: true,
          minRm: null,
          currency: 'MYR',
        }),
      ],
    });
    expectNoStore(res);
  });

  // The response says when the new account's cooling-off window closes.
  it('reports when a new account becomes usable', async () => {
    const res = mkRes();
    await POST(mkReq(VALID_BODY), res);
    const written = updateCustomers.mock.calls[0][1].metadata.bank_accounts;
    const savedAt = Date.parse(written[0].savedAt);
    const [view] = (res as { json: jest.Mock }).json.mock.calls[0][0].accounts;
    // 24h is the default window; the value is the server's, not the client's.
    expect(Date.parse(view.usableFrom) - savedAt).toBe(24 * 60 * 60 * 1000);
  });

  it('401s a register-phase token (empty actor_id) before touching the DB', async () => {
    const req = {
      auth_context: { actor_id: '' },
      body: VALID_BODY,
      scope,
    } as never;
    await expect(POST(req, mkRes())).rejects.toThrow(/unauthorized/i);
    expect(retrieveCustomer).not.toHaveBeenCalled();
    expect(getVerificationState).not.toHaveBeenCalled();
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('saves for the token customer only, from bank_code and account_number', async () => {
    await POST(
      mkReq({
        ...VALID_BODY,
        customer_id: 'cus_other',
        bank_name: 'evil\nline',
        account_holder_name: 'Someone Else',
        account_holder_name_confirm: 'Another Name',
      }),
      mkRes(),
    );
    expect(mutateCustomerMetadata.mock.calls[0][0].customerId).toBe('cus_1');
    expect(payoutNumberStanding).toHaveBeenCalledWith('cus_1', {
      bankCode: 'MBBEMYKL',
      accountNumber: '123456789012',
    });
    // The registry names the bank, and the holder is the real name.
    expect(updateCustomers.mock.calls[0][1].metadata.bank_accounts).toEqual([
      expect.objectContaining({
        bankName: 'Maybank',
        accountHolderName: 'Tan Ah Kow',
      }),
    ]);
  });

  it('a missing body is invalid details, not a crash', async () => {
    await expect(POST(mkReq(null), mkRes())).rejects.toMatchObject({
      type: 'invalid_data',
    });
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  // The refusals reach the client with the save's type and copy.
  it('passes a refusal through as not allowed, with its message', async () => {
    payoutNumberStanding.mockResolvedValue(standing([{ customerId: 'cus_2' }]));
    const res = mkRes();
    await expect(POST(mkReq(VALID_BODY), res)).rejects.toMatchObject({
      type: 'not_allowed',
      message: SHARED_SAVE_MESSAGE,
    });
    expect((res as { json: jest.Mock }).json).not.toHaveBeenCalled();
  });

  it('a re-save echoes the list unchanged, with usableFrom null for a row with no savedAt', async () => {
    const { savedAt: _dropped, ...noTimestamp } = savedShape();
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [noTimestamp] },
    });
    const res = mkRes();
    await POST(mkReq(VALID_BODY), res);
    expect(updateCustomers).not.toHaveBeenCalled();
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      accounts: [viewOf(noTimestamp)],
    });
    expectNoStore(res);
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
      accounts: [viewOf(landed)],
    });
  });
});

describe('DELETE /store/credits/withdraw/accounts', () => {
  it('refuses: a saved account cannot be removed or changed', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [savedShape()] },
    });
    await expect(
      DELETE(mkReq({ id: savedShape().id }), mkRes()),
    ).rejects.toThrow(/cannot be removed or changed/);
    expect(mutateCustomerMetadata).not.toHaveBeenCalled();
    expect(updateCustomers).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it('401s a register-phase token, not the refusal', async () => {
    await expect(
      DELETE(
        { auth_context: { actor_id: '' }, body: {}, scope } as never,
        mkRes(),
      ),
    ).rejects.toThrow('Unauthorized');
  });
});

describe('GET /store/credits/withdraw/accounts', () => {
  it('keeps an unverified Singapore bank under Singapore without asking to re-add it', async () => {
    const account = savedShape({
      id: savedBankAccountId('ALLIANCESG', '123456789012'),
      bankCode: 'ALLIANCESG',
      bankName: 'Alliance Bank (SG)',
    });
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [account] },
    });
    const res = mkRes();
    await GET(mkReq(), res);
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      accounts: [
        expect.objectContaining({
          ...account,
          currency: 'SGD',
          supported: false,
          unavailableReason:
            'Withdrawals to Alliance Bank (SG) are unavailable. Choose another bank. Contact support to change it.',
        }),
      ],
    });
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('keeps invalid saved details visible but unavailable, with correction guidance', async () => {
    const invalid = savedShape({
      id: savedBankAccountId('MBBESGSG', '123456789012'),
      bankCode: 'MBBESGSG',
      bankName: 'Maybank (SG)',
    });
    const invalidMy = savedShape({
      id: savedBankAccountId('MBBEMYKL', '12345678901'),
      accountNumber: '12345678901',
    });
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [invalid, invalidMy, savedShape()] },
    });
    const res = mkRes();
    await GET(mkReq(), res);
    const [blocked, blockedMy, valid] = (res as { json: jest.Mock }).json.mock
      .calls[0][0].accounts;
    expect(blocked).toMatchObject({
      ...invalid,
      supported: false,
      currency: 'SGD',
      unavailableReason: expect.stringMatching(
        /Maybank \(SG\) account numbers are 11 digits.*Contact support.*correct bank country/i,
      ),
    });
    expect(blockedMy).toMatchObject({
      supported: false,
      unavailableReason: expect.stringContaining(
        'Maybank account numbers are 12 digits',
      ),
    });
    expect(valid.supported).toBe(true);
    expect(valid.unavailableReason).toBeUndefined();
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('lists the parsed accounts', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [savedShape(), 'junk'] },
    });
    const res = mkRes();
    await GET(mkReq(), res);
    expectNoStore(res);
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      accounts: [viewOf(savedShape())],
    });
  });

  // The picker must be able to SHOW a not-yet-usable account as disabled rather
  // than hide it (hidden reads as a bug). Both refused states are distinguishable
  // in the response: a future instant vs. null.
  it('reports usableFrom null for a row with no savedAt', async () => {
    const { savedAt: _dropped, ...noTimestamp } = savedShape();
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [noTimestamp] },
    });
    const res = mkRes();
    await GET(mkReq(), res);
    expect(
      (res as { json: jest.Mock }).json.mock.calls[0][0].accounts[0].usableFrom,
    ).toBeNull();
  });

  // The admin's Touch 'n Go switch and floor reach the picker: a paused TNG
  // account shows as unavailable with the reason, and its minimum is the
  // admin's. A bank account is untouched.
  it("marks a Touch 'n Go account paused and states the admin minimum", async () => {
    const tng = savedShape({
      id: savedBankAccountId('TNGMY', '012345678901'),
      bankCode: 'TNGMY',
      bankName: "Touch 'n Go eWallet",
      accountNumber: '012345678901',
    });
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [tng, savedShape()] },
    });
    withdrawalControls.mockResolvedValueOnce({
      ...DEFAULT_WITHDRAWAL_CONTROLS,
      tng: { ...DEFAULT_WITHDRAWAL_CONTROLS.tng, open: false, min_rm: 200 },
    });
    const res = mkRes();
    await GET(mkReq(), res);
    const [tngView, bankView] = (res as { json: jest.Mock }).json.mock
      .calls[0][0].accounts;
    expect(tngView).toMatchObject({
      supported: false,
      minRm: 200,
      unavailableReason: "Touch 'n Go withdrawals are paused for now",
    });
    expect(bankView.unavailableReason).toBeUndefined();
    expect(bankView.minRm).toBeNull();
  });
});

// 13 clusters of 2-3 customer accounts on one bank account farmed welcome
// packs and tasks by 2026-10-14. A NEW link to a number someone else holds is
// refused; the existing clusters were deliberately left as they are.

describe('GET accounts — a shared bank account is on hold', () => {
  const held = standing([{ customerId: 'cus_2', paid: true }]);

  it('marks it unavailable, says what to do, and hides nothing', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [savedShape()] },
    });
    payoutNumberStanding.mockResolvedValue(held);
    const res = mkRes();
    await GET(mkReq(), res);
    const [account] = (res as { json: jest.Mock }).json.mock.calls[0][0]
      .accounts;
    expect(account).toMatchObject({
      id: savedShape().id,
      supported: false,
      unavailableReason: SHARED_PAYOUT_ACCOUNT_MESSAGE,
    });
  });

  it('holds the whole list: a second saved number is no way round it', async () => {
    const other = savedShape({ id: 'other', accountNumber: '999999999999' });
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [savedShape(), other] },
    });
    payoutNumberStanding.mockImplementation(
      async (_id: string, n: { accountNumber: string }) =>
        n.accountNumber === '123456789012' ? held : standing(),
    );
    const res = mkRes();
    await GET(mkReq(), res);
    const { accounts } = (res as { json: jest.Mock }).json.mock.calls[0][0];
    expect(accounts.map((a: { supported: boolean }) => a.supported)).toEqual([
      false,
      false,
    ]);
  });

  it('lifts it once support verified the customer, without looking', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [savedShape()],
        bank_share_verified: { [savedShape().id]: '2026-11-03T00:00:00.000Z' },
      },
    });
    payoutNumberStanding.mockResolvedValue(held);
    const res = mkRes();
    await GET(mkReq(), res);
    const [account] = (res as { json: jest.Mock }).json.mock.calls[0][0]
      .accounts;
    expect(account.supported).toBe(true);
    expect(payoutNumberStanding).not.toHaveBeenCalled();
  });

  it('verifying one number does not lift a hold from another on the list', async () => {
    const other = savedShape({ id: 'other', accountNumber: '999999999999' });
    retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [savedShape(), other],
        bank_share_verified: { [savedShape().id]: '2026-11-03T00:00:00.000Z' },
      },
    });
    payoutNumberStanding.mockResolvedValue(held);
    const res = mkRes();
    await GET(mkReq(), res);
    const { accounts } = (res as { json: jest.Mock }).json.mock.calls[0][0];
    expect(accounts.map((a: { supported: boolean }) => a.supported)).toEqual([
      false,
      false,
    ]);
  });

  it('holds a wallet another account only saved', async () => {
    const TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [
          savedShape({
            id: savedBankAccountId('USDTTRC20', TRON),
            bankCode: 'USDTTRC20',
            bankName: 'USDT · TRC20 (Tron)',
            accountNumber: TRON,
            accountHolderName: 'USDT · TRC20 (Tron)',
          }),
        ],
      },
    });
    payoutNumberStanding.mockResolvedValue(
      standing([{ customerId: 'cus_2', paid: false }], {
        bankId: 'USDTTRC20',
        key: TRON,
        forms: [TRON],
      }),
    );
    const res = mkRes();
    await GET(mkReq(), res);
    const [account] = (res as { json: jest.Mock }).json.mock.calls[0][0].accounts;
    expect(account.supported).toBe(false);
  });

  it('asks about each saved number at its bank; nobody else on it, no hold', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [savedShape()] },
    });
    const res = mkRes();
    await GET(mkReq(), res);
    expect(payoutNumberStanding).toHaveBeenCalledWith('cus_1', {
      bankCode: 'MBBEMYKL',
      accountNumber: '123456789012',
    });
    const [account] = (res as { json: jest.Mock }).json.mock.calls[0][0]
      .accounts;
    expect(account.supported).toBe(true);
  });
});
