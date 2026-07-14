import { describe, expect, test } from 'vitest';
import {
  HREEL_STRIP_LEN,
  HREEL_WIN_INDEX,
  DECOY_DEXES,
  decoyRarity,
  teaseRarity,
  buildHReelStrip,
  buildPressStrip,
  buildDecoyPool,
  shuffleCells,
  type HReelCell,
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

describe('buildDecoyPool', () => {
  test('a single-species-heavy pack keeps EVERY rarity tier (dedup by dex+rarity, not dex)', () => {
    // Regression: an all-Pikachu/Charizard pack used to collapse to 2 pool
    // entries (first card per dex), so the spin flickered only 2 tier colors.
    const cards = [
      {
        name: 'Charizard [1st Edition] #4',
        pokemonDex: 6,
        rarity: 'Immortal' as const,
      },
      {
        name: 'Pikachu #227/S-P',
        pokemonDex: 25,
        rarity: 'Legendary' as const,
      },
      {
        name: 'Charizard GX #SV49',
        pokemonDex: 6,
        rarity: 'Mythical' as const,
      },
      { name: 'Charizard #4', pokemonDex: 6, rarity: 'Rare' as const },
      { name: 'Pikachu #160', pokemonDex: 25, rarity: 'Uncommon' as const },
      { name: 'Pikachu ex #219', pokemonDex: 25, rarity: 'Common' as const },
    ];
    const pool = buildDecoyPool(cards);
    expect(new Set(pool.map((c) => c.rarity)).size).toBe(6);
  });
  test('drops exact (dex, rarity) duplicates and dex-less cards', () => {
    const pool = buildDecoyPool([
      { name: 'Pikachu #1', pokemonDex: 25, rarity: 'Common' as const },
      { name: 'Pikachu #2', pokemonDex: 25, rarity: 'Common' as const }, // dupe
      { name: 'Trainer Card', pokemonDex: null, rarity: 'Common' as const }, // no dex
    ]);
    expect(pool).toEqual([{ dex: 25, rarity: 'Common' }]);
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
  // `null` is NOT a bad value — it is the idle state, and it never reaches this
  // fallback (buildHReelStrip skips the pin entirely). Its behavior is pinned by
  // the periodicity test below.
  test('out-of-range winner dex falls back to a valid dex', () => {
    for (const bad of [0, 99999]) {
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
  // ReelStrip's idle drift wraps at exactly pool.length cells. That is only
  // seamless if the IDLE strip (winnerDex === null) is a pure tiling of the
  // pool — no winner pin, no tease cell — for ANY winnerRarity the caller
  // happens to pass.
  test('an idle strip (null winner) is exactly periodic over the pool length', () => {
    const packPool = [
      { dex: 201, rarity: 'Immortal' as const },
      { dex: 202, rarity: 'Common' as const },
      { dex: 203, rarity: 'Rare' as const },
    ];
    // Both the pack pool and the curated fallback (empty pool -> DECOY_DEXES).
    for (const pool of [packPool, []]) {
      const period = pool.length > 0 ? pool.length : DECOY_DEXES.length;
      for (const rarity of ['Common', 'Rare', 'Immortal'] as const) {
        const s = buildHReelStrip(
          null,
          rarity,
          HREEL_STRIP_LEN,
          HREEL_WIN_INDEX,
          1,
          pool,
        );
        for (let i = 0; i + period < s.length; i++) {
          expect(s[i + period]).toEqual(s[i]);
        }
        // idle pins nothing: every cell — including winIndex — is a pool dex.
        for (const c of s) expect(c.dex).toBeGreaterThanOrEqual(1);
      }
    }
  });
  test('a real spin still pins the winner and tease (idle purity is null-only)', () => {
    const s = buildHReelStrip(150, 'Rare', HREEL_STRIP_LEN, HREEL_WIN_INDEX);
    expect(s[HREEL_WIN_INDEX]!.dex).toBe(150);
    expect(s[HREEL_WIN_INDEX - 1]!.rarity).toBe('Mythical');
  });
  test('rejects invalid geometry', () => {
    expect(() => buildHReelStrip(1, 'Common', 0, 0)).toThrow(RangeError);
    expect(() => buildHReelStrip(1, 'Common', 10, 10)).toThrow(RangeError);
  });
});

describe('buildPressStrip (press-launched spin strip)', () => {
  const POOL = [
    { dex: 1, rarity: 'Common' },
    { dex: 4, rarity: 'Rare' },
    { dex: 7, rarity: 'Uncommon' },
    { dex: 25, rarity: 'Legendary' },
    { dex: 130, rarity: 'Mythical' },
  ] as const;
  const base = {
    winnerDex: 6,
    winnerRarity: 'Rare',
    winIndex: 30,
    keepCells: 12,
    seed: 1,
    rngSeed: 12345,
    decoyCards: POOL,
  } as const;

  test('cells [0, keepCells) reproduce the idle tiling EXACTLY (seamless press)', () => {
    const idle = buildHReelStrip(null, 'Common', 64, 48, base.seed, POOL);
    const press = buildPressStrip(base);
    for (let i = 0; i < base.keepCells; i++) {
      expect(press[i]).toEqual(idle[i]);
    }
  });

  test('winner pinned at winIndex, tease one cell before it', () => {
    const press = buildPressStrip(base);
    expect(press[base.winIndex]!.dex).toBe(6);
    // Rare teases one tier up (Mythical) at winIndex - 1 (spec §7b).
    expect(press[base.winIndex - 1]!.rarity).toBe('Mythical');
  });

  test('strip covers the landed window (winner + right half + margin)', () => {
    const press = buildPressStrip(base);
    expect(press.length).toBeGreaterThanOrEqual(base.winIndex + 5);
  });

  test('runway is randomized: NOT the periodic 1-2-3 tiling', () => {
    const idle = buildHReelStrip(null, 'Common', 64, 48, base.seed, POOL);
    const press = buildPressStrip(base);
    const runway = press.slice(base.keepCells, base.winIndex - 1);
    const tiled = idle.slice(base.keepCells, base.winIndex - 1);
    expect(runway).not.toEqual(tiled);
    // every runway cell still comes from the pack's own pool
    const dexes = new Set<number>(POOL.map((c) => c.dex));
    for (const c of runway) expect(dexes.has(c.dex)).toBe(true);
  });

  test('no immediate sprite repeats in the runway (no stutter at speed)', () => {
    const press = buildPressStrip({ ...base, winIndex: 60, rngSeed: 99 });
    for (let i = base.keepCells + 1; i < 59; i++) {
      expect(press[i]!.dex).not.toBe(press[i - 1]!.dex);
    }
  });

  test('deterministic per seed, different across spins', () => {
    expect(buildPressStrip(base)).toEqual(buildPressStrip(base));
    expect(buildPressStrip(base)).not.toEqual(
      buildPressStrip({ ...base, rngSeed: 54321 }),
    );
  });

  test('null/garbage winner dex falls back to a pool dex', () => {
    const press = buildPressStrip({ ...base, winnerDex: null });
    expect(press[base.winIndex]!.dex).toBe(POOL[0].dex);
  });

  test('rejects invalid geometry', () => {
    expect(() => buildPressStrip({ ...base, winIndex: 0 })).toThrow(RangeError);
    expect(() => buildPressStrip({ ...base, keepCells: 30 })).toThrow(
      RangeError,
    );
  });
});

describe('buildPressStrip edge cases', () => {
  test("the winner's neighbors never duplicate the winner's sprite", () => {
    // Regression: the winner used to be overwritten AFTER the runway roll, so
    // the anti-repeat reroll never saw it — winIndex±1 could double the
    // winner's sprite right at the landing. Winner dex IS in the pool here, so
    // without the inline pin + neighbor block this fails for some seeds.
    const pool = [
      { dex: 25, rarity: 'Common' },
      { dex: 4, rarity: 'Rare' },
      { dex: 7, rarity: 'Uncommon' },
    ] as const;
    for (let rngSeed = 1; rngSeed <= 40; rngSeed++) {
      const press = buildPressStrip({
        winnerDex: 25,
        winnerRarity: 'Rare',
        winIndex: 30,
        keepCells: 12,
        seed: 1,
        rngSeed,
        decoyCards: pool,
      });
      expect(press[30]!.dex).toBe(25);
      expect(press[29]!.dex).not.toBe(25);
      expect(press[31]!.dex).not.toBe(25);
    }
  });

  test('pool of 1: builds the full strip, duplicates allowed (bounded reroll)', () => {
    const one = [{ dex: 25, rarity: 'Common' }] as const;
    const press = buildPressStrip({
      winnerDex: 6,
      winnerRarity: 'Common',
      winIndex: 30,
      keepCells: 12,
      seed: 1,
      rngSeed: 7,
      decoyCards: one,
    });
    expect(press).toHaveLength(30 + Math.ceil(9 / 2) + 2);
    press.forEach((c, i) => {
      if (i !== 30) expect(c.dex).toBe(25);
    });
    expect(press[30]!.dex).toBe(6);
  });
});

describe('shuffleCells', () => {
  // Tiny deterministic LCG so tests never depend on Math.random.
  const seededRand = (seed: number) => {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };
  const pool: HReelCell[] = [
    { dex: 1, rarity: 'Common' },
    { dex: 4, rarity: 'Rare' },
    { dex: 7, rarity: 'Mythical' },
    { dex: 25, rarity: 'Immortal' },
    { dex: 143, rarity: 'Uncommon' },
    { dex: 130, rarity: 'Legendary' },
  ];
  const key = (c: HReelCell) => `${c.dex}:${c.rarity}`;

  test('preserves length and multiset (same cells, reordered)', () => {
    const out = shuffleCells(pool, seededRand(42));
    expect(out).toHaveLength(pool.length);
    expect(out.map(key).sort()).toEqual(pool.map(key).sort());
  });

  test('does not mutate its input', () => {
    const copy = pool.map((c) => ({ ...c }));
    shuffleCells(pool, seededRand(7));
    expect(pool).toEqual(copy);
  });

  test('is deterministic under an injected rng', () => {
    const a = shuffleCells(pool, seededRand(123));
    const b = shuffleCells(pool, seededRand(123));
    expect(a).toEqual(b);
  });

  test('actually reorders (some seed produces a different order)', () => {
    const orders = [1, 2, 3, 4, 5].map((s) =>
      shuffleCells(pool, seededRand(s)).map(key).join('|'),
    );
    const original = pool.map(key).join('|');
    expect(orders.some((o) => o !== original)).toBe(true);
  });

  test('handles empty and single-element pools', () => {
    expect(shuffleCells([], seededRand(1))).toEqual([]);
    expect(shuffleCells([pool[0]!], seededRand(1))).toEqual([pool[0]]);
  });
});
