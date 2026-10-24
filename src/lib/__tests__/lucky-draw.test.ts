import { describe, expect, it } from 'vitest';
import {
  chancePercent,
  drawCountdown,
  ENTER_REFUSALS,
  ENTER_REFUSAL_COPY,
  landingAngle,
  segmentAt,
  ticketRanges,
  wheelSegments,
  winnerIndex,
} from '@/lib/lucky-draw';

describe('chancePercent', () => {
  it('reads the share of tickets the way the prize card shows it', () => {
    expect(chancePercent(30, 100)).toBe('30%');
    expect(chancePercent(1, 300)).toBe('0.3%');
    expect(chancePercent(1, 5000)).toBe('<0.1%');
    expect(chancePercent(0, 0)).toBe('0%');
  });

  it('never rounds a near-10% share up to "10.0%"', () => {
    expect(chancePercent(996, 10_000)).toBe('10%');
  });

  it('never promises 100% while someone else holds tickets', () => {
    expect(chancePercent(9_999, 10_000)).toBe('99%');
    expect(chancePercent(50, 50)).toBe('100%');
  });

  it('reads no tickets as 0%', () => {
    expect(chancePercent(0, 400)).toBe('0%');
  });
});

describe('drawCountdown', () => {
  const at = '2026-11-30T15:59:00Z';
  it('counts down in days, hours, then minutes', () => {
    expect(drawCountdown(at, Date.parse('2026-11-28T11:59:00Z'))).toBe('2d 4h');
    expect(drawCountdown(at, Date.parse('2026-11-30T12:54:00Z'))).toBe(
      '3h 05m',
    );
    expect(drawCountdown(at, Date.parse('2026-11-30T15:54:51Z'))).toBe(
      '4m 09s',
    );
    expect(drawCountdown(at, Date.parse('2026-11-30T16:00:00Z'))).toBe(
      'Drawing…',
    );
  });

  it('says Drawing… only once the draw time has come', () => {
    expect(drawCountdown(at, Date.parse(at) - 400)).toBe('0m 01s');
    expect(drawCountdown(at, Date.parse(at))).toBe('Drawing…');
  });
});

describe('ENTER_REFUSAL_COPY', () => {
  it('has copy for every refusal the enter route can send', () => {
    for (const reason of ENTER_REFUSALS) {
      expect(ENTER_REFUSAL_COPY[reason]).toMatch(/\S/);
    }
    expect(Object.keys(ENTER_REFUSAL_COPY).sort()).toEqual(
      [...ENTER_REFUSALS].sort(),
    );
  });

  it('says exactly what the brief says', () => {
    expect(ENTER_REFUSAL_COPY).toEqual({
      not_found: 'This prize is no longer available.',
      not_open: 'This Lucky Draw has not started yet.',
      closed: 'Entries for this prize are closed.',
      not_enough_tickets: "You don't have that many tickets.",
      no_topup: 'Top up at least once to enter the Lucky Draw.',
    });
  });
});

describe('ticket ranges and the winner', () => {
  const entries = [{ tickets: 50 }, { tickets: 1 }, { tickets: 49 }];

  it('numbers tickets from 0 through the list in its order', () => {
    expect(ticketRanges(entries)).toEqual([
      { start: 0, end: 49 },
      { start: 50, end: 50 },
      { start: 51, end: 99 },
    ]);
  });

  it('finds the entry holding the winning ticket', () => {
    expect(winnerIndex(entries, 0)).toBe(0);
    expect(winnerIndex(entries, 49)).toBe(0);
    expect(winnerIndex(entries, 50)).toBe(1);
    expect(winnerIndex(entries, 99)).toBe(2);
  });

  it('has no winner without a ticket index or past the last ticket', () => {
    expect(winnerIndex(entries, null)).toBe(-1);
    expect(winnerIndex(entries, 100)).toBe(-1);
    expect(winnerIndex([], 0)).toBe(-1);
  });
});

describe('wheelSegments', () => {
  it('sizes each segment by its tickets, in list order', () => {
    const segs = wheelSegments([{ tickets: 3 }, { tickets: 1 }], 0);
    expect(segs).toEqual([
      { a0: 0, a1: 270, index: 0 },
      { a0: 270, a1: 360, index: 1 },
    ]);
  });

  it('merges the smallest into one filler arc above the cap, never the winner', () => {
    // Six entrants, cap 4: the winner (smallest of all, keeps its own span)
    // and the two biggest stay; the rest become one filler arc at the end.
    const entries = [
      { tickets: 10 },
      { tickets: 1 }, // winner
      { tickets: 2 },
      { tickets: 30 },
      { tickets: 3 },
      { tickets: 54 },
    ];
    const segs = wheelSegments(entries, 1, 4);
    expect(segs.map((s) => s.index)).toEqual([1, 3, 5, null]);
    const total = 100;
    expect(segs[0]!.a1 - segs[0]!.a0).toBeCloseTo((1 / total) * 360);
    expect(segs[3]!.a1 - segs[3]!.a0).toBeCloseTo(((10 + 2 + 3) / total) * 360);
    expect(segs[segs.length - 1]!.a1).toBeCloseTo(360);
  });

  it('leaves a wheel at or under the cap alone', () => {
    const entries = Array.from({ length: 300 }, () => ({ tickets: 1 }));
    expect(wheelSegments(entries, 7)).toHaveLength(300);
    expect(wheelSegments([...entries, { tickets: 1 }], 7)).toHaveLength(300);
  });
});

describe('landing and the pointer', () => {
  const seg = { a0: 100, a1: 200, index: 0 };

  it('lands inside the middle 56% of the segment', () => {
    expect(landingAngle(seg, 0)).toBeCloseTo(122);
    expect(landingAngle(seg, 1)).toBeCloseTo(178);
  });

  it('reads the segment under the 12 o’clock pointer for a rotation', () => {
    const segs = wheelSegments([{ tickets: 1 }, { tickets: 1 }], 0);
    expect(segmentAt(segs, 0)).toBe(0);
    // Turning the wheel 90° clockwise brings the 270° point under the pointer.
    expect(segmentAt(segs, 90)).toBe(1);
    expect(segmentAt(segs, 360 * 6 + 270)).toBe(0);
    expect(segmentAt(segs, -7)).toBe(0);
  });
});
