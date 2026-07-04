import { coercePackBody } from '../validate';

// Minimal valid pack body — published_odds cases are layered on top of this.
const base = {
  title: 'Test Pack',
  category: 'pokemon',
  price: 10,
  image: '/images/test.webp',
  buyback_percent: 90,
  boost: false,
  rank: 0,
  status: 'draft',
};

describe('coercePackBody — published_odds', () => {
  it('leaves published_odds undefined when the writer omits it (keep stored)', () => {
    expect(coercePackBody(base, 'test-pack').published_odds).toBeUndefined();
  });

  it('passes an explicit null through (clear)', () => {
    expect(
      coercePackBody({ ...base, published_odds: null }, 'test-pack')
        .published_odds,
    ).toBeNull();
  });

  it('validates and rounds a full object, keeping only known tiers', () => {
    const out = coercePackBody(
      {
        ...base,
        published_odds: {
          overall: 99.999,
          tiers: {
            Immortal: '0.1', // string coerced
            Mythical: 4.5,
            Common: 50,
            Epic: 12, // unknown tier (renamed) — dropped
            bogus: 1, // unknown key — dropped
          },
        },
      },
      'test-pack',
    ).published_odds;
    expect(out).toEqual({
      overall: 100,
      tiers: { Immortal: 0.1, Mythical: 4.5, Common: 50 },
    });
  });

  it('rejects out-of-range percentages', () => {
    expect(() =>
      coercePackBody(
        { ...base, published_odds: { overall: 101, tiers: {} } },
        'test-pack',
      ),
    ).toThrow(/published_odds.overall/);
    expect(() =>
      coercePackBody(
        { ...base, published_odds: { overall: 100, tiers: { Rare: -1 } } },
        'test-pack',
      ),
    ).toThrow(/published_odds.tiers.Rare/);
  });

  it('rejects non-object shapes', () => {
    expect(() =>
      coercePackBody({ ...base, published_odds: 'x' }, 'test-pack'),
    ).toThrow(/published_odds/);
    expect(() =>
      coercePackBody({ ...base, published_odds: { tiers: [] } }, 'test-pack'),
    ).toThrow(/published_odds.tiers/);
  });
});
