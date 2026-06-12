import { describe, expect, it } from "vitest";
import { parseChance, sampleRarity, demoDraw } from "../demo-spin";
import type { PackCard, Rarity } from "@/app/claw/packs-data";

// The guest demo spin is theater: a client-side weighted sample over the
// STATIC published odds (never the secret per-card weights). These tests pin
// the weighting math and the tier fallback when the pool lacks a sampled tier.

const ODDS: { rarity: Rarity; chance: string }[] = [
  { rarity: "Legendary", chance: "0.5%" },
  { rarity: "Epic", chance: "4.5%" },
  { rarity: "Rare", chance: "15%" },
  { rarity: "Uncommon", chance: "30%" },
  { rarity: "Common", chance: "50%" },
];

const card = (id: string, rarity: Rarity): PackCard => ({
  id,
  name: id,
  image: `/x/${id}.webp`,
  value: "$10.00",
  rarity,
});

describe("parseChance", () => {
  it("parses percentage strings to numbers", () => {
    expect(parseChance("0.5%")).toBe(0.5);
    expect(parseChance("50%")).toBe(50);
  });

  it("returns 0 for malformed input", () => {
    expect(parseChance("n/a")).toBe(0);
    expect(parseChance("")).toBe(0);
  });
});

describe("sampleRarity", () => {
  it("returns the rarest tier at the bottom of the roll range", () => {
    expect(sampleRarity(ODDS, 0)).toBe("Legendary");
    expect(sampleRarity(ODDS, 0.004)).toBe("Legendary");
  });

  it("crosses tier boundaries at the cumulative published chances", () => {
    // cumulative: 0.5 / 5 / 20 / 50 / 100 (%)
    expect(sampleRarity(ODDS, 0.005)).toBe("Epic");
    expect(sampleRarity(ODDS, 0.049)).toBe("Epic");
    expect(sampleRarity(ODDS, 0.05)).toBe("Rare");
    expect(sampleRarity(ODDS, 0.199)).toBe("Rare");
    expect(sampleRarity(ODDS, 0.2)).toBe("Uncommon");
    expect(sampleRarity(ODDS, 0.5)).toBe("Common");
    expect(sampleRarity(ODDS, 0.999)).toBe("Common");
  });

  it("falls back to the most common tier on a degenerate roll", () => {
    expect(sampleRarity(ODDS, 1)).toBe("Common");
    expect(sampleRarity(ODDS, 1.5)).toBe("Common");
  });
});

describe("demoDraw", () => {
  const pool = [
    card("leg", "Legendary"),
    card("epic-a", "Epic"),
    card("epic-b", "Epic"),
    card("rare", "Rare"),
    card("unc", "Uncommon"),
    // no Common in the pool — mirrors the real mock CARD_POOL
  ];

  it("picks a card of the sampled rarity", () => {
    // rarityRoll 0 → Legendary; cardRoll anywhere → the only legendary
    expect(demoDraw(pool, ODDS, 0, 0.7)?.id).toBe("leg");
  });

  it("picks uniformly among cards of the sampled tier", () => {
    // rarityRoll 0.01 → Epic; two epics — cardRoll selects within the tier
    expect(demoDraw(pool, ODDS, 0.01, 0)?.id).toBe("epic-a");
    expect(demoDraw(pool, ODDS, 0.01, 0.99)?.id).toBe("epic-b");
  });

  it("falls back toward more common tiers when the sampled tier is empty", () => {
    // rarityRoll 0.9 → Common, which the pool lacks → nearest lower tier present
    expect(demoDraw(pool, ODDS, 0.9, 0)?.id).toBe("unc");
  });

  it("falls back toward rarer tiers when nothing more common exists", () => {
    const rareOnly = [card("only", "Legendary")];
    expect(demoDraw(rareOnly, ODDS, 0.9, 0)?.id).toBe("only");
  });

  it("returns null on an empty pool", () => {
    expect(demoDraw([], ODDS, 0.5, 0.5)).toBeNull();
  });

  it("still draws when no pool rarity appears in the published odds", () => {
    const offOdds: { rarity: Rarity; chance: string }[] = [
      { rarity: "Common", chance: "100%" },
    ];
    const pool = [card("only", "Legendary")];
    expect(demoDraw(pool, offOdds, 0.5, 0.5)?.id).toBe("only");
  });
});
