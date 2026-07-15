import { randomInt } from 'node:crypto';
import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import { pickWonRow } from '../../modules/packs/pick';
import { pageAll } from '../../api/utils/page-all';

// Cryptographically-secure, UNBIASED integer roll in [0, bound). This is a
// money-determining draw (it decides which card — and therefore its FMV/buyback
// value — the customer wins), so it must use a CSPRNG, matching the reward-box
// draw and pack-open ids. crypto.randomInt uses rejection sampling, so unlike
// `randomBytes()/2**48` (division introduces modulo bias — CodeQL
// js/biased-cryptographic-random) every value in [0, bound) is exactly equally
// likely. Pack weights are normalized to integer basis points (Σweight = 10000),
// so `bound` is an integer in practice; floor guards a legacy fractional total
// (randomInt requires an integer max) and Math.max(1, …) guards the lower edge
// (fetchPackData already throws on totalWeight <= 0). A roll in [0, bound) is
// always < Σweight, so pickWonRow's last-row fallback is a pure safety net.
// Exported for a direct range/distribution unit test — not called from any
// route; production draws always use the default below.
export function secureRoll(bound: number): number {
  return randomInt(Math.max(1, Math.floor(bound)));
}

type RollPackInput = {
  pack_id: string; // = Pack.slug
  // customer_id is carried on the workflow input but unused here — the roll is
  // anonymous; the authenticated id is attached when the pull is recorded.
  customer_id?: string;
};

// Plain, JSON-safe winner shape. market_value is a BigNumber on the Card model;
// it is normalized to a number HERE so no ORM instance / BigNumber crosses the
// workflow boundary (StepResponse → transform → WorkflowResponse all serialize).
// rarity comes from the WINNING PackOdds row — it is the tier the card has in
// THIS pack, not a card property.
export type RolledCard = {
  handle: string;
  name: string;
  set: string;
  grader: string;
  grade: string;
  rarity: string;
  market_value: number;
  image: string;
  pokemon_dex: number | null;
  sprite_image: string | null;
  slab_image: string | null;
};

// A PackOdds row narrowed to a card row (card_id non-null). The normal pack
// draw only ever rolls cards — reward rows are filtered out in fetchPackData.
type PackOddsRow = Awaited<
  ReturnType<PacksModuleService['listPackOdds']>
>[number];
type CardOddsRow = Omit<PackOddsRow, 'card_id'> & { card_id: string };

// Shared return shape from fetchPackData — carries the static pack/odds state
// that is safe to fetch once and reuse across N independent draws.
export type PackData = {
  pack: Awaited<ReturnType<PacksModuleService['listPacks']>>[number];
  odds: CardOddsRow[];
  totalWeight: number;
};

// fetchPackData — fetches and validates the pack + odds ONCE.
// Call this before a draw loop so listPacks + listPackOdds run only once per
// batch regardless of count. The validations (active check, empty odds, zero
// weight) all belong here — they are pack-level invariants, not per-draw logic.
// The odds read is PAGED (pageAll), not take:1000: a pack may hold 2000+ card
// rows, and a bare cap would make cards past the 1000th unwinnable AND compute
// totalWeight over a truncated pool (skewing every published odds ratio). The
// read runs once per batch, so paging cost is amortized across all draws.
export async function fetchPackData(
  packs: PacksModuleService,
  packId: string,
): Promise<PackData> {
  const [pack] = await packs.listPacks(
    { slug: packId, status: 'active' },
    { take: 1 },
  );
  if (!pack)
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Pack '${packId}' is not available.`,
    );
  // reward_box packs are internal draw pools — never openable via the normal pack path (B2).
  if (pack.category === 'reward_box')
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Pack '${packId}' is not available.`,
    );
  const allOdds = await pageAll((opts) =>
    packs.listPackOdds({ pack_id: packId }, opts),
  );
  // Normal pack draw rolls cards only — drop reward rows (card_id null). This
  // narrows card_id/rarity to string and keeps totalWeight over the card pool.
  const odds = allOdds.filter((o): o is CardOddsRow => o.card_id != null);
  if (odds.length === 0)
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Pack '${packId}' has no odds configured.`,
    );
  const totalWeight = odds.reduce((sum, o) => sum + o.weight, 0);
  if (totalWeight <= 0)
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `Pack '${packId}' has invalid odds.`,
    );
  return { pack, odds, totalWeight };
}

// drawFromData — performs ONE independent weighted draw from pre-fetched pack data.
// This is the per-roll logic: a fresh CSPRNG draw per call ensures draw independence.
// listCards is intentionally kept HERE (not hoisted) because it fetches the
// specific card that WAS won — it varies per roll and must stay per-draw.
// `roll` defaults to a fresh CSPRNG value in [0, totalWeight); it is injectable
// ONLY so tests can force a specific winner deterministically — production always
// uses the secure default (there is no caller-supplied roll on any real path).
export async function drawFromData(
  packs: PacksModuleService,
  odds: PackData['odds'],
  totalWeight: number,
  roll: number = secureRoll(totalWeight),
): Promise<RolledCard> {
  const won = pickWonRow(odds, roll);
  const [card] = await packs.listCards({ handle: won.card_id }, { take: 1 });
  if (!card)
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Card '${won.card_id}' not found.`,
    );
  return {
    handle: card.handle,
    name: card.name,
    set: card.set,
    grader: card.grader,
    grade: card.grade,
    // Card rows always carry a rarity; default to Common to match the lookup
    // fallback used everywhere else (makeRarityOf) if a row ever lacks one.
    rarity: won.rarity ?? 'Common',
    market_value: Number(card.market_value),
    image: card.image,
    pokemon_dex: card.pokemon_dex ?? null,
    sprite_image: card.sprite_image ?? null,
    slab_image: card.slab_image ?? null,
  };
}

// rollOne — convenience wrapper: fetch pack data + draw once.
// Single-open (rollPackStep) uses this so its behavior stays byte-identical to
// before the refactor — same validations, same draw algorithm, same errors.
// Batch callers should call fetchPackData once, then drawFromData N times.
export async function rollOne(
  packs: PacksModuleService,
  packId: string,
): Promise<RolledCard> {
  const d = await fetchPackData(packs, packId);
  return drawFromData(packs, d.odds, d.totalWeight);
}

// roll-pack — read-only step: validate the pack is active, then pick a winner
// over its weighted PackOdds table. No mutation, so no compensation. The weighted
// draw runs at execution time (inside the step body, never the composition body
// which runs at load time), so the CSPRNG draw here is correct.
export const rollPackStep = createStep(
  'roll-pack',
  async (input: RollPackInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    return new StepResponse(await rollOne(packs, input.pack_id));
  },
);

export default rollPackStep;
