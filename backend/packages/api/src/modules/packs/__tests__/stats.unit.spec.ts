import { statsWindows } from '../stats';

// 2026-09-29 16:07 MYT.
const NOW = new Date('2026-09-29T08:07:00.000Z');

const iso = (w: ReturnType<typeof statsWindows>) =>
  w && {
    current: [w.current.from.toISOString(), w.current.to.toISOString()],
    previous: [w.previous.from.toISOString(), w.previous.to.toISOString()],
  };

describe('statsWindows — presets (MYT, previous = same span one period back)', () => {
  it('today runs from MYT midnight to now, against yesterday up to the same time', () => {
    expect(iso(statsWindows('today', NOW))).toEqual({
      current: ['2026-09-28T16:00:00.000Z', '2026-09-29T08:07:00.000Z'],
      previous: ['2026-09-27T16:00:00.000Z', '2026-09-28T08:07:00.000Z'],
    });
  });

  it('yesterday is the whole previous MYT day, against the day before', () => {
    expect(iso(statsWindows('yesterday', NOW))).toEqual({
      current: ['2026-09-27T16:00:00.000Z', '2026-09-28T16:00:00.000Z'],
      previous: ['2026-09-26T16:00:00.000Z', '2026-09-27T16:00:00.000Z'],
    });
  });

  it('7d and 30d include today and shift back by their own length', () => {
    expect(iso(statsWindows('7d', NOW))).toEqual({
      current: ['2026-09-22T16:00:00.000Z', '2026-09-29T08:07:00.000Z'],
      previous: ['2026-09-15T16:00:00.000Z', '2026-09-22T08:07:00.000Z'],
    });
    expect(iso(statsWindows('30d', NOW))).toEqual({
      current: ['2026-08-30T16:00:00.000Z', '2026-09-29T08:07:00.000Z'],
      previous: ['2026-07-31T16:00:00.000Z', '2026-08-30T08:07:00.000Z'],
    });
  });

  it('month to date compares with the same days of last month', () => {
    expect(iso(statsWindows('month', NOW))).toEqual({
      current: ['2026-08-31T16:00:00.000Z', '2026-09-29T08:07:00.000Z'],
      previous: ['2026-07-31T16:00:00.000Z', '2026-08-29T08:07:00.000Z'],
    });
  });

  it('month on the 31st clamps the previous window to the end of a shorter month', () => {
    // 2026-03-31 10:00 MYT: "February 31st" does not exist, so all of February.
    expect(
      iso(statsWindows('month', new Date('2026-03-31T02:00:00.000Z'))),
    ).toEqual({
      current: ['2026-02-28T16:00:00.000Z', '2026-03-31T02:00:00.000Z'],
      previous: ['2026-01-31T16:00:00.000Z', '2026-02-28T16:00:00.000Z'],
    });
  });

  it('last_month is the whole previous calendar month, across a year boundary', () => {
    expect(
      iso(statsWindows('last_month', new Date('2026-01-15T04:00:00.000Z'))),
    ).toEqual({
      current: ['2025-11-30T16:00:00.000Z', '2025-12-31T16:00:00.000Z'],
      previous: ['2025-10-31T16:00:00.000Z', '2025-11-30T16:00:00.000Z'],
    });
  });

  it('uses the MYT calendar day, not the UTC one', () => {
    // 2026-09-30 17:30 UTC is already 1 October 01:30 in MYT.
    const lateUtc = new Date('2026-09-30T17:30:00.000Z');
    expect(statsWindows('today', lateUtc)?.current.from.toISOString()).toBe(
      '2026-09-30T16:00:00.000Z',
    );
    expect(statsWindows('month', lateUtc)?.current.from.toISOString()).toBe(
      '2026-09-30T16:00:00.000Z',
    );
  });
});

describe('statsWindows — custom (inclusive MYT days)', () => {
  it('covers whole days and shifts back by the day count', () => {
    expect(
      iso(statsWindows('custom', NOW, '2026-09-10', '2026-09-11')),
    ).toEqual({
      current: ['2026-09-09T16:00:00.000Z', '2026-09-11T16:00:00.000Z'],
      previous: ['2026-09-07T16:00:00.000Z', '2026-09-09T16:00:00.000Z'],
    });
  });

  it('a single day is a one-day window', () => {
    expect(
      iso(statsWindows('custom', NOW, '2026-09-10', '2026-09-10')),
    ).toEqual({
      current: ['2026-09-09T16:00:00.000Z', '2026-09-10T16:00:00.000Z'],
      previous: ['2026-09-08T16:00:00.000Z', '2026-09-09T16:00:00.000Z'],
    });
  });

  it('a range ending today stops at now', () => {
    expect(
      iso(statsWindows('custom', NOW, '2026-09-28', '2026-09-29')),
    ).toEqual({
      current: ['2026-09-27T16:00:00.000Z', '2026-09-29T08:07:00.000Z'],
      previous: ['2026-09-25T16:00:00.000Z', '2026-09-27T08:07:00.000Z'],
    });
  });

  it.each([
    ['an unknown range', 'forever', undefined, undefined],
    ['a missing date', 'custom', '2026-09-10', undefined],
    ['a reversed range', 'custom', '2026-09-11', '2026-09-10'],
    ['a malformed date', 'custom', '2026-9-1', '2026-09-10'],
    ['a date Date.parse would roll over', 'custom', '2026-02-30', '2026-03-02'],
    ['a start in the future', 'custom', '2026-09-30', '2026-10-01'],
  ])('rejects %s with null', (_label, range, from, to) => {
    expect(statsWindows(range, NOW, from, to)).toBeNull();
  });
});
