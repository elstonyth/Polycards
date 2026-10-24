import type {
  GatewayDeposit,
  GatewayWithdrawal,
  ReferralSettlement,
  SettlementReport,
  StatsFigures,
  GatewayAuditFinding,
} from './admin-rest';

// Data shaping for the Dashboard (docs/superpowers/specs/
// 2026-10-14-admin-redesign-design.md §7). Pure functions only: the page
// components own fetching and rendering.

/** % change against the previous value; null against a zero base. */
export const percentChange = (cur: number, prev: number): number | null =>
  prev === 0 ? null : ((cur - prev) / prev) * 100;

export type Tone = 'good' | 'bad' | 'flat';

/** A rise is good — except for money leaving, where `riseIsBad` flips it. */
export const deltaTone = (
  cur: number,
  prev: number,
  riseIsBad = false,
): Tone => {
  const pct = percentChange(cur, prev);
  if (pct === null || pct === 0) return 'flat';
  return pct > 0 !== riseIsBad ? 'good' : 'bad';
};

/**
 * RM difference against the previous window. For figures that can be
 * negative or near zero (net cash), where a % change would mislead.
 */
export const amountChange = (
  cur: number,
  prev: number,
): { diff: number; tone: Tone } => {
  const diff = Math.round((cur - prev) * 100) / 100;
  return { diff, tone: diff > 0 ? 'good' : diff < 0 ? 'bad' : 'flat' };
};

/** Money the gateway received minus money paid out, same window. */
export const netCashIn = (s: StatsFigures): number =>
  s.topup_amount - s.withdrawal_amount;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const MYT_MS = 8 * 3_600_000;

/** 'YYYY-MM-DD' → '6 Oct'. */
const dayLabel = (key: string): string =>
  `${Number(key.slice(8, 10))} ${MONTHS[Number(key.slice(5, 7)) - 1]}`;

/** 'YYYY-MM-01' → 'Oct', or "Jan '27" so a year change reads on the axis. */
const monthLabel = (key: string): string => {
  const month = Number(key.slice(5, 7));
  return month === 1 ? `Jan '${key.slice(2, 4)}` : MONTHS[month - 1];
};

