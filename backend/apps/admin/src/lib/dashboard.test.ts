import { describe, expect, it } from 'vitest';
import {
  amountChange,
  attentionIncreased,
  attentionTitle,
  attentionWithdrawals,
  deltaTone,
  doublePayAcross,
  doublePayRisks,
  latestPayments,
  moneyFlowSeries,
  netCashIn,
  paymentStatus,
  percentChange,
  referralSeries,
  stuckDeposits,
} from './dashboard';
import type {
  GatewayDeposit,
  GatewayWithdrawal,
  ReferralSettlement,
  SettlementDirection,
  SettlementPeriod,
  SettlementReport,
  StatsFigures,
} from './admin-rest';

const dir = (gross: number): SettlementDirection => ({
  count: 1,
  gross,
  net: gross,
  fee: 0,
  missingNet: 0,
  missingGross: 0,
});
const period = (
  key: string,
  moneyIn: number,
  out: number,
): SettlementPeriod => ({
  period: key,
  deposits: dir(moneyIn),
  withdrawals: dir(out),
  ledger: { topupCredited: moneyIn, cashoutNet: out },
  delta: { deposits: 0, withdrawals: 0 },
});
const report = (
  granularity: 'week' | 'month',
  since: string,
  periods_requested: number,
  periods: SettlementPeriod[],
): SettlementReport => ({
  granularity,
  currency: null,
  since,
  periods_requested,
  periods,
});

describe('percentChange / deltaTone', () => {
  it('is null against a zero base instead of Infinity', () => {
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
  });
  it('is the signed change in percent', () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(75, 100)).toBe(-25);
  });
  it('colours a rise good, and a rise in money out bad', () => {
    expect(deltaTone(150, 100)).toBe('good');
    expect(deltaTone(50, 100)).toBe('bad');
    expect(deltaTone(150, 100, true)).toBe('bad');
    expect(deltaTone(50, 100, true)).toBe('good');
  });
  it('is flat with no base or no change', () => {
    expect(deltaTone(5, 0)).toBe('flat');
    expect(deltaTone(100, 100)).toBe('flat');
  });
});

describe('amountChange', () => {
  // Net cash can be negative or near zero, where a % change misleads
  // (RM 100 → RM −6,667.79 reads "−6767.8%"); the RM difference doesn't.
  it('is the RM difference with its direction', () => {
    expect(amountChange(-6667.79, 100)).toEqual({
      diff: -6767.79,
      tone: 'bad',
    });
    expect(amountChange(500, -200)).toEqual({ diff: 700, tone: 'good' });
  });
  it('is flat with no change, and counts a change from zero', () => {
    expect(amountChange(100, 100).tone).toBe('flat');
    expect(amountChange(50, 0)).toEqual({ diff: 50, tone: 'good' });
  });
});

describe('netCashIn', () => {
  it('is gateway top-ups minus withdrawals', () => {
    const s = {
      topup_amount: 1200.5,
      withdrawal_amount: 200.25,
    } as StatsFigures;
    expect(netCashIn(s)).toBeCloseTo(1000.25);
  });
});

describe('moneyFlowSeries', () => {
  // since = MYT midnight Monday 2026-09-21, i.e. 2026-09-20T16:00Z.
  const since = '2026-09-20T16:00:00.000Z';

  it('gap-fills a sparse, newest-first report into ascending buckets', () => {
    const r = report('week', since, 4, [
      period('2026-10-05', 300, 100),
      period('2026-09-21', 100, 50),
    ]);
    expect(
      moneyFlowSeries(r).map((p) => [p.key, p.moneyIn, p.moneyOut]),
    ).toEqual([
      ['2026-09-21', 100, 50],
      ['2026-09-28', 0, 0],
      ['2026-10-05', 300, 100],
      ['2026-10-12', 0, 0],
    ]);
  });

  it('labels weeks by their Monday and months by name', () => {
    const w = moneyFlowSeries(report('week', since, 1, []));
    expect(w[0].label).toBe('21 Sep');
    const m = moneyFlowSeries(
      report('month', '2026-07-31T16:00:00.000Z', 3, [
        period('2026-09-01', 5, 1),
      ]),
    );
    expect(m.map((p) => [p.key, p.label])).toEqual([
      ['2026-08-01', 'Aug'],
      ['2026-09-01', 'Sep'],
      ['2026-10-01', 'Oct'],
    ]);
    expect(m[1].net).toBe(4);
  });

  it('steps months across a year end', () => {
    const m = moneyFlowSeries(
      report('month', '2026-11-30T16:00:00.000Z', 3, []),
    );
    expect(m.map((p) => p.key)).toEqual([
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
    ]);
    expect(m[1].label).toBe("Jan '27");
  });

  it('falls back to the rows it has, ascending, when since is unusable', () => {
    const r = report('week', 'not-a-date', 12, [
      period('2026-10-05', 3, 1),
      period('2026-09-21', 1, 1),
    ]);
    expect(moneyFlowSeries(r).map((p) => p.key)).toEqual([
      '2026-09-21',
      '2026-10-05',
    ]);
  });

  it('is empty without a report', () => {
    expect(moneyFlowSeries(undefined)).toEqual([]);
  });
});

