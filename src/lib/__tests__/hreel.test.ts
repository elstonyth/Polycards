import { describe, expect, test } from 'vitest';
import {
  HREEL_STRIP_LEN,
  HREEL_WIN_INDEX,
  HREEL_VISIBLE_CELLS,
  HREEL_IDLE_BASE_INDEX,
  HREEL_IDLE_POOL_MAX,
  DECOY_DEXES,
  NEUTRAL_CARD_SPRITE,
  decoyRarity,
  teaseRarity,
  buildHReelStrip,
  buildPressStrip,
  buildDecoyPool,
  buildIdlePool,
  idleDriftFits,
  shuffleCells,
  type HReelCell,
} from '@/lib/hreel';
import { TICKET_ART, ticketCard } from '@/lib/packs-data';

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
        spriteImage: null,
        rarity: 'Immortal' as const,
      },
      {
        name: 'Pikachu #227/S-P',
        pokemonDex: 25,
        spriteImage: null,
        rarity: 'Legendary' as const,
      },
      {
        name: 'Charizard GX #SV49',
        pokemonDex: 6,
        spriteImage: null,
        rarity: 'Mythical' as const,
      },
      {
        name: 'Charizard #4',
        pokemonDex: 6,
        spriteImage: null,
        rarity: 'Rare' as const,
      },
      {
        name: 'Pikachu #160',
        pokemonDex: 25,
        spriteImage: null,
        rarity: 'Uncommon' as const,
      },
      {
        name: 'Pikachu ex #219',
        pokemonDex: 25,
        spriteImage: null,
        rarity: 'Common' as const,
      },
    ];
    const pool = buildDecoyPool(cards);
    expect(new Set(pool.map((c) => c.rarity)).size).toBe(6);
  });
  test('drops exact (dex, rarity) duplicates and dex-less cards', () => {
    const pool = buildDecoyPool([
      {
        name: 'Pikachu #1',
        pokemonDex: 25,
        spriteImage: null,
        rarity: 'Common' as const,
      },
      // dupe
      {
        name: 'Pikachu #2',
        pokemonDex: 25,
        spriteImage: null,
        rarity: 'Common' as const,
      },
      // no dex
      {
        name: 'Trainer Card',
        pokemonDex: null,
        spriteImage: null,
        rarity: 'Common' as const,
      },
    ]);
    expect(pool).toEqual([{ dex: 25, rarity: 'Common' }]);
  });
  test('a One Piece pack flickers its own custom sprites, never the Pokémon fallback', () => {
    // Regression: dex-less custom-sprite cards were skipped, the pool came out
    // empty and the reel fell back to DECOY_DEXES — Pokémon in a One Piece pack.
    const pool = buildDecoyPool(
      [
        {
          name: 'Monkey.D.Luffy OP05-119',
          pokemonDex: null,
          spriteImage: 'https://cdn.example/luffy-gear5.gif',
          rarity: 'Immortal' as const,
        },
        // "Bartholomew Kuma" contains "mew" — must stay Kuma, not Mew (dex 151)
        {
          name: 'Bartholomew Kuma OP07-079',
          pokemonDex: null,
          spriteImage: 'https://cdn.example/kuma.gif',
          rarity: 'Rare' as const,
        },
        // same sprite + rarity → deduped
        {
          name: 'Monkey.D.Luffy OP05-119 Parallel',
          pokemonDex: null,
          spriteImage: 'https://cdn.example/luffy-gear5.gif',
          rarity: 'Immortal' as const,
        },
      ],
      // the slot machine passes the pack's isPokemonPack — false for One Piece
      { pokemon: false },
    );
    expect(pool).toEqual([
      {
        dex: 0,
        rarity: 'Immortal',
        image: 'https://cdn.example/luffy-gear5.gif',
      },
      { dex: 0, rarity: 'Rare', image: 'https://cdn.example/kuma.gif' },
    ]);
  });
});

describe('buildDecoyPool in a non-Pokémon pack (pokemon: false)', () => {
  test('keeps only custom sprites — a Pokémon-dex card is never flickered', () => {
    const pool = buildDecoyPool(
      [
        {
          name: 'Pikachu #25',
          pokemonDex: 25,
          spriteImage: null,
          rarity: 'Common' as const,
        },
        {
          name: 'Roronoa Zoro OP01-025',
          pokemonDex: null,
          spriteImage: 'https://cdn.example/zoro.gif',
          rarity: 'Rare' as const,
        },
      ],
      { pokemon: false },
    );
    expect(pool).toEqual([
      { dex: 0, rarity: 'Rare', image: 'https://cdn.example/zoro.gif' },
    ]);
  });

  test('with nothing to show it falls back to the neutral card-back, never DECOY_DEXES', () => {
    const pool = buildDecoyPool(
      [
        {
          name: 'LeBron James 2003 Topps #221',
          pokemonDex: null,
          spriteImage: null,
          rarity: 'Legendary' as const,
        },
      ],
      { pokemon: false },
    );
    expect(pool.length).toBe(6);
    expect(pool.every((c) => c.image === NEUTRAL_CARD_SPRITE)).toBe(true);
    expect(new Set(pool.map((c) => c.rarity)).size).toBe(6);
    expect(pool.some((c) => DECOY_DEXES.includes(c.dex))).toBe(false);
  });
});

