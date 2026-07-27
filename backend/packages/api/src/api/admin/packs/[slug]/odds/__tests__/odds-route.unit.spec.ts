import { GET, coerceOddsEntries } from '../route';
import { clearFxDisplayCache } from '../../../../../../modules/packs/pricing';

// ── coerceOddsEntries ───────────────────────────────────────────────────────
// The POST body gate. Set 1 (`pct`) stays LENIENT (Number(x ?? 0)) — the
// existing admin form and the activation-guard integration spec both rely on
// it. Sets 2/3 are STRICT (number | null) and, critically, an ABSENT key must
// coerce to an EXPLICIT null: computeSetWeights treats `!== null` as "the
// operator set this", so an `undefined` would materialize weight_2/weight_3 on
// every card of every save.

const valid = {
  card_id: 'card-a',
  locked: false,
  pct: 25,
  rarity: 'Rare',
};

describe('coerceOddsEntries — set 2/3 percentages', () => {
  it('keeps explicit per-set percentages (including 0)', () => {
    const [e] = coerceOddsEntries([{ ...valid, pct_2: 40, pct_3: 0 }]);
    expect(e).toEqual({
      card_id: 'card-a',
      locked: false,
      pct: 25,
      rarity: 'Rare',
      pct_2: 40,
      pct_3: 0,
    });
  });

  it('coerces an ABSENT pct_2/pct_3 to an explicit null, never undefined', () => {
    const [e] = coerceOddsEntries([valid]);
    expect(e.pct_2).toBeNull();
    expect(e.pct_3).toBeNull();
    // The keys must exist — `undefined` reads as "explicit" downstream.
    expect('pct_2' in e).toBe(true);
    expect('pct_3' in e).toBe(true);
  });

  it('passes an explicit null through', () => {
    const [e] = coerceOddsEntries([{ ...valid, pct_2: null, pct_3: null }]);
    expect(e.pct_2).toBeNull();
    expect(e.pct_3).toBeNull();
  });

  it('rejects a non-number, non-null pct_2/pct_3', () => {
    expect(() => coerceOddsEntries([{ ...valid, pct_2: 'x' }])).toThrow(/pct_2/);
    // Numeric strings too — the editor must send real numbers.
    expect(() => coerceOddsEntries([{ ...valid, pct_3: '40' }])).toThrow(
      /pct_3/,
    );
    expect(() => coerceOddsEntries([{ ...valid, pct_2: NaN }])).toThrow(/pct_2/);
    expect(() => coerceOddsEntries([{ ...valid, pct_3: {} }])).toThrow(/pct_3/);
  });
});

describe('coerceOddsEntries — ported set-1 validation', () => {
  it('rejects a non-array body', () => {
    expect(() => coerceOddsEntries(undefined)).toThrow(/entries/);
    expect(() => coerceOddsEntries({ entries: [] })).toThrow(/entries/);
  });

  it('rejects a non-object entry', () => {
    expect(() => coerceOddsEntries(['x'])).toThrow(/object/);
    expect(() => coerceOddsEntries([null])).toThrow(/object/);
  });

  it('rejects a missing/non-string card_id or non-boolean locked', () => {
    expect(() => coerceOddsEntries([{ ...valid, card_id: 1 }])).toThrow(
      /card_id/,
    );
    expect(() => coerceOddsEntries([{ ...valid, locked: 'no' }])).toThrow(
      /locked/,
    );
  });

  it('rejects a rarity outside RARITIES', () => {
    expect(() => coerceOddsEntries([{ ...valid, rarity: 'Epic' }])).toThrow(
      /rarity/,
    );
    expect(() => coerceOddsEntries([{ ...valid, rarity: undefined }])).toThrow(
      /rarity/,
    );
  });

  // The workflow's pool guard compares Set SIZES, so a duplicated id passes it
  // and then collides in idByCard — the pack silently persists Σweight ≠ 10000.
  it('rejects a duplicate card_id', () => {
    expect(() =>
      coerceOddsEntries([
        { ...valid, pct: 20 },
        { ...valid, pct: 20, rarity: 'Common' },
      ]),
    ).toThrow(/[Dd]uplicate card_id/);
    // Distinct ids still pass.
    expect(
      coerceOddsEntries([valid, { ...valid, card_id: 'card-b' }]),
    ).toHaveLength(2);
  });

  it('stays lenient on set-1 pct (absent → 0, numeric string coerced)', () => {
    expect(coerceOddsEntries([{ ...valid, pct: undefined }])[0].pct).toBe(0);
    expect(coerceOddsEntries([{ ...valid, pct: '12.5' }])[0].pct).toBe(12.5);
  });
});

// ── GET ─────────────────────────────────────────────────────────────────────

const mkRes = () => {
  const out: { body?: any; status?: number } = {};
  return {
    res: {
      json: (b: any) => {
        out.body = b;
      },
      status: (s: number) => {
        out.status = s;
        return { json: (b: any) => (out.body = b) };
      },
    } as any,
    out,
  };
};

const FX = 4; // clean arithmetic: price = usd × 4 × multiplier