describe('referralSeries', () => {
  const run = (
    week_start: string,
    cents: number,
    status: ReferralSettlement['status'] = 'paid',
  ): ReferralSettlement => ({
    id: week_start,
    week_start,
    status,
    approved_by: null,
    approved_at: null,
    paid_at: null,
    total_commission_cents: cents,
    held_for_review: false,
  });

  it('keeps the last N non-void runs, oldest first, in RM', () => {
    const runs = [
      run('2026-10-06', 214000),
      run('2026-09-29', 999, 'void'),
      run('2026-09-22', 150000),
      run('2026-09-15', 100000),
    ];
    expect(referralSeries(runs, 2)).toEqual([
      { key: '2026-09-22', label: '22 Sep', amount: 1500 },
      { key: '2026-10-06', label: '6 Oct', amount: 2140 },
    ]);
  });
});

const wd = (
  id: string,
  amount: number,
  created_at: string,
): GatewayWithdrawal =>
  ({
    id,
    amount,
    created_at,
    status: 'held',
    customer_id: `cus_${id}`,
  }) as GatewayWithdrawal;
const dep = (
  id: string,
  created_at: string,
  stuck: boolean,
  extra: Partial<GatewayDeposit> = {},
): GatewayDeposit =>
  ({
    id,
    created_at,
    stale: stuck,
    stuck,
    status: 'pending',
    amount_requested: 100,
    amount_settled: null,
    customer_id: `cus_${id}`,
    ...extra,
  }) as GatewayDeposit;

describe('attentionWithdrawals', () => {
  it('sums the page and finds the oldest', () => {
    const a = attentionWithdrawals(
      [
        wd('a', 100, '2026-10-14T02:00:00Z'),
        wd('b', 50.5, '2026-10-14T01:00:00Z'),
      ],
      2,
    );
    expect(a).toEqual({
      count: 2,
      amountPartial: false,
      amount: 150.5,
      oldest: '2026-10-14T01:00:00Z',
    });
  });
  it('keeps the exact count; only the RM sum covers just the fetched page', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      wd(String(i), 1, '2026-10-14T00:00:00Z'),
    );
    expect(attentionWithdrawals(rows, 73)).toMatchObject({
      count: 73,
      amountPartial: true,
      amount: 50,
    });
  });
  it('is empty with nothing held', () => {
    expect(attentionWithdrawals([], 0)).toEqual({
      count: 0,
      amountPartial: false,
      amount: 0,
      oldest: null,
    });
  });
});

describe('stuckDeposits', () => {
  it('counts only stuck rows and reports the oldest of them', () => {
    const s = stuckDeposits(
      [
        dep('a', '2026-10-14T01:00:00Z', true),
        dep('b', '2026-10-14T02:00:00Z', true),
        dep('c', '2026-10-14T03:00:00Z', false),
      ],
      3,
    );
    expect(s).toEqual({
      count: 2,
      capped: false,
      oldest: '2026-10-14T01:00:00Z',
    });
  });
  it('ignores a stale row that is not stuck (a customer who walked away)', () => {
    const walkedAway = dep('w', '2026-10-14T00:00:00Z', false, { stale: true });
    expect(stuckDeposits([walkedAway], 1)).toMatchObject({ count: 0 });
  });
  it('caps when a full page is all stuck and more exist', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      dep(String(i), '2026-10-14T00:00:00Z', true),
    );
    expect(stuckDeposits(rows, 80)).toMatchObject({ count: 50, capped: true });
  });
});

describe('latestPayments', () => {
  it('merges both lists newest first and keeps n', () => {
    const rows = latestPayments(
      [
        dep('d1', '2026-10-14T03:00:00Z', false, {
          status: 'settled',
          amount_settled: 500,
        }),
        dep('d2', '2026-10-14T01:00:00Z', false),
      ],
      [wd('w1', 1250, '2026-10-14T02:00:00Z')],
      2,
    );
    expect(rows.map((r) => [r.id, r.kind, r.amount])).toEqual([
      ['d1', 'deposit', 500],
      ['w1', 'withdrawal', 1250],
    ]);
  });
});

