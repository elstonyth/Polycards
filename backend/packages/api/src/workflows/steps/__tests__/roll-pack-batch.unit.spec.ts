import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { MedusaContainer } from '@medusajs/framework/types';
import { rollOne, fetchPackData, drawFromData, secureRoll } from '../roll-pack';
import { rollBatch } from '../roll-pack-batch';

// Stub shape matching the fields rollOne reads from PacksModuleService.
// We drive rollOne directly (it's exported) — not the step wrapper — so
// no container is needed.

const PACK = { id: 'pack_1', slug: 'test-pack', status: 'active', price: 5 };

const ODDS = [
  {
    id: 'o1',
    pack_id: 'test-pack',
    card_id: 'pikachu',
    weight: 70,
    rarity: 'common',
  },
  {
    id: 'o2',
    pack_id: 'test-pack',
    card_id: 'charizard',
    weight: 30,
    rarity: 'rare',
  },
];

const CARD_PIKACHU = {
  handle: 'pikachu',
  name: 'Pikachu',
  set: 'Base',
  grader: 'PSA',
  grade: '9',
  market_value: 10,
  image: '/pikachu.webp',
  pokemon_dex: 25,
  sprite_image: '/sprites/25.png',
  slab_image: '/slab-pika.webp',
};

const CARD_CHARIZARD = {
  handle: 'charizard',
  name: 'Charizard',
  set: 'Base',
  grader: 'PSA',
  grade: '10',
  market_value: 500,
  image: '/charizard.webp',
  pokemon_dex: 6,
  sprite_image: '/sprites/6.png',
  slab_image: null,
};

/** Build a minimal PacksModuleService stub with overrideable mocks. */
function buildPacks(overrides?: {
  listPacks?: jest.Mock;
  listPackOdds?: jest.Mock;
  listCards?: jest.Mock;
}) {
  return {
    listPacks: overrides?.listPacks ?? jest.fn().mockResolvedValue([PACK]),
    listPackOdds: overrides?.listPackOdds ?? jest.fn().mockResolvedValue(ODDS),
    listCards:
      overrides?.listCards ?? jest.fn().mockResolvedValue([CARD_PIKACHU]),
  } as unknown as Parameters<typeof rollOne>[0];
}

// ---------------------------------------------------------------------------
// batch-path coverage — tests the fetchPackData + drawFromData helpers that
// rollPackBatchStep calls. The step wrapper itself (createStep) is awkward to
// invoke without a live Medusa container, so we test the underlying helpers
// directly. These helpers ARE the logic the step runs — covering them is
// equivalent to covering the batch path.
// ---------------------------------------------------------------------------

describe('batch path (fetchPackData + drawFromData)', () => {
  it('(a) batch of 3 draws yields 3 independent RolledCard results', async () => {
    const packs = buildPacks({
      listCards: jest.fn().mockResolvedValue([CARD_PIKACHU]),
    });

    const data = await fetchPackData(packs, 'test-pack');
    const results = await Promise.all([
      drawFromData(packs, data.odds, data.totalWeight),
      drawFromData(packs, data.odds, data.totalWeight),
      drawFromData(packs, data.odds, data.totalWeight),
    ]);

    expect(results).toHaveLength(3);
    results.forEach((r) => {
      expect(r).toHaveProperty('handle');
      expect(r).toHaveProperty('rarity');
      expect(r).toHaveProperty('pokemon_dex');
      expect(r).toHaveProperty('sprite_image');
      expect(r).toHaveProperty('slab_image');
    });
  });

  it('(b) fetch-once: listPacks + listPackOdds called ONCE, listCards called N times for N draws', async () => {
    const listPacks = jest.fn().mockResolvedValue([PACK]);
    const listPackOdds = jest.fn().mockResolvedValue(ODDS);
    const listCards = jest.fn().mockResolvedValue([CARD_PIKACHU]);
    const packs = buildPacks({ listPacks, listPackOdds, listCards });

    // Simulate what rollPackBatchStep does: fetch once, draw N times.
    const data = await fetchPackData(packs, 'test-pack');
    for (let i = 0; i < 3; i++) {
      await drawFromData(packs, data.odds, data.totalWeight);
    }

    // Pack-level fetches happen exactly once (Fix 1 — the whole point of the hoisting).
    expect(listPacks).toHaveBeenCalledTimes(1);
    expect(listPackOdds).toHaveBeenCalledTimes(1);
    // Card fetch is per-draw (varies by winner) — 3 draws = 3 listCards calls.
    expect(listCards).toHaveBeenCalledTimes(3);
  });

  it('(c) the roll value deterministically selects the winning odds row', async () => {
    // The draw is now CSPRNG-backed; drawFromData exposes an injectable `roll`
    // (test-only) so selection can be asserted deterministically instead of
    // mocking global Math.random. Odds: pikachu 70, charizard 30 (total 100).
    const listCards = jest
      .fn()
      .mockImplementation(({ handle }: { handle: string }) =>
        Promise.resolve(
          handle === 'pikachu' ? [CARD_PIKACHU] : [CARD_CHARIZARD],
        ),
      );
    const packs = buildPacks({ listCards });
    const data = await fetchPackData(packs, 'test-pack');

    // roll in [0,70) → first row (pikachu); roll in [70,100) → charizard.
    const low = await drawFromData(packs, data.odds, data.totalWeight, 10);
    const high = await drawFromData(packs, data.odds, data.totalWeight, 85);
    expect(low.handle).toBe('pikachu');
    expect(high.handle).toBe('charizard');
    // One card fetch per draw — each drawFromData does its own independent draw.
    expect(listCards).toHaveBeenCalledTimes(2);
  });

  it('fetchPackData throws NOT_FOUND for a missing/inactive pack', async () => {
    const packs = buildPacks({ listPacks: jest.fn().mockResolvedValue([]) });
    await expect(fetchPackData(packs, 'ghost-pack')).rejects.toMatchObject({
      type: MedusaError.Types.NOT_FOUND,
    });
  });

  it('fetchPackData throws NOT_FOUND when pack has no odds rows', async () => {
    const packs = buildPacks({ listPackOdds: jest.fn().mockResolvedValue([]) });
    await expect(fetchPackData(packs, 'test-pack')).rejects.toMatchObject({
      type: MedusaError.Types.NOT_FOUND,
    });
  });
});