type MockCard = {
  handle: string;
  name?: string;
  image?: string;
  slab_image?: string | null;
  grader?: string;
  market_value?: number;
  market_multiplier?: number | null;
};

const card = (c: MockCard) => ({
  name: `Card ${c.handle}`,
  image: `${c.handle}.webp`,
  slab_image: null,
  grader: '',
  grade: '',
  set: 'Base',
  market_value: 10,
  market_multiplier: null,
  ...c,
});

const odd = (
  card_id: string,
  weight: number,
  weight_2: number | null = null,
  weight_3: number | null = null,
) => ({
  pack_id: 'p',
  card_id,
  rarity: 'Common',
  weight,
  weight_2,
  weight_3,
  locked: false,
  top_hit_order: null,
});

function mkScope(odds: any[], cards: MockCard[], packPrice: number = 25) {
  // One stub answers every resolve() key: the packs module service AND the
  // `query` registration getCardStockByHandle uses (empty graph ⇒ untracked).
  const stub = {
    listPacks: async () => [
      {
        slug: 'p',
        title: 'Pack P',
        category: 'pokemon',
        status: 'active',
        price: packPrice,
      },
    ],
    listPackOdds: async () => odds,
    listCards: async () => cards.map(card),
    listFxRates: async () => [
      { rate: FX, manual_override: false, manual_rate: null },
    ],
    graph: async () => ({ data: [] }),
  };
  return { resolve: () => stub };
}

const runGet = async (odds: any[], cards: MockCard[], packPrice?: number) => {
  const { res, out } = mkRes();
  await GET({ scope: mkScope(odds, cards, packPrice), params: { slug: 'p' } } as any, res);
  return out.body;
};

const byId = (body: any, id: string) =>
  body.odds.find((r: any) => r.card_id === id);

describe('GET /admin/packs/:slug/odds — 3 sets', () => {
  beforeEach(() => clearFxDisplayCache());

  it('resolves pct per set against that set’s OWN total', async () => {
    // a overrides set 2 (8000); b inherits (5000). Set 3 chains off set 2 for
    // both, so its percentages match set 2's — not set 1's.
    const body = await runGet(
      [odd('a', 5000, 8000), odd('b', 5000)],
      [{ handle: 'a' }, { handle: 'b' }],
    );
    const a = byId(body, 'a'),
      b = byId(body, 'b');
    expect([a.pct, b.pct]).toEqual([50, 50]);
    // Σ = 13000 (8000 explicit + 5000 inherited) — the mixed denominator.
    expect([a.pct_2, b.pct_2]).toEqual([61.54, 38.46]);
    expect([a.pct_3, b.pct_3]).toEqual([61.54, 38.46]);
  });

  it('mirrors set 1 when no card materializes set 2/3', async () => {
    const body = await runGet(
      [odd('a', 7000), odd('b', 3000)],
      [{ handle: 'a' }, { handle: 'b' }],
    );
    for (const r of body.odds) {
      expect(r.pct_2).toBe(r.pct);
      expect(r.pct_3).toBe(r.pct);
    }
  });

  it('exposes the RAW nullable set weights', async () => {
    const body = await runGet(
      [odd('a', 5000, 8000, null), odd('b', 5000)],
      [{ handle: 'a' }, { handle: 'b' }],
    );
    expect(byId(body, 'a')).toMatchObject({
      weight: 5000,
      weight_2: 8000,
      weight_3: null,
    });
    expect(byId(body, 'b')).toMatchObject({ weight_2: null, weight_3: null });
  });
});

describe('GET /admin/packs/:slug/odds — price + pack block', () => {
  beforeEach(() => clearFxDisplayCache());

  it('shows the PRICE (FMV × fx × per-card multiplier), not raw FMV', async () => {
    const body = await runGet(
      [odd('a', 5000), odd('b', 5000)],
      [
        { handle: 'a', market_value: 10, market_multiplier: 1.5 }, // 10×4×1.5
        { handle: 'b', market_value: 10, market_multiplier: null }, // ×1.2 default
      ],
    );
    expect(byId(body, 'a').market_value).toBe(60);
    expect(byId(body, 'b').market_value).toBe(48);
  });

  it('returns the pack price for the live RTP readout', async () => {
    const body = await runGet([], [], 19.9);
    expect(body.pack.price).toBe(19.9);
  });

  it('auto-detects the pack group from the loaded cards', async () => {
    const two = [odd('a', 5000), odd('b', 5000)];
    expect(
      (await runGet(two, [{ handle: 'a' }, { handle: 'b' }])).pack.group,
    ).toBe('RAW');
    expect(
      (
        await runGet(two, [
          { handle: 'a', grader: 'PSA' },
          { handle: 'b', grader: ' BGS ' },
        ])
      ).pack.group,
    ).toBe('GRADED');
    expect(
      (
        await runGet(two, [{ handle: 'a', grader: 'PSA' }, { handle: 'b' }])
      ).pack.group,
    ).toBe('MIX');
    // Nothing to infer from — an empty pack has no group.
    expect((await runGet([], [])).pack.group).toBeNull();
  });
});
