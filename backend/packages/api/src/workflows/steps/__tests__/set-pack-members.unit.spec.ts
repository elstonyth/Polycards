import type { MedusaContainer } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../modules/packs';
import { setPackMembersInvoke } from '../set-pack-members';
import { weightForSet, type OddsSet } from '../../../modules/packs/odds-sets';

// set-pack-members under the Common-as-balancer model (POLYCARD-BACK §2.4):
// a membership edit must (1) keep every survivor's pinned rate verbatim,
// (2) let the unlocked Commons re-absorb whatever the edit freed, and
// (3) carry sets 2/3 through — the old computeOdds call rewrote `weight`
// only, so adding/removing a card left a materialized set 2/3 summing to
// something other than 1_000_000.

const PACK = {
  id: 'pack_1',
  slug: 'test-pack',
  status: 'active',
  category: 'standard',
};

type OddsRow = {
  id: string;
  pack_id: string;
  card_id: string | null;
  rarity: string | null;
  weight: number;
  weight_2: number | null;
  weight_3: number | null;
  locked: boolean;
};

type MemberDiff = {
  pack_id: string;
  create: {
    pack_id: string;
    card_id: string;
    rarity: string;
    weight: number;
    weight_2?: number | null;
    weight_3?: number | null;
    locked: boolean;
  }[];
  remove_ids: string[];
  reweigh: {
    id: string;
    weight: number;
    weight_2?: number | null;
    weight_3?: number | null;
  }[];
};

const odd = (
  card_id: string,
  rarity: string,
  weight: number,
  extra: Partial<OddsRow> = {},
): OddsRow => ({
  id: `o_${card_id}`,
  pack_id: PACK.slug,
  card_id,
  rarity,
  weight,
  weight_2: null,
  weight_3: null,
  locked: false,
  ...extra,
});

function buildPacks(existing: OddsRow[]) {
  return {
    listPacks: jest.fn().mockResolvedValue([PACK]),
    listCards: jest.fn(async ({ handle }: { handle: string[] }) =>
      handle.map((h) => ({ handle: h })),
    ),
    listPackOdds: jest.fn().mockResolvedValue(existing),
    applyPackMemberDiff: jest.fn(async (diff: MemberDiff) => ({
      created_ids: diff.create.map((c) => `o_${c.card_id}`),
    })),
  };
}

const buildContainer = (packs: ReturnType<typeof buildPacks>) =>
  ({
    resolve: (key: string) => (key === PACKS_MODULE ? packs : undefined),
  }) as unknown as MedusaContainer;

async function run(existing: OddsRow[], card_ids: string[]) {
  const packs = buildPacks(existing);
  const res = await setPackMembersInvoke(
    { pack_id: PACK.slug, card_ids },
    { container: buildContainer(packs) },
  );
  const diff = packs.applyPackMemberDiff.mock.calls[0][0];
  return { res, packs, diff };
}

/** The rows as they end up in the DB after the diff — for resolved-Σ checks. */
function finalRows(existing: OddsRow[], diff: MemberDiff) {
  const removed = new Set(diff.remove_ids);
  const reweighById = new Map(diff.reweigh.map((r) => [r.id, r]));
  return [
    ...existing
      .filter((o) => !removed.has(o.id))
      .map((o) => ({ ...o, ...(reweighById.get(o.id) ?? {}) })),
    ...diff.create.map((c) => ({
      weight: c.weight,
      weight_2: c.weight_2 ?? null,
      weight_3: c.weight_3 ?? null,
    })),
  ];
}

const resolvedSum = (
  rows: {
    weight: number;
    weight_2?: number | null;
    weight_3?: number | null;
  }[],
  set: OddsSet,
) => rows.reduce((sum, r) => sum + weightForSet(r, set), 0);