// ---------------------------------------------------------------------------
// rollBatch — the batch step's whole body, driven through a stub container.
// createStep returns an opaque step object (not a callable), so the body lives
// in an exported function and the step is a two-line wrapper. That is what lets
// the count guard AND the odds-set resolution be asserted here for real.
// ---------------------------------------------------------------------------

// Set 1 gives pikachu all the weight, set 2 gives it all to charizard, so the
// winner is fully determined by the RESOLVED set — no injected roll needed.
const SET_SPLIT_ODDS = [
  {
    id: 'o1',
    pack_id: 'test-pack',
    card_id: 'pikachu',
    rarity: 'common',
    weight: 10000,
    weight_2: 0,
    weight_3: null,
  },
  {
    id: 'o2',
    pack_id: 'test-pack',
    card_id: 'charizard',
    rarity: 'rare',
    weight: 0,
    weight_2: 10000,
    weight_3: null,
  },
];

/** Stub container: PACKS_MODULE → packs stub, CUSTOMER → group lookup stub. */
function buildContainer(oddsSet?: number) {
  const listCustomerGroups = jest
    .fn()
    .mockResolvedValue(
      oddsSet === undefined ? [] : [{ id: 'cg_1', metadata: { odds_set: oddsSet } }],
    );
  const listPackOdds = jest.fn().mockResolvedValue(SET_SPLIT_ODDS);
  const listPacks = jest.fn().mockResolvedValue([PACK]);
  const listCards = jest
    .fn()
    .mockImplementation(({ handle }: { handle: string }) =>
      Promise.resolve([
        handle === 'pikachu' ? CARD_PIKACHU : CARD_CHARIZARD,
      ]),
    );
  const container = {
    resolve: (key: string) =>
      key === Modules.CUSTOMER
        ? { listCustomerGroups }
        : { listPacks, listPackOdds, listCards },
  } as unknown as MedusaContainer;
  return { container, listCustomerGroups, listPacks, listPackOdds, listCards };
}

describe('rollBatch — customer odds set', () => {
  it('resolves the set ONCE per batch, not once per draw', async () => {
    const { container, listCustomerGroups, listPacks, listPackOdds, listCards } =
      buildContainer(2);

    const cards = await rollBatch(container, {
      pack_id: 'test-pack',
      count: 3,
      customer_id: 'cus_1',
    });

    expect(cards).toHaveLength(3);
    // One group lookup and one odds read for the whole batch; one card fetch per draw.
    expect(listCustomerGroups).toHaveBeenCalledTimes(1);
    expect(listPacks).toHaveBeenCalledTimes(1);
    expect(listPackOdds).toHaveBeenCalledTimes(1);
    expect(listCards).toHaveBeenCalledTimes(3);
  });

  it('every draw in the batch uses the resolved set-2 weights', async () => {
    const { container } = buildContainer(2);
    const cards = await rollBatch(container, {
      pack_id: 'test-pack',
      count: 3,
      customer_id: 'cus_1',
    });
    // Set 2 puts all the weight on charizard — set 1 would give pikachu ×3.
    expect(cards.map((c) => c.handle)).toEqual([
      'charizard',
      'charizard',
      'charizard',
    ]);
  });

  it('a customer in no group draws on set 1', async () => {
    const { container, listCustomerGroups } = buildContainer();
    const cards = await rollBatch(container, {
      pack_id: 'test-pack',
      count: 2,
      customer_id: 'cus_nogroup',
    });
    expect(cards.map((c) => c.handle)).toEqual(['pikachu', 'pikachu']);
    expect(listCustomerGroups).toHaveBeenCalledTimes(1);
  });

  it('an anonymous batch (no customer_id) draws on set 1 without a group lookup', async () => {
    const { container, listCustomerGroups } = buildContainer(2);
    const cards = await rollBatch(container, { pack_id: 'test-pack', count: 2 });
    expect(cards.map((c) => c.handle)).toEqual(['pikachu', 'pikachu']);
    expect(listCustomerGroups).not.toHaveBeenCalled();
  });

  it('rejects a non-positive / non-integer count before any draw (Fix 3)', async () => {
    for (const count of [0, -1, 1.5, Number.NaN]) {
      const { container, listPacks } = buildContainer(2);
      await expect(
        rollBatch(container, { pack_id: 'test-pack', count }),
      ).rejects.toMatchObject({ type: MedusaError.Types.INVALID_DATA });
      expect(listPacks).not.toHaveBeenCalled();
    }
  });
});

