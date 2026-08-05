import { demoTierSplit, tierSplitForSet } from "../odds-sets";

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

  // A tier that rounds to 0.00% would be UNREACHABLE for a consumer sampling on
  // these numbers (the demo spin parses 0 as "never draw"), while a real spin
  // pulls it fine. Only bites on pools big enough to push a tier under 0.005%.
  it("floors a pullable tier at 0.01% instead of rounding it away", () => {
    const split = tierSplitForSet(
      [
        { rarity: "Common", weight: 1_000_000, weight_2: null, weight_3: null },
        { rarity: "Immortal", weight: 1, weight_2: null, weight_3: null },
      ],
      3,
    );
    expect(split?.Immortal).toBe(0.01);
  });
});

// The publishable wrapper. Set 3 is the only set the demo may disclose; a pack
// whose set 3 was never authored resolves (3→2→1) to SET 1 — what the default
// group and every ungrouped player really roll — so it must publish nothing.
describe("demoTierSplit", () => {
  const untouched = [
    { rarity: "Common", weight: 9000, weight_2: null, weight_3: null },
    { rarity: "Rare", weight: 1000, weight_2: null, weight_3: null },
  ];

  it("withholds the split when set 3 was never authored", () => {
    expect(tierSplitForSet(untouched, 3)).toEqual({ Common: 90, Rare: 10 });
    expect(demoTierSplit(untouched)).toBeNull();
  });

  // Same numbers reached deliberately, not by inheritance, are still withheld:
  // the bound is "must differ from what default players roll", and an operator
  // who mirrored set 1 into set 3 loses nothing but the demo's set-3 draw.
  it("withholds a set 3 authored to equal set 1", () => {
    expect(
      demoTierSplit([
        { rarity: "Common", weight: 9000, weight_2: null, weight_3: 9000 },
        { rarity: "Rare", weight: 1000, weight_2: null, weight_3: 1000 },
      ]),
    ).toBeNull();
  });

  it("publishes a set 3 that differs from set 1", () => {
    expect(
      demoTierSplit([
        { rarity: "Common", weight: 9000, weight_2: null, weight_3: 5000 },
        { rarity: "Rare", weight: 1000, weight_2: null, weight_3: 5000 },
      ]),
    ).toEqual({ Common: 50, Rare: 50 });
  });

  // Set 3 inheriting an authored SET 2 is still a real set-3 configuration —
  // that IS this pack's set 3, and it differs from what default players roll.
  it("publishes a set 3 inherited from an authored set 2", () => {
    expect(
      demoTierSplit([
        { rarity: "Common", weight: 9000, weight_2: 2500, weight_3: null },
        { rarity: "Rare", weight: 1000, weight_2: 7500, weight_3: null },
      ]),
    ).toEqual({ Common: 25, Rare: 75 });
  });

  it("returns null when nothing is pullable", () => {
    expect(demoTierSplit([])).toBeNull();
  });
});
