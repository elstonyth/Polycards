import {
  GET,
  POST,
  DELETE,
  parseSavedBankAccounts,
  savedBankAccountId,
  MAX_SAVED_BANK_ACCOUNTS,
  SHARED_PAYOUT_ACCOUNT_MESSAGE,
  SHARED_SAVE_MESSAGE,
} from '../route';
import type {
  FakeFacet,
  CustomerWallet,
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

// Other customers holding the same account number (none by default).
const otherPayoutAccountHolders = jest.fn();
// Banned numbers and names used elsewhere (owner, 2026-11-03); none by default.
const payoutAccountBanned = jest.fn();
const holderNameHeldByAnother = jest.fn();

// The admin withdrawal controls; open by default.
const withdrawalControls = jest.fn(async () => DEFAULT_WITHDRAWAL_CONTROLS);

const createNotifications = jest.fn();
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const scope = {
  resolve: jest.fn((key: string) => {
    if (key === 'packs')
      return {
        mutateCustomerMetadata,
        otherPayoutAccountHolders,
        payoutAccountBanned,
        holderNameHeldByAnother,
        withdrawalControls,
      } satisfies FakeFacet<CustomerWallet>;
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

// A bank save types the holder name twice; a body without the second copy gets
// it filled in, so only the tests about it need to say so.
const mkReq = (body: Record<string, unknown> | null = null) =>
  ({
    auth_context: { actor_id: 'cus_1' },
    body:
      body && 'account_holder_name' in body && !('account_holder_name_confirm' in body)
        ? { ...body, account_holder_name_confirm: body.account_holder_name }
        : body,
    scope,
  }) as never;

const VALID_BODY = {
  bank_code: 'MBBEMYKL',
  bank_name: 'Maybank',
  account_number: '123456789012',
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
  otherPayoutAccountHolders.mockReset();
  otherPayoutAccountHolders.mockResolvedValue([]);
  payoutAccountBanned.mockReset();
  payoutAccountBanned.mockResolvedValue(false);
  holderNameHeldByAnother.mockReset();
  holderNameHeldByAnother.mockResolvedValue(false);
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
          minRm: null,
          currency: 'MYR',
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

  it('refuses a Malaysian-length Maybank number under Singapore before saving', async () => {
    await expect(
      POST(mkReq({ ...VALID_BODY, bank_code: 'MBBESGSG' }), mkRes()),
    ).rejects.toThrow(/Maybank \(SG\) account numbers are 11 digits/);
    expect(mutateCustomerMetadata).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it.each<[string, string, RegExp]>([
    ['ALLIANCESG', '123456789012', /unavailable/i],
    ['PAYNOWSG', '0123456789', /mobile number linked to PayNow/i],
  ])(
    'refuses %s before saving unverified or malformed details',
    async (bankCode, accountNumber, message) => {
      await expect(
        POST(
          mkReq({
            ...VALID_BODY,
            bank_code: bankCode,
            account_number: accountNumber,
          }),
          mkRes(),
        ),
      ).rejects.toThrow(message);
      expect(mutateCustomerMetadata).not.toHaveBeenCalled();
      expect(createNotifications).not.toHaveBeenCalled();
    },
  );

  it('saves an 11-digit Maybank Singapore number without dropping its leading zero', async () => {
    await POST(
      mkReq({
        ...VALID_BODY,
        bank_code: 'MBBESGSG',
        account_number: '01234567890',
      }),
      mkRes(),
    );
    expect(updateCustomers).toHaveBeenCalledWith('cus_1', {
      metadata: {
        bank_accounts: [
          expect.objectContaining({
            bankCode: 'MBBESGSG',
            accountNumber: '01234567890',
          }),
        ],
      },
    });
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
    // the gateway's code for Maybank, as an older storefront (or a legacy picker)
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
            id: savedBankAccountId('MBBEMYKL', '123456789012'),
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

  it('refuses the sandbox dummy bank unless the sandbox is configured', async () => {
    const prev = process.env.TGPAY_API_BASE;
    process.env.TGPAY_API_BASE = 'https://api.tgpay365.com/api/v2';
    try {
      await expect(
        POST(mkReq({ ...VALID_BODY, bank_code: 'DUMMYBANKVERIFIED' }), mkRes()),
      ).rejects.toThrow(/pick a bank/i);
      expect(updateCustomers).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.TGPAY_API_BASE;
      else process.env.TGPAY_API_BASE = prev;
    }
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

  it('saves a USDT wallet with no holder; an ERC20 address in either case is ONE account', async () => {
    const checksummed = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
    await POST(
      mkReq({ bank_code: 'USDTERC20', account_number: checksummed }),
      mkRes(),
    );
    const [saved] = updateCustomers.mock.calls[0][1].metadata.bank_accounts;
    expect(saved).toMatchObject({
      bankCode: 'USDTERC20',
      accountNumber: checksummed.toLowerCase(),
      accountHolderName: 'USDT · ERC20 (Ethereum)',
    });
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [saved] },
    });
    await POST(
      mkReq({
        bank_code: 'USDTERC20',
        account_number: checksummed.toLowerCase(),
      }),
      mkRes(),
    );
    // The other letter case is the same id, so nothing is added or written.
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });

  it('refuses a mistyped wallet address with the reason', async () => {
    await expect(
      POST(
        mkReq({
          bank_code: 'USDTERC20',
          account_number: '0xdAC17F958D2ee523a2206206994597C13D831ec8',
        }),
        mkRes(),
      ),
    ).rejects.toThrow(/not a valid ERC20/);
  });

  it('re-adding the same bank+number changes nothing', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [savedShape()] },
    });
    const res = mkRes();
    await POST(
      mkReq({ ...VALID_BODY, account_holder_name: 'Tan A. Kow' }),
      res,
    );
    expect(updateCustomers).not.toHaveBeenCalled();
    const [echoed] = (res as { json: jest.Mock }).json.mock.calls[0][0].accounts;
    expect(echoed.accountHolderName).toBe('Tan Ah Kow');
    expect(echoed.savedAt).toBe(SAVED_AT);
  });

  // Re-saving a PRE-cooling-off row must not silently arm it. Only support
  // removing it and a new entry starts a window.
  it('re-adding a row that has no savedAt does NOT stamp one', async () => {
    const { savedAt: _dropped, ...noTimestamp } = savedShape();
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [noTimestamp] },
    });
    const res = mkRes();
    await POST(mkReq(VALID_BODY), res);
    expect(updateCustomers).not.toHaveBeenCalled();
    expect(
      (res as { json: jest.Mock }).json.mock.calls[0][0].accounts[0].usableFrom,
    ).toBeNull();
  });

  it(`refuses account #${MAX_SAVED_BANK_ACCOUNTS + 1}`, async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: fullList() },
    });
    await expect(POST(mkReq(VALID_BODY), mkRes())).rejects.toThrow(
      /already has a bank account/i,
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
  // read would happily save a second account here.
  it('enforces the cap against the blob the MUTATOR supplies, not one read outside it', async () => {
    retrieveCustomer.mockResolvedValue({ metadata: { bank_accounts: [] } });
    mutateCustomerMetadata.mockImplementationOnce(async (input) => {
      const next = input.mutate({ bank_accounts: fullList() });
      return next ?? {};
    });
    await expect(POST(mkReq(VALID_BODY), mkRes())).rejects.toThrow(
      /already has a bank account/i,
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
        account_last4: '9012',
      }),
    });
    // The full number must never leave the database on this path.
    expect(JSON.stringify(emails[0])).not.toContain('123456789012');
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
      data: expect.objectContaining({ account_last4: '9012' }),
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
describe('POST accounts — one bank account, one Polycards account', () => {
  it('refuses a number another customer holds at the same bank, and writes nothing', async () => {
    otherPayoutAccountHolders.mockResolvedValue([
      { customer_id: 'cus_2', bank_code: 'MBBEMYKL' },
    ]);
    await expect(POST(mkReq(VALID_BODY), mkRes())).rejects.toThrow(
      SHARED_SAVE_MESSAGE,
    );
    expect(otherPayoutAccountHolders).toHaveBeenCalledWith(
      'cus_1',
      '123456789012',
      false,
    );
    expect(updateCustomers).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
    // Logged so repeated probing shows up, with the last 4 digits only.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = logger.warn.mock.calls[0][0] as string;
    expect(line).toContain('cus_1');
    expect(line).toContain('9012');
    expect(line).not.toContain('123456789012');
  });

  it("reads another customer's retired-gateway code as the same bank", async () => {
    otherPayoutAccountHolders.mockResolvedValue([
      { customer_id: 'cus_2', bank_code: 'MYMB2U' },
    ]);
    await expect(POST(mkReq(VALID_BODY), mkRes())).rejects.toThrow(
      SHARED_SAVE_MESSAGE,
    );
  });

  it('a number another customer only saved blocks under any holder name', async () => {
    // The ring in ADR 0015 typed ten holder names onto one number.
    otherPayoutAccountHolders.mockResolvedValue([
      { customer_id: 'cus_2', bank_code: 'MBBEMYKL', holder_name: 'Someone Else' },
    ]);
    await expect(POST(mkReq(VALID_BODY), mkRes())).rejects.toThrow(
      SHARED_SAVE_MESSAGE,
    );
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('a second bank account gets the one-account refusal, whoever holds it', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [savedShape({ accountNumber: '999999999999', id: 'x' })],
      },
    });
    otherPayoutAccountHolders.mockResolvedValue([
      { customer_id: 'cus_2', bank_code: 'MBBEMYKL', holder_name: 'X' },
    ]);
    await expect(POST(mkReq(VALID_BODY), mkRes())).rejects.toThrow(
      /already has a bank account/i,
    );
  });

  it('a USDT wallet is matched by its whole address, and only a paid-out one blocks', () => {
    const TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const body = { bank_code: 'USDTTRC20', account_number: TRON };
    return (async () => {
      // Someone else only SAVED it: wallets have no holder name to tell
      // owners apart, and the address is public, so this must not block.
      otherPayoutAccountHolders.mockResolvedValue([
        { customer_id: 'cus_2', bank_code: 'USDTTRC20', holder_name: 'USDT · TRC20 (Tron)' },
      ]);
      await POST(mkReq(body), mkRes());
      expect(updateCustomers).toHaveBeenCalledTimes(1);
      expect(otherPayoutAccountHolders).toHaveBeenCalledWith('cus_1', TRON, true);

      // Already paid out to another customer: refused.
      otherPayoutAccountHolders.mockResolvedValue([
        { customer_id: 'cus_2', bank_code: 'USDTTRC20', holder_name: null },
      ]);
      await expect(POST(mkReq(body), mkRes())).rejects.toThrow(
        SHARED_SAVE_MESSAGE,
      );
    })();
  });

  it('allows the same digits at a different bank', async () => {
    otherPayoutAccountHolders.mockResolvedValue([
      { customer_id: 'cus_2', bank_code: 'PBBEMYKL' },
    ]);
    await POST(mkReq(VALID_BODY), mkRes());
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });

  it('verification never lets a new shared number in', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_share_verified: { [savedShape().id]: '2026-11-03T00:00:00.000Z' } },
    });
    otherPayoutAccountHolders.mockResolvedValue([
      { customer_id: 'cus_2', bank_code: 'MBBEMYKL', holder_name: null },
    ]);
    await expect(POST(mkReq(VALID_BODY), mkRes())).rejects.toThrow(
      SHARED_SAVE_MESSAGE,
    );
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('re-saving an account already on the list is not a new link', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [savedShape()] },
    });
    otherPayoutAccountHolders.mockResolvedValue([
      { customer_id: 'cus_2', bank_code: 'MBBEMYKL' },
    ]);
    // Decided on the locked read: the account is already theirs, so nothing is
    // refused, and nothing changes either.
    await POST(mkReq(VALID_BODY), mkRes());
    expect(updateCustomers).not.toHaveBeenCalled();
  });
});

