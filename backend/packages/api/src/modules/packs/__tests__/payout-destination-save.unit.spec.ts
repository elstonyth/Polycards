import { savePayoutDestination } from '../payout-destination-save';
import {
  MAX_SAVED_BANK_ACCOUNTS,
  SHARED_SAVE_MESSAGE,
  savedBankAccountId,
} from '../saved-accounts';
import type { FakeFacet, PayoutDestinations } from '../facets';

// Saving a Payout Destination (payout-destination-save.ts): the order, the
// locked write, the re-checks after it and their undo, and the owner's notice,
// for the customer's own save and support's add. The routes around it only map
// HTTP (their specs: store credits/withdraw/accounts, admin bank-accounts).
//
// Three properties matter enough to pin: the merge must never clobber sibling
// metadata keys (avatar_url et al share the blob), the validation must be the
// SAME gate as the payout submit so the picker can never offer an account the
// withdraw path refuses, and the write must go through the locked metadata
// mutator rather than reading the blob and writing it back.

const retrieveCustomer = jest.fn();
const updateCustomers = jest.fn();

// Stand-in for PacksModuleService.mutateCustomerMetadata. The real one does the
// read and the write as raw SQL on its own locked transaction; this fake
// reproduces only the contract the save depends on: mutate is handed the
// current blob exactly once, `null` means no write, and the return value is
// what landed. The lock itself, the read-after-lock ordering and the
// single-connection property are pinned in customer-metadata-lock.unit.spec.
//
// `retrieveCustomer` / `updateCustomers` below therefore stand in for the SQL,
// which keeps the merge assertions meaningful.
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
  holders: { customerId: string; paid?: boolean; verified?: boolean }[] = [],
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
// Support's audited writes (pinned in saved-account-support.unit.spec).
const addSavedBankAccount = jest.fn();
const removeSavedBankAccount = jest.fn();
const listCustomers = jest.fn();

const createNotifications = jest.fn();
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const scope = {
  resolve: jest.fn((key: string) => {
    if (key === 'packs')
      return {
        addSavedBankAccount,
        getVerificationState,
        mutateCustomerMetadata,
        payoutNameStanding,
        payoutNumberStanding,
        removeSavedBankAccount,
      } satisfies FakeFacet<PayoutDestinations>;
    if (key === 'notification') return { createNotifications };
    if (key === 'logger') return logger;
    return { retrieveCustomer, updateCustomers, listCustomers };
  }),
};

/** A holder name another account used, not cleared for this customer. */
const linkedName = { holders: ['cus_2'], blocking: ['cus_2'] };

/** The customer's own save of what a request body carried. */
const save = (body: Record<string, unknown>) =>
  savePayoutDestination(scope as never, {
    customerId: 'cus_1',
    actor: { kind: 'customer' },
    bankCode: body.bank_code,
    accountNumber: body.account_number,
  });

const VALID_BODY = {
  bank_code: 'MBBEMYKL',
  bank_name: 'Maybank',
  account_number: '123456789012',
};

/** A saved list already at the cap. */
const fullList = () =>
  Array.from({ length: MAX_SAVED_BANK_ACCOUNTS }, (_, i) =>
    savedShape({ id: `id_${i}`, accountNumber: `900000000${i}` }),
  );

/** A fixed, long-past save time, outside the cooling-off window. */
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

/** The saved list in the metadata a save returned. */
const listOf = (out: { metadata: Record<string, unknown> }) =>
  out.metadata.bank_accounts as ReturnType<typeof savedShape>[];

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
  addSavedBankAccount.mockReset();
  removeSavedBankAccount.mockReset();
  listCustomers.mockReset();
  listCustomers.mockResolvedValue([]);
  retrieveCustomer.mockResolvedValue({ metadata: {} });
  updateCustomers.mockResolvedValue({});
  createNotifications.mockResolvedValue(undefined);
});