describe('custom-sprite (dex 0 + image) cells through the strip builders', () => {
  const POOL: HReelCell[] = ['a', 'b', 'c'].map((s, i) => ({
    dex: 0,
    rarity: decoyRarity(i),
    image: `https://cdn.example/${s}.gif`,
  }));

  test('the idle tiling keeps every cell’s image', () => {
    const s = buildHReelStrip(null, 'Common', 64, 48, 0, POOL);
    expect(s.every((c) => c.image?.startsWith('https://cdn.example/'))).toBe(
      true,
    );
  });

  test('a press spin pins the winner image and never doubles a sprite', () => {
    const press = buildPressStrip({
      winnerDex: null,
      winnerImage: 'https://cdn.example/b.gif',
      winnerRarity: 'Legendary',
      winIndex: 40,
      keepCells: 12,
      seed: 0,
      rngSeed: 7,
      decoyCards: POOL,
    });
    expect(press[40]).toEqual({
      dex: 0,
      rarity: 'Legendary',
      image: 'https://cdn.example/b.gif',
    });
    expect(press.every((c) => c.image !== undefined)).toBe(true);
    // All cells are dex 0: the repeat checks must compare the IMAGE, or every
    // neighbour pair would count as a repeat (or none would).
    for (let i = 1; i < press.length; i++) {
      expect(press[i]!.image).not.toBe(press[i - 1]!.image);
    }
  });

  test('a seeded-linked winner (dex + image) never lands beside its own species', () => {
    // The winner carries its hosted sprite URL AND its dex; decoys of the same
    // Pokémon are dex-only. Identity must be the dex, or Pikachu can land with
    // a Pikachu decoy right beside it.
    const pool: HReelCell[] = [
      { dex: 25, rarity: 'Common' },
      { dex: 6, rarity: 'Rare' },
    ];
    for (let rngSeed = 0; rngSeed < 40; rngSeed++) {
      const press = buildPressStrip({
        winnerDex: 25,
        winnerImage: 'https://cdn.example/pixel/25.gif',
        winnerRarity: 'Common',
        winIndex: 30,
        keepCells: 5,
        seed: 0,
        rngSeed,
        decoyCards: pool,
      });
      expect(press[29]!.dex).not.toBe(25);
      expect(press[31]!.dex).not.toBe(25);
    }
  });
});