describe('paymentStatus', () => {
  it('maps every status to a plain label and colour', () => {
    expect(paymentStatus('deposit', 'pending')).toEqual({
      labelKey: 'dashboard.status.waiting',
      color: 'orange',
    });
    expect(paymentStatus('deposit', 'settled')).toEqual({
      labelKey: 'dashboard.status.credited',
      color: 'green',
    });
    expect(paymentStatus('deposit', 'failed').color).toBe('red');
    expect(paymentStatus('deposit', 'expired').color).toBe('grey');
    expect(paymentStatus('withdrawal', 'held')).toEqual({
      labelKey: 'dashboard.status.needsApproval',
      color: 'orange',
    });
    expect(paymentStatus('withdrawal', 'pending').labelKey).toBe(
      'dashboard.status.sentToBank',
    );
    expect(paymentStatus('withdrawal', 'settled')).toEqual({
      labelKey: 'dashboard.status.paid',
      color: 'green',
    });
  });
});

describe('attentionIncreased', () => {
  // Decides when the Dashboard plays its alert sound.
  it('is false on the first reading (nothing to compare with)', () => {
    expect(attentionIncreased({}, { withdrawals: 3 })).toBe(false);
  });
  it('is true when any queue grows', () => {
    expect(
      attentionIncreased(
        { withdrawals: 1, orders: 2 },
        { withdrawals: 1, orders: 3 },
      ),
    ).toBe(true);
  });
  it('counts growth from zero', () => {
    expect(attentionIncreased({ deposits: 0 }, { deposits: 1 })).toBe(true);
  });
  it('takes a queue read for the first time as its baseline', () => {
    // e.g. a queue whose first load failed: its later recovery is not news.
    expect(
      attentionIncreased({ withdrawals: 1 }, { withdrawals: 1, deposits: 4 }),
    ).toBe(false);
  });
  it('stays quiet when queues shrink or hold', () => {
    expect(
      attentionIncreased(
        { withdrawals: 2, orders: 1 },
        { withdrawals: 1, orders: 1 },
      ),
    ).toBe(false);
    expect(attentionIncreased({ withdrawals: 2 }, { withdrawals: 2 })).toBe(
      false,
    );
  });
});

describe('attentionTitle', () => {
  it('prefixes the tab title with the number of things waiting', () => {
    expect(attentionTitle('Polycards Admin', 6)).toBe('(6) Polycards Admin');
  });
  it('leaves the title alone when nothing is waiting', () => {
    expect(attentionTitle('Polycards Admin', 0)).toBe('Polycards Admin');
  });
  it('replaces an earlier count instead of stacking them', () => {
    expect(attentionTitle('(3) Polycards Admin', 1)).toBe(
      '(1) Polycards Admin',
    );
    expect(attentionTitle('(3) Polycards Admin', 0)).toBe('Polycards Admin');
  });
});

describe('doublePayRisks', () => {
  const finding = (o: Record<string, unknown>) => ({
    kind: 'withdrawal' as const,
    gateway: 'tgpay' as const,
    id: 'w',
    merchant_transaction_id: 'PC-1',
    gateway_transaction_id: null,
    customer_id: 'c',
    status: 'failed',
    amount: 512.4,
    note: 'gateway still reports pending for a payout we refunded',
    audited_at: null,
    ...o,
  });

  // The audit's two notes for a refunded payout the gateway did not drop:
  // still holding it, or already paid it (gateway-audit.ts).
  it('counts refunded payouts the gateway still holds or paid, and their sum', () => {
    expect(
      doublePayRisks([
        finding({}),
        finding({
          id: 'w2',
          amount: 100,
          note: 'gateway says PAID OUT (100.00) but the row is failed and refunded — DOUBLE PAYMENT risk, investigate now',
        }),
      ]),
    ).toEqual({ count: 2, paid: 1, amount: 612.4 });
  });

  it('ignores every other finding', () => {
    expect(
      doublePayRisks([
        finding({
          kind: 'deposit',
          note: 'gateway paid 154.58, row credited 154.52',
        }),
        finding({
          status: 'settled',
          note: 'gateway still reports pending for a payout we marked settled',
        }),
        finding({
          gateway: 'globepay',
          note: 'gateway "globepay" is not configured here — not audited',
        }),
      ]),
    ).toEqual({ count: 0, paid: 0, amount: 0 });
  });

  // An operator acknowledged it on Settlement: it no longer needs anyone.
  it('leaves out a refunded payout someone acknowledged', () => {
    expect(
      doublePayRisks([
        finding({}),
        finding({
          id: 'w2',
          acknowledged: { by: 'ops@test.dev', at: '2026-10-15T10:00:00Z' },
        }),
      ]),
    ).toEqual({ count: 1, paid: 0, amount: 512.4 });
  });

  // One rail's audit failing to load must not hide the other's risks.
  it('counts whichever rails loaded, and nothing when none did', () => {
    const rm = { findings: [finding({})] };
    expect(doublePayAcross([rm, undefined])).toEqual({
      count: 1,
      paid: 0,
      amount: 512.4,
    });
    expect(
      doublePayAcross([rm, { findings: [finding({ id: 'w3', amount: 10 })] }]),
    ).toEqual({ count: 2, paid: 0, amount: 522.4 });
    expect(doublePayAcross([undefined, undefined])).toBeUndefined();
  });
});