describe('POST accounts — a saved account changes through support', () => {
  it('a re-save cannot relabel the holder, even while held', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [savedShape()] },
    });
    const res = mkRes();
    await POST(
      mkReq({ ...VALID_BODY, account_holder_name: 'Someone Else' }),
      res,
    );
    expect(updateCustomers).not.toHaveBeenCalled();
    const [echoed] = (res as { json: jest.Mock }).json.mock.calls[0][0].accounts;
    expect(echoed.accountHolderName).toBe('Tan Ah Kow');
  });
});

describe('GET accounts — a shared bank account is on hold', () => {
  const held = [
    { customer_id: 'cus_2', bank_code: 'MBBEMYKL', holder_name: null },
  ];

  it('marks it unavailable, says what to do, and hides nothing', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [savedShape()] },
    });
    otherPayoutAccountHolders.mockResolvedValue(held);
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
    otherPayoutAccountHolders.mockImplementation(async (_id, number) =>
      number === '123456789012' ? held : [],
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
    otherPayoutAccountHolders.mockResolvedValue(held);
    const res = mkRes();
    await GET(mkReq(), res);
    const [account] = (res as { json: jest.Mock }).json.mock.calls[0][0]
      .accounts;
    expect(account.supported).toBe(true);
    expect(otherPayoutAccountHolders).not.toHaveBeenCalled();
  });

  it('verifying one number does not lift a hold from another on the list', async () => {
    const other = savedShape({ id: 'other', accountNumber: '999999999999' });
    retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [savedShape(), other],
        bank_share_verified: { [savedShape().id]: '2026-11-03T00:00:00.000Z' },
      },
    });
    otherPayoutAccountHolders.mockResolvedValue(held);
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
    otherPayoutAccountHolders.mockResolvedValue([
      { customer_id: 'cus_2', bank_code: 'USDTTRC20', holder_name: 'USDT · TRC20 (Tron)' },
    ]);
    const res = mkRes();
    await GET(mkReq(), res);
    const [account] = (res as { json: jest.Mock }).json.mock.calls[0][0].accounts;
    expect(account.supported).toBe(false);
  });

  it('does not hold the same digits at another bank', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [savedShape()] },
    });
    otherPayoutAccountHolders.mockResolvedValue([
      { customer_id: 'cus_2', bank_code: 'PBBEMYKL', holder_name: null },
    ]);
    const res = mkRes();
    await GET(mkReq(), res);
    const [account] = (res as { json: jest.Mock }).json.mock.calls[0][0]
      .accounts;
    expect(account.supported).toBe(true);
  });
});

