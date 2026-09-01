import {
  createStep,
  StepResponse,
  type InvokeFn,
} from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import { FREE_WELCOME_CATEGORY } from '../../modules/packs/free-pack';

export type ChargePackBatchInput = {
  pack_id: string;
  customer_id: string;
  count: number;
  open_id: string; // one per batch — the single charge row's open id
};

export type ChargePackBatchResult = {
  /** MYR (RM) price per pack (decimal, never cents). */
  price: number;
  /** Total debited = price × count. */
  total: number;
  /** Customer balance AFTER the charge. */
  balance: number;
};

// open_id is the authoritative key for compensation: reverseOpen(open_id) cascades
// the debit + every commission. (The debit row id is not needed here.)
type CompensateData = { open_id: string } | undefined;

/** Exported for the unit spec (same shape as create-card's registerCardInvoke). */
export const chargePackBatchInvoke: InvokeFn<
  ChargePackBatchInput,
  ChargePackBatchResult,
  CompensateData
> = async (input, { container }) => {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const [pack] = await packs.listPacks({ slug: input.pack_id }, { take: 1 });
  if (!pack) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Pack '${input.pack_id}' is not available.`,
    );
  }
  const price = Number(pack.price);
  if (!Number.isFinite(price) || price < 0) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'This pack has no valid price and cannot be opened.',
    );
  }
  // The free welcome pack is a one-time SINGLE open whose claim seam lives in
  // open-pack, not here. The route refuses it too, but the step is the
  // authority: no other caller may mint N unclaimed, unlock-granting pulls.
  if (pack.category === FREE_WELCOME_CATEGORY) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'The free welcome pack can only be opened once, singly.',
    );
  }
  // Cent-round: price × count in binary floats (149.9 × 3) would book an
  // un-rounded wallet_delta and echo it as total_charged.
  const total = Math.round(price * input.count * 100) / 100;
  if (total === 0) {
    const balance = await packs.creditBalance(input.customer_id);
    return new StepResponse(
      { price, total, balance } satisfies ChargePackBatchResult,
      undefined as CompensateData,
    );
  }
  const { balance } = await packs.settleOpen({
    customerId: input.customer_id,
    amount: -total,
    sourceTransactionId: input.open_id,
  });
  return new StepResponse(
    { price, total, balance } satisfies ChargePackBatchResult,
    { open_id: input.open_id } satisfies CompensateData,
  );
};

export const chargePackBatchStep = createStep<
  ChargePackBatchInput,
  ChargePackBatchResult,
  CompensateData
>(
  'charge-pack-batch',
  chargePackBatchInvoke,
  async (data: CompensateData, { container }) => {
    if (!data) return; // free-batch wrote no debit -> nothing to reverse
    // The batch open is append-only: undo it with cascading compensating rows,
    // NOT a delete. reverseOpen reverses the recruit's debit AND claws back
    // every commission (direct + override) paid for this open_id, so a failure
    // after settleOpen committed can never leave the recruit refunded but
    // sponsors overpaid (Phase 2b go-live blocker).
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.reverseOpen(data.open_id);
  },
);

export default chargePackBatchStep;
