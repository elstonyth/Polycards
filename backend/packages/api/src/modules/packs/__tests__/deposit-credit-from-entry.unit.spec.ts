import { Modules } from '@medusajs/framework/utils';
import type { FakeFacet, GatewayDeposits } from '../facets';
import { fakeGateway } from '../fake-gateway';
import { setActiveGateway } from '../gateway';
import { GatewayError } from '../gateway-types';
import { creditFromAdjustmentEntry } from '../deposit-adjustment-entry';
import { topupIdempotencyReference } from '../topup';

// A USDT payment that arrived as a different amount than the order. The gateway
// keeps the order FAILED (Verify Fail), our row expires, and the gateway books
// what arrived as its own manual entry. Staff credit the row from that entry:
// the entry's amount through the row's FX lock, on the sweep's own anchor, with
// the entry linked so the hourly audit is answered in the same step.
const ORIGINAL = { ...process.env };

beforeEach(() => {
  fakeGateway.reset();
  setActiveGateway('fake');
  process.env.GATEWAY_ENABLED = 'true';
  process.env.PAYMENT_GATEWAY = 'fake';
});

afterAll(() => {
  process.env = ORIGINAL;
  setActiveGateway(null);
});

// A real case, 2026-11-21: 75 USDT ordered at a locked RM 306.45, 75.36
// arrived. Credited by hand that day as RM 307.92.
const overRow = {
  id: 'gpd_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PC-1',
  gateway_transaction_id: 'D-ORDER-1',
  amount_requested: '306.45',
  gateway_amount: '75',
  currency: 'USDT',
  payment_method_code: 'UTRC',
  status: 'expired',
  gateway: 'fake',
  gateway_adjustment_ref: null,
  audit_note: null,
};

// Max_lim, 2026-11-20: 44 USDT ordered at a locked RM 179.87, 42 arrived.
// Credited by hand that day as RM 171.69.
const shortRow = {
  ...overRow,
  amount_requested: '179.87',
  gateway_amount: '44',
};

const REF = 'MD20261121150000';

/** The gateway's answer for the entry, in ITS currency (USDT). */
const entryPaid = (usdt: number) => ({
  state: 'success' as const,
  amount: usdt,
  netAmount: usdt,
  statusId: 6,
  transactionId: 'D-ENTRY-1',
});

const orderFailed = { state: 'failed' as const, amount: 0 };

/** The gateway answers the row's own order (PC-1) and the entry apart. */
const answer = (entry: object | Error, order: object | Error = orderFailed) =>
  fakeGateway.script({
    getDepositDetail: (() => {
      const asked = fakeGateway.calls.depositDetails.at(-1);
      const pick = asked === 'PC-1' ? order : entry;
      if (pick instanceof Error) throw pick;
      return pick;
    }) as never,
  });

type Credit = { customer_id?: unknown; reference?: string; reason?: unknown };

