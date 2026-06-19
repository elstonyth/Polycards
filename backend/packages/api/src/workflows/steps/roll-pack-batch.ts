import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import { fetchPackData, drawFromData, type RolledCard } from './roll-pack';

export type RollPackBatchInput = { pack_id: string; count: number };

// Read-only (no compensation). Loops INSIDE the step (the workflow body can't
// loop). N independent draws — win-rate lock holds per roll.
//
// Fix 1: fetchPackData is called ONCE before the loop. listPacks + listPackOdds
// run exactly once per batch regardless of count, eliminating N× redundant DB
// reads for pack-level invariants that don't change between draws.
//
// Fix 3: count is validated before the loop (defense-in-depth). The route
// already enforces 1..3 but the step must not loop on garbage inputs.
export const rollPackBatchStep = createStep(
  'roll-pack-batch',
  async (input: RollPackBatchInput, { container }) => {
    // Fix 3 — defensive count guard
    if (!Number.isInteger(input.count) || input.count < 1) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'count must be a positive integer.',
      );
    }

    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

    // Fix 1 — hoist pack/odds fetch: one DB round-trip for the entire batch
    const data = await fetchPackData(packs, input.pack_id);

    // Each drawFromData call is independent (new Math.random() per call).
    // listCards stays inside drawFromData — it varies per winning card.
    const cards: RolledCard[] = [];
    for (let i = 0; i < input.count; i++) {
      cards.push(await drawFromData(packs, data.odds, data.totalWeight));
    }
    return new StepResponse(cards);
  },
);

export default rollPackBatchStep;
