import { describe, expect, test } from 'vitest';
import {
  HREEL_STRIP_LEN,
  HREEL_WIN_INDEX,
  DECOY_DEXES,
  decoyRarity,
  teaseRarity,
  buildHReelStrip,
} from '@/lib/hreel';

describe('decoyRarity', () => {
  test('cycles the full 6-tier palette (varied flicker)', () => {
    const seen = new Set(Array.from({ length: 12 }, (_, i) => decoyRarity(i)));
    expect(seen.size).toBe(6);
  });
});

describe('teaseRarity (spec §7b gating)', () => {
  test('a Common win gets NO faked near-miss', () => {
    expect(teaseRarity('Common')).toBeNull();
  });
  test('a mid win teases ONE tier up', () => {
    expect(teaseRarity('Uncommon')).toBe('Rare');
    expect(teaseRarity('Rare')).toBe('Mythical');
  });
  test('a top win teases its own tier (the prize approaches, then lands)', () => {
    expect(teaseRarity('Mythical')).toBe('Mythical');
    expect(teaseRarity('Legendary')).toBe('Legendary');
    expect(teaseRarity('Immortal')).toBe('Immortal');
  });
});

describe('buildHReelStrip', () => {
  test('pins the winner dex at the win index', () => {
    const s = buildHReelStrip(150, 'Rare', HREEL_STRIP_LEN, HREEL_WIN_INDEX);
    expect(s).toHaveLength(HREEL_STRIP_LEN);
    expect(s[HREEL_WIN_INDEX]!.dex).toBe(150);
  });
  test('decoys come from a small but varied dex pool (slot symbol set)', () => {
    const s = buildHReelStrip(150, 'Rare', HREEL_STRIP_LEN, HREEL_WIN_INDEX);
    const decoyDexes = new Set(
      s.filter((_, i) => i !== HREEL_WIN_INDEX).map((c) => c.dex),
    );
    expect(decoyDexes.size).toBeLessThanOrEqual(12); // small fixed symbol set
    expect(decoyDexes.size).toBeGreaterThanOrEqual(8); // still varied
  });
  test('decoys are drawn ONLY from the supplied pack pool — dex AND rarity paired', () => {
    const pool = [
      { dex: 201, rarity: 'Immortal' as const },
      { dex: 202, rarity: 'Common' as const },
    ];
    // 'Common' winner → teaseRarity is null → NO tease cell overriding a
    // rarity, so every non-winner cell keeps its card's own pool rarity.
    const s = buildHReelStrip(
      150,
      'Common',
      HREEL_STRIP_LEN,
      HREEL_WIN_INDEX,
      0,
      pool,
    );
    const rarityByDex = new Map(pool.map((c) => [c.dex, c.rarity]));
    for (let i = 0; i < s.length; i++) {
      if (i === HREEL_WIN_INDEX) continue; // winner is the real reward dex
      expect(rarityByDex.has(s[i]!.dex)).toBe(true); // only pack dexes
      expect(s[i]!.rarity).toBe(rarityByDex.get(s[i]!.dex)); // each dex keeps ITS rarity
    }
  });
  test("a top-tier win keeps EVERY cell within the pack's rarities", () => {
    // A pack of only Immortal + Common: for a top-tier win, every cell stays in
    // {Immortal, Common} — decoys keep their card's own tier, and the §7b tease
    // of a top win is its OWN (in-pack) tier. (Caveat: a MID-tier win in a
    // gappy-rarity pack CAN briefly tint the winIndex-1 tease one tier up — the
    // deliberate spec §7b anticipation exception, covered by the tease tests
    // above, not a phantom DECOY color.)
    const pool = [
      { dex: 150, rarity: 'Immortal' as const },
      { dex: 743, rarity: 'Common' as const },
    ];
    const s = buildHReelStrip(
      150,
      'Immortal',
      HREEL_STRIP_LEN,
      HREEL_WIN_INDEX,
      0,
      pool,
    );
    const allowed = new Set<string>(pool.map((c) => c.rarity));
    for (const cell of s) expect(allowed.has(cell.rarity)).toBe(true);
  });
  test('an empty pool falls back to the curated decoy set (never broken images)', () => {
    const s = buildHReelStrip(
      150,
      'Rare',
      HREEL_STRIP_LEN,
      HREEL_WIN_INDEX,
      0,
      [],
    );
    for (let i = 0; i < s.length; i++) {
      if (i === HREEL_WIN_INDEX) continue;
      expect(DECOY_DEXES).toContain(s[i]!.dex);
    }
  });
  test('the winner cell carries a DECOY color, never spoiling the real tier', () => {
    // Pool of only Common; a Legendary win must NOT put Legendary on the winner
    // cell in the strip data (ReelStrip paints the real color at settle).
    const s = buildHReelStrip(
      150,
      'Legendary',
      HREEL_STRIP_LEN,
      HREEL_WIN_INDEX,
      0,
      [{ dex: 150, rarity: 'Common' as const }],
    );
    expect(s[HREEL_WIN_INDEX]!.rarity).toBe('Common');
    expect(s[HREEL_WIN_INDEX]!.rarity).not.toBe('Legendary');
  });
  test('places the gated near-miss tease at winIndex-1', () => {
    const rare = buildHReelStrip(9, 'Rare', HREEL_STRIP_LEN, HREEL_WIN_INDEX);
    expect(rare[HREEL_WIN_INDEX - 1]!.rarity).toBe('Mythical'); // one tier up
    const common = buildHReelStrip(
      9,
      'Common',
      HREEL_STRIP_LEN,
      HREEL_WIN_INDEX,
    );
    // Common → no faked tease → the cell keeps its normal decoy color.
    expect(common[HREEL_WIN_INDEX - 1]!.rarity).toBe(
      decoyRarity((HREEL_WIN_INDEX - 1) % DECOY_DEXES.length),
    );
  });
  test('different seeds produce different decoy strips (independent reels)', () => {
    const a = buildHReelStrip(150, 'Rare', HREEL_STRIP_LEN, HREEL_WIN_INDEX, 0);
    const b = buildHReelStrip(150, 'Rare', HREEL_STRIP_LEN, HREEL_WIN_INDEX, 1);
    // the real winner is identical across strips...
    expect(a[HREEL_WIN_INDEX]!.dex).toBe(b[HREEL_WIN_INDEX]!.dex);
    // ...but the decoy dexes and/or colors differ somewhere
    const dexDiffers = a.some(
      (c, i) => i !== HREEL_WIN_INDEX && c.dex !== b[i]!.dex,
    );
    const colorDiffers = a.some((c, i) => c.rarity !== b[i]!.rarity);
    expect(dexDiffers || colorDiffers).toBe(true);
  });
  test('null / out-of-range winner dex falls back to a valid dex', () => {
    for (const bad of [null, 0, 99999]) {
      const s = buildHReelStrip(
        bad,
        'Common',
        HREEL_STRIP_LEN,
        HREEL_WIN_INDEX,
      );
      const w = s[HREEL_WIN_INDEX]!.dex;
      expect(w).toBeGreaterThanOrEqual(1);
      expect(w).toBeLessThanOrEqual(1025);
    }
  });
  test('rejects invalid geometry', () => {
    expect(() => buildHReelStrip(1, 'Common', 0, 0)).toThrow(RangeError);
    expect(() => buildHReelStrip(1, 'Common', 10, 10)).toThrow(RangeError);
  });
});