function harness(
  row: Record<string, unknown> | null = overRow,
  opts: {
    /** Other deposit rows, matched on every filter key. */
    taken?: Record<string, unknown>[];
    /** Every credit transaction on record, any customer. */
    credits?: Credit[];
    /** Whether the top-up anchor already holds this credit. */
    replayed?: boolean;
    /** Answers of the link claim, in order. */
    claims?: boolean[];
    /** What the top-up anchor holds (a landed credit). */
    anchored?: { amount: number }[];
  } = {},
) {
  const claims = [...(opts.claims ?? [])];
  const credits = opts.credits ?? [];
  const packs = {
    listGatewayDeposits: jest.fn(async (f: Record<string, unknown>) => {
      if (f.id) return row && f.id === row.id ? [row] : [];
      return (opts.taken ?? []).filter((t) =>
        Object.entries(f).every(([k, v]) => t[k] === v),
      );
    }),
    // Filters seen: quotedForAnotherCustomer ({ customer_id: { $ne }, reference:
    // { $ilike } }), ledgerTrail's anchor ({ source_transaction_id }) and its
    // hand credits ({ customer_id, reason }).
    listCreditTransactions: jest.fn(async (f: Record<string, unknown>) => {
      if (f.source_transaction_id) return opts.anchored ?? [];
      const id = f.customer_id;
      if (id && typeof id === 'object' && '$ne' in id) {
        const ne = (id as { $ne: unknown }).$ne;
        const like = String((f.reference as { $ilike: string }).$ilike).replace(
          /%/g,
          '',
        );
        return credits.filter(
          (c) => c.customer_id !== ne && c.reference?.includes(like),
        );
      }
      return credits.filter((c) => c.customer_id === id);
    }),
    claimDepositAdjustmentRef: jest.fn(
      async (_input: Record<string, unknown>): Promise<boolean> =>
        claims.length ? (claims.shift() as boolean) : true,
    ),
    topUpCreditsWithLedger: jest.fn(async (input: { amount: number }) => ({
      id: 'ct_1',
      amount: input.amount,
      balance: input.amount,
      replayed: opts.replayed ?? false,
    })),
    claimDepositStatus: jest.fn(async () => true),
    createAdminActionAudits: jest.fn(async () => []),
    updateGatewayDeposits: jest.fn(async () => ({})),
  } satisfies FakeFacet<GatewayDeposits>;
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const others: Record<string, unknown> = {
    logger,
    [Modules.CUSTOMER]: {
      retrieveCustomer: async () => ({ email: 'payer@example.test' }),
    },
    [Modules.NOTIFICATION]: { createNotifications: jest.fn() },
  };
  const scope = { resolve: (k: string) => others[k] ?? packs } as never;
  const credit = (ref = REF, reason = 'GlobePay365 confirmed 75.36 arrived') =>
    creditFromAdjustmentEntry(scope, {
      depositId: 'gpd_1',
      ref,
      adminId: 'usr_admin_1',
      reason,
    });
  return { packs, credit, logger };
}

const NOTHING = /Nothing was (changed|credited)/;

