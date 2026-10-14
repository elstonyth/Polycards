import { describe, expect, it } from 'vitest';
import { dayRangeText } from './helpers';

describe('dayRangeText', () => {
  it('names the MYT days a half-open window covers, year once', () => {
    // 1 Oct 00:00 MYT to 14 Oct 13:43 MYT (month to date).
    expect(
      dayRangeText({
        from: '2026-09-30T16:00:00.000Z',
        to: '2026-10-14T05:43:00.000Z',
      }),
    ).toBe('1 Oct – 14 Oct 2026');
  });

  it('a window ending at midnight ends the day before', () => {
    // Last month: 1 Sep 00:00 to 1 Oct 00:00 MYT.
    expect(
      dayRangeText({
        from: '2026-08-31T16:00:00.000Z',
        to: '2026-09-30T16:00:00.000Z',
      }),
    ).toBe('1 Sep – 30 Sep 2026');
  });

  it('one day reads as that day; a year boundary names both years', () => {
    expect(
      dayRangeText({
        from: '2026-10-13T16:00:00.000Z',
        to: '2026-10-14T16:00:00.000Z',
      }),
    ).toBe('14 Oct 2026');
    expect(
      dayRangeText({
        from: '2025-12-27T16:00:00.000Z',
        to: '2026-01-03T16:00:00.000Z',
      }),
    ).toBe('28 Dec 2025 – 3 Jan 2026');
  });
});