describe('rollOne', () => {
  it('returns a RolledCard with pokemon_dex and sprite_image keys', async () => {
    const packs = buildPacks();
    const result = await rollOne(packs, 'test-pack');

    expect(result).toMatchObject({
      handle: 'pikachu',
      name: 'Pikachu',
      rarity: expect.any(String),
      market_value: expect.any(Number),
      // Draw-time pulled-value snapshot: FMV × multiplier (card row carries
      // none → DEFAULT_MARKET_MULTIPLIER 1.2). Pins the stamping expression
      // the recorded-pull-value integration spec assumes.
      recorded_value_usd: 12,
    });
    // These keys MUST exist (even if null) — batch step relies on them.
    expect('pokemon_dex' in result).toBe(true);
    expect('sprite_image' in result).toBe(true);
    expect('slab_image' in result).toBe(true);
  });

  it('sets rarity from the winning odds row (not the card)', async () => {
    const packs = buildPacks({
      listCards: jest
        .fn()
        .mockImplementation(({ handle }: { handle: string }) =>
          Promise.resolve(
            handle === 'pikachu' ? [CARD_PIKACHU] : [CARD_CHARIZARD],
          ),
        ),
    });
    const data = await fetchPackData(packs, 'test-pack');
    // roll=0 → first odds row wins (weight 70 / common). Deterministic via the
    // injectable roll rather than mocking the (now CSPRNG) draw source.
    const result = await drawFromData(packs, data.odds, data.totalWeight, 0);
    expect(result.rarity).toBe('common');
    expect(result.handle).toBe('pikachu');
  });

  it('calling rollOne 3× yields 3 independent RolledCard results', async () => {
    const listCards = jest.fn().mockResolvedValue([CARD_PIKACHU]);
    const packs = buildPacks({ listCards });
    const results = await Promise.all([
      rollOne(packs, 'test-pack'),
      rollOne(packs, 'test-pack'),
      rollOne(packs, 'test-pack'),
    ]);
    expect(results).toHaveLength(3);
    results.forEach((r) => {
      expect(r).toHaveProperty('handle');
      expect(r).toHaveProperty('rarity');
      expect(r).toHaveProperty('pokemon_dex');
      expect(r).toHaveProperty('sprite_image');
      expect(r).toHaveProperty('slab_image');
    });
    // Each rollOne does its own independent draw → one winning-card fetch each.
    expect(listCards).toHaveBeenCalledTimes(3);
  });

  it('throws NOT_FOUND when the pack is inactive/missing', async () => {
    const packs = buildPacks({ listPacks: jest.fn().mockResolvedValue([]) });
    await expect(rollOne(packs, 'ghost-pack')).rejects.toMatchObject({
      type: MedusaError.Types.NOT_FOUND,
    });
  });

  it('throws NOT_FOUND when the pack has no odds rows', async () => {
    const packs = buildPacks({ listPackOdds: jest.fn().mockResolvedValue([]) });
    await expect(rollOne(packs, 'test-pack')).rejects.toMatchObject({
      type: MedusaError.Types.NOT_FOUND,
    });
  });
});

// The CSPRNG that backs the money-determining draw. A predictable/biased RNG
// here would let winning cards (and their FMV/buyback value) be forecast or
// skewed — so this locks in that secureRoll stays an unbiased integer source in
// [0, bound) (crypto.randomInt, no modulo/division bias).
describe('secureRoll', () => {
  it('always returns an integer in [0, bound)', () => {
    for (let i = 0; i < 100_000; i++) {
      const v = secureRoll(10_000);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10_000);
    }
  });

  it('is non-degenerate (not constant) and roughly uniform across quartiles', () => {
    const N = 200_000;
    const bound = 10_000;
    const buckets = [0, 0, 0, 0]; // [0,2500) [2500,5000) [5000,7500) [7500,10000)
    for (let i = 0; i < N; i++) {
      buckets[Math.min(3, Math.floor(secureRoll(bound) / (bound / 4)))]++;
    }
    // Each quartile ~25%. A predictable/degenerate source (always 0, a stuck
    // bit) would collapse a bucket; allow a generous ±3% band.
    for (const count of buckets) {
      expect(count / N).toBeGreaterThan(0.22);
      expect(count / N).toBeLessThan(0.28);
    }
  });

  it('floors a fractional bound and never returns it (randomInt integer-max guard)', () => {
    for (let i = 0; i < 10_000; i++) {
      const v = secureRoll(3.9); // floored to 3 → values in {0,1,2}
      expect([0, 1, 2]).toContain(v);
    }
  });
});
