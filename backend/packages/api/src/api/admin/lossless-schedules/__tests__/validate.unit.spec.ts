import { parseLosslessSchedule } from '../validate';

// now is fixed so the "just started" and "already over" edges are exact.
const NOW = Date.parse('2026-10-17T00:00:00Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const body = (over: Record<string, unknown> = {}) => ({
  starts_at: iso(HOUR),
  ends_at: iso(2 * HOUR),
  ...over,
});

const invalid = (raw: unknown) => {
  try {
    parseLosslessSchedule(raw, NOW);
  } catch (e) {
    return e as { type?: string };
  }
  throw new Error('expected parseLosslessSchedule to throw');
};

describe('parseLosslessSchedule', () => {
  it('parses the dates and passes missing pack_slugs through as null (every pack)', () => {
    const out = parseLosslessSchedule(body(), NOW);
    expect(out.startsAt.toISOString()).toBe(iso(HOUR));
    expect(out.endsAt.toISOString()).toBe(iso(2 * HOUR));
    expect(out.packSlugs).toBeNull();
  });

  it('treats an explicit null pack_slugs as every pack', () => {
    expect(parseLosslessSchedule(body({ pack_slugs: null }), NOW).packSlugs).toBeNull();
  });

  it('de-duplicates pack_slugs, keeping first-seen order', () => {
    const out = parseLosslessSchedule(body({ pack_slugs: ['b', 'a', 'b'] }), NOW);
    expect(out.packSlugs).toEqual(['b', 'a']);
  });

  it.each([
    ['null body', null],
    ['missing starts_at', { ends_at: iso(HOUR) }],
    ['missing ends_at', { starts_at: iso(HOUR) }],
    ['non-string starts_at', body({ starts_at: 123 })],
    ['unparsable starts_at', body({ starts_at: 'not a date' })],
    ['unparsable ends_at', body({ ends_at: 'soon' })],
  ])('refuses %s', (_name, raw) => {
    expect(invalid(raw).type).toBe('invalid_data');
  });

  it('refuses ends_at equal to or before starts_at', () => {
    expect(invalid(body({ ends_at: iso(HOUR) })).type).toBe('invalid_data');
    expect(invalid(body({ ends_at: iso(HOUR - 1) })).type).toBe('invalid_data');
  });

  it('refuses a window that is already over (ends_at <= now)', () => {
    expect(
      invalid(body({ starts_at: iso(-HOUR), ends_at: iso(0) })).type,
    ).toBe('invalid_data');
  });

  it('allows a start up to 5 minutes in the past, not 1 ms more', () => {
    expect(
      parseLosslessSchedule(body({ starts_at: iso(-5 * MIN) }), NOW).startsAt.getTime(),
    ).toBe(NOW - 5 * MIN);
    expect(invalid(body({ starts_at: iso(-5 * MIN - 1) })).type).toBe(
      'invalid_data',
    );
  });

  it.each([
    ['an empty list', []],
    ['a non-array', 'pack-a'],
    ['a non-string entry', ['a', 7]],
    ['an empty-string entry', ['a', '']],
  ])('refuses pack_slugs that is %s', (_name, slugs) => {
    expect(invalid(body({ pack_slugs: slugs })).type).toBe('invalid_data');
  });
});
