import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { MedusaError } from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../../modules/packs";
import type PacksModuleService from "../../modules/packs/service";

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
};

// Shared return shape from fetchPackData — carries the static pack/odds state
// that is safe to fetch once and reuse across N independent draws.
export type PackData = {
  pack: Awaited<ReturnType<PacksModuleService["listPacks"]>>[number];
  odds: Awaited<ReturnType<PacksModuleService["listPackOdds"]>>;
  totalWeight: number;
};

// fetchPackData — fetches and validates the pack + odds ONCE.
// Call this before a draw loop so listPacks + listPackOdds run only once per
// batch regardless of count. The validations (active check, empty odds, zero
// weight) all belong here — they are pack-level invariants, not per-draw logic.
// NOTE: take: 1000 on listPackOdds is intentional and pre-existing; packs with
// >1000 odds rows are not a realistic scenario (skipping Fix #2 per spec).
export async function fetchPackData(
  packs: PacksModuleService,
  packId: string,
): Promise<PackData> {
  const [pack] = await packs.listPacks({ slug: packId, status: "active" }, { take: 1 });
  if (!pack) throw new MedusaError(MedusaError.Types.NOT_FOUND, `Pack '${packId}' is not available.`);
  const odds = await packs.listPackOdds({ pack_id: packId }, { take: 1000 });
  if (odds.length === 0) throw new MedusaError(MedusaError.Types.NOT_FOUND, `Pack '${packId}' has no odds configured.`);
  const totalWeight = odds.reduce((sum, o) => sum + o.weight, 0);
  if (totalWeight <= 0) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, `Pack '${packId}' has invalid odds.`);
  return { pack, odds, totalWeight };
}

// pickWonRow — pure weighted selection over any array of { weight: number }.
// Extracted so the reward-draw engine (B4) can reuse the same algorithm without
// depending on PacksModuleService or any I/O.
// ponytail: last-row fallback handles roll >= totalWeight (rounding / float drift).
export function pickWonRow<T extends { weight: number }>(rows: T[], roll: number): T {
  let won = rows[rows.length - 1];
  for (const r of rows) { roll -= r.weight; if (roll < 0) { won = r; break; } }
  return won;
}

// drawFromData — performs ONE independent weighted draw from pre-fetched pack data.
// This is the per-roll logic: a new Math.random() per call ensures draw independence.
// listCards is intentionally kept HERE (not hoisted) because it fetches the
// specific card that WAS won — it varies per roll and must stay per-draw.
export async function drawFromData(
  packs: PacksModuleService,
  odds: PackData["odds"],
  totalWeight: number,
): Promise<RolledCard> {
  const won = pickWonRow(odds, Math.random() * totalWeight);
  const [card] = await packs.listCards({ handle: won.card_id }, { take: 1 });
  if (!card) throw new MedusaError(MedusaError.Types.NOT_FOUND, `Card '${won.card_id}' not found.`);
  return {
    handle: card.handle, name: card.name, set: card.set, grader: card.grader,
    grade: card.grade, rarity: won.rarity, market_value: Number(card.market_value),
    image: card.image, pokemon_dex: card.pokemon_dex ?? null, sprite_image: card.sprite_image ?? null,
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
// draw runs at execution time, so Math.random here is correct (the composition
// body, which runs at load time, must never contain this logic).
export const rollPackStep = createStep(
  "roll-pack",
  async (input: RollPackInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    return new StepResponse(await rollOne(packs, input.pack_id));
  }
);

export default rollPackStep;
