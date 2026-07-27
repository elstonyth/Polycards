import { cardByHandle, isGraded, makeRarityOf, toCardView } from "../card-view";

const card = {
  handle: "pikachu-001",
  name: "Pikachu",
  set: "Base",
  grader: "PSA",
  grade: "10",
  market_value: "0.15",
  image: "/p.png",
  slab_image: null,
};

describe("cardByHandle", () => {
  it("indexes cards by handle", () => {
    const m = cardByHandle([card]);
    expect(m.get("pikachu-001")).toBe(card);
    expect(m.size).toBe(1);
  });
});

describe("isGraded", () => {
  it("treats a non-blank grader as graded", () => {
    expect(isGraded({ grader: "PSA" })).toBe(true);
    expect(isGraded({ grader: " BGS " })).toBe(true);
  });

  // A raw card carries an EMPTY grader (the column is NOT NULL), and a
  // whitespace-only one is the same thing typed sloppily — both must read RAW,
  // or a pack of raw cards reports GRADED.
  it("treats an empty or whitespace-only grader as raw", () => {
    expect(isGraded({ grader: "" })).toBe(false);
    expect(isGraded({ grader: "  " })).toBe(false);
  });
});

describe("makeRarityOf", () => {
  const odds = [{ pack_id: "p1", card_id: "pikachu-001", rarity: "Mythical" }];
  it("looks rarity up by (pack, card) pair", () => {
    const rarityOf = makeRarityOf(odds);
    expect(rarityOf("p1", "pikachu-001")).toBe("Mythical");
  });
  it("defaults missing pairs to Common", () => {
    const rarityOf = makeRarityOf(odds);
    expect(rarityOf("p9", "nope")).toBe("Common");
  });
});

describe("toCardView", () => {
  it("shapes the canonical 8-field card view with money-normalized FMV", () => {
    expect(toCardView(card, "Mythical")).toEqual({
      handle: "pikachu-001",
      name: "Pikachu",
      set: "Base",
      grader: "PSA",
      grade: "10",
      rarity: "Mythical",
      market_value: 0.15,
      image: "/p.png",
      slab_image: null,
    });
  });

  it('passes slab_image through, defaulting to null', () => {
    const base = {
      handle: 'h',
      name: 'N',
      set: 'S',
      grader: 'PSA',
      grade: '9',
      market_value: 10,
      image: '/i.webp',
      slab_image: '/s.webp' as string | null,
    };
    expect(toCardView(base, 'Rare').slab_image).toBe('/s.webp');
    expect(toCardView({ ...base, slab_image: null }, 'Rare').slab_image).toBeNull();
  });
});
