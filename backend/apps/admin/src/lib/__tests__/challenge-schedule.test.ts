import { describe, it, expect } from 'vitest';
import {
  nextWeeklyReset,
  describeInShopZone,
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

  it('never returns a past instant, whatever day/hour it is called on', () => {
    // 24 hourly probes across a full week — the off-by-one in the day maths
    // only bites on the reset day itself, which a single fixed date misses.
    const start = Date.parse('2026-08-05T00:00:00Z');
    for (let h = 0; h < 7 * 24; h++) {
      const at = new Date(start + h * 3_600_000);
      expect(nextWeeklyReset(KL, at).getTime()).toBeGreaterThan(at.getTime());
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
});
