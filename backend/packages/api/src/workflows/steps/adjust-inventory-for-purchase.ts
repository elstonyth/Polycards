import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { findCardInventoryTarget } from '../../modules/packs/card-stock';

export type AdjustInventoryForPurchaseInput = {
  lines: { card_handle: string; qty: number }[];
};

type Adjustment = { inventoryItemId: string; locationId: string; qty: number };
type CompensateData = Adjustment[];

// adjust-inventory-for-purchase — raises the SAME Medusa inventory counter
// card-stock.ts reads for "on hand" (§3.2, mirrors decrement-card-stock in
// the opposite direction), so a receipt is visible the instant the invoice
// saves, with zero new plumbing on the read side. Best-effort per line: an
// untracked handle (no tracked inventory item) adjusts nothing rather than
// failing the whole invoice — the paper trail (stock_movement) was already
// written in the previous step regardless.
export const adjustInventoryForPurchaseStep = createStep(
  'adjust-inventory-for-purchase',
  async (input: AdjustInventoryForPurchaseInput, { container }) => {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
    const inventoryModule = container.resolve(Modules.INVENTORY);
    const done: Adjustment[] = [];
    for (const line of input.lines) {
      try {
        const target = await findCardInventoryTarget(container, line.card_handle);
        if (!target) continue; // untracked — nothing to raise
        await inventoryModule.adjustInventory(
          target.inventoryItemId,
          target.locationId,
          line.qty,
        );
        done.push({
          inventoryItemId: target.inventoryItemId,
          locationId: target.locationId,
          qty: line.qty,
        });
      } catch (error) {
        logger.warn(
          `adjust-inventory-for-purchase: could not adjust '${line.card_handle}' — invoice still saves. ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return new StepResponse(done, done satisfies CompensateData);
  },
  async (data: CompensateData, { container }) => {
    const inventoryModule = container.resolve(Modules.INVENTORY);
    for (const a of data ?? []) {
      await inventoryModule.adjustInventory(
        a.inventoryItemId,
        a.locationId,
        -a.qty,
      );
    }
  },
);

export default adjustInventoryForPurchaseStep;