describe('savePayoutDestination as the customer', () => {
  it('saves a valid account and MERGES around sibling metadata keys', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { avatar_url: 'https://cdn/x.webp' },
    });
    const out = await save(VALID_BODY);
    const written = {
      avatar_url: 'https://cdn/x.webp',
      bank_accounts: [savedShape({ savedAt: expect.any(String) })],
    };
    expect(updateCustomers).toHaveBeenCalledWith('cus_1', {
      metadata: written,
    });
    expect(out).toEqual({ added: true, metadata: written });
  });

  // A new destination is stamped NOW, so it starts a fresh cooling-off window.
  // Without the stamp the account would resolve as "never usable" on the
  // payout path. (The response's usableFrom is the route spec's.)
  it('stamps savedAt on a new account', async () => {
    const before = Date.now();
    await save(VALID_BODY);
    const written = updateCustomers.mock.calls[0][1].metadata.bank_accounts;
    const savedAt = Date.parse(written[0].savedAt);
    expect(savedAt).toBeGreaterThanOrEqual(before);
    expect(savedAt).toBeLessThanOrEqual(Date.now());
  });

  it('refuses what the payout submit would refuse (shared validation gate)', async () => {
    await expect(
      save({ ...VALID_BODY, account_number: 'not-digits' }),
    ).rejects.toThrow(/valid account number/i);
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('refuses a Malaysian-length Maybank number under Singapore before saving', async () => {
    await expect(
      save({ ...VALID_BODY, bank_code: 'MBBESGSG' }),
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
        save({
            ...VALID_BODY,
            bank_code: bankCode,
            account_number: accountNumber,
          }),
      ).rejects.toThrow(message);
      expect(mutateCustomerMetadata).not.toHaveBeenCalled();
      expect(createNotifications).not.toHaveBeenCalled();
    },
  );

  it('saves an 11-digit Maybank Singapore number without dropping its leading zero', async () => {
    await save({
        ...VALID_BODY,
        bank_code: 'MBBESGSG',
        account_number: '01234567890',
      });
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
    await save({ ...VALID_BODY, bank_name: 'evil\nline' });
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
    await save({
        ...VALID_BODY,
        bank_code: 'MYMB2U',
        bank_name: 'Maybank Berhad',
      });
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
      save({ ...VALID_BODY, bank_code: 'MBB' }),
    ).rejects.toThrow(/pick a bank/i);
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('refuses the sandbox dummy bank unless the sandbox is configured', async () => {
    const prev = process.env.TGPAY_API_BASE;
    process.env.TGPAY_API_BASE = 'https://api.tgpay365.com/api/v2';
    try {
      await expect(
        save({ ...VALID_BODY, bank_code: 'DUMMYBANKVERIFIED' }),
      ).rejects.toThrow(/pick a bank/i);
      expect(updateCustomers).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.TGPAY_API_BASE;
      else process.env.TGPAY_API_BASE = prev;
    }
  });


  it('saves a USDT wallet with no holder; an ERC20 address in either case is ONE account', async () => {
    const checksummed = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
    await save({ bank_code: 'USDTERC20', account_number: checksummed });
    const [saved] = updateCustomers.mock.calls[0][1].metadata.bank_accounts;
    expect(saved).toMatchObject({
      bankCode: 'USDTERC20',
      accountNumber: checksummed.toLowerCase(),
      accountHolderName: 'USDT · ERC20 (Ethereum)',
    });
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [saved] },
    });
    await save({
        bank_code: 'USDTERC20',
        account_number: checksummed.toLowerCase(),
      });
    // The other letter case is the same id, so nothing is added or written.
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });

  it('refuses a mistyped wallet address with the reason', async () => {
    await expect(
      save({
          bank_code: 'USDTERC20',
          account_number: '0xdAC17F958D2ee523a2206206994597C13D831ec8',
        }),
    ).rejects.toThrow(/not a valid ERC20/);
  });

  it('re-adding the same bank+number changes nothing', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [savedShape()] },
    });
    realName = 'Tan A. Kow';
    const out = await save(VALID_BODY);
    expect(updateCustomers).not.toHaveBeenCalled();
    expect(out.added).toBe(false);
    const [echoed] = listOf(out);
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
    const out = await save(VALID_BODY);
    expect(updateCustomers).not.toHaveBeenCalled();
    expect(listOf(out)[0]).not.toHaveProperty('savedAt');
  });

  it(`refuses account #${MAX_SAVED_BANK_ACCOUNTS + 1}`, async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: fullList() },
    });
    await expect(save(VALID_BODY)).rejects.toThrow(
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
    await expect(save(VALID_BODY)).rejects.toThrow(
      /already has a bank account/i,
    );
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('goes through the locked mutator rather than writing metadata itself', async () => {
    await save(VALID_BODY);
    expect(mutateCustomerMetadata).toHaveBeenCalledTimes(1);
    expect(mutateCustomerMetadata.mock.calls[0][0].customerId).toBe('cus_1');
  });

  // Contract: the response is the list that LANDED, not the one this handler
  // proposed. Under the lock those can differ (a concurrent writer wins), and
  // echoing the proposal would tell the customer something untrue.
});

