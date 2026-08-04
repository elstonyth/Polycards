/**
 * Date maths for scheduling a Weekly Challenge.
 *
 * Its own module (not inline in routes/challenge/page.tsx) so the zoned
 * arithmetic is unit-testable — see __tests__/challenge-schedule.test.ts. A
 * wrong default here silently flips the milestone ladder mid-week, under
 * players already competing on those thresholds, and the operator has no way
 * to tell from the form that it happened.
 *
 * No date library: the admin bundle carries none, and the two helpers below
 * are the standard way to do zoned arithmetic with plain Intl.
 */

/** The zone's UTC offset (ms) at a given instant. Both sides are re-parsed in
 *  browser-local time, so the BROWSER's own offset cancels and what is left is
 *  the target zone's. */
export const zoneOffsetMs = (instant: Date, tz: string): number =>
  new Date(instant.toLocaleString('en-US', { timeZone: tz })).getTime() -
  new Date(instant.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();

/**
 * The next occurrence of the configured weekly reset, as a real instant.
 *
 * `wall` is a Date shifted so its getUTC* fields read as the target zone's WALL
 * clock — the usual trick for zoned day-of-week/hour maths without a library.
 * Everything in between therefore uses the setUTC/getUTC accessors, never the
 * local ones, which would silently mix in the browser's zone.
 */
export const nextWeeklyReset = (
  settings: { timezone: string; reset_day: number; reset_hour: number },
  now: Date = new Date(),
): Date => {
  const { timezone, reset_day, reset_hour } = settings;
  const wall = new Date(now.getTime() + zoneOffsetMs(now, timezone));

  const target = new Date(wall);
  target.setUTCHours(reset_hour, 0, 0, 0);
  let days = (reset_day - target.getUTCDay() + 7) % 7;
  // Today IS the reset day but its hour has already passed (or is exactly now):
  // the next reset is a week out, not a moment in the past.
  if (days === 0 && target.getTime() <= wall.getTime()) days = 7;
  target.setUTCDate(target.getUTCDate() + days);

  // Wall clock -> instant. Two passes so a value landing near a DST boundary
  // settles on the offset that actually applies THERE; Malaysia has no DST, so
  // the second pass is a no-op for this shop's default.
  const wallMs = target.getTime();
  let instant = new Date(wallMs - zoneOffsetMs(target, timezone));
  instant = new Date(wallMs - zoneOffsetMs(instant, timezone));
  return instant;
};

/** An instant -> the value a `datetime-local` input wants. That control speaks
 *  BROWSER wall-clock with no zone, so the browser offset is subtracted before
 *  slicing the ISO string. */
export const toLocalInput = (d: Date): string =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);

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
