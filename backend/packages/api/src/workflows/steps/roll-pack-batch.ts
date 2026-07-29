import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import type { MedusaContainer } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import { resolveOddsSetForCustomer } from '../../modules/packs/odds-sets';
import { fetchPackData, drawFromData, type RolledCard } from './roll-pack';

export type RollPackBatchInput = {
  pack_id: string;
  count: number;
  // Same role as on the single-open input: resolves the customer's ODDS SET
  // server-side (§2.5). Optional — an absent id draws on set 1.
  customer_id?: string;
};

// rollBatch — the batch step's body, exported so it can be driven directly in a
// unit test (createStep returns an opaque step object, not a callable).
//
// Fix 1: fetchPackData is called ONCE before the loop. listPacks + listPackOdds
// run exactly once per batch regardless of count, eliminating N× redundant DB
// reads for pack-level invariants that don't change between draws. The odds-set
// lookup is hoisted for the same reason — one group read per batch, and every
// draw in the batch must roll on the SAME set anyway.
//
// Fix 3: count is validated before the loop (defense-in-depth). The route
// already enforces 1..3 but the step must not loop on garbage inputs.
export async function rollBatch(
  container: MedusaContainer,
  input: RollPackBatchInput,
): Promise<RolledCard[]> {
  // Fix 3 — defensive count guard
  if (!Number.isInteger(input.count) || input.count < 1) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'count must be a positive integer.',
    );
  }

  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  // Resolve the customer's odds set ONCE for the whole batch (never from the
  // request body). Anonymous/ungrouped → set 1 (handled by the resolver).
  const set = await resolveOddsSetForCustomer(container, input.customer_id);

  // Fix 1 — hoist pack/odds fetch: one DB round-trip for the entire batch
  const data = await fetchPackData(packs, input.pack_id, set);

  // Each drawFromData call is independent (fresh CSPRNG draw per call).
  // listCards stays inside drawFromData — it varies per winning card.
  const cards: RolledCard[] = [];
  for (let i = 0; i < input.count; i++) {
    cards.push(await drawFromData(packs, data.odds, data.totalWeight));
  }
  return cards;
}

// Read-only (no compensation). Loops INSIDE the step (the workflow body can't
// loop). N independent draws — win-rate lock holds per roll.
export const rollPackBatchStep = createStep(
  'roll-pack-batch',
  async (input: RollPackBatchInput, { container }) =>
    new StepResponse(await rollBatch(container, input)),
);

export default rollPackBatchStep;
