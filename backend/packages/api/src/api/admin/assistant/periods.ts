// Report windows in Malaysia time (UTC+8, no daylight saving), the zone every
// Polycards date boundary uses — a TypeScript copy of the desk bots'
// tools/desk-reports/periods.mjs, so the assistant and the desks read the
// same window for "today" or "last week". A period resolves to a half-open
// [from, to) pair of ISO instants plus a label staff can check.
const MYT_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  Math.floor((ms + MYT_MS) / DAY_MS) * DAY_MS - MYT_MS;

const monthStart = (ms: number, offset = 0) => {
  const d = new Date(ms + MYT_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1) - MYT_MS;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dateStart(value: unknown, name: string): number {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new Error(`${name} must be a date like 2026-09-29.`);
  }
  const ms = Date.parse(`${value}T00:00:00+08:00`);
  // V8 rolls 2026-02-30 over to March; round-tripping catches it.
  if (
    Number.isNaN(ms) ||
    new Date(ms + MYT_MS).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${name} is not a real date.`);
  }
  return ms;
}

const clock = (ms: number) =>
  new Date(ms + MYT_MS).toISOString().slice(0, 16).replace('T', ' ');

export function resolvePeriod(
  period: string,
  { from, to }: { from?: unknown; to?: unknown } = {},
  now = Date.now(),
): ResolvedPeriod {
  if (period === 'all_time') return { from: null, to: null, label: 'all time' };
  const today = dayStart(now);
  const weekStart =
    today - ((new Date(today + MYT_MS).getUTCDay() + 6) % 7) * DAY_MS;
  const ranges: Record<string, () => [number, number]> = {
    today: () => [today, today + DAY_MS],
    yesterday: () => [today - DAY_MS, today],
    this_week: () => [weekStart, weekStart + 7 * DAY_MS],
    last_week: () => [weekStart - 7 * DAY_MS, weekStart],
    this_month: () => [monthStart(now), monthStart(now, 1)],
    last_month: () => [monthStart(now, -1), monthStart(now)],
    last_7_days: () => [now - 7 * DAY_MS, now],
    last_30_days: () => [now - 30 * DAY_MS, now],
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
