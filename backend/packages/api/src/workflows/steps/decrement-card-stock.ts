import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import {
  adjustCardStock,
  findCardInventoryTarget,
} from '../../modules/packs/card-stock';

export type DecrementCardStockInput = {
  card_id: string; // = Card.handle (=== Product.handle)
  // The pull this earmark belongs to — flagged stock_earmarked on success so
  // buyback knows whether a unit was actually taken (and may be restored).
  pull_id: string;
};

// What was adjusted, so compensation can put the unit back.
// null, not undefined: with undefined compensate data Medusa hands the
// compensator the step's OUTPUT instead (#968, audit 2026-11-11).
type CompensateData = { inventoryItemId: string; locationId: string } | null;

// decrement-card-stock — earmark one physical unit for the pull that just won
// this card. STOCK IS A COUNTER, NOT A GATE: pulls must NEVER fail because of
// inventory, so this step is best-effort — untracked products and even lookup
// errors resolve to "nothing adjusted" with at most a warning.
//
// The counter is allowed to go NEGATIVE (operator request, 2026-07-03): every
// win on a tracked product decrements, so a negative number is exactly the
// units owed to winners that still need sourcing. Because the decrement is
// unconditional there is no read-then-check race, and buyback's +1 restore is
// always symmetric with the −1 taken here.
export const decrementCardStockStep = createStep(
  'decrement-card-stock',
  async (input: DecrementCardStockInput, { container }) => {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
    let compensate: CompensateData = null;
    let adjusted = false;

    try {
      const target = await findCardInventoryTarget(container, input.card_id);
      // Untracked (null) — nothing to count; the pull is fulfilled via
      // buyback if the customer wants no/own physical card.
      if (target) {
        await adjustCardStock(
          container,
          target.inventoryItemId,
          target.locationId,
          -1,
        );
        adjusted = true;
        compensate = {
          inventoryItemId: target.inventoryItemId,
          locationId: target.locationId,
        };
        // Record that THIS pull took a unit — buyback only restores flagged
        // pulls (an untracked-product pull never decremented, so restoring it
        // would mint a phantom unit). If the flag write fails the counter errs
        // LOW (no restore later) — the conservative direction — so warn rather
        // than fail the pull.
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.updatePulls([{ id: input.pull_id, stock_earmarked: true }]);
      }
    } catch (error) {
      logger.warn(
        `decrement-card-stock: could not adjust stock for '${input.card_id}' — pull continues (buyback-only). ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return new StepResponse({ adjusted }, compensate);
  },
  async (data: CompensateData, { container }) => {
    if (!data) return;
    await adjustCardStock(container, data.inventoryItemId, data.locationId, 1);
  },
);

export default decrementCardStockStep;
