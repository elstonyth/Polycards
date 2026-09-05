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

const createNotifications = jest.fn();
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const scope = {
  resolve: jest.fn((key: string) => {
    if (key === 'packs') return { mutateCustomerMetadata };
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
  ({
    auth_context: { actor_id: 'cus_1' },
    body,
    scope,
  }) as never;

const VALID_BODY = {
  bank_code: 'MBBEMYKL',
  bank_name: 'Maybank',
  account_number: '1234567890',
  account_holder_name: 'Tan Ah Kow',
};

/** A saved list already at the cap. */
const fullList = () =>
  Array.from({ length: MAX_SAVED_BANK_ACCOUNTS }, (_, i) =>
    savedShape({ id: `id_${i}`, accountNumber: `900000000${i}` }),
  );

/** A fixed, long-past save time, so `usableFrom` is deterministic and these
 *  fixtures are already outside the cooling-off window. */
const SAVED_AT = '2026-01-01T00:00:00.000Z';

const savedShape = (over: Partial<Record<string, unknown>> = {}) => ({
  id: savedBankAccountId('MBBEMYKL', '1234567890'),
  bankCode: 'MBBEMYKL',
  bankName: 'Maybank',
  accountNumber: '1234567890',
  accountHolderName: 'Tan Ah Kow',
  savedAt: SAVED_AT,
  ...over,
});

/** What a handler RETURNS for a stored account: the row plus the server's
 *  verdict on when it may receive money. The storefront renders that verdict
 *  rather than recomputing the window, so it is part of the response contract. */
const viewOf = (account: Record<string, unknown>) => ({
  ...account,
  // Maybank is payable on every gateway, so the view marks it supported.
  supported: true,
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
  logger.warn.mockReset();
  logger.error.mockReset();
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
        }),
      ],
    });
    expectNoStore(res);
  });

  // A new destination is stamped NOW, so it starts a fresh cooling-off window,
  // and the response says when that window closes. Without the stamp the
  // account would resolve as "never usable" on the payout path.
  it('stamps savedAt on a new account and reports when it becomes usable', async () => {
    const before = Date.now();
    const res = mkRes();
    await POST(mkReq(VALID_BODY), res);
    const written = updateCustomers.mock.calls[0][1].metadata.bank_accounts;
    const savedAt = Date.parse(written[0].savedAt);
    expect(savedAt).toBeGreaterThanOrEqual(before);
    expect(savedAt).toBeLessThanOrEqual(Date.now());

    const [view] = (res as { json: jest.Mock }).json.mock.calls[0][0].accounts;
    // 24h is the default window; the value is the server's, not the client's.
    expect(Date.parse(view.usableFrom) - savedAt).toBe(24 * 60 * 60 * 1000);
  });

  it('refuses what the payout submit would refuse (shared validation gate)', async () => {
    await expect(
      POST(mkReq({ ...VALID_BODY, account_number: 'not-digits' }), mkRes()),
    ).rejects.toThrow(/valid account number/i);
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('ignores any submitted bank name — the registry supplies it', async () => {
    retrieveCustomer.mockResolvedValue({ metadata: { bank_accounts: [] } });
    await POST(mkReq({ ...VALID_BODY, bank_name: 'evil\nline' }), mkRes());
    expect(updateCustomers).toHaveBeenCalledWith('cus_1', {
      metadata: expect.objectContaining({
        bank_accounts: [expect.objectContaining({ bankName: 'Maybank' })],
      }),
    });
  });

  it("normalises a gateway's own bank code to the canonical bank and its neutral name", async () => {
    retrieveCustomer.mockResolvedValue({ metadata: { bank_accounts: [] } });
    // GlobePay's code for Maybank, as an older storefront (or a legacy picker)
    // would send it — the saved account must not depend on which gateway was
    // active when it was saved.
    await POST(
      mkReq({
        ...VALID_BODY,
        bank_code: 'MYMB2U',
        bank_name: 'Maybank Berhad',
      }),
      mkRes(),
    );
    expect(updateCustomers).toHaveBeenCalledWith('cus_1', {
      metadata: expect.objectContaining({
        bank_accounts: [
          expect.objectContaining({
            id: savedBankAccountId('MBBEMYKL', '1234567890'),
            bankCode: 'MBBEMYKL',
            bankName: 'Maybank',
          }),
        ],
      }),
    });
  });

  it('refuses a bank no gateway can pay to', async () => {
    await expect(
      POST(mkReq({ ...VALID_BODY, bank_code: 'MBB' }), mkRes()),
    ).rejects.toThrow(/pick a bank/i);
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
    // The cooling-off window is NOT restarted: the id is derived from
    // (bankCode, accountNumber), so this relabels the destination rather than
    // changing it, and a customer fixing a typo must not lose a day.
    expect(written[0].savedAt).toBe(SAVED_AT);
  });

  // The other direction of the same rule: re-saving a PRE-cooling-off row must
  // not silently arm it. Only an explicit delete-then-add (a genuinely new
  // entry) starts a window.
  it('re-adding a row that has no savedAt does NOT stamp one', async () => {
    const { savedAt: _dropped, ...noTimestamp } = savedShape();
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [noTimestamp] },
    });
    const res = mkRes();
    await POST(mkReq(VALID_BODY), res);
    const written = updateCustomers.mock.calls[0][1].metadata.bank_accounts;
    expect(written[0].savedAt).toBeUndefined();
    expect(
      (res as { json: jest.Mock }).json.mock.calls[0][0].accounts[0].usableFrom,
    ).toBeNull();
  });

  it(`refuses account #${MAX_SAVED_BANK_ACCOUNTS + 1}`, async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: fullList() },
    });
    await expect(POST(mkReq(VALID_BODY), mkRes())).rejects.toThrow(
      /remove one first/i,
    );
    expect(updateCustomers).not.toHaveBeenCalled();
    // Exactly one read on the REFUSAL path, and it is the mutator's. A second
    // read here would mean a caller-side copy of the blob exists to go stale.
    // (The success path does read the customer a second time — the new-account
    // notice needs their email address — but that read happens after the write
    // has committed and decides nothing.)
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
      accounts: [viewOf(landed)],
    });
  });
});