// Adding a payout destination is a security event now, not a preference: it is
// the first half of "steal a token, wait out the cooling-off, cash out". The
// email is what gives the real owner the day in between.
describe('customer save — the new-destination notice', () => {
  it('emails the account holder, with the last 4 digits only', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {},
      email: 'player@example.test',
    });
    await save(VALID_BODY);

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
    await save(VALID_BODY);
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
    await save(VALID_BODY);
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
    await save(VALID_BODY);
    const firstKey = createNotifications.mock.calls
      .map(([args]) => args)
      .find((args) => args.channel === 'email').idempotency_key;

    // …deleted, then added again (an empty list is what DELETE leaves behind).
    createNotifications.mockClear();
    await new Promise((r) => setTimeout(r, 2));
    await save(VALID_BODY);
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
    await expect(save(VALID_BODY)).resolves.toMatchObject({ added: true });
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });
});

describe('customer save — one bank account, one Polycards account', () => {
  it('refuses a number another customer holds at the same bank, and writes nothing', async () => {
    payoutNumberStanding.mockResolvedValue(standing([{ customerId: 'cus_2' }]));
    await expect(save(VALID_BODY)).rejects.toThrow(
      SHARED_SAVE_MESSAGE,
    );
    // Asked at this bank; every spelling and the bank scope are the module's.
    expect(payoutNumberStanding).toHaveBeenCalledWith('cus_1', {
      bankCode: 'MBBEMYKL',
      accountNumber: '123456789012',
    });
    expect(updateCustomers).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
    // Logged so repeated probing shows up, with the last 4 digits only.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = logger.warn.mock.calls[0][0] as string;
    expect(line).toContain('cus_1');
    expect(line).toContain('9012');
    expect(line).not.toContain('123456789012');
  });

  it('a number another customer only saved blocks under any holder name', async () => {
    // The ring in ADR 0015 typed ten holder names onto one number.
    payoutNumberStanding.mockResolvedValue(
      standing([{ customerId: 'cus_2', paid: false }]),
    );
    await expect(save(VALID_BODY)).rejects.toThrow(
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
    payoutNumberStanding.mockResolvedValue(standing([{ customerId: 'cus_2' }]));
    await expect(save(VALID_BODY)).rejects.toThrow(
      /already has a bank account/i,
    );
  });

  it('a USDT wallet another account only saved does not block; one paid out does', () => {
    const TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const body = { bank_code: 'USDTTRC20', account_number: TRON };
    const wallet = (paid: boolean) =>
      standing([{ customerId: 'cus_2', paid }], {
        bankId: 'USDTTRC20',
        key: TRON,
        forms: [TRON],
      });
    return (async () => {
      // Someone else only SAVED it: wallets have no holder name to tell
      // owners apart, and the address is public, so this must not block.
      payoutNumberStanding.mockResolvedValue(wallet(false));
      await save(body);
      expect(updateCustomers).toHaveBeenCalledTimes(1);
      expect(payoutNumberStanding).toHaveBeenCalledWith('cus_1', {
        bankCode: 'USDTTRC20',
        accountNumber: TRON,
      });

      // Already paid out to another customer: refused.
      payoutNumberStanding.mockResolvedValue(wallet(true));
      await expect(save(body)).rejects.toThrow(
        SHARED_SAVE_MESSAGE,
      );
    })();
  });

  it('verification never lets a new shared number in', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_share_verified: { [savedShape().id]: '2026-11-03T00:00:00.000Z' } },
    });
    payoutNumberStanding.mockResolvedValue(
      standing([{ customerId: 'cus_2', paid: true }]),
    );
    await expect(save(VALID_BODY)).rejects.toThrow(
      SHARED_SAVE_MESSAGE,
    );
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('re-saving an account already on the list is not a new link', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [savedShape()] },
    });
    payoutNumberStanding.mockResolvedValue(standing([{ customerId: 'cus_2' }]));
    // Decided on the locked read: the account is already theirs, so nothing is
    // refused, and nothing changes either.
    await save(VALID_BODY);
    expect(updateCustomers).not.toHaveBeenCalled();
  });
});

