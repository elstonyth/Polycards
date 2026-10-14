import { describe, expect, it } from 'vitest';
import {
  amountChange,
  attentionWithdrawals,
  deltaTone,
  latestPayments,
  moneyFlowSeries,
  netCashIn,
  paymentStatus,
  percentChange,
  referralSeries,
  staleDeposits,
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
  stale: boolean,
  extra: Partial<GatewayDeposit> = {},
): GatewayDeposit =>
  ({
    id,
    created_at,
    stale,
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
      capped: false,
      amount: 150.5,
      oldest: '2026-10-14T01:00:00Z',
    });
  });
  it('flags a total beyond the fetched page', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      wd(String(i), 1, '2026-10-14T00:00:00Z'),
    );
    expect(attentionWithdrawals(rows, 73)).toMatchObject({
      count: 73,
      capped: true,
      amount: 50,
    });
  });
  it('is empty with nothing held', () => {
    expect(attentionWithdrawals([], 0)).toEqual({
      count: 0,
      capped: false,
      amount: 0,
      oldest: null,
    });
  });
});

describe('staleDeposits', () => {
  it('counts only overdue rows and reports the oldest of them', () => {
    const s = staleDeposits(
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
  it('caps when a full page is all overdue and more exist', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      dep(String(i), '2026-10-14T00:00:00Z', true),
    );
    expect(staleDeposits(rows, 80)).toMatchObject({ count: 50, capped: true });
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