describe('set-pack-members — balancer semantics', () => {
  it('(a) a new member joins the balancer pool; pinned survivors keep their rate', async () => {
    const existing = [odd('alpha', 'Rare', 300_000), odd('beta', 'Common', 700_000)];
    const { diff } = await run(existing, ['alpha', 'beta', 'gamma']);

    // gamma enters unlocked/Common → it IS a balancer, so it splits the
    // remainder with beta instead of landing on NEW_MEMBER_WEIGHT.
    expect(diff.create).toEqual([
      expect.objectContaining({
        card_id: 'gamma',
        rarity: 'Common',
        locked: false,
        weight: 350_000,
        weight_2: null,
        weight_3: null,
      }),
    ]);
    // alpha is pinned verbatim (non-Common) → unchanged, so it is not written.
    expect(diff.reweigh).toEqual([
      expect.objectContaining({ id: 'o_beta', weight: 350_000 }),
    ]);
    expect(resolvedSum(finalRows(existing, diff), 1)).toBe(1_000_000);
  });

  it('(b) removing a card re-balances — the unlocked Common absorbs the freed rate', async () => {
    const existing = [
      odd('alpha', 'Rare', 300_000),
      odd('delta', 'Legendary', 200_000),
      odd('beta', 'Common', 500_000),
    ];
    const { diff } = await run(existing, ['alpha', 'beta']);

    expect(diff.remove_ids).toEqual(['o_delta']);
    expect(diff.reweigh).toEqual([
      expect.objectContaining({ id: 'o_beta', weight: 700_000 }),
    ]);
    expect(resolvedSum(finalRows(existing, diff), 1)).toBe(1_000_000);
  });

  it('(c) a survivor keeps its explicit weight_2 and set 2 still resolves to 1_000_000', async () => {
    const existing = [
      odd('alpha', 'Rare', 300_000, { weight_2: 400_000 }),
      odd('beta', 'Common', 700_000, { weight_2: 600_000 }),
    ];
    const { diff } = await run(existing, ['alpha', 'beta', 'gamma']);

    // alpha's explicit 40% set-2 pin rides through untouched.
    expect(diff.reweigh.find((r) => r.id === 'o_alpha')).toBeUndefined();
    expect(diff.reweigh).toEqual([
      expect.objectContaining({
        id: 'o_beta',
        weight: 350_000,
        weight_2: 300_000,
        weight_3: null,
      }),
    ]);
    expect(diff.create[0]).toMatchObject({
      card_id: 'gamma',
      weight: 350_000,
      weight_2: 300_000,
      weight_3: null,
    });
    expect(resolvedSum(finalRows(existing, diff), 2)).toBe(1_000_000);
  });

  it('(d) writes and the compensation snapshot carry both set columns', async () => {
    const existing = [
      odd('alpha', 'Rare', 300_000, { weight_2: 400_000, weight_3: 450_000 }),
      odd('beta', 'Common', 650_000, { weight_2: 550_000, weight_3: 500_000 }),
      odd('delta', 'Legendary', 50_000, { weight_2: 50_000, weight_3: 50_000 }),
    ];
    const { diff, res } = await run(existing, ['alpha', 'beta']);

    expect(diff.reweigh).toEqual([
      { id: 'o_beta', weight: 700_000, weight_2: 600_000, weight_3: 550_000 },
    ]);
    for (const set of [1, 2, 3] as const) {
      expect(resolvedSum(finalRows(existing, diff), set)).toBe(1_000_000);
    }

    const compensate = res.compensateInput;
    expect(compensate?.removed).toEqual([
      {
        pack_id: PACK.slug,
        card_id: 'delta',
        rarity: 'Legendary',
        weight: 50_000,
        weight_2: 50_000,
        weight_3: 50_000,
        locked: false,
      },
    ]);
    expect(compensate?.reweighted).toEqual([
      { id: 'o_alpha', weight: 300_000, weight_2: 400_000, weight_3: 450_000 },
      { id: 'o_beta', weight: 650_000, weight_2: 550_000, weight_3: 500_000 },
    ]);
  });

  it('(e) a row whose set-1 weight is unchanged is still rewritten when its set 2 moved', async () => {
    // Dropping zeta frees nothing in set 1 (it sat at weight 0) but takes an
    // explicit 20% out of set 2 — the balancer's weight_2 must be refreshed or
    // set 2 resolves to 800_000.
    const existing = [
      odd('alpha', 'Rare', 300_000, { weight_2: 300_000 }),
      odd('beta', 'Common', 700_000, { weight_2: 500_000 }),
      odd('zeta', 'Rare', 0, { weight_2: 200_000 }),
    ];
    const { diff } = await run(existing, ['alpha', 'beta']);

    expect(diff.reweigh).toEqual([
      { id: 'o_beta', weight: 700_000, weight_2: 700_000, weight_3: null },
    ]);
    expect(resolvedSum(finalRows(existing, diff), 2)).toBe(1_000_000);
  });

  it('(f) an unbalanceable result is left untouched (operator warning, no writes)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Removing the only unlocked Common leaves pinned rates at 30% — the
      // balancer cannot make that sum to 100, so the reweight is skipped.
      const existing = [
        odd('alpha', 'Rare', 300_000, { weight_2: 400_000 }),
        odd('beta', 'Common', 700_000),
      ];
      const { diff, res } = await run(existing, ['alpha']);

      // Set 1 is left verbatim (the draw is scale-invariant), but alpha's
      // explicit weight_2 is collapsed to NULL so set 2 inherits it — see (g).
      expect(diff.reweigh).toEqual([
        { id: 'o_alpha', weight: 300_000, weight_2: null, weight_3: null },
      ]);
      expect(res.compensateInput?.reweighted).toEqual([
        { id: 'o_alpha', weight: 300_000, weight_2: 400_000, weight_3: null },
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("skipped auto-reweight for 'test-pack'"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('(g) the degraded path cannot strand set 2 at a resolved total of 0', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Both sets are valid before the edit (Σ = 1_000_000 each). Removing alpha
      // takes ALL of set 2's weight with it and leaves pinned Rares at 50% —
      // unbalanceable, so the reweight degrades. Set 1 survives at 500_000 (beta
      // always wins, and the activation guard passes on weight > 0), but beta's
      // stored weight_2 = 0 would leave set 2 totalling 0 → every spin by a
      // set-2 customer fails permanently. Nulling it makes set 2 inherit set 1.
      const existing = [
        odd('alpha', 'Rare', 500_000, { weight_2: 1_000_000 }),
        odd('beta', 'Rare', 500_000, { weight_2: 0 }),
      ];
      const { diff } = await run(existing, ['beta']);

      expect(diff.reweigh).toEqual([
        { id: 'o_beta', weight: 500_000, weight_2: null, weight_3: null },
      ]);
      const rows = finalRows(existing, diff);
      expect(resolvedSum(rows, 1)).toBe(500_000);
      // Not 1_000_000 — the degraded path only promises a ROLLABLE set, and the
      // draw is scale-invariant. Before the fix this was 0.
      expect(resolvedSum(rows, 2)).toBe(500_000);
      expect(resolvedSum(rows, 3)).toBe(500_000);
    } finally {
      warn.mockRestore();
    }
  });
});