describe('customer save — a saved account changes through support', () => {
  it('a re-save cannot relabel the holder, even while held', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: { bank_accounts: [savedShape()] },
    });
    realName = 'Someone Else';
    const out = await save(VALID_BODY);
    expect(updateCustomers).not.toHaveBeenCalled();
    const [echoed] = listOf(out);
    expect(echoed.accountHolderName).toBe('Tan Ah Kow');
  });
});

// One name per account (owner, 2026-11-16): a bank's holder IS the real name.
describe('customer save — the holder is the real name', () => {
  const TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

  it('saves a bank in the real name and drops a holder name an old page typed', async () => {
    await save({
        ...VALID_BODY,
        account_holder_name: 'Someone Else',
        account_holder_name_confirm: 'Another Name',
      });
    expect(getVerificationState).toHaveBeenCalledWith('cus_1');
    expect(payoutNameStanding).toHaveBeenCalledWith('cus_1', 'Tan Ah Kow');
    expect(
      updateCustomers.mock.calls[0][1].metadata.bank_accounts[0].accountHolderName,
    ).toBe('Tan Ah Kow');
  });

  it('refuses a bank when no real name is on file, and writes nothing', async () => {
    realName = null;
    await expect(save(VALID_BODY)).rejects.toThrow(
      /real name.*none on your account.*contact support/i,
    );
    expect(payoutNumberStanding).not.toHaveBeenCalled();
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it.each([['陈大文'], ['Иван Петров'], ['Таn Ah Kow']])(
    'refuses a bank when the real name %j is not in English letters',
    async (name) => {
      realName = name;
      await expect(save(VALID_BODY)).rejects.toThrow(
        /real name.*not in English letters.*contact support/i,
      );
      expect(updateCustomers).not.toHaveBeenCalled();
    },
  );

  it('the copy never names the verification provider', async () => {
    for (const name of [null, '陈大文']) {
      realName = name;
      const err = await save(VALID_BODY).catch((e) => e);
      expect(String(err.message)).not.toMatch(/touch|tng/i);
    }
  });

  it('a wallet needs no real name and never asks for one', async () => {
    realName = null;
    await save({ bank_code: 'USDTTRC20', account_number: TRON });
    expect(getVerificationState).not.toHaveBeenCalled();
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });

  it('a bad bank code is refused as before, without reading the real name', async () => {
    await expect(
      save({ ...VALID_BODY, bank_code: 'NOPE' }),
    ).rejects.toThrow(/bank from the list/);
    expect(getVerificationState).not.toHaveBeenCalled();
  });

  // The real name is read before the metadata lock, so support may correct it
  // while a save is under way. The bank must not stay in the old name.
  it.each([['Tan Ah Koh'], ['陈大文']])(
    'takes the save back off when the real name changes to %j during it',
    async (name) => {
      getVerificationState
        .mockResolvedValueOnce({ phoneVerified: true, realName: 'Tan Ah Kow' })
        .mockResolvedValueOnce({ phoneVerified: true, realName: name });
      retrieveCustomer
        .mockResolvedValueOnce({ metadata: {} })
        .mockResolvedValueOnce({ metadata: { bank_accounts: [savedShape()] } });
      await expect(save(VALID_BODY)).rejects.toThrow(
        /real name on file changed.*try again/i,
      );
      expect(updateCustomers).toHaveBeenCalledTimes(2);
      expect(updateCustomers.mock.calls[1][1].metadata.bank_accounts).toEqual(
        [],
      );
      expect(createNotifications).not.toHaveBeenCalled();
    },
  );

  it('keeps a save the correction already carried to the new name', async () => {
    getVerificationState
      .mockResolvedValueOnce({ phoneVerified: true, realName: 'Tan Ah Kow' })
      .mockResolvedValueOnce({ phoneVerified: true, realName: 'Tan Ah Koh' });
    const carried = savedShape({ accountHolderName: 'Tan Ah Koh' });
    retrieveCustomer
      .mockResolvedValueOnce({ metadata: {} })
      .mockResolvedValueOnce({ metadata: { bank_accounts: [carried] } });
    const out = await save(VALID_BODY);
    expect(updateCustomers).toHaveBeenCalledTimes(1);
    expect(out.added).toBe(true);
    expect(listOf(out)[0].accountHolderName).toBe('Tan Ah Koh');
  });
});

describe('customer save — owner rules of 2026-11-03', () => {
  const TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

  it('refuses a banned number and logs only its last 4', async () => {
    payoutNumberStanding.mockResolvedValue(
      standing([], { banned: true, bannedForPlayer: true }),
    );
    await expect(save(VALID_BODY)).rejects.toThrow(
      /cannot be used on Polycards/,
    );
    expect(updateCustomers).not.toHaveBeenCalled();
    const line = logger.warn.mock.calls[0][0] as string;
    expect(line).toContain('9012');
    expect(line).not.toContain('123456789012');
  });

  it('a number support unbanned for this customer saves', async () => {
    payoutNumberStanding.mockResolvedValue(
      standing([], { banned: true, bannedForPlayer: false }),
    );
    await save(VALID_BODY);
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });

  it('refuses a holder name another account already used', async () => {
    payoutNameStanding.mockResolvedValue(linkedName);
    await expect(save(VALID_BODY)).rejects.toThrow(
      /name is already linked/,
    );
    expect(payoutNameStanding).toHaveBeenCalledWith('cus_1', 'Tan Ah Kow');
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('a name support cleared for this customer saves', async () => {
    payoutNameStanding.mockResolvedValue({ holders: ['cus_2'], blocking: [] });
    await save(VALID_BODY);
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });

  it('a wallet skips the name check', async () => {
    await save({ bank_code: 'USDTTRC20', account_number: TRON });
    expect(payoutNameStanding).not.toHaveBeenCalled();
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });

  it('one account per currency: a wallet fits beside an RM bank, a second RM bank does not', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [savedShape({ accountNumber: '999999999999', id: 'x' })],
      },
    });
    await save({ bank_code: 'USDTTRC20', account_number: TRON });
    expect(updateCustomers).toHaveBeenCalledTimes(1);
    await expect(save(VALID_BODY)).rejects.toThrow(
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
    await save(TNG);
    const saved = updateCustomers.mock.calls[0][1].metadata.bank_accounts;
    expect(saved.map((a: { bankCode: string }) => a.bankCode)).toEqual(['MBBEMYKL', 'TNGMY']);
    retrieveCustomer.mockResolvedValue({ metadata: { bank_accounts: saved } });
    await expect(
      save({ ...TNG, account_number: '120000000002' }),
    ).rejects.toThrow(/already has a Touch 'n Go account/);
  });

  it('one name on every bank: a Touch \'n Go is refused when a saved bank is in another name', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [savedShape({ accountNumber: '999999999999', id: 'x' })],
      },
    });
    const TNG = { ...VALID_BODY, bank_code: 'TNGMY', account_number: '120000000001' };
    realName = 'Lim Mei Ling';
    await expect(save(TNG)).rejects.toThrow(
      /saved bank account is in another name than your real name.*contact support/i,
    );
    expect(updateCustomers).not.toHaveBeenCalled();
    // Case and separators do not make it another name.
    realName = 'TAN AH-KOW';
    await save(TNG);
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });

  it('one name on every bank: an SGD bank under another name is refused too', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [savedShape({ accountNumber: '999999999999', id: 'x' })],
      },
    });
    realName = 'Lim Mei Ling';
    await expect(
      save({ bank_code: 'DBSSSGSG', account_number: '0123456789' }),
    ).rejects.toThrow(/another name than your real name/);
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
    await save(VALID_BODY);
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
    await save({ ...VALID_BODY, bank_code: 'TNGMY', account_number: '120000000001' });
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
    realName = 'Tan Ah Kow Bin Abu';
    await save({ bank_code: 'DBSSSGSG', account_number: '0123456789' });
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });

  it('one name on every bank: a USDT wallet beside a bank needs no name', async () => {
    retrieveCustomer.mockResolvedValue({
      metadata: {
        bank_accounts: [savedShape({ accountNumber: '999999999999', id: 'x' })],
      },
    });
    await save({ bank_code: 'USDTTRC20', account_number: TRON });
    expect(updateCustomers).toHaveBeenCalledTimes(1);
  });
});

