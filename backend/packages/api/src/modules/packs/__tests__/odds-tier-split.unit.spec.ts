import { tierSplitForSet } from "../odds-sets";

// The guest demo spin (storefront ?demo=1) rolls whatever this returns for set
// 3, and it is the only odds data derived from the SECRET per-card weights that
// the store route publishes — so the aggregation is pinned here rather than
// only through the http suite.

describe("tierSplitForSet", () => {
  it("aggregates weights per rarity as 2dp percentages", () => {
    const split = tierSplitForSet(
      [
        { rarity: "Common", weight: 5000, weight_2: null, weight_3: null },
        { rarity: "Rare", weight: 3000, weight_2: null, weight_3: null },
        { rarity: "Rare", weight: 1000, weight_2: null, weight_3: null },
        { rarity: "Legendary", weight: 1000, weight_2: null, weight_3: null },
      ],
      1,
    );
    expect(split).toEqual({ Common: 50, Rare: 40, Legendary: 10 });
  });

  // Set 3 inherits PER CARD (3 → 2 → 1), the same chain a set-3 player's spin
  // resolves — a demo that read `weight` alone would show set 1's distribution.
  it("resolves each card through the set-3 fallback chain", () => {
    const rows = [
      { rarity: "Common", weight: 5000, weight_2: null, weight_3: null }, // → 5000
      { rarity: "Rare", weight: 3000, weight_2: 2000, weight_3: null }, // → 2000
      { rarity: "Legendary", weight: 2000, weight_2: null, weight_3: 1000 }, // → 1000
    ];
    expect(tierSplitForSet(rows, 3)).toEqual({
      Common: 62.5,
      Rare: 25,
      Legendary: 12.5,
    });
    // Same rows, set 1: the overrides are ignored and the split differs.
    expect(tierSplitForSet(rows, 1)).toEqual({
      Common: 50,
      Rare: 30,
      Legendary: 20,
    });
  });

  it("skips unpullable rows and buckets a missing rarity as Common", () => {
    expect(
      tierSplitForSet(
        [
          { rarity: null, weight: 3000, weight_2: null, weight_3: null },
          { rarity: "Rare", weight: 1000, weight_2: null, weight_3: null },
          { rarity: "Immortal", weight: 0, weight_2: null, weight_3: null },
        ],
        3,
      ),
    ).toEqual({ Common: 75, Rare: 25 });
  });

  it("returns null when nothing in the pack is pullable", () => {
    expect(tierSplitForSet([], 3)).toBeNull();
    expect(
      tierSplitForSet(
        [{ rarity: "Common", weight: 0, weight_2: null, weight_3: null }],
        3,
      ),
    ).toBeNull();
  });
});