// Adding a payout destination is a security event now, not a preference: it is
// the first half of "steal a token, wait out the cooling-off, cash out". The
// email is what gives the real owner the day in between.
describe('POST accounts — the new-destination notice', () => {
  it('emails the account holder, with the last 4 digits only', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {},
      email: 'player@example.test',
    });
    await POST(mkReq(VALID_BODY), mkRes());

    const emails = createNotifications.mock.calls
      .map(([args]) => args)
      .filter((args) => args.channel === 'email');
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({
      to: 'player@example.test',
      template: 'bank-account-added',
      data: expect.objectContaining({
        bank_name: 'Maybank',
        account_last4: '7890',
      }),
    });
    // The full number must never leave the database on this path.
    expect(JSON.stringify(emails[0])).not.toContain('1234567890');
  });

  it('also drops an in-app feed row for the same event', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {},
      email: 'player@example.test',
    });
    await POST(mkReq(VALID_BODY), mkRes());
    const feed = createNotifications.mock.calls
      .map(([args]) => args)
      .filter((args) => args.template === 'bank_account_added');
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      receiver_id: 'cus_1',
      data: expect.objectContaining({ account_last4: '7890' }),
    });
  });

  // Re-saving an account they already had is not news. Alerting on it would
  // train the customer to ignore the alert that matters.
  it('stays silent when the destination was already saved', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [savedShape()] },
      email: 'player@example.test',
    });
    await POST(
      mkReq({ ...VALID_BODY, account_holder_name: 'Tan A. Kow' }),
      mkRes(),
    );
    expect(createNotifications.mock.calls.length).toBe(0);
  });

  // The attack this notice exists for, second attempt: the owner noticed the
  // first one and deleted it, so the destination is gone from the list and
  // re-adding it is a genuinely new entry with a new cooling-off window. It
  // MUST alarm again. The notification idempotency key folds in savedAt for
  // exactly this reason — without it, this second alert is deduped away
  // against the first and the owner never hears about it.
  it('alarms again when a deleted destination is re-added', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {},
      email: 'player@example.test',
    });
    await POST(mkReq(VALID_BODY), mkRes());
    const firstKey = createNotifications.mock.calls
      .map(([args]) => args)
      .find((args) => args.channel === 'email').idempotency_key;

    // …deleted, then added again (an empty list is what DELETE leaves behind).
    createNotifications.mockClear();
    await new Promise((r) => setTimeout(r, 2));
    await POST(mkReq(VALID_BODY), mkRes());
    const second = createNotifications.mock.calls
      .map(([args]) => args)
      .find((args) => args.channel === 'email');
    expect(second).toBeDefined();
    expect(second.idempotency_key).not.toBe(firstKey);
  });

  // The account is already saved by the time this runs; a mail problem must
  // not undo it or surface as a failed save.
  it('a notification failure does not fail the add', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {},
      email: 'player@example.test',
    });
    createNotifications.mockRejectedValue(new Error('resend is down'));
    const res = mkRes();
    await expect(POST(mkReq(VALID_BODY), res)).resolves.toBeUndefined();
    expect(updateCustomers).toHaveBeenCalledTimes(1);
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledTimes(1);
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
});
