import { fakeGateway } from '../../modules/packs/fake-gateway';
import { setActiveGateway } from '../../modules/packs/gateway';
import { GatewayError } from '../../modules/packs/gateway-types';
import gatewayAuditJob from '../gateway-audit';

// Nothing is mocked. The job requeries through the real seam — it resolves
// the active gateway, looks the config up PER ROW (rowGatewayConfigs) and
// dispatches on that config's kind — so pointing the rows at the fake
// gateway substitutes the HTTP and nothing else. Every decision under test is
// the job's own: the not-configured stamp, the ambiguous-answer skip, the
// net_amount backfill, and the finding stamp.
const ORIGINAL = { ...process.env };

beforeEach(() => {
  fakeGateway.reset();
  setActiveGateway(null);
  process.env.GATEWAY_ENABLED = 'true';
  // The fake needs no credentials; the active gateway falls back to this.
  process.env.PAYMENT_GATEWAY = 'fake';
});

afterAll(() => {
  process.env = ORIGINAL;
  setActiveGateway(null);
});

const settledDeposit = {
  id: 'gpd_1',
  gateway: 'fake',
  merchant_transaction_id: 'PC-1',
  status: 'settled',
  amount_settled: '50.00',
  net_amount: null,
  created_at: new Date(),
};

function harness(
  deposits: Record<string, unknown>[],
  withdrawals: Record<string, unknown>[] = [],
) {
  const packs = {
    siteSettings: jest.fn(async () => ({ payment_gateway: null })),
    listGatewayDeposits: jest.fn(async (f: { audited_at?: unknown }) =>
      f.audited_at === null ? deposits : [],
    ),
    listGatewayWithdrawals: jest.fn(async (f: { audited_at?: unknown }) =>
      f.audited_at === null ? withdrawals : [],
    ),
    updateGatewayDeposits: jest.fn(async () => []),
    updateGatewayWithdrawals: jest.fn(async () => []),
    listCreditTransactions: jest.fn(
      async (_filter: Record<string, unknown>): Promise<unknown[]> => [],
    ),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const container = {
    resolve: (k: string) => (k === 'logger' ? logger : packs),
  };
  return { packs, logger, container };
}

describe('gateway audit job', () => {
  it('stamps an agreeing row with no note and backfills the net the gateway reports', async () => {
    fakeGateway.script({
      getDepositDetail: { state: 'success', amount: 50, netAmount: 49.4 },
    });
    const h = harness([settledDeposit]);
    await gatewayAuditJob(h.container as never);
    expect(h.packs.updateGatewayDeposits).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'gpd_1',
        audit_note: null,
        net_amount: 49.4,
      }),
    );
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('records a disagreement as a finding and logs it', async () => {
    fakeGateway.script({ getDepositDetail: { state: 'failed', amount: 0 } });
    const h = harness([settledDeposit]);
    await gatewayAuditJob(h.container as never);
    const call = (
      h.packs.updateGatewayDeposits.mock.calls as unknown[][]
    )[0][0] as {
      audit_note: string | null;
    };
    expect(call.audit_note).toMatch(/gateway/i);
    expect(h.logger.error).toHaveBeenCalledTimes(1);
  });

  // From a real row: A3Pay settled it on 10-18, the transfer bounced,
  // staff refunded it by hand that day and the customer was paid through TGPay.
  it('a settled payout refunded by hand never reads "not refunded"', async () => {
    fakeGateway.script({ getWithdrawalDetail: { state: 'failed', amount: 0 } });
    const h = harness(
      [],
      [
        {
          id: 'gpw_9',
          gateway: 'fake',
          customer_id: 'cus_9',
          merchant_transaction_id: 'PC-BOUNCED',
          gateway_transaction_id: 'W2026000000000001',
          status: 'settled',
          amount: '100',
          net_amount: null,
          created_at: new Date(),
        },
      ],
    );
    h.packs.listCreditTransactions.mockImplementation(
      async (f: Record<string, unknown>) =>
        f.source_transaction_id
          ? []
          : [
              {
                reference:
                  'Refund RM100 for returned payout W2026000000000001; merchant PC-BOUNCED',
              },
            ],
    );
    await gatewayAuditJob(h.container as never);
    const [row] = h.packs.updateGatewayWithdrawals.mock.calls[0] as unknown as [
      { audit_note: string },
    ];
    expect(row.audit_note).toMatch(/do not refund again/);
    expect(row.audit_note).not.toMatch(/not refunded/);
  });

  it('asks the ledger only about a row that disagrees', async () => {
    fakeGateway.script({
      getDepositDetail: { state: 'success', amount: 50, netAmount: 49.4 },
    });
    const h = harness([settledDeposit]);
    await gatewayAuditJob(h.container as never);
    expect(h.packs.listCreditTransactions).not.toHaveBeenCalled();
  });

  it('leaves an ambiguous answer un-stamped so the next run retries it', async () => {
    fakeGateway.script({
      getDepositDetail: new GatewayError('timeout', [], 500, false),
    });
    const h = harness([settledDeposit]);
    await gatewayAuditJob(h.container as never);
    expect(h.packs.updateGatewayDeposits).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('a row from a retired gateway is stamped as a finding, without a gateway call', async () => {
    const h = harness(
      [],
      [
        {
          id: 'gpw_1',
          gateway: 'globepay',
          merchant_transaction_id: 'PC-w1',
          status: 'settled',
          amount: '100.00',
          created_at: new Date(),
        },
      ],
    );
    await gatewayAuditJob(h.container as never);
    expect(fakeGateway.calls.withdrawalDetails).toEqual([]);
    expect(h.packs.updateGatewayWithdrawals).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'gpw_1',
        audit_note: expect.stringMatching(/not configured/),
      }),
    );
  });

  // 2026-10-14 prod: 1,460 rows in the 7-day window are each re-checked
  // daily, 50 a run is 1,200 a day, and oldest-first let re-checks use up
  // every batch, so nothing created after 10-13 13:31 was ever audited (no
  // TGPay fee backfilled, no disagreement seen).
  it('open findings first, then never-audited rows; re-checks take what is left, stalest first', async () => {
    fakeGateway.script({
      getDepositDetail: { state: 'success', amount: 50, netAmount: 49.4 },
    });
    const fresh = [settledDeposit];
    const stale = [
      { ...settledDeposit, id: 'gpd_old', audited_at: new Date(0) },
    ];
    const h = harness([]);
    h.packs.listGatewayDeposits.mockImplementation(
      async (f: { audit_note?: unknown; audited_at?: unknown }) =>
        f.audit_note ? [] : f.audited_at === null ? fresh : stale,
    );
    await gatewayAuditJob(h.container as never);
    const calls = h.packs.listGatewayDeposits.mock.calls as unknown as [
      Record<string, unknown>,
      { take: number; order: Record<string, string> },
    ][];
    // Open findings (none here) come first, then the never-checked.
    expect(calls[0][0]).toMatchObject({ audit_note: { $ne: null } });
    expect(calls[1][0]).toMatchObject({ audited_at: null });
    expect(calls[1][1]).toEqual({ take: 50, order: { created_at: 'ASC' } });
    // Deposits linked to a gateway entry next, a capped share at any age.
    expect(calls[2][0]).toMatchObject({
      gateway_adjustment_ref: { $ne: null },
    });
    expect(calls[2][1]).toEqual({ take: 10, order: { audited_at: 'ASC' } });
    // The daily re-checks take what is left (the linked query returned the
    // stale row here too; it is checked once).
    expect(calls[3][0]).toMatchObject({
      audited_at: { $lt: expect.any(Date) },
    });
    expect(calls[3][0]).not.toHaveProperty('gateway_adjustment_ref');
    expect(calls[3][1]).toEqual({ take: 48, order: { audited_at: 'ASC' } });
    const ids = (
      h.packs.updateGatewayDeposits.mock.calls as unknown as [{ id: string }][]
    ).map((c) => c[0].id);
    expect(ids).toEqual(['gpd_1', 'gpd_old']);
  });

  it('a full batch of new rows leaves no room for re-checks', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => ({
      ...settledDeposit,
      id: `gpd_${i}`,
      merchant_transaction_id: `PC-${i}`,
    }));
    fakeGateway.script({
      getDepositDetail: { state: 'success', amount: 50, netAmount: 49.4 },
    });
    const h = harness(fifty);
    await gatewayAuditJob(h.container as never);
    // The open-findings query, then the new rows fill the batch.
    expect(h.packs.listGatewayDeposits).toHaveBeenCalledTimes(2);
  });

  // 2026-10-14: a RM 512.40 TGPay payout refunded while TGPay still held it
  // PENDING sat on Settlement for a day between checks, a payout that may yet
  // be paid twice. A row with an open finding is re-checked every hour, at any
  // age, ahead of everything else; a retired gateway's rows (which cannot be
  // checked) are left out, and a row picked twice is checked once.
  // A finding that never clears (the S$ 6-cent A3Pay rounding gap) comes
  // back every hour. Were open findings allowed the whole batch, 50 of them
  // would starve new rows of their first check again (#776).
  it('open findings take at most 10 of the batch: new rows still get checked', async () => {
    fakeGateway.script({
      getDepositDetail: { state: 'success', amount: 50, netAmount: 49.4 },
    });
    const open = Array.from({ length: 60 }, (_, i) => ({
      ...settledDeposit,
      id: `gpd_open_${i}`,
      merchant_transaction_id: `PC-open-${i}`,
      audit_note: 'gateway paid 50.06, row credited 50.00',
      audited_at: new Date(0),
    }));
    const h = harness([]);
    h.packs.listGatewayDeposits.mockImplementation(
      async (
        f: { audit_note?: unknown; audited_at?: unknown },
        o?: { take: number },
      ) =>
        f.audit_note
          ? open.slice(0, o?.take)
          : f.audited_at === null
            ? [settledDeposit]
            : [],
    );
    await gatewayAuditJob(h.container as never);
    const ids = (
      h.packs.updateGatewayDeposits.mock.calls as unknown as [{ id: string }][]
    ).map((c) => c[0].id);
    expect(ids).toHaveLength(11);
    expect(ids).toContain('gpd_1');
  });

  it('re-checks a row with an open finding within the hour, once, never a retired gateway', async () => {
    fakeGateway.script({
      getWithdrawalDetail: { state: 'failed', amount: 512.4 },
    });
    const flagged = {
      id: 'gpw_flag',
      gateway: 'fake',
      merchant_transaction_id: 'PC-flag',
      status: 'failed',
      amount: '512.40',
      net_amount: null,
      audit_note: 'gateway still reports pending for a payout we refunded',
      audited_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
      created_at: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
    };
    const h = harness([]);
    h.packs.listGatewayWithdrawals.mockImplementation(
      async (f: { audit_note?: unknown; audited_at?: unknown }) =>
        f.audit_note || (f.audited_at && f.audited_at !== null)
          ? [flagged]
          : [],
    );
    const before = Date.now();
    await gatewayAuditJob(h.container as never);
    const [[filter, opts]] = h.packs.listGatewayWithdrawals.mock
      .calls as unknown as [
      {
        audit_note: unknown;
        audited_at: { $lt: Date };
        gateway: { $nin: string[] };
        created_at?: unknown;
      },
      { take: number; order: Record<string, string> },
    ][];
    expect(filter.audit_note).toEqual({ $ne: null });
    // Any age: no window on an open finding.
    expect(filter.created_at).toBeUndefined();
    expect(filter.gateway.$nin).toContain('globepay');
    const age = before - filter.audited_at.$lt.getTime();
    expect(age).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1000);
    expect(age).toBeLessThan(2 * 60 * 60 * 1000);
    // A small share: open findings never take the whole batch. Ones an
    // operator acknowledged go after the rest: DESC puts Postgres's NULLs
    // (not acknowledged) first.
    expect(opts).toEqual({
      take: 10,
      order: { audit_ack_at: 'DESC', audited_at: 'ASC' },
    });
    // Returned by the open-findings query AND the daily re-check: one call.
    expect(fakeGateway.calls.withdrawalDetails).toEqual(['PC-flag']);
    // The gateway now agrees (failed = failed): the finding clears.
    expect(h.packs.updateGatewayWithdrawals).toHaveBeenCalledTimes(1);
    expect(h.packs.updateGatewayWithdrawals).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gpw_flag', audit_note: null }),
    );
  });

  // An acknowledgement covers the note it was given for, nothing after it.
  describe('an acknowledged finding', () => {
    const acked = {
      ...settledDeposit,
      id: 'gpd_ack',
      audit_note: 'gateway paid 50.06, row credited 50.00',
      audited_at: new Date(0),
      audit_ack_note: 'gateway paid 50.06, row credited 50.00',
      audit_ack_by: 'ops@test.dev',
      audit_ack_at: new Date(0),
    };
    const run = async (gatewayAmount: number) => {
      fakeGateway.script({
        getDepositDetail: { state: 'success', amount: gatewayAmount },
      });
      const h = harness([]);
      h.packs.listGatewayDeposits.mockImplementation(
        async (f: { audit_note?: unknown; audited_at?: unknown }) =>
          f.audit_note ? [acked] : [],
      );
      await gatewayAuditJob(h.container as never);
      return (
        h.packs.updateGatewayDeposits.mock.calls as unknown as [
          Record<string, unknown>,
        ][]
      )[0][0];
    };

    it('stays acknowledged while the gateway gives the same answer', async () => {
      const update = await run(50.06);
      expect(update.audit_note).toBe('gateway paid 50.06, row credited 50.00');
      expect(update).not.toHaveProperty('audit_ack_note');
    });

    it('comes back as a new warning when the answer changes', async () => {
      const update = await run(50.1);
      expect(update.audit_note).toBe('gateway paid 50.10, row credited 50.00');
      expect(update).toMatchObject({
        audit_ack_note: null,
        audit_ack_by: null,
        audit_ack_at: null,
      });
    });

    it('drops the acknowledgement once the gateway agrees', async () => {
      const update = await run(50);
      expect(update).toMatchObject({ audit_note: null, audit_ack_note: null });
    });
  });

  // From the real 2026-11-08 row: asked RM 64.56, 14 of 16 USDT arrived,
  // credited RM 56.49 by hand; the gateway keeps the order FAILED.
  describe('a short payment credited by hand', () => {
    const short = {
      ...settledDeposit,
      id: 'gpd_short',
      customer_id: 'cus_s',
      amount_settled: '56.49',
      amount_requested: '64.56',
    };
    const run = async (row: Record<string, unknown>) => {
      fakeGateway.script({ getDepositDetail: { state: 'failed', amount: 0 } });
      const h = harness([row]);
      await gatewayAuditJob(h.container as never);
      return (
        h.packs.updateGatewayDeposits.mock.calls as unknown as [
          Record<string, unknown>,
        ][]
      )[0][0];
    };

    it('gets the short-payment note, not the alarm', async () => {
      const update = await run(short);
      expect(update.audit_note).toMatch(
        /credited RM 56\.49 of RM 64\.56 asked/,
      );
      expect(update.audit_note).not.toMatch(/without gateway confirmation/);
    });

    it('keeps an acknowledgement of the alarm it replaces', async () => {
      const alarm =
        'gateway says FAILED but the row is settled — credit issued without gateway confirmation, investigate';
      const update = await run({
        ...short,
        audit_note: alarm,
        audit_ack_note: alarm,
        audit_ack_by: 'ops@test.dev',
        audit_ack_at: new Date(0),
      });
      expect(update.audit_ack_note).toBe(update.audit_note);
      expect(update).not.toHaveProperty('audit_ack_by');
    });
  });

  // The order stays FAILED at the gateway; the linked manual entry is the
  // record that backs the hand credit, so the audit checks that instead.
  describe("a short payment linked to the gateway's manual entry", () => {
    const linked = {
      ...settledDeposit,
      id: 'gpd_linked',
      customer_id: 'cus_l',
      amount_settled: '56.49',
      amount_requested: '64.56',
      gateway_adjustment_ref: 'MD-ENTRY-1',
    };
    const byRef =
      (
        entry: Record<string, unknown> | Error,
        order: Record<string, unknown> = { state: 'failed', amount: 0 },
      ) =>
      (): Record<string, unknown> => {
        const ref = fakeGateway.calls.depositDetails.at(-1);
        if (ref === 'PC-1') return order;
        if (entry instanceof Error) throw entry;
        return entry;
      };
    const run = async (
      entry: Record<string, unknown> | Error,
      row = linked,
    ) => {
      fakeGateway.script({ getDepositDetail: byRef(entry) as never });
      const h = harness([row]);
      await gatewayAuditJob(h.container as never);
      return h;
    };
    const update = (h: Awaited<ReturnType<typeof run>>) =>
      (
        h.packs.updateGatewayDeposits.mock.calls as unknown as [
          Record<string, unknown>,
        ][]
      )[0]?.[0];

    it('clears the finding when the entry is paid for what was credited', async () => {
      const h = await run({ state: 'success', amount: 56.49 });
      expect(fakeGateway.calls.depositDetails).toEqual(['PC-1', 'MD-ENTRY-1']);
      expect(update(h)).toMatchObject({ id: 'gpd_linked', audit_note: null });
      expect(h.logger.error).not.toHaveBeenCalled();
    });

    it('names the entry when it paid a different sum', async () => {
      const h = await run({ state: 'success', amount: 50 });
      expect(update(h)?.audit_note).toBe(
        "gateway's manual entry MD-ENTRY-1 paid 50.00, row credited 56.49 — investigate",
      );
    });

    it('is loud when the gateway has no such entry', async () => {
      const h = await run(
        new GatewayError('Not found', [], 400, false, { result: 'not-found' }),
      );
      expect(update(h)?.audit_note).toMatch(
        /NO record of manual entry MD-ENTRY-1/,
      );
    });

    it('leaves the row untouched when the entry lookup is ambiguous', async () => {
      const h = await run(new GatewayError('their outage', [], 500));
      expect(h.packs.updateGatewayDeposits).not.toHaveBeenCalled();
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/MD-ENTRY-1.*retry next run/),
      );
    });

    // A link clears the note, so an old linked row would otherwise drop out
    // of every step (security review, 2026-11-18).
    it('re-checks linked deposits daily at any age, payouts never', async () => {
      const h = harness([]);
      const before = Date.now();
      await gatewayAuditJob(h.container as never);
      const filters = (
        h.packs.listGatewayDeposits.mock.calls as unknown as [
          Record<string, unknown>,
          { take: number; order: Record<string, string> },
        ][]
      ).filter(([f]) => 'gateway_adjustment_ref' in f);
      expect(filters).toHaveLength(1);
      const [[filter, opts]] = filters as unknown as [
        {
          gateway_adjustment_ref: unknown;
          audited_at: { $lt: Date };
          gateway: { $nin: string[] };
          created_at?: unknown;
        },
        { take: number },
      ][];
      expect(filter.gateway_adjustment_ref).toEqual({ $ne: null });
      expect(filter.created_at).toBeUndefined();
      expect(filter.gateway.$nin).toContain('globepay');
      const age = before - filter.audited_at.$lt.getTime();
      expect(age).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
      expect(age).toBeLessThan(25 * 60 * 60 * 1000);
      expect(opts.take).toBe(10);
      for (const [f] of h.packs.listGatewayWithdrawals.mock
        .calls as unknown as [Record<string, unknown>][]) {
        expect(f).not.toHaveProperty('gateway_adjustment_ref');
      }
    });

    // The order turned paid after the link. The plain "gateway paid X, row
    // credited Y" would hide that the entry is on the gateway's books too
    // (code review, 2026-11-20).
    it('names the entry when the order itself turns paid for another sum', async () => {
      fakeGateway.script({
        getDepositDetail: { state: 'success', amount: 64.56 },
      });
      const h = harness([linked]);
      await gatewayAuditJob(h.container as never);
      expect(fakeGateway.calls.depositDetails).toEqual(['PC-1', 'MD-ENTRY-1']);
      expect(update(h)?.audit_note).toBe(
        'gateway now reports the order itself PAID (64.56), row credited 56.49, and manual entry MD-ENTRY-1 is linked to it too — the gateway may hold two paid records for one top-up, investigate',
      );
    });

    // Settlement's Link gateway entry answered the row while this run was
    // asking the gateway. What the run read at its start is stale: stamping
    // it would put back the finding the operator just answered.
    it.each([
      ['linked', { ...linked, gateway_adjustment_ref: null }, 'MD-ENTRY-1'],
      ['pointed at another entry', linked, 'MD-ENTRY-2'],
    ])('leaves a row %s mid-run to the next run', async (_label, row, now) => {
      fakeGateway.script({
        getDepositDetail: byRef({ state: 'failed', amount: 0 }) as never,
      });
      const h = harness([row]);
      h.packs.listGatewayDeposits.mockImplementation(
        async (f: { id?: unknown; audited_at?: unknown }) =>
          f.id
            ? [{ id: 'gpd_linked', gateway_adjustment_ref: now }]
            : f.audited_at === null
              ? [row]
              : [],
      );
      await gatewayAuditJob(h.container as never);
      expect(h.packs.updateGatewayDeposits).not.toHaveBeenCalled();
      expect(h.logger.error).not.toHaveBeenCalled();
    });

    // The order turned paid for exactly the credited sum. The row agrees with
    // its order, but a linked entry still paid means two paid records for one
    // credit, so the entry is asked about too (review, 2026-11-21).
    describe('when the order itself turns paid for what was credited', () => {
      const orderPaid = { state: 'success', amount: 56.49, netAmount: 55.92 };
      const runPaid = async (entry: Record<string, unknown> | Error) => {
        fakeGateway.script({
          getDepositDetail: byRef(entry, orderPaid) as never,
        });
        const h = harness([linked]);
        await gatewayAuditJob(h.container as never);
        return h;
      };

      it('names the entry when it is paid too', async () => {
        const h = await runPaid({
          state: 'success',
          amount: 56.49,
          netAmount: 50,
        });
        expect(fakeGateway.calls.depositDetails).toEqual([
          'PC-1',
          'MD-ENTRY-1',
        ]);
        expect(update(h)?.audit_note).toBe(
          'gateway now reports the order itself PAID (56.49), row credited 56.49, and manual entry MD-ENTRY-1 is linked to it too — the gateway may hold two paid records for one top-up, investigate',
        );
      });

      it.each([
        ['failed', { state: 'failed', amount: 56.49, netAmount: 50 }],
        [
          'gone from the gateway',
          new GatewayError('Not found', [], 400, false, {
            result: 'not-found',
          }),
        ],
      ])(
        'reads the order alone when the entry is %s, backfilling the order net',
        async (_label, entry) => {
          const h = await runPaid(entry);
          expect(fakeGateway.calls.depositDetails).toEqual([
            'PC-1',
            'MD-ENTRY-1',
          ]);
          expect(update(h)).toMatchObject({
            id: 'gpd_linked',
            audit_note: null,
            net_amount: 55.92,
          });
          expect(h.logger.error).not.toHaveBeenCalled();
        },
      );

      it('gives the plain order note when the order paid another sum and the entry is not paid', async () => {
        fakeGateway.script({
          getDepositDetail: byRef(
            { state: 'failed', amount: 0 },
            { state: 'success', amount: 64.56 },
          ) as never,
        });
        const h = harness([linked]);
        await gatewayAuditJob(h.container as never);
        expect(update(h)?.audit_note).toBe(
          'gateway paid 64.56, row credited 56.49',
        );
      });

      it('writes nothing when the entry lookup is ambiguous', async () => {
        const h = await runPaid(new GatewayError('their outage', [], 500));
        expect(h.packs.updateGatewayDeposits).not.toHaveBeenCalled();
        expect(h.logger.warn).toHaveBeenCalledWith(
          expect.stringMatching(/MD-ENTRY-1.*retry next run/),
        );
      });
    });
  });

  it('does nothing while the real-gateway switch is off', async () => {
    process.env.GATEWAY_ENABLED = 'false';
    const h = harness([settledDeposit]);
    await gatewayAuditJob(h.container as never);
    expect(h.packs.listGatewayDeposits).not.toHaveBeenCalled();
  });
});

