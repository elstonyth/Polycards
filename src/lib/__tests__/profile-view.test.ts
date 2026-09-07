import { describe, it, expect } from 'vitest';
import { toProfileView } from '@/lib/profile-view';
import type { PublicProfile } from '@/lib/data/profiles';

describe('toProfileView — tolerates a missing recent array', () => {
  it('does not throw and yields empty activity when recent is absent', () => {
    // PublicProfileSchema is intentionally loose (handle + stats), so a
    // regressed/absent `recent` must degrade gracefully here (empty activity),
    // not crash the async server component with a `.map of undefined` 500.
    const profile = {
      name: 'Ash',
      seed: 1,
      joined_at: '2026-01-01T00:00:00Z',
      stats: { pulls: 0, volume: 0 },
      collection: [],
      // `recent` deliberately omitted
    } as unknown as PublicProfile;

    const view = toProfileView(profile);
    expect(view.activity).toEqual([]);
    expect(view.username).toBe('Ash');
  });

  it('does not throw when recent is present but NOT an array (loose-payload regression)', () => {
    const profile = {
      name: 'Ash',
      seed: 1,
      joined_at: '2026-01-01T00:00:00Z',
      stats: { pulls: 0, volume: 0 },
      collection: [],
      recent: {}, // regressed to a non-array — Array.isArray guard must catch it
    } as unknown as PublicProfile;

    const view = toProfileView(profile);
    expect(view.activity).toEqual([]);
  });
});

// Both card lists go through the one card mapper (card-view.test.ts pins its
// defaults — the raw USD market_value never becoming the RM price, an unknown
// tier degrading to null). What is pinned HERE is only that the profile's own
// fields ride alongside it on both lists.
describe('toProfileView — cards map through toCardView', () => {
  const card = {
    handle: 'c1',
    name: 'Card',
    grader: 'PSA',
    grade: '10',
    image: '/x.webp',
    market_value: 39.99, // raw USD — must never become priceMyr
  };
  const profile = {
    name: 'Ash',
    seed: 1,
    joined_at: '2026-01-01T00:00:00Z',
    stats: { pulls: 1, volume: 0 },
    collection: [{ ...card, marketPriceMyr: 9.99, rarity: 'Legendary' }],
    recent: [{ pack_id: 'p', rarity: 'Rare', rolled_at: '2026-01-02', card }],
  } as unknown as PublicProfile;

  it('a showcased card keeps its grading line beside the mapped view', () => {
    expect(toProfileView(profile).collection[0]).toEqual({
      handle: 'c1',
      name: 'Card',
      image: '/x.webp',
      slabImage: null,
      rarity: 'Legendary',
      priceMyr: 9.99,
      pokemonDex: null,
      spriteImage: null,
      grader: 'PSA',
      grade: '10',
    });
  });

  it('an activity card is the same mapping, unpriced and frameless here', () => {
    const view = toProfileView(profile);
    expect(view.activity?.[0]?.card).toMatchObject({
      handle: 'c1',
      priceMyr: null,
      rarity: null,
      grader: 'PSA',
      grade: '10',
    });
  });
});
