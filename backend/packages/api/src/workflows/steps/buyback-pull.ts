import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import {
  ContainerRegistrationKeys,
  MedusaError,
} from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import {
  adjustCardStock,
  findCardInventoryTarget,
} from '../../modules/packs/card-stock';
import type { BuybackRateType } from '../../modules/packs/buyback-rate';
import { insertOrMapDuplicate } from './duplicate-race';

export type BuybackPullInput = {
  pull_id: string;
  customer_id: string; // from the authenticated token — NEVER the request body
};

export type BuybackResult = {
  pull_id: string;
  /** MYR credited (decimal, never cents) — percent of the FX-converted Value. */
  amount: number;
  /** The buyback percent actually applied. */
  percent: number;
  /** Which rate applied: instant (within the post-pull window) or vault. */
  rate_type: BuybackRateType;
  /** The customer's new credit balance (Σ ledger). */
  balance: number;
};

type CompensateData =
  | {
      pullId: string;
      creditTransactionId: string;
      stockTarget: { inventoryItemId: string; locationId: string } | null;
    }
  | undefined;

// buyback-pull — the customer sells a vaulted pull back to the house: the pull
// flips to bought_back, the credit ledger gains current-FMV × pack-% , and the
// physical unit returns to stock (best-effort, mirror of the pull's earmark).
//
// Money and ownership settle in one customer-locked transaction.
export const buybackPullStep = createStep(
  'buyback-pull',
  async (input: BuybackPullInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

    const { pull, amount, percent, rate_type, creditTransactionId } = await insertOrMapDuplicate({
      insert: () => packs.buybackPullAtomic({ customerId: input.customer_id, pullId: input.pull_id }),
      probeDuplicate: async () => (await packs.listCreditTransactions({ pull_id: input.pull_id }, { take: 1 })).length > 0,
      duplicateError: () => new MedusaError(MedusaError.Types.NOT_ALLOWED, 'This card was already sold back.'),
      logger,
      label: 'buyback-pull',
    });

    // 3. Return the physical unit to stock — ONLY if this pull actually took
    //    one (stock_earmarked): a pull made at 0 stock / on an untracked
    //    product never decremented, so restoring it would mint a phantom unit.
    //    The flag clears with the restore (and compensation re-sets it) so the
    //    earmark and the counter always agree. Best-effort: errors only warn.
    let stockTarget: { inventoryItemId: string; locationId: string } | null =
      null;
    try {
      if (pull.stock_earmarked) {
        const target = await findCardInventoryTarget(container, pull.card_id);
        if (target) {
          await adjustCardStock(
            container,
            target.inventoryItemId,
            target.locationId,
            1,
          );
          await packs.updatePulls([{ id: pull.id, stock_earmarked: false }]);
          stockTarget = {
            inventoryItemId: target.inventoryItemId,
            locationId: target.locationId,
          };
        }
      }
    } catch (error) {
      logger.warn(
        `buyback-pull: could not restore stock for '${pull.card_id}' — buyback continues. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // New balance = paged Σ ledger (append-only; exact at any ledger size).
    const balance = await packs.creditBalance(input.customer_id);

    // F1: this buyback credit was written outside mutateCreditAtomic, so it
    // skipped the inline auto-unfreeze. Lift an AUTO freeze whose debt this
    // repays, under the same per-customer lock. Best-effort: the credit already
    // committed, so a lingering freeze is no worse than before and clears on the
    // next inflow — never fail a successful buyback on the unfreeze check.
    try {
      await packs.maybeAutoUnfreezeForCustomer(input.customer_id);
    } catch (error) {
      logger.warn(
        `buyback-pull: auto-unfreeze check failed for '${input.customer_id}' — buyback continues. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const result: BuybackResult = {
      pull_id: pull.id,
      amount,
      percent,
      rate_type,
      balance,
    };
    return new StepResponse(result, {
      pullId: pull.id,
      creditTransactionId,
      stockTarget,
    } satisfies CompensateData);
  },
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const undone = await packs.undoBuybackAtomic({ pullId: data.pullId, creditTransactionId: data.creditTransactionId, restoreEarmark: Boolean(data.stockTarget) });
    if (!undone) return;
    if (data.stockTarget) {
      await adjustCardStock(
        container,
        data.stockTarget.inventoryItemId,
        data.stockTarget.locationId,
        -1,
      );
    }
  },
);

export default buybackPullStep;