describe('creditFromAdjustmentEntry', () => {
  it('credits an overpayment at the row lock: 75 ordered, 75.36 arrived = RM 307.92', async () => {
    answer(entryPaid(75.36));
    const h = harness();
    await expect(h.credit()).resolves.toEqual({
      credited: true,
      replayed: false,
      amount: 307.92,
      ref: REF,
      entryId: 'D-ENTRY-1',
    });
    expect(fakeGateway.calls.depositDetails).toEqual(['PC-1', REF]);
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledTimes(1);
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_1',
        amount: 307.92,
        reason: 'topup',
        idempotencyReference: topupIdempotencyReference('cus_1', 'PC-1'),
      }),
    );
    expect(h.packs.claimDepositStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gpd_1', to: 'settled' }),
    );
  });

  it('credits a short payment at the row lock: 44 ordered, 42 arrived = RM 171.69', async () => {
    answer(entryPaid(42));
    const h = harness(shortRow);
    await expect(h.credit()).resolves.toMatchObject({ amount: 171.69 });
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 171.69 }),
    );
  });

  it('reserves the entry on an unsettled row BEFORE any money moves', async () => {
    answer(entryPaid(75.36));
    const h = harness({ ...overRow, audit_note: 'gateway says Verify Fail' });
    await h.credit();
    expect(h.packs.claimDepositAdjustmentRef).toHaveBeenCalledWith({
      id: 'gpd_1',
      from: null,
      to: REF,
      entryId: 'D-ENTRY-1',
      status: ['failed', 'expired'],
    });
    const claimedAt =
      h.packs.claimDepositAdjustmentRef.mock.invocationCallOrder[0];
    const creditedAt =
      h.packs.topUpCreditsWithLedger.mock.invocationCallOrder[0];
    expect(claimedAt).toBeLessThan(creditedAt);
  });

  it('records who, why, the entry and what arrived', async () => {
    answer(entryPaid(75.36));
    const h = harness();
    await h.credit();
    expect(h.packs.createAdminActionAudits).toHaveBeenCalledWith([
      expect.objectContaining({
        admin_id: 'usr_admin_1',
        entity_type: 'gateway_deposit',
        entity_id: 'gpd_1',
        action: 'edit',
        before: { status: 'expired', gateway_adjustment_ref: null },
        after: {
          status: 'settled',
          amount: 307.92,
          replayed: false,
          gateway_adjustment_ref: REF,
          gateway_entry_id: 'D-ENTRY-1',
          entry_reported_amount: 75.36,
        },
        reason: 'GlobePay365 confirmed 75.36 arrived',
      }),
    ]);
  });

  it.each([
    ['settled', 'already settled'],
    ['pending', 'still waiting'],
  ])('refuses a %s row without asking the gateway', async (status, says) => {
    answer(entryPaid(75.36));
    const h = harness({ ...overRow, status });
    await expect(h.credit()).rejects.toThrow(says);
    expect(fakeGateway.calls.depositDetails).toEqual([]);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it.each(['failed', 'expired'])('accepts a %s row', async (status) => {
    answer(entryPaid(75.36));
    const h = harness({ ...overRow, status });
    await expect(h.credit()).resolves.toMatchObject({ credited: true });
  });

  it('refuses when the gateway reports the order itself paid (use Credit deposit)', async () => {
    answer(entryPaid(75.36), { state: 'success', amount: 75 });
    const h = harness();
    await expect(h.credit()).rejects.toThrow(/Credit deposit/);
    expect(h.packs.claimDepositAdjustmentRef).not.toHaveBeenCalled();
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('refuses an entry the gateway does not know', async () => {
    answer(
      new GatewayError('Not found', [], 400, false, { result: 'not-found' }),
    );
    const h = harness();
    await expect(h.credit()).rejects.toThrow(/no entry with that reference/);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('refuses an entry the gateway does not report paid', async () => {
    answer({ ...entryPaid(75.36), state: 'pending' });
    const h = harness();
    await expect(h.credit()).rejects.toThrow(/not paid/);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  // The gateway names no payer, so a wrong entry pasted on a small row is
  // bounded: what arrived must be close to what was ordered.
  it.each([
    [59.99, 'under 80%'],
    [78.76, 'over 105%'],
  ])('refuses an entry of %s USDT on a 75 USDT order (%s)', async (usdt) => {
    answer(entryPaid(usdt));
    const h = harness();
    await expect(h.credit()).rejects.toThrow(/too far from the order/);
    expect(h.packs.claimDepositAdjustmentRef).not.toHaveBeenCalled();
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it.each([60, 78.75])('accepts the band edge %s USDT', async (usdt) => {
    answer(entryPaid(usdt));
    const h = harness();
    await expect(h.credit()).resolves.toMatchObject({ credited: true });
  });

  it.each([
    ['merchant_transaction_id', REF],
    ['gateway_transaction_id', REF],
    ['gateway_adjustment_ref', REF],
    ['gateway_transaction_id', 'D-ENTRY-1'],
    ['gateway_adjustment_entry_id', 'D-ENTRY-1'],
  ])('refuses when another row holds it as %s', async (column, value) => {
    answer(entryPaid(75.36));
    const h = harness(overRow, {
      taken: [{ id: 'gpd_other', [column]: value }],
    });
    await expect(h.credit()).rejects.toThrow(/belongs to another deposit/);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it("refuses an entry another customer's hand credit quotes", async () => {
    answer(entryPaid(75.36));
    const h = harness(overRow, {
      credits: [
        { customer_id: 'cus_2', reason: 'adjustment', reference: `per ${REF}` },
      ],
    });
    await expect(h.credit()).rejects.toThrow(/another customer/);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  // Staff may already have paid this customer by admin adjustment quoting the
  // entry; a second credit from it would pay twice.
  it.each([REF, 'D-ENTRY-1'])(
    "refuses when this customer's own hand credit already quotes %s",
    async (quoted) => {
      answer(entryPaid(75.36));
      const h = harness(overRow, {
        credits: [
          {
            customer_id: 'cus_1',
            reason: 'adjustment',
            reference: `for ${quoted}`,
          },
        ],
      });
      await expect(h.credit()).rejects.toThrow(/pay the customer twice/);
      expect(h.packs.claimDepositAdjustmentRef).not.toHaveBeenCalled();
      expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    },
  );

  it('refuses, moving no money, when another operator reserved the row first', async () => {
    answer(entryPaid(75.36));
    const h = harness(overRow, { claims: [false] });
    await expect(h.credit()).rejects.toThrow(NOTHING);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('refuses, moving no money, when the unique index says the entry is taken', async () => {
    answer(entryPaid(75.36));
    const h = harness();
    h.packs.claimDepositAdjustmentRef.mockRejectedValueOnce(
      new Error(
        'Gateway deposit with gateway_adjustment_ref: x, already exists.',
      ),
    );
    await expect(h.credit()).rejects.toThrow(/belongs to another deposit/);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('releases the reservation when the credit is refused', async () => {
    answer(entryPaid(75.36));
    // A hand adjustment naming the ORDER: applyDepositOutcome refuses it.
    const h = harness(overRow, {
      credits: [
        { customer_id: 'cus_1', reason: 'adjustment', reference: 'paid PC-1' },
      ],
    });
    await expect(h.credit()).rejects.toThrow(/pay the customer twice/);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.claimDepositAdjustmentRef).toHaveBeenLastCalledWith({
      id: 'gpd_1',
      from: REF,
      to: null,
      entryId: null,
      status: ['failed', 'expired'],
    });
    expect(h.packs.createAdminActionAudits).not.toHaveBeenCalled();
  });

  it('answers a ledger replay with what the LEDGER holds, not the entry', async () => {
    answer(entryPaid(75.36));
    const h = harness(overRow, {
      replayed: true,
      anchored: [{ amount: 306.45 }],
    });
    await expect(h.credit()).resolves.toMatchObject({
      credited: true,
      replayed: true,
      amount: 306.45,
    });
    expect(h.packs.createAdminActionAudits).toHaveBeenCalledWith([
      expect.objectContaining({
        after: expect.objectContaining({ amount: 306.45, replayed: true }),
      }),
    ]);
  });

  it('clears the audit note only once the credit stands', async () => {
    answer(entryPaid(75.36));
    const h = harness({ ...overRow, audit_note: 'gateway says Verify Fail' });
    await h.credit();
    expect(h.packs.updateGatewayDeposits).toHaveBeenCalledWith({
      id: 'gpd_1',
      audit_note: null,
    });
  });

  it('leaves the note alone when the credit is refused', async () => {
    answer(entryPaid(75.36));
    const h = harness(
      { ...overRow, audit_note: 'gateway says Verify Fail' },
      {
        credits: [
          {
            customer_id: 'cus_1',
            reason: 'adjustment',
            reference: 'paid PC-1',
          },
        ],
      },
    );
    await expect(h.credit()).rejects.toThrow(/pay the customer twice/);
    expect(h.packs.updateGatewayDeposits).not.toHaveBeenCalledWith(
      expect.objectContaining({ audit_note: null }),
    );
  });

  // Code review 2026-11-21: a different reference on a row already reserved
  // (in flight, or credited after a crash) would swap a paid entry away and
  // free it to be credited again on another row.
  it('refuses a different reference on a row already reserved, before asking the gateway', async () => {
    answer(entryPaid(75.36));
    const h = harness({ ...overRow, gateway_adjustment_ref: 'MD-OTHER' });
    await expect(h.credit()).rejects.toThrow(
      /already being credited from gateway entry MD-OTHER/,
    );
    expect(fakeGateway.calls.depositDetails).toEqual([]);
    expect(h.packs.claimDepositAdjustmentRef).not.toHaveBeenCalled();
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('a retry with the SAME reserved reference skips the reservation and credits on the anchor', async () => {
    answer(entryPaid(75.36));
    const h = harness({
      ...overRow,
      gateway_adjustment_ref: REF,
      gateway_adjustment_entry_id: 'D-ENTRY-1',
    });
    await expect(h.credit()).resolves.toMatchObject({ credited: true });
    expect(h.packs.claimDepositAdjustmentRef).not.toHaveBeenCalled();
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledTimes(1);
  });

  it('refuses a top-up from a gateway that books no manual entries', async () => {
    answer(entryPaid(75.36));
    const h = harness({ ...overRow, gateway: 'tgpay' });
    await expect(h.credit()).rejects.toThrow(/Only a GlobePay365/);
    expect(fakeGateway.calls.depositDetails).toEqual([]);
  });

  it('releases the reservation when the ledger throws before any credit landed', async () => {
    answer(entryPaid(75.36));
    const h = harness();
    h.packs.topUpCreditsWithLedger.mockRejectedValueOnce(
      new Error('lock timeout'),
    );
    await expect(h.credit()).rejects.toThrow('lock timeout');
    expect(h.packs.claimDepositAdjustmentRef).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: REF, to: null }),
    );
  });

  it('keeps the reservation when the throw came after the credit landed', async () => {
    answer(entryPaid(75.36));
    const h = harness(overRow, { anchored: [{ amount: 307.92 }] });
    h.packs.claimDepositStatus.mockRejectedValueOnce(new Error('db gone'));
    await expect(h.credit()).rejects.toThrow('db gone');
    expect(h.packs.claimDepositAdjustmentRef).toHaveBeenCalledTimes(1);
  });

  it('keeps the reservation when it cannot tell whether the credit landed', async () => {
    answer(entryPaid(75.36));
    const h = harness();
    h.packs.topUpCreditsWithLedger.mockRejectedValueOnce(new Error('reset'));
    const real = h.packs.listCreditTransactions.getMockImplementation();
    let anchorReads = 0;
    h.packs.listCreditTransactions.mockImplementation(async (f) => {
      // The first anchor read is applyDepositOutcome's own trail check; the
      // second is the one after the throw, which cannot be answered.
      if ((f as Record<string, unknown>).source_transaction_id) {
        if (++anchorReads > 1) throw new Error('db gone');
        return [];
      }
      return real ? real(f) : [];
    });
    await expect(h.credit()).rejects.toThrow('reset');
    expect(h.packs.claimDepositAdjustmentRef).toHaveBeenCalledTimes(1);
  });

  it('a failed release is logged and the refusal still reaches the operator', async () => {
    answer(entryPaid(75.36));
    const h = harness(overRow, {
      credits: [
        { customer_id: 'cus_1', reason: 'adjustment', reference: 'paid PC-1' },
      ],
    });
    h.packs.claimDepositAdjustmentRef
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('db gone'));
    await expect(h.credit()).rejects.toThrow(/pay the customer twice/);
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not release entry'),
    );
  });

  // The band is judged in USDT, so exactly 80% of the order passes even
  // where the RM figure floors a cent under (35.2 of 44 = RM 143.89).
  it('accepts exactly 80% in USDT on the 44 USDT order', async () => {
    answer(entryPaid(35.2));
    const h = harness(shortRow);
    await expect(h.credit()).resolves.toMatchObject({ amount: 143.89 });
  });

  it.each([
    ['', 'Checked'],
    ['md 1', 'Checked'],
    [REF, ''],
    [REF, 'x'.repeat(501)],
  ])('refuses ref %j / reason length %#', async (ref, reason) => {
    answer(entryPaid(75.36));
    const h = harness();
    await expect(h.credit(ref, reason)).rejects.toThrow();
    expect(fakeGateway.calls.depositDetails).toEqual([]);
  });

  it("refuses the row's own order reference as the entry", async () => {
    answer(entryPaid(75.36));
    const h = harness();
    await expect(h.credit('PC-1')).rejects.toThrow(/own order reference/);
  });
});
