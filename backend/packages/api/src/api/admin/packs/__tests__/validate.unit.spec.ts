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
      decimals: 2,
    });
  });

  it('rounds tiers to the configured decimals and carries the setting', () => {
    const fine = coercePackBody(
      {
        ...base,
        published_odds: {
          overall: 100,
          tiers: { Legendary: 0.68425 },
          decimals: 4,
        },
      },
      'test-pack',
    ).published_odds;
    expect(fine).toEqual({
      overall: 100,
      tiers: { Legendary: 0.6843 },
      decimals: 4,
    });

    const coarse = coercePackBody(
      {
        ...base,
        published_odds: { overall: 100, tiers: { Legendary: 0.6842 } },
      },
      'test-pack',
    ).published_odds;
    expect(coarse).toEqual({
      overall: 100,
      tiers: { Legendary: 0.68 },
      decimals: 2,
    });
  });

  it('rejects a non-integer or out-of-range decimals', () => {
    for (const decimals of [5, -1, 1.5, '2', {}]) {
      expect(() =>
        coercePackBody(
          { ...base, published_odds: { overall: 100, tiers: {}, decimals } },
          'test-pack',
        ),
      ).toThrow(/published_odds.decimals/);
    }
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

describe('coercePackBody — display_image (optional hero)', () => {
  it('omitted → undefined (keep stored value — deploy-skew safety)', () => {
    expect(coercePackBody(base, 'test-pack').display_image).toBeUndefined();
  });

  it('null / empty → null (explicit clear)', () => {
    expect(
      coercePackBody({ ...base, display_image: null }, 'test-pack')
        .display_image,
    ).toBeNull();
    expect(
      coercePackBody({ ...base, display_image: '  ' }, 'test-pack')
        .display_image,
    ).toBeNull();
  });

  it('accepts http(s) URLs and /storefront paths, trimmed', () => {
    expect(
      coercePackBody(
        { ...base, display_image: ' https://cdn.x/hero.webp ' },
        'test-pack',
      ).display_image,
    ).toBe('https://cdn.x/hero.webp');
    expect(
      coercePackBody(
        { ...base, display_image: '/images/hero.webp' },
        'test-pack',
      ).display_image,
    ).toBe('/images/hero.webp');
  });

  it('rejects non-strings, odd schemes, and protocol-relative URLs', () => {
    expect(() =>
      coercePackBody({ ...base, display_image: 42 }, 'test-pack'),
    ).toThrow(/display_image/);
    expect(() =>
      coercePackBody(
        { ...base, display_image: 'data:image/png;x' },
        'test-pack',
      ),
    ).toThrow(/display_image/);
    expect(() =>
      coercePackBody(
        { ...base, display_image: '//evil.example/x.gif' },
        'test-pack',
      ),
    ).toThrow(/display_image/);
  });
});