describe('HREEL_IDLE_POOL_MAX (frozen-rails regression)', () => {
  test('the cap sits EXACTLY on the drift-fit boundary of the shared guard', () => {
    // ReelStrip disables the idle drift (rails freeze) when idleDriftFits
    // fails. Prod diamond-pack shipped a 78-pair pool and the machine sat
    // dead. The cap must be the LARGEST fitting pool: MAX passes the shared
    // guard, MAX+1 fails it — a smaller (over-conservative) or larger
    // (drift-killing) cap both fail this test.
    expect(idleDriftFits(HREEL_IDLE_POOL_MAX)).toBe(true);
    expect(idleDriftFits(HREEL_IDLE_POOL_MAX + 1)).toBe(false);
  });
  test('buildIdlePool caps an oversized pool to the drift-fit max', () => {
    // The invariant that actually broke prod: a 78-pair pool reaching the
    // reel uncapped. Every idle-cycle pool must come back drift-fittable.
    const big: HReelCell[] = Array.from({ length: 78 }, (_, i) => ({
      dex: i + 1,
      rarity: 'Common',
    }));
    const pool = buildIdlePool(big, () => 0.5);
    expect(pool.length).toBeLessThanOrEqual(HREEL_IDLE_POOL_MAX);
    expect(
      HREEL_IDLE_BASE_INDEX + HREEL_VISIBLE_CELLS + pool.length,
    ).toBeLessThanOrEqual(HREEL_STRIP_LEN);
  });
  test('buildIdlePool is a no-op cap for small pools (bronze stays intact)', () => {
    const small: HReelCell[] = Array.from({ length: 6 }, (_, i) => ({
      dex: i + 1,
      rarity: 'Rare',
    }));
    const pool = buildIdlePool(small, () => 0.5);
    expect(pool).toHaveLength(6);
    // Same cells, reshuffled — nothing dropped.
    expect(new Set(pool.map((c) => c.dex))).toEqual(
      new Set(small.map((c) => c.dex)),
    );
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

describe('review fixes (#842): every card flickers its own sprite', () => {
  test('a Pokémon card with a custom sprite flickers that sprite, not the stock one', () => {
    const pool = buildDecoyPool([
      {
        name: 'Pikachu with Grey Felt Hat',
        pokemonDex: 25,
        spriteImage: '/sprites/pikachu-hat.gif',
        rarity: 'Rare',
      },
      // a variant of the same species in the same tier stays its own decoy
      {
        name: 'Pikachu (Shiny)',
        pokemonDex: 25,
        spriteImage: '/sprites/pikachu-shiny.gif',
        rarity: 'Rare',
      },
      // no custom sprite: the stock dex cell, exactly as before
      { name: 'Charizard', pokemonDex: 6, spriteImage: null, rarity: 'Rare' },
    ]);
    expect(pool).toEqual([
      { dex: 25, rarity: 'Rare', image: '/sprites/pikachu-hat.gif' },
      { dex: 25, rarity: 'Rare', image: '/sprites/pikachu-shiny.gif' },
      { dex: 6, rarity: 'Rare' },
    ]);
  });

  test('a One Piece prize in a Pokémon-allowlisted pack never derives a Pokémon', () => {
    // reward boxes count as Pokémon packs; Kuma's set still says One Piece
    const pool = buildDecoyPool([
      {
        name: 'Bartholomew Kuma',
        set: 'One Piece Wings of the Captain',
        pokemonDex: null,
        spriteImage: null,
        rarity: 'Rare',
      },
    ]);
    expect(pool).toEqual([]);
  });

  test('the neutral card-back reel still spins several tier colours', () => {
    const pool = buildDecoyPool([], { pokemon: false });
    const press = buildPressStrip({
      winnerDex: null,
      winnerImage: NEUTRAL_CARD_SPRITE,
      winnerRarity: 'Rare',
      winIndex: 30,
      keepCells: 12,
      seed: 0,
      rngSeed: 7,
      decoyCards: pool,
    });
    const spun = press.slice(12, 29).map((c) => c.rarity);
    expect(new Set(spun).size).toBeGreaterThan(2);
  });
});

describe('ticket cells', () => {
  test('a tickets-1000 odds row builds a labelled cell', () => {
    expect(
      buildDecoyPool([ticketCard(1000, 'Immortal')], { pokemon: false }),
    ).toEqual([
      { dex: 0, rarity: 'Immortal', image: TICKET_ART, label: 'x1000' },
    ]);
  });

  // Same art, same tier: only the amount tells them apart.
  test('two amounts in one tier stay two cells', () => {
    const pool = buildDecoyPool(
      [ticketCard(10, 'Common'), ticketCard(50, 'Common')],
      { pokemon: false },
    );
    expect(pool.map((c) => c.label)).toEqual(['x10', 'x50']);
  });

  // Admin picks the category, so a ticket pack can sit under Pokémon.
  test('never resolves a Pokémon, even in a Pokémon category', () => {
    expect(buildDecoyPool([ticketCard(5, 'Rare')], { pokemon: true })).toEqual([
      { dex: 0, rarity: 'Rare', image: TICKET_ART, label: 'x5' },
    ]);
  });

  const pool: HReelCell[] = [10, 50, 100, 1000].map((n) => ({
    dex: 0,
    rarity: 'Common',
    image: TICKET_ART,
    label: `x${n}`,
  }));

  test('the press strip pins the winner with its own amount', () => {
    const cells = buildPressStrip({
      winnerDex: null,
      winnerImage: TICKET_ART,
      winnerLabel: 'x1000',
      winnerRarity: 'Immortal',
      winIndex: 40,
      keepCells: 12,
      seed: 0,
      rngSeed: 7,
      decoyCards: pool,
    });
    expect(cells[40]).toEqual({
      dex: 0,
      rarity: 'Immortal',
      image: TICKET_ART,
      label: 'x1000',
    });
    // Every cell shares one image, so the repeat checks must key on the amount.
    expect(cells[39]?.label).not.toBe('x1000');
    expect(cells[41]?.label).not.toBe('x1000');
    for (let i = 13; i < cells.length; i++) {
      expect(cells[i]?.label).not.toBe(cells[i - 1]?.label);
    }
  });

  test('a card winner carries no label', () => {
    const cells = buildPressStrip({
      winnerDex: 25,
      winnerRarity: 'Rare',
      winIndex: 40,
      keepCells: 12,
      seed: 0,
      rngSeed: 7,
    });
    expect(cells[40]).toEqual({ dex: 25, rarity: 'Rare' });
  });
});
