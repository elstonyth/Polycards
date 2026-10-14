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
    expect(calls[2][0]).toMatchObject({
      audited_at: { $lt: expect.any(Date) },
    });
    expect(calls[2][1]).toEqual({ take: 49, order: { audited_at: 'ASC' } });
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
    expect(opts).toEqual({ take: 50, order: { audited_at: 'ASC' } });
    // Returned by the open-findings query AND the daily re-check: one call.
    expect(fakeGateway.calls.withdrawalDetails).toEqual(['PC-flag']);
    // The gateway now agrees (failed = failed): the finding clears.
    expect(h.packs.updateGatewayWithdrawals).toHaveBeenCalledTimes(1);
    expect(h.packs.updateGatewayWithdrawals).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gpw_flag', audit_note: null }),
    );
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
