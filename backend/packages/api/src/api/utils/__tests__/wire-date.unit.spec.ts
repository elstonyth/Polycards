import { wireDate, wireDateOrNull } from '../wire-date';

// The whole point of wireDate: typing a response as string must not change
// what res.json sends (ADR 0017).
describe('wireDate', () => {
  const at = new Date('2026-11-15T20:37:16.345Z');

  it('sends a Date as the same JSON a raw Date gives', () => {
    expect(JSON.stringify({ at: wireDate(at) })).toBe(JSON.stringify({ at }));
  });

  it('passes a string through untouched, whatever its format', () => {
    expect(wireDate('2026-11-15 20:37:16.345+00')).toBe(
      '2026-11-15 20:37:16.345+00',
    );
  });

  it('keeps null and turns a missing value into null', () => {
    expect(wireDateOrNull(null)).toBeNull();
    expect(wireDateOrNull(undefined)).toBeNull();
    expect(wireDateOrNull(at)).toBe('2026-11-15T20:37:16.345Z');
  });
});