describe('customer save — holder names compare as one person reads them', () => {
  it('stores the name with invisible characters and odd spaces folded away', async () => {
    realName = 'Tan\u200b Ah  Kow';
    await save(VALID_BODY);
    expect(payoutNameStanding).toHaveBeenCalledWith('cus_1', 'Tan Ah Kow');
    expect(
      updateCustomers.mock.calls[0][1].metadata.bank_accounts[0].accountHolderName,
    ).toBe('Tan Ah Kow');
  });

  it.each([['Таn Ah Kow'], ['--'], ['Tan Ah Kow 😀'], ['Tan Ah Ŋow']])(
    'refuses a real name %j: Latin letters, digits and name punctuation only',
    async (name) => {
      realName = name;
      await expect(save(VALID_BODY)).rejects.toThrow(
        /English letters/,
      );
      expect(updateCustomers).not.toHaveBeenCalled();
    },
  );

  it.each([['TAN AH KOW&'], ['TAN AH KOW (1)'], ['TAN AH KÓW'], ['ᴛᴀɴ ᴀʜ ᴋᴏᴡ'], ['Tan ɑh Kow']])(
    'refuses %j when the plain name is on another account (the query compares letters)',
    async (name) => {
      payoutNameStanding.mockResolvedValue(linkedName);
      realName = name;
      await expect(save(VALID_BODY)).rejects.toThrow(
        /name is already linked/,
      );
      // Asked once, as typed: the read keys both sides by their letters
      // (holder-name-key-sql.integration.spec).
      expect(payoutNameStanding).toHaveBeenCalledTimes(1);
      expect(updateCustomers).not.toHaveBeenCalled();
    },
  );

  it('takes a save back off when another account saved the number at the same moment', async () => {
    payoutNumberStanding
      .mockResolvedValueOnce(standing())
      .mockResolvedValueOnce(standing([{ customerId: 'cus_2' }]));
    await expect(save(VALID_BODY)).rejects.toThrow(
      SHARED_SAVE_MESSAGE,
    );
    expect(mutateCustomerMetadata).toHaveBeenCalledTimes(2);
    expect(updateCustomers.mock.calls[1][1].metadata.bank_accounts).toEqual([]);
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it('a PayNow mobile is asked about as typed; its spellings are the module\'s', async () => {
    payoutNumberStanding.mockResolvedValue(
      standing([{ customerId: 'cus_2' }], {
        bankId: 'PAYNOWSG',
        key: '91234567',
        forms: ['91234567', '6591234567'],
      }),
    );
    await expect(
      save({ ...VALID_BODY, bank_code: 'PAYNOWSG', account_number: '91234567' }),
    ).rejects.toThrow(SHARED_SAVE_MESSAGE);
    expect(payoutNumberStanding).toHaveBeenCalledWith('cus_1', {
      bankCode: 'PAYNOWSG',
      accountNumber: '91234567',
    });
    expect(updateCustomers).not.toHaveBeenCalled();
  });

  it('takes a save back off when another account saved the name at the same moment', async () => {
    payoutNameStanding
      .mockResolvedValueOnce({ holders: [], blocking: [] })
      .mockResolvedValueOnce(linkedName);
    await expect(save(VALID_BODY)).rejects.toThrow(
      /name is already linked/,
    );
    expect(mutateCustomerMetadata).toHaveBeenCalledTimes(2);
    expect(createNotifications).not.toHaveBeenCalled();
  });
});
// Support's add (ADR 0015): the override for a real owner whose number another
// account holds. The audited writes are pinned in saved-account-support.
describe('savePayoutDestination as support', () => {
  const SUPPORT = {
    kind: 'support' as const,
    adminId: 'user_1',
    reason: 'owner proved it',
  };
  const NUMBER = '512345678901';
  const ID = savedBankAccountId('MBBEMYKL', NUMBER);
  const add = (over: Record<string, unknown> = {}) => {
    const body: Record<string, unknown> = {
      bank_code: 'MBBEMYKL',
      account_number: NUMBER,
      ...over,
    };
    return savePayoutDestination(scope as never, {
      customerId: 'cus_1',
      actor: SUPPORT,
      bankCode: body.bank_code,
      accountNumber: body.account_number,
    });
  };
  /** Another account on the number, paid to it. */
  const heldBy = (customerId: string, verified = false) =>
    standing([{ customerId, paid: true, verified }], { key: NUMBER });

  beforeEach(() => {
    realName = ' Test Holder ';
    retrieveCustomer.mockResolvedValue({ metadata: {}, email: 'a@b.test' });
  });

  it('refuses invalid details and a bank nothing can pay', async () => {
    await expect(add({ account_number: '123' })).rejects.toThrow();
    await expect(add({ bank_code: 'NOTABANK' })).rejects.toThrow(
      /bank from the list/,
    );
    expect(addSavedBankAccount).not.toHaveBeenCalled();
  });

  it('adds a number nobody else holds, unverified, and tells the owner', async () => {
    await expect(add()).resolves.toEqual({ added: true });
    expect(addSavedBankAccount).toHaveBeenCalledWith({
      customerId: 'cus_1',
      adminId: 'user_1',
      account: expect.objectContaining({
        id: ID,
        bankCode: 'MBBEMYKL',
        accountHolderName: 'Test Holder',
      }),
      verify: false,
      reason: 'owner proved it',
    });
    // Support's add writes through its audited method, never the raw mutator.
    expect(mutateCustomerMetadata).not.toHaveBeenCalled();
    const sent = JSON.stringify(createNotifications.mock.calls);
    expect(sent).toContain(NUMBER.slice(-4));
    expect(sent).not.toContain(NUMBER);
  });

  // One name per account (owner, 2026-11-16): support adds in the real name
  // only, and corrects the real name first to fix a spelling.
  it('adds in the real name', async () => {
    await add();
    expect(getVerificationState).toHaveBeenCalledWith('cus_1');
    expect(addSavedBankAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({ accountHolderName: 'Test Holder' }),
      }),
    );
  });

  it("refuses with no real name on file, or one not in English letters, in staff's words", async () => {
    realName = null;
    await expect(add()).rejects.toThrow(
      'This player has no real name on file. A bank account is saved in the real name: set it first.',
    );
    realName = '陈大文';
    await expect(add()).rejects.toThrow(
      /not in English letters.*Correct the real name first/,
    );
    expect(payoutNumberStanding).not.toHaveBeenCalled();
    expect(addSavedBankAccount).not.toHaveBeenCalled();
  });

  // Read before the add's lock: a correction landing in between must not leave
  // the bank in the old name.
  it('takes the add back when the real name changes during it', async () => {
    getVerificationState
      .mockResolvedValueOnce({ phoneVerified: true, realName: 'Test Holder' })
      .mockResolvedValueOnce({ phoneVerified: true, realName: 'Test Holdre' });
    await expect(add()).rejects.toThrow(/real name changed.*try again/i);
    expect(addSavedBankAccount).toHaveBeenCalledTimes(1);
    expect(removeSavedBankAccount).toHaveBeenCalledWith({
      customerId: 'cus_1',
      adminId: 'user_1',
      accountId: ID,
      reason: expect.stringMatching(/real name changed/),
    });
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it('keeps the add when the real name keys the same', async () => {
    getVerificationState
      .mockResolvedValueOnce({ phoneVerified: true, realName: 'Test Holder' })
      .mockResolvedValueOnce({ phoneVerified: true, realName: 'TEST HOLDER' });
    await add();
    expect(removeSavedBankAccount).not.toHaveBeenCalled();
  });

  it('a wallet needs no real name', async () => {
    realName = null;
    await add({
      bank_code: 'USDTTRC20',
      account_number: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    });
    expect(getVerificationState).not.toHaveBeenCalled();
    expect(addSavedBankAccount).toHaveBeenCalledTimes(1);
  });

  it('refuses a banned number, asked for this player, and logs nothing', async () => {
    payoutNumberStanding.mockResolvedValue(
      standing([], { banned: true, bannedForPlayer: true }),
    );
    await expect(
      add({ bank_code: 'PAYNOWSG', account_number: '91234567' }),
    ).rejects.toThrow(/cannot be used on Polycards/);
    expect(payoutNumberStanding).toHaveBeenCalledWith('cus_1', {
      bankCode: 'PAYNOWSG',
      accountNumber: '91234567',
    });
    expect(addSavedBankAccount).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('adds a number support unbanned for this player', async () => {
    payoutNumberStanding.mockResolvedValue(
      standing([], { banned: true, bannedForPlayer: false }),
    );
    await add();
    expect(addSavedBankAccount).toHaveBeenCalledTimes(1);
  });

  it('vouches for a shared number by adding it', async () => {
    payoutNumberStanding.mockResolvedValue(
      standing([{ customerId: 'cus_2', paid: false }]),
    );
    await add();
    expect(addSavedBankAccount).toHaveBeenCalledWith(
      expect.objectContaining({ verify: true }),
    );
  });

  it('one person, one account: refuses while another account is verified on it', async () => {
    payoutNumberStanding.mockResolvedValue(heldBy('cus_2', true));
    listCustomers.mockResolvedValue([
      { id: 'cus_2', metadata: { handle: 'Collector2' } },
    ]);
    await expect(add()).rejects.toThrow(
      'One person, one account: Collector2 is already verified on this bank account. Undo that first if this is the right account.',
    );
    expect(listCustomers).toHaveBeenCalledWith(
      { id: ['cus_2'] },
      { select: ['id', 'metadata'], take: 1 },
    );
    expect(addSavedBankAccount).not.toHaveBeenCalled();
  });

  // Decision 2026-11-15 (#3), kept: support adds for a person it checked, so
  // the customer-only rules are not asked, and nothing is re-checked after.
  it('skips the name-linked, one-name and race checks', async () => {
    payoutNameStanding.mockResolvedValue(linkedName);
    await add();
    expect(payoutNameStanding).not.toHaveBeenCalled();
    expect(payoutNumberStanding).toHaveBeenCalledTimes(1);
    expect(addSavedBankAccount).toHaveBeenCalledTimes(1);
  });

  it("passes the slot refusal of support's add through, and tells no one", async () => {
    addSavedBankAccount.mockRejectedValue(
      new Error('This player already has an RM bank account. Remove it first.'),
    );
    await expect(add()).rejects.toThrow(/already has an RM bank account/);
    expect(createNotifications).not.toHaveBeenCalled();
  });
});
