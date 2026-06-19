import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';

export type ChargePackBatchInput = { pack_id: string; customer_id: string; count: number };

export type ChargePackBatchResult = {
  /** USD price per pack (decimal, never cents). */
  price: number;
  /** Total debited = price × count. */
  total: number;
  /** Customer balance AFTER the charge. */
  balance: number;
};

type CompensateData = { creditTransactionId: string } | undefined;

export const chargePackBatchStep = createStep<
  ChargePackBatchInput,
  ChargePackBatchResult,
  CompensateData
>(
  'charge-pack-batch',
  async (input: ChargePackBatchInput, { container }) => {
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
    const total = price * input.count;
    if (total === 0) {
      const balance = await packs.creditBalance(input.customer_id);
      return new StepResponse(
        { price, total, balance } satisfies ChargePackBatchResult,
        undefined as CompensateData,
      );
    }
    const { id, balance } = await packs.mutateCreditAtomic({
      customerId: input.customer_id, amount: -total, reason: 'pack_open', floor: 0,
    });
    return new StepResponse(
      { price, total, balance } satisfies ChargePackBatchResult,
      { creditTransactionId: id } satisfies CompensateData,
    );
  },
  async (data: CompensateData, { container }) => {
    if (!data?.creditTransactionId) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.deleteCreditTransactions([data.creditTransactionId]);
  },
);

export default chargePackBatchStep;
