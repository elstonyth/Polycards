/**
 * Date maths for scheduling a Weekly Challenge.
 *
 * Its own module (not inline in routes/challenge/page.tsx) so the zoned
 * arithmetic is unit-testable — see __tests__/challenge-schedule.test.ts. A
 * wrong default here silently flips the milestone ladder mid-week, under
 * players already competing on those thresholds, and the operator has no way
 * to tell from the form that it happened.
 *
 * ADVISORY, not enforced. `nextWeeklyReset` picks the DEFAULT start and
 * `isWeeklyResetInstant` warns when the operator edits away from it; the
 * backend accepts any future instant. That is deliberate — the same mid-week
 * hazard is already reachable by saving the live stages on the This-week tab,
 * so refusing it on this one door would be an inconsistent rule that costs the
 * operator an emergency swap they occasionally need.
 *
 * No date library: the admin bundle carries none, and the helpers below are
 * the standard way to do zoned arithmetic with plain Intl.
 */

// One formatter per zone. Constructing an Intl.DateTimeFormat is the expensive
// part; the offset lookups below are called several times per render path.
const partsCache = new Map<string, Intl.DateTimeFormat>();
const zoneParts = (tz: string): Intl.DateTimeFormat => {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(tz, f);
  }
  return f;
};

/**
 * The zone's UTC offset (ms) at a given instant.
 *
 * Reads the zoned wall-clock FIELDS via formatToParts and rebuilds them as a
 * UTC instant. The obvious alternative — rendering the time in `tz` and again
 * in UTC and subtracting — looks like it cancels the browser's own offset, and
 * silently does not: both strings are re-parsed as BROWSER-local wall times, so
 * if the browser's zone has a DST transition between the two rendered times
 * they parse under different offsets. Concretely, with the browser in
 * America/New_York, 2026-11-01T00:30:00Z reports Asia/Kuala_Lumpur as UTC+9,
 * because 00:30 parses as EDT and 08:30 parses as EST across that morning's
 * fall-back. formatToParts never round-trips through the local parser at all.
 */
export const zoneOffsetMs = (instant: Date, tz: string): number => {
  const p: Record<string, string> = {};
  for (const { type, value } of zoneParts(tz).formatToParts(instant)) {
    p[type] = value;
  }
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    // hourCycle h23 pins midnight to 00, but some ICU builds still emit 24 —
    // and Date.UTC would roll that into the next day.
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  // formatToParts carries whole seconds only, so compare against a
  // second-floored instant or every offset is off by the millisecond remainder.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
};

/**
 * How close to a reset is "too close to schedule for". Promotion runs on the
 * hourly settle job, so a start under an hour out is not a schedulable moment
 * in the first place — and offering it as the default loses a race the operator
 * cannot see: they accept a default 90 seconds out, type a reason, click Save
 * after the boundary passes, and the route refuses a start that is now in the
 * past. Skipping to the following week is what they meant anyway.
 */
const RESET_MARGIN_MS = 60 * 60_000;

type WeekSettings = {
  timezone: string;
  reset_day: number;
  reset_hour: number;
};

/**
 * The first reset boundary at or after `from` — no schedulability margin, so
 * this answers "where is the boundary?" and nothing else. `nextWeeklyReset`
 * layers the margin on top; `isWeeklyResetInstant` needs the bare answer.
 *
 * `wall` is a Date shifted so its getUTC* fields read as the target zone's WALL
 * clock — the usual trick for zoned day-of-week/hour maths without a library.
 * Everything in between therefore uses the setUTC/getUTC accessors, never the
 * local ones, which would silently mix in the browser's zone.
 */
const resetAtOrAfter = (settings: WeekSettings, from: Date): Date => {
  const { timezone, reset_day, reset_hour } = settings;
  const wall = new Date(from.getTime() + zoneOffsetMs(from, timezone));

  const target = new Date(wall);
  target.setUTCHours(reset_hour, 0, 0, 0);
  // Today IS the reset day but its hour has already passed: the next one is a
  // week out, not a moment in the past.
  let days = (reset_day - target.getUTCDay() + 7) % 7;
  if (days === 0 && target.getTime() < wall.getTime()) days = 7;
  target.setUTCDate(target.getUTCDate() + days);

  // Wall clock -> instant. Two passes so a value landing near a DST boundary
  // settles on the offset that actually applies THERE; Malaysia has no DST, so
  // the second pass is a no-op for this shop's default.
  const wallMs = target.getTime();
  const once = new Date(wallMs - zoneOffsetMs(target, timezone));
  return new Date(wallMs - zoneOffsetMs(once, timezone));
};

/** The next weekly reset that is far enough out to actually schedule for. */
export const nextWeeklyReset = (
  settings: WeekSettings,
  now: Date = new Date(),
): Date => {
  // The margin is checked on the RESOLVED INSTANT, not on the day arithmetic:
  // the common too-close case is the eve of the reset (KL Sunday 23:58 is a
  // whole day away by weekday count and 90 seconds away in reality), which a
  // check on the day offset steps straight over.
  const first = resetAtOrAfter(settings, now);
  if (first.getTime() - now.getTime() >= RESET_MARGIN_MS) return first;
  return resetAtOrAfter(settings, new Date(first.getTime() + 60_000));
};

/**
 * Is this instant a weekly reset boundary (to the minute)?
 *
 * A start that is NOT one promotes mid-week: legal, occasionally what an
 * operator wants for an emergency swap, but it changes the ladder under players
 * already competing on those thresholds, and the following settlement pays the
 * finished week on the NEW table. The form says so rather than refusing —
 * editing the live stages reaches the same hazard by a door that is already
 * open, so blocking only this one would be an inconsistent rule.
 */
export const isWeeklyResetInstant = (
  settings: WeekSettings,
  at: Date,
): boolean => {
  if (!Number.isFinite(at.getTime())) return false;
  // Probe from just BEFORE `at`, so `at` itself is the candidate rather than
  // the boundary a week after it.
  const boundary = resetAtOrAfter(settings, new Date(at.getTime() - 60_000));
  return Math.abs(boundary.getTime() - at.getTime()) < 60_000;
};

/** An instant -> the value a `datetime-local` input wants. That control speaks
 *  BROWSER wall-clock with no zone, so the browser offset is subtracted before
 *  slicing the ISO string.
 *
 *  Returns '' rather than throwing on an invalid date: zoneOffsetMs round-trips
 *  through the platform's Date parser, and a browser that rejects its own
 *  toLocaleString output would otherwise surface as a RangeError from
 *  toISOString DURING RENDER — a white-screened modal instead of an empty
 *  field the operator can just fill in. */
export const toLocalInput = (d: Date): string =>
  Number.isFinite(d.getTime())
    ? new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16)
    : '';

/** How the chosen start reads in the SHOP's timezone. The input is browser
 *  wall-clock, so an operator in a different zone would otherwise have no way
 *  to see that "Monday 00:00" on their screen is not the shop's reset. */
export const describeInShopZone = (d: Date, tz: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
