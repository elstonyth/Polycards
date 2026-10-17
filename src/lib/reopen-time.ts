// Malaysia keeps UTC+8 all year (no DST), so a fixed offset finds its day.
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const myt = (at: number, options: Intl.DateTimeFormatOptions, locale: string) =>
  new Date(at).toLocaleString(locale, {
    timeZone: 'Asia/Kuala_Lumpur',
    ...options,
  });

/**
 * When paused withdrawals reopen, in the customer's terms: "6:00 AM",
 * "6:00 AM tomorrow" or "Sat 18 Oct, 6:00 AM" — Malaysia time, the only
 * market. Mirrors mytWhen in the API's withdrawal-controls.ts.
 */
export function reopenLabel(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  const time = myt(at, { hour: 'numeric', minute: '2-digit' }, 'en-US');
  const day = (t: number) => Math.floor((t + MYT_OFFSET_MS) / DAY_MS);
  const ahead = day(at) - day(now);
  if (ahead <= 0) return time;
  if (ahead === 1) return `${time} tomorrow`;
  const date = myt(
    at,
    { weekday: 'short', day: 'numeric', month: 'short' },
    'en-GB',
  );
  return `${date}, ${time}`;
}
