// Malaysia time (UTC+8, no daylight saving) for the reports: every Polycards
// date boundary is a Malaysia one. One home for the window calculators (the
// Dashboard's statsWindows, the reports' resolvePeriod) and the SQL day
// buckets. The periods last_7_days / last_30_days are the Dashboard's 7d /
// 30d (owner decision 2026-11-16).

/** The Malaysia calendar day of a timestamptz column, as 'YYYY-MM-DD'. */
export const mytDaySql = (column: string): string =>
  `to_char((${column} AT TIME ZONE 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD')`;

/** The first Malaysia day of the week (ISO, Monday) or month holding a
 *  timestamptz column, as 'YYYY-MM-DD'. */
export const mytPeriodStartSql = (
  unit: 'week' | 'month',
  column: string,
): string =>
  `to_char(date_trunc('${unit}', ${column} AT TIME ZONE 'Asia/Kuala_Lumpur'), 'YYYY-MM-DD')`;

// ── Dashboard / Stats windows (GET /admin/stats, Profit) ──────────────────────
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
  const thisMonth = mytMidnight(y, m, 1);

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
        current: win(thisMonth, t),
        previous: win(
          mytMidnight(y, m - 1, 1),
          Math.min(shiftMonths(t, -1), thisMonth),
        ),
      };
    case 'last_month':
      return {
        current: win(mytMidnight(y, m - 1, 1), thisMonth),
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

// ── Report periods (the assistant and the desk bots) ─────────────────────────
//
// Report windows in Malaysia time (UTC+8, no daylight saving), the zone every
// Polycards date boundary uses — a TypeScript copy of the desk bots'
// tools/desk-reports/periods.mjs, so the assistant and the desks read the
// same window for "today" or "last week". A period resolves to a half-open
// [from, to) pair of ISO instants plus a label staff can check.

export const PERIODS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'last_7_days',
  'last_30_days',
  'all_time',
  'custom',
] as const;
export type Period = (typeof PERIODS)[number];

export type ResolvedPeriod = {
  from: string | null;
  to: string | null;
  label: string;
};

const dayStart = (ms: number) =>
  Math.floor((ms + MYT_OFFSET_MS) / DAY_MS) * DAY_MS - MYT_OFFSET_MS;

const monthStart = (ms: number, offset = 0) => {
  const d = new Date(ms + MYT_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1) - MYT_OFFSET_MS;
};

function dateStart(value: unknown, name: string): number {
  if (typeof value !== 'string' || !DATE_ONLY_RE.test(value)) {
    throw new Error(`${name} must be a date like 2026-09-29.`);
  }
  const ms = Date.parse(`${value}T00:00:00+08:00`);
  // V8 rolls 2026-02-30 over to March; round-tripping catches it.
  if (
    Number.isNaN(ms) ||
    new Date(ms + MYT_OFFSET_MS).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${name} is not a real date.`);
  }
  return ms;
}

const clock = (ms: number) =>
  new Date(ms + MYT_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');

export function resolvePeriod(
  period: string,
  { from, to }: { from?: unknown; to?: unknown } = {},
  now = Date.now(),
): ResolvedPeriod {
  if (period === 'all_time') return { from: null, to: null, label: 'all time' };
  const today = dayStart(now);
  const weekStart =
    today - ((new Date(today + MYT_OFFSET_MS).getUTCDay() + 6) % 7) * DAY_MS;
  const ranges: Record<string, () => [number, number]> = {
    today: () => [today, today + DAY_MS],
    yesterday: () => [today - DAY_MS, today],
    this_week: () => [weekStart, weekStart + 7 * DAY_MS],
    last_week: () => [weekStart - 7 * DAY_MS, weekStart],
    this_month: () => [monthStart(now), monthStart(now, 1)],
    last_month: () => [monthStart(now, -1), monthStart(now)],
    // The Dashboard's 7d and 30d windows (statsWindows): today and the six
    // or 29 Malaysia days before it, up to now.
    last_7_days: () => [today - 6 * DAY_MS, now],
    last_30_days: () => [today - 29 * DAY_MS, now],
    custom: () => {
      const start = dateStart(from, 'from');
      const end = dateStart(to ?? from, 'to') + DAY_MS; // `to` is included
      if (end <= start) throw new Error('from must be on or before to.');
      return [start, end];
    },
  };
  if (!Object.hasOwn(ranges, period))
    throw new Error(`Unknown period ${period}.`);
  const [a, b] = ranges[period]();
  return {
    from: new Date(a).toISOString(),
    to: new Date(b).toISOString(),
    label: `${period} (Malaysia time ${clock(a)} to ${clock(b)}, end excluded)`,
  };
}
