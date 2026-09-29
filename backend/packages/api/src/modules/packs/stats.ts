// GET /admin/stats — the window math and the result shape. Pure (no Medusa
// imports) so every preset is unit-testable.
//
// MYT is a fixed UTC+8: Malaysia has never observed DST, the same convention
// as ledger.ts. Windows are half-open [from, to), and the current window
// never runs past `now`. The previous window is the same span one period
// back: N days for the day presets and custom ranges, one calendar month for
// the month presets. A partial "today" is therefore compared with yesterday
// up to the same time of day, not with the whole of yesterday.

export const STATS_RANGES = [
  'today',
  'yesterday',
  '7d',
  '30d',
  'month',
  'last_month',
  'custom',
] as const;

export type StatsWindow = { from: Date; to: Date };
export type StatsWindows = { current: StatsWindow; previous: StatsWindow };

export type SignupTopupStats = {
  /** Accounts created (customer.has_account), deleted ones included. */
  signups: number;
  topup_count: number;
  /** Distinct customers with at least one top-up in the window. */
  topup_customers: number;
  /** MYR. */
  topup_amount: number;
  /** Customers whose first-ever top-up falls in the window. */
  first_topup_count: number;
  /** MYR, the sum of those first top-ups. */
  first_topup_amount: number;
};

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Instant of MYT midnight on (y, m, d). Date.UTC normalizes an out-of-range
// month or day, so m - 1 in January is December of the year before.
const mytMidnight = (y: number, m: number, d: number): number =>
  Date.UTC(y, m, d) - MYT_OFFSET_MS;

// The same MYT wall-clock time `months` calendar months away. A missing day
// rolls forward (31 March minus one month lands on 3 March), and callers
// clamp that.
const shiftMonths = (t: number, months: number): number => {
  const w = new Date(t + MYT_OFFSET_MS);
  return (
    Date.UTC(
      w.getUTCFullYear(),
      w.getUTCMonth() + months,
      w.getUTCDate(),
      w.getUTCHours(),
      w.getUTCMinutes(),
      w.getUTCSeconds(),
      w.getUTCMilliseconds(),
    ) - MYT_OFFSET_MS
  );
};

// 'YYYY-MM-DD' as the instant of that MYT midnight. NaN unless it is a real
// calendar date, because Date.parse happily rolls 2026-02-30 into March.
const mytDay = (s: string | undefined): number => {
  if (!s || !DATE_ONLY_RE.test(s)) return NaN;
  const utc = Date.parse(s);
  return !Number.isNaN(utc) && new Date(utc).toISOString().startsWith(s)
    ? utc - MYT_OFFSET_MS
    : NaN;
};

const win = (from: number, to: number): StatsWindow => ({
  from: new Date(from),
  to: new Date(to),
});

const byDays = (from: number, to: number, days: number): StatsWindows => ({
  current: win(from, to),
  previous: win(from - days * DAY_MS, to - days * DAY_MS),
});

/** Null for an unknown range or a bad custom range (the route's 400). */
export function statsWindows(
  range: string,
  now: Date,
  customFrom?: string,
  customTo?: string,
): StatsWindows | null {
  const t = now.getTime();
  const w = new Date(t + MYT_OFFSET_MS); // MYT wall clock via the UTC getters
  const y = w.getUTCFullYear();
  const m = w.getUTCMonth();
  const today = mytMidnight(y, m, w.getUTCDate());
  const monthStart = mytMidnight(y, m, 1);

  switch (range) {
    case 'today':
      return byDays(today, t, 1);
    case 'yesterday':
      return byDays(today - DAY_MS, today, 1);
    case '7d':
      return byDays(today - 6 * DAY_MS, t, 7);
    case '30d':
      return byDays(today - 29 * DAY_MS, t, 30);
    case 'month':
      return {
        current: win(monthStart, t),
        previous: win(
          mytMidnight(y, m - 1, 1),
          Math.min(shiftMonths(t, -1), monthStart),
        ),
      };
    case 'last_month':
      return {
        current: win(mytMidnight(y, m - 1, 1), monthStart),
        previous: win(mytMidnight(y, m - 2, 1), mytMidnight(y, m - 1, 1)),
      };
    case 'custom': {
      const from = mytDay(customFrom);
      const end = mytDay(customTo) + DAY_MS;
      // NaN fails both comparisons, so a malformed date lands here too.
      if (!(from < end && from < t)) return null;
      return byDays(from, Math.min(end, t), (end - from) / DAY_MS);
    }
    default:
      return null;
  }
}