describe('POST accounts — owner rules of 2026-11-03', () => {
  const TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

  it('refuses a holder name not typed the same twice, ignoring case and spaces', async () => {
    await expect(
      POST(
        mkReq({ ...VALID_BODY, account_holder_name_confirm: 'Tan Ah Kaw' }),
        mkRes(),
      ),
    ).rejects.toThrow(/do not match/);
    await expect(
      POST(mkReq({ ...VALID_BODY, account_holder_name_confirm: undefined }), mkRes()),
    ).rejects.toThrow(/do not match/);
    expect(updateCustomers).not.toHaveBeenCalled();
    await POST(
      mkReq({ ...VALID_BODY, account_holder_name_confirm: ' tan  AH kow ' }),
      mkRes(),
    );
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });

  it('refuses a banned number and logs only its last 4', async () => {
    payoutAccountBanned.mockResolvedValue(true);
    await expect(POST(mkReq(VALID_BODY), mkRes())).rejects.toThrow(
      /cannot be used on Polycards/,
    );
    // Asked for this customer: a number support unbanned for them passes.
    expect(payoutAccountBanned).toHaveBeenCalledWith('123456789012', false, 'cus_1');
    expect(updateCustomers).not.toHaveBeenCalled();
    const line = logger.warn.mock.calls[0][0] as string;
    expect(line).toContain('9012');
    expect(line).not.toContain('123456789012');
  });

  it('refuses a holder name another account already used', async () => {
    holderNameHeldByAnother.mockResolvedValue(true);
    await expect(POST(mkReq(VALID_BODY), mkRes())).rejects.toThrow(
      /name is already linked/,
    );
    expect(holderNameHeldByAnother).toHaveBeenCalledWith('cus_1', 'Tan Ah Kow');
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('a wallet needs no second name and skips the name check', async () => {
    await POST(
      mkReq({ bank_code: 'USDTTRC20', account_number: TRON }),
      mkRes(),
    );
    expect(holderNameHeldByAnother).not.toHaveBeenCalled();
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });

  it('one account per currency: a wallet fits beside an RM bank, a second RM bank does not', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [savedShape({ accountNumber: '999999999999', id: 'x' })],
      },
    });
    await POST(
      mkReq({ bank_code: 'USDTTRC20', account_number: TRON }),
      mkRes(),
    );
    expect(updateCustomers).toHaveBeenCalledTimes(1);
    await expect(POST(mkReq(VALID_BODY), mkRes())).rejects.toThrow(
      /already has a bank account for this currency/,
    );
  });

  it("Touch 'n Go has its own slot: it fits beside an RM bank, a second one does not", async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [savedShape({ accountNumber: '999999999999', id: 'x' })],
      },
    });
    const TNG = { ...VALID_BODY, bank_code: 'TNGMY', account_number: '120000000001' };
    await POST(mkReq(TNG), mkRes());
    const saved = updateCustomers.mock.calls[0][1].metadata.bank_accounts;
    expect(saved.map((a: { bankCode: string }) => a.bankCode)).toEqual(['MBBEMYKL', 'TNGMY']);
    retrieveCustomer.mockResolvedValue({ metadata: { bank_accounts: saved } });
    await expect(
      POST(mkReq({ ...TNG, account_number: '120000000002' }), mkRes()),
    ).rejects.toThrow(/already has a Touch 'n Go account/);
  });

  it('one name on every bank: a Touch \'n Go under another name is refused', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [savedShape({ accountNumber: '999999999999', id: 'x' })],
      },
    });
    const TNG = { ...VALID_BODY, bank_code: 'TNGMY', account_number: '120000000001' };
    await expect(
      POST(mkReq({ ...TNG, account_holder_name: 'Lim Mei Ling' }), mkRes()),
    ).rejects.toThrow(/same account holder name as your saved bank account/);
    expect(updateCustomers).not.toHaveBeenCalled();
    // Case and separators do not make it another name.
    await POST(mkReq({ ...TNG, account_holder_name: 'TAN AH-KOW' }), mkRes());
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });

  it('one name on every bank: an SGD bank under another name is refused too', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [savedShape({ accountNumber: '999999999999', id: 'x' })],
      },
    });
    await expect(
      POST(
        mkReq({
          bank_code: 'DBSSSGSG',
          account_number: '0123456789',
          account_holder_name: 'Lim Mei Ling',
        }),
        mkRes(),
      ),
    ).rejects.toThrow(/same account holder name as your saved bank account/);
  });

  it('one name on every bank: a saved wallet sets no name', async () => {
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
    await POST(mkReq(VALID_BODY), mkRes());
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });

  it('one name on every bank: an older entry with no name blocks nothing', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [
          savedShape({ accountNumber: '999999999999', id: 'x', accountHolderName: '' }),
        ],
      },
    });
    await POST(
      mkReq({ ...VALID_BODY, bank_code: 'TNGMY', account_number: '120000000001' }),
      mkRes(),
    );
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });

  it('one name on every bank: any saved name will do once support saved two', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [
          savedShape({ accountNumber: '999999999999', id: 'x' }),
          savedShape({
            id: 'y',
            bankCode: 'TNGMY',
            bankName: "Touch 'n Go eWallet",
            accountNumber: '120000000001',
            accountHolderName: 'Tan Ah Kow Bin Abu',
          }),
        ],
      },
    });
    await POST(
      mkReq({
        bank_code: 'DBSSSGSG',
        account_number: '0123456789',
        account_holder_name: 'Tan Ah Kow Bin Abu',
      }),
      mkRes(),
    );
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });

  it('one name on every bank: a USDT wallet beside a bank needs no name', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [savedShape({ accountNumber: '999999999999', id: 'x' })],
      },
    });
    await POST(mkReq({ bank_code: 'USDTTRC20', account_number: TRON }), mkRes());
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });
});

