import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import {
  adjustCardStock,
  findCardInventoryTarget,
} from '../../modules/packs/card-stock';

export type DecrementCardStockBatchInput = {
  items: {
    card_id: string; // = Card.handle (=== Product.handle)
    pull_id: string; // The pull this earmark belongs to
  }[];
};

// Per-item compensation data — only populated when a unit was actually taken.
type ItemCompensate = { inventoryItemId: string; locationId: string };

// Compensation: the list of items where stock was decremented, so each can be
// restored +1 on rollback.
type CompensateData = ItemCompensate[];

// decrement-card-stock-batch — best-effort batch version of decrement-card-stock.
// Loops over input.items and earmarks one physical unit for each pull that won
// a card. STOCK IS NEVER A GATE: pulls must never fail because of inventory, so
// every error is caught and logged as a warning. The counter is allowed to go
// NEGATIVE — every tracked win decrements, so a negative number is the units
// owed to winners (see decrement-card-stock). The compensation list only
// contains entries for items that were actually decremented.
export const decrementCardStockBatchStep = createStep<
  DecrementCardStockBatchInput,
  void,
  CompensateData
>(
  'decrement-card-stock-batch',
  async (input: DecrementCardStockBatchInput, { container }) => {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
    const compensate: CompensateData = [];

    for (const item of input.items) {
      try {
        const target = await findCardInventoryTarget(container, item.card_id);
        // Untracked (null) — nothing to count; the pull is fulfilled via
        // buyback if the customer wants no/own physical card.
        if (target) {
          await adjustCardStock(
            container,
            target.inventoryItemId,
            target.locationId,
            -1,
          );
          compensate.push({
            inventoryItemId: target.inventoryItemId,
            locationId: target.locationId,
          });
          // Record that THIS pull took a unit — buyback only restores flagged
          // pulls (an untracked-product pull never decremented, so restoring
          // it would mint a phantom unit). If the flag write fails the counter
          // errs LOW (no restore later) — the conservative direction — so warn
          // rather than fail the pull.
          const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
          await packs.updatePulls([
            { id: item.pull_id, stock_earmarked: true },
          ]);
        }
      } catch (error) {
        logger.warn(
          `decrement-card-stock-batch: could not adjust stock for '${item.card_id}' — pull continues (buyback-only). ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return new StepResponse(undefined, compensate);
  },
  async (data: CompensateData, { container }) => {
    if (!data?.length) return;
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
    for (const item of data) {
      try {
        await adjustCardStock(
          container,
          item.inventoryItemId,
          item.locationId,
          1,
        );
      } catch (error) {
        logger.warn(
          `decrement-card-stock-batch compensation: failed to restore stock for inventoryItemId='${item.inventoryItemId}' — continuing rollback. ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  },
);

export default decrementCardStockBatchStep;
