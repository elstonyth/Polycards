import { lastMidnightCutoff } from '../procurement-view';

// The to-buy snapshot is served only if taken since the last 12am Malaysia
// time (16:00 UTC); this pins where that boundary falls.
describe('lastMidnightCutoff', () => {
  it('after 12am MYT, is that same 12am', () => {
    expect(
      lastMidnightCutoff(new Date('2026-10-28T16:00:05Z')).toISOString(),
    ).toBe('2026-10-28T16:00:00.000Z');
  });

  it('during the Malaysian day, is the 12am that started it', () => {
    // 2026-10-29 10:00 MYT
    expect(
      lastMidnightCutoff(new Date('2026-10-29T02:00:00Z')).toISOString(),
    ).toBe('2026-10-28T16:00:00.000Z');
  });

  it('a second before 12am MYT, is the previous 12am', () => {
    expect(
      lastMidnightCutoff(new Date('2026-10-28T15:59:59Z')).toISOString(),
    ).toBe('2026-10-27T16:00:00.000Z');
  });

  it('exactly 12am MYT counts as the new day', () => {
    expect(
      lastMidnightCutoff(new Date('2026-10-28T16:00:00Z')).toISOString(),
    ).toBe('2026-10-28T16:00:00.000Z');
  });
});
