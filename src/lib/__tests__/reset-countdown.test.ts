import { describe, it, expect } from 'vitest';
import {
  formatReset,
  nextResetAt,
  resetMsLeft,
  formatResetLeft,
} from '@/lib/reset-countdown';

describe('formatReset', () => {
  it('formats a Monday 00:00 Asia/Kuala_Lumpur reset', () => {
    expect(formatReset(1, 0, 'Asia/Kuala_Lumpur')).toBe(
      'Resets Mondays 00:00 (MYT)',
    );
  });

  it('pads the hour and maps Sunday=0..Saturday=6', () => {
    expect(formatReset(0, 9, 'UTC')).toBe('Resets Sundays 09:00 (UTC)');
    expect(formatReset(6, 23, 'UTC')).toBe('Resets Saturdays 23:00 (UTC)');
  });

  it('falls back to the raw IANA name for an unknown zone', () => {
    expect(formatReset(1, 0, 'America/New_York')).toBe(
      'Resets Mondays 00:00 (America/New_York)',
    );
  });
});

describe('reset countdown', () => {
  // Thursday 2026-08-20 10:00Z = Thursday 18:00 MYT (UTC+8) — the next Monday
  // 00:00 MYT is 3d 6h later, i.e. 2026-08-23T16:00Z.
  const thu = new Date('2026-08-20T10:00:00Z');

  it('resolves the next reset instant in the challenge timezone', () => {
    expect(
      new Date(nextResetAt(1, 0, 'Asia/Kuala_Lumpur', thu)).toISOString(),
    ).toBe('2026-08-23T16:00:00.000Z');
  });

  it('skips a whole week when the reset moment has just passed', () => {
    const mondayMidnightMyt = new Date('2026-08-23T16:00:00Z');
    expect(
      new Date(
        nextResetAt(1, 0, 'Asia/Kuala_Lumpur', mondayMidnightMyt),
      ).toISOString(),
    ).toBe('2026-08-30T16:00:00.000Z');
  });

  it('falls back to the runtime zone for an unknown IANA name', () => {
    expect(() => nextResetAt(1, 0, 'Not/AZone', thu)).not.toThrow();
  });

  // A zone that CHANGES offset inside the week: a fixed 7-day walk lands an
  // hour off across a DST transition. Assert the zone-local reading rather than
  // a hand-computed UTC instant — "Monday 00:00 there" is the actual contract.
  const inZone = (ms: number, timeZone: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(ms));

  it('still lands on Monday 00:00 local across spring-forward', () => {
    // DST starts Sun 2026-03-08 in America/New_York; the reset is the Monday
    // after, so the week's offset changes mid-flight.
    const ms = nextResetAt(
      1,
      0,
      'America/New_York',
      new Date('2026-03-06T17:00:00Z'),
    );
    expect(inZone(ms, 'America/New_York')).toBe('Mon 00:00');
  });

  it('still lands on Monday 00:00 local across fall-back', () => {
    // DST ends Sun 2026-11-01 in America/New_York.
    const ms = nextResetAt(
      1,
      0,
      'America/New_York',
      new Date('2026-10-30T16:00:00Z'),
    );
    expect(inZone(ms, 'America/New_York')).toBe('Mon 00:00');
  });

  it('leaves a no-DST zone exactly where the plain walk put it', () => {
    expect(
      new Date(
        nextResetAt(
          1,
          0,
          'Asia/Kuala_Lumpur',
          new Date('2026-08-20T10:00:00Z'),
        ),
      ).toISOString(),
    ).toBe('2026-08-23T16:00:00.000Z');
  });

  it('rolls a stale deadline forward instead of sticking at zero', () => {
    const at = Date.parse('2026-08-23T16:00:00Z');
    expect(resetMsLeft(at, at - 60_000)).toBe(60_000);
    // A page cached past the reset still counts down to the NEXT one.
    expect(resetMsLeft(at, at + 60_000)).toBe(7 * 86_400_000 - 60_000);
  });

  it('formats days only while there are days left', () => {
    expect(formatResetLeft((2 * 86_400 + 3 * 3600 + 4 * 60 + 5) * 1000)).toBe(
      '2d 03h 04m 05s',
    );
    expect(formatResetLeft(59 * 1000)).toBe('00h 00m 59s');
    expect(formatResetLeft(-5)).toBe('00h 00m 00s');
  });
});