// Plan 133. The withdrawal loop's docblock claimed a net backfill it never
// did, and the payout rows written before this change stored net as
// amount − fee — the inverted convention. Both are this loop's to settle.
describe('gateway audit job — payout net_amount', () => {
  const settledPayout = (over: Record<string, unknown> = {}) => ({
    id: 'gpw_n',
    gateway: 'fake',
    merchant_transaction_id: 'PC-wn',
    status: 'settled',
    amount: '100.00',
    net_amount: null,
    created_at: new Date(),
    ...over,
  });
  const lastWithdrawalUpdate = (h: ReturnType<typeof harness>) =>
    (h.packs.updateGatewayWithdrawals.mock.calls as unknown[][]).at(-1)?.[0] as
      Record<string, unknown> | undefined;

  it('backfills a NULL payout net from the gateway’s answer', async () => {
    fakeGateway.script({
      getWithdrawalDetail: { state: 'success', amount: 100, netAmount: 101 },
    });
    const h = harness([], [settledPayout()]);
    await gatewayAuditJob(h.container as never);
    expect(lastWithdrawalUpdate(h)).toMatchObject({
      id: 'gpw_n',
      net_amount: 101,
    });
  });

  it('does NOT restate a disagreeing net on a gateway that is not TGPay', async () => {
    fakeGateway.script({
      getWithdrawalDetail: { state: 'success', amount: 100, netAmount: 101 },
    });
    const h = harness([], [settledPayout({ net_amount: '99.00' })]);
    await gatewayAuditJob(h.container as never);
    // The repair is TGPay's alone: another provider's rows were written under
    // its own convention and this sweep has no standing to rewrite them.
    expect(lastWithdrawalUpdate(h)).not.toHaveProperty('net_amount');
    // No repair line — the only info this run logs is the run summary.
    expect(h.logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('PC-wn'),
    );
  });

  it('repairs a TGPay payout whose stored net disagrees, and says so', async () => {
    // A real tgpay config for THIS row, so the job takes the tgpay adapter
    // rather than the fake — the repair is scoped to that gateway id and a
    // fake row can never reach it. Only the HTTP is replaced.
    process.env.TGPAY_API_BASE = 'https://sandbox-api.tgpay365.test/api/v2';
    process.env.TGPAY_PUBLIC_KEY = 'pk';
    process.env.TGPAY_SECRET_KEY = 'sk';
    const realFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          status: 1,
          data: {
            status: 'success',
            order: {
              payoutRefNum: 'W1',
              merchantRefNum: 'PC-wn',
              amount: 100,
              fee: 1,
              amountIncludeFee: 101,
            },
          },
        }),
    })) as unknown as typeof fetch;
    try {
      const h = harness(
        [],
        [settledPayout({ gateway: 'tgpay', net_amount: '99.00' })],
      );
      await gatewayAuditJob(h.container as never);
      // 99 was amount − fee. 101 is what the payout wallet actually paid.
      expect(lastWithdrawalUpdate(h)).toMatchObject({ net_amount: 101 });
      expect(h.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('PC-wn'),
      );
      expect(h.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('99 -> 101'),
      );
    } finally {
      global.fetch = realFetch;
      delete process.env.TGPAY_API_BASE;
      delete process.env.TGPAY_PUBLIC_KEY;
      delete process.env.TGPAY_SECRET_KEY;
    }
  });
});