describe('POST accounts — holder names compare as one person reads them', () => {
  it('stores the name with invisible characters and odd spaces folded away', async () => {
    await POST(
      mkReq({
        ...VALID_BODY,
        account_holder_name: 'Tan​ Ah  Kow',
        account_holder_name_confirm: 'tan ah kow',
      }),
      mkRes(),
    );
    expect(holderNameHeldByAnother).toHaveBeenCalledWith('cus_1', 'Tan Ah Kow');
    expect(
      updateCustomers.mock.calls[0][1].metadata.bank_accounts[0].accountHolderName,
    ).toBe('Tan Ah Kow');
  });

  it.each([['Таn Ah Kow'], ['--'], ['Tan Ah Kow 😀']])(
    'refuses %j: Latin letters, digits and name punctuation only',
    async (name) => {
      await expect(
        POST(mkReq({ ...VALID_BODY, account_holder_name: name }), mkRes()),
      ).rejects.toThrow(/English letters/);
      expect(updateCustomers).not.toHaveBeenCalled();
    },
  );

  it('takes a save back off when another account saved the name at the same moment', async () => {
    holderNameHeldByAnother
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await expect(POST(mkReq(VALID_BODY), mkRes())).rejects.toThrow(
      /name is already linked/,
    );
    expect(mutateCustomerMetadata).toHaveBeenCalledTimes(2);
    expect(createNotifications).not.toHaveBeenCalled();
  });
});
