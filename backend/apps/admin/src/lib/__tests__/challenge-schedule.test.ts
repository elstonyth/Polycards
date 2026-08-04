import { describe, it, expect } from 'vitest';
import {
  nextWeeklyReset,
  describeInShopZone,
  isWeeklyResetInstant,
  toLocalInput,
  zoneOffsetMs,
} from '../challenge-schedule';

// The shop's real configuration (challenge_settings defaults): Monday 00:00
// Asia/Kuala_Lumpur, which is UTC+8 year-round.
const KL = { timezone: 'Asia/Kuala_Lumpur', reset_day: 1, reset_hour: 0 };

const iso = (d: Date) => d.toISOString();

describe('nextWeeklyReset', () => {
  it('resolves the KL Monday-midnight reset to the right UTC instant', () => {
    // Wed 2026-08-05 10:00 UTC == Wed 18:00 in KL. Next Monday 00:00 KL is
    // 2026-08-10 00:00 +08 == 2026-08-09T16:00Z.
    expect(iso(nextWeeklyReset(KL, new Date('2026-08-05T10:00:00Z')))).toBe(
      '2026-08-09T16:00:00.000Z',
    );
  });

  it('skips to NEXT week when the reset hour has already passed today', () => {
    // Mon 2026-08-10 01:00 KL (== 2026-08-09T17:00Z) is one hour past the
    // reset — returning today would be a start in the past, which the backend
    // rejects and which would flip the ladder on the next tick.
    const at = new Date('2026-08-09T17:00:00Z');
    const next = nextWeeklyReset(KL, at);
    expect(next.getTime()).toBeGreaterThan(at.getTime());
    expect(iso(next)).toBe('2026-08-16T16:00:00.000Z');
  });

  it('skips a boundary that is too close to schedule for', () => {
    // 90 seconds before the KL Monday reset. Offering it would lose a race the
    // operator cannot see: they accept the default, type a reason, click Save
    // after the boundary, and the route refuses a past start.
    const at = new Date('2026-08-09T15:58:30Z');
    expect(iso(nextWeeklyReset(KL, at))).toBe('2026-08-16T16:00:00.000Z');
  });

  it('never returns an instant less than an hour out, whatever minute it is called on', () => {
    // Minute-resolution probes across a full week: the reset-day off-by-one and
    // the too-close window both only bite in a narrow band that hourly probes
    // step straight over.
    const start = Date.parse('2026-08-05T00:00:00Z');
    for (let m = 0; m < 7 * 24 * 60; m++) {
      const at = new Date(start + m * 60_000);
      expect(nextWeeklyReset(KL, at).getTime() - at.getTime()).toBeGreaterThanOrEqual(
        60 * 60_000,
      );
    }
  });

  it('lands on the configured weekday in the configured zone, not UTC', () => {
    // The KL Monday boundary is a SUNDAY in UTC — reading the weekday off the
    // raw instant instead of the zone is exactly the bug this guards.
    const next = nextWeeklyReset(KL, new Date('2026-08-05T10:00:00Z'));
    expect(next.getUTCDay()).toBe(0); // Sunday in UTC
    expect(describeInShopZone(next, KL.timezone)).toMatch(/^Mon/);
  });

  it('honours a non-midnight reset hour', () => {
    const next = nextWeeklyReset(
      { ...KL, reset_hour: 9 },
      new Date('2026-08-05T10:00:00Z'),
    );
    expect(iso(next)).toBe('2026-08-10T01:00:00.000Z'); // 09:00 +08
  });
});

describe('isWeeklyResetInstant', () => {
  it('accepts the boundary nextWeeklyReset produces', () => {
    // The two have to agree or the form warns about its own default.
    const next = nextWeeklyReset(KL, new Date('2026-08-05T10:00:00Z'));
    expect(isWeeklyResetInstant(KL, next)).toBe(true);
  });

  it('accepts a boundary that is already in the past', () => {
    // The predicate answers "is this a boundary?", not "is it schedulable" —
    // the margin belongs to nextWeeklyReset alone.
    expect(isWeeklyResetInstant(KL, new Date('2026-07-26T16:00:00Z'))).toBe(
      true,
    );
  });

  it('rejects a mid-week instant', () => {
    // Wednesday 12:00 KL — the case the modal warns about.
    expect(isWeeklyResetInstant(KL, new Date('2026-08-12T04:00:00Z'))).toBe(
      false,
    );
  });

  it('rejects the right hour on the wrong day and the wrong hour on the right day', () => {
    // Sunday 00:00 KL (a day early) and Monday 01:00 KL (an hour late).
    expect(isWeeklyResetInstant(KL, new Date('2026-08-08T16:00:00Z'))).toBe(
      false,
    );
    expect(isWeeklyResetInstant(KL, new Date('2026-08-09T17:00:00Z'))).toBe(
      false,
    );
  });

  it('rejects an invalid date instead of throwing', () => {
    expect(isWeeklyResetInstant(KL, new Date('nope'))).toBe(false);
  });
});

describe('toLocalInput', () => {
  it('returns empty string for an invalid date rather than throwing', () => {
    // toISOString throws RangeError on Invalid Date, and this runs during
    // render — a white-screened modal is worse than an empty field.
    expect(toLocalInput(new Date('nope'))).toBe('');
  });
});

describe('zoneOffsetMs', () => {
  it('reports KL as UTC+8 regardless of the browser zone', () => {
    expect(zoneOffsetMs(new Date('2026-08-05T10:00:00Z'), KL.timezone)).toBe(
      8 * 3_600_000,
    );
    // A DST zone, to prove the offset is read at the given INSTANT rather than
    // assumed constant.
    const winter = zoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'Europe/London');
    const summer = zoneOffsetMs(new Date('2026-07-15T12:00:00Z'), 'Europe/London');
    expect(winter).toBe(0);
    expect(summer).toBe(3_600_000);
  });

  // Regression: the previous implementation rendered the instant in `tz` and
  // again in UTC and subtracted, which looks like it cancels the BROWSER's
  // offset and does not — both strings get re-parsed as browser-local wall
  // times. An operator in a DST zone, on the morning that zone shifts, had the
  // two halves parsed under different offsets. 2026-11-01T00:30:00Z is
  // 00:30 EDT and 08:30 EST on the same New York morning, so KL came back as
  // UTC+9 and the scheduled default landed an hour off.
  it('is unaffected by a DST transition in the BROWSER zone', () => {
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      // The new implementation never touches the browser zone, so this case
      // passes trivially if the runner ignored TZ — assert the switch took
      // effect first, or the regression guards nothing. (July: NY is UTC-4.)
      expect(new Date('2026-07-01T12:00:00Z').getHours()).toBe(8);
      expect(
        zoneOffsetMs(new Date('2026-11-01T00:30:00Z'), KL.timezone),
      ).toBe(8 * 3_600_000);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('ignores sub-second precision rather than reporting a fractional offset', () => {
    // formatToParts carries whole seconds; without flooring the instant, the
    // millisecond remainder leaks into the offset.
    expect(zoneOffsetMs(new Date('2026-08-05T10:00:00.777Z'), KL.timezone)).toBe(
      8 * 3_600_000,
    );
  });
});
