/**
 * Weekly-challenge reset timing: the label ("Resets Mondays 00:00 (MYT)"), the
 * next reset instant, and the countdown formatting.
 *
 * Pure + isomorphic (no server-only imports), same contract as
 * `sell-countdown.ts` — the countdown is rendered by a client component, so
 * importing these from the data layer would drag the Medusa SDK into the
 * browser bundle.
 */

const DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

// Short timezone tag for the reset line. A tiny known-zone map keeps it honest
// without pulling a tz library; an unknown zone falls back to the raw IANA name.
const TZ_ABBR: Record<string, string> = {
  'Asia/Kuala_Lumpur': 'MYT',
  UTC: 'UTC',
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** ONE clamp for both readings of the schedule — the label and the countdown
 *  must never disagree about what an out-of-range resetDay/resetHour means. */
function normalizeReset(
  day: number,
  hour: number,
): { day: number; hour: number } {
  return {
    day: ((Math.trunc(day) % 7) + 7) % 7,
    hour: Math.max(0, Math.min(23, Math.trunc(hour))),
  };
}

/** "Resets Mondays 00:00 (MYT)" from (resetDay 0=Sun…6=Sat, resetHour, timezone). */
export function formatReset(
  day: number,
  hour: number,
  timezone: string,
): string {
  const reset = normalizeReset(day, hour);
  const name = DAYS[reset.day] ?? 'Monday';
  const hh = String(reset.hour).padStart(2, '0');
  const tz = TZ_ABBR[timezone] ?? timezone;
  return `Resets ${name}s ${hh}:00 (${tz})`;
}

/**
 * Epoch ms of the next reset instant, from the same (day, hour, timezone) the
 * label is built from.
 *
 * ponytail: assumes the zone's UTC offset holds across the coming week — exact
 * for MYT (no DST). A DST zone would be an hour off for the single week that
 * spans a transition; swap in a tz library if one ever ships.
 */
export function nextResetAt(
  day: number,
  hour: number,
  timezone: string,
  now: Date = new Date(),
): number {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  };
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: timezone });
  } catch {
    // Unknown IANA zone: fall back to the runtime zone rather than throwing the
    // whole challenge away over a cosmetic countdown. The label still prints the
    // raw zone name, so the two CAN disagree for that (misconfigured) case —
    // counting down in the wrong zone beats rendering nothing.
    fmt = new Intl.DateTimeFormat('en-US', opts);
  }
  const parts = fmt.formatToParts(now);
  const at = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  const weekday = at('weekday');
  // Unreachable with the locale pinned to en-US; Sunday is the tie-break rather
  // than a -1 index silently shifting the whole week.
  const wd = Math.max(
    0,
    DAYS.findIndex((d) => d.startsWith(weekday)),
  );
  const nowSec =
    (Number(at('hour')) % 24) * 3600 +
    Number(at('minute')) * 60 +
    Number(at('second'));
  const reset = normalizeReset(day, hour);
  let delta = ((reset.day - wd + 7) % 7) * 86400 + reset.hour * 3600 - nowSec;
  if (delta <= 0) delta += 7 * 86400;
  // Drop the sub-second remainder so the deadline lands ON the minute.
  return now.getTime() - now.getMilliseconds() + delta * 1000;
}

/** Ms until the next reset. A stale (cached) deadline rolls forward whole weeks
 *  instead of sticking at zero. */
export function resetMsLeft(resetAt: number, nowMs: number): number {
  const weeks = Math.max(0, Math.ceil((nowMs - resetAt) / WEEK_MS));
  return resetAt + weeks * WEEK_MS - nowMs;
}

/** "2d 14h 32m 18s" — days drop off once under a day. */
export function formatResetLeft(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const hms = `${pad(Math.floor((s % 86400) / 3600))}h ${pad(
    Math.floor((s % 3600) / 60),
  )}m ${pad(s % 60)}s`;
  const d = Math.floor(s / 86400);
  return d > 0 ? `${d}d ${hms}` : hms;
}