const addDays = (key: string, days: number): string => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const addMonth = (key: string): string => {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  return m === 12
    ? `${y + 1}-01-01`
    : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

export interface FlowPoint {
  key: string;
  label: string;
  moneyIn: number;
  moneyOut: number;
  net: number;
}

/**
 * The settlement report's periods as an evenly spaced, oldest-first series.
 * The route omits empty periods and returns newest first; the bucket keys are
 * rebuilt from `since` (the MYT midnight starting the first bucket) so gaps
 * read as zero instead of collapsing the axis.
 */
export const moneyFlowSeries = (
  report: SettlementReport | undefined,
): FlowPoint[] => {
  if (!report) return [];
  const byKey = new Map(report.periods.map((p) => [p.period, p]));
  const month = report.granularity === 'month';
  const sinceMs = Date.parse(report.since);
  const keys = Number.isNaN(sinceMs)
    ? [...byKey.keys()].sort()
    : Array.from({ length: report.periods_requested }).reduce<string[]>(
        (acc) => {
          const prev = acc[acc.length - 1];
          const next =
            prev === undefined
              ? new Date(sinceMs + MYT_MS).toISOString().slice(0, 10)
              : month
                ? addMonth(prev)
                : addDays(prev, 7);
          return [...acc, next];
        },
        [],
      );
  return keys.map((key) => {
    const p = byKey.get(key);
    const moneyIn = p?.deposits.gross ?? 0;
    const moneyOut = p?.withdrawals.gross ?? 0;
    return {
      key,
      label: month ? monthLabel(key) : dayLabel(key),
      moneyIn,
      moneyOut,
      net: moneyIn - moneyOut,
    };
  });
};

export interface RefPoint {
  key: string;
  label: string;
  amount: number;
}

/** The last `count` weekly commission runs that weren't voided, oldest first, in RM. */
export const referralSeries = (
  runs: ReferralSettlement[],
  count: number,
): RefPoint[] =>
  runs
    .filter((r) => r.status !== 'void')
    .map((r) => ({
      key: r.week_start.slice(0, 10),
      amount: r.total_commission_cents / 100,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(-count)
    .map((r) => ({ ...r, label: dayLabel(r.key) }));

const oldestOf = (rows: { created_at: string }[]): string | null =>
  rows.reduce<string | null>(
    (min, r) => (min === null || r.created_at < min ? r.created_at : min),
    null,
  );

/** Held withdrawals: `total` is the server count; the sum covers the fetched page. */
export const attentionWithdrawals = (
  rows: GatewayWithdrawal[],
  total: number,
) => ({
  count: total,
  amountPartial: total > rows.length,
  amount: rows.reduce((sum, r) => sum + r.amount, 0),
  oldest: oldestOf(rows),
});

/**
 * Payouts we refunded that the gateway still holds or has paid: money that
 * may leave twice (2026-10-14, a RM 512.40 TGPay payout). Read off the audit's
 * findings by its own two notes (backend gateway-audit.ts withdrawalAuditNote).
 */
export const doublePayRisks = (findings: GatewayAuditFinding[]) => {
  const risky = findings.filter(
    (f) =>
      f.kind === 'withdrawal' &&
      f.status === 'failed' &&
      !f.acknowledged &&
      /DOUBLE PAYMENT|pending for a payout we refunded/.test(f.note),
  );
  return {
    count: risky.length,
    paid: risky.filter((f) => /DOUBLE PAYMENT/.test(f.note)).length,
    amount:
      Math.round(risky.reduce((sum, f) => sum + (f.amount ?? 0), 0) * 100) /
      100,
  };
};

/** doublePayRisks over whichever rails' audits loaded: one that failed must
 *  not hide the other's. Undefined until one has. */
export const doublePayAcross = (
  audits: ({ findings: GatewayAuditFinding[] } | undefined)[],
) => {
  const loaded = audits.filter((a) => a !== undefined);
  return loaded.length > 0
    ? doublePayRisks(loaded.flatMap((a) => a.findings))
    : undefined;
};

/**
 * Pending deposits the sweep should long since have closed (`stuck`, computed
 * server-side: two sweeps past the reconcile window, with a gateway id). Not
 * `stale` — that also catches customers who walked away, which the next sweep
 * expires, and operators read it as a gateway fault. The route sorts pending
 * oldest first, so the stuck rows lead the page; a full page of them with more
 * behind is a floor, not a count.
 */
export const stuckDeposits = (rows: GatewayDeposit[], total: number) => {
  const stuck = rows.filter((r) => r.stuck);
  return {
    count: stuck.length,
    capped:
      stuck.length === rows.length && total > rows.length && rows.length > 0,
    oldest: oldestOf(stuck),
  };
};

export interface PaymentRow {
  id: string;
  kind: 'deposit' | 'withdrawal';
  customerId: string;
  email: string | null;
  amount: number;
  status: string;
  at: string;
}

/** Deposits and withdrawals merged, newest first. */
export const latestPayments = (
  deposits: GatewayDeposit[],
  withdrawals: GatewayWithdrawal[],
  n: number,
): PaymentRow[] =>
  [
    ...deposits.map<PaymentRow>((d) => ({
      id: d.id,
      kind: 'deposit',
      customerId: d.customer_id,
      email: d.customer_email,
      amount: d.amount_settled ?? d.amount_requested,
      status: d.status,
      at: d.created_at,
    })),
    ...withdrawals.map<PaymentRow>((w) => ({
      id: w.id,
      kind: 'withdrawal',
      customerId: w.customer_id,
      email: w.customer_email,
      amount: w.amount,
      status: w.status,
      at: w.created_at,
    })),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, n);

export type StatusColor = 'green' | 'orange' | 'red' | 'grey';

const DEPOSIT_STATUS: Record<string, { labelKey: string; color: StatusColor }> =
  {
    pending: { labelKey: 'dashboard.status.waiting', color: 'orange' },
    settled: { labelKey: 'dashboard.status.credited', color: 'green' },
    failed: { labelKey: 'dashboard.status.failed', color: 'red' },
    expired: { labelKey: 'dashboard.status.expired', color: 'grey' },
  };
const WITHDRAWAL_STATUS: Record<
  string,
  { labelKey: string; color: StatusColor }
> = {
  held: { labelKey: 'dashboard.status.needsApproval', color: 'orange' },
  pending: { labelKey: 'dashboard.status.sentToBank', color: 'grey' },
  settled: { labelKey: 'dashboard.status.paid', color: 'green' },
  failed: { labelKey: 'dashboard.status.failed', color: 'red' },
};

/** Plain-language label key and badge colour for a payment status. */
export const paymentStatus = (kind: PaymentRow['kind'], status: string) =>
  (kind === 'deposit' ? DEPOSIT_STATUS : WITHDRAWAL_STATUS)[status] ?? {
    labelKey: 'dashboard.status.unknown',
    color: 'grey' as StatusColor,
  };

/**
 * Whether any attention queue grew since the last reading — the Dashboard's
 * cue to play its alert. A queue's first reading only sets its baseline, so
 * opening the page with work already waiting (or a failed load recovering)
 * stays quiet.
 */
export const attentionIncreased = (
  prev: Record<string, number>,
  next: Record<string, number>,
) => Object.entries(next).some(([key, n]) => key in prev && n > prev[key]);

/** Browser tab title with the number of waiting items, e.g. "(3) Polycards Admin". */
export const attentionTitle = (title: string, n: number) => {
  const base = title.replace(/^\(\d+\) /, '');
  return n > 0 ? `(${n}) ${base}` : base;
};
