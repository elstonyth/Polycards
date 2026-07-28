import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';

export type RecordPullsBatchInput = {
  customer_id: string;
  pack_id: string; // = Pack.slug
  // The batch's open_id (uuid) — the SAME id the count×price charge row stores
  // in source_transaction_id, stamped on every pull so money↔card links.
  open_id: string;
  // One entry per won card: Card.handle + the draw-time USD value snapshot.
  cards: { card_id: string; recorded_value_usd: number }[];
  price: number; // price × count, the whole batch's debit
};

// Compensation data: the IDs of every pull row inserted, so we can delete
// them all if a later step in the workflow fails.
type CompensateData = { pullIds: string[]; open_id: string } | undefined;

// Structural Pull type — mirrors what createPulls returns (same shape as
// record-pull.ts single-pull step), so downstream steps can read id/card_id
// without relying on `any`.
type PullRecord = {
  id: string;
  customer_id: string;
  pack_id: string;
  card_id: string;
  order_id: string | null;
  rolled_at: Date;
  revealed_at: Date | null;
  stock_earmarked: boolean;
  status: 'vaulted' | 'bought_back' | 'delivering' | 'delivered';
  recorded_value_usd: number | null;
  buyback_amount: number | null;
  buyback_at: Date | null;
  showcased: boolean;
};

// record-pulls-batch — insert N Pull rows in one shot (one per card_id), then
// return them all. Mirrors record-pull.ts but accepts an array. Compensation
// deletes every inserted row if a later step throws.
export const recordPullsBatchStep = createStep<
  RecordPullsBatchInput,
  PullRecord[],
  CompensateData
>(
  'record-pulls-batch',
  async (input: RecordPullsBatchInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

    const pulls = (await packs.recordPullsWithLedger({
      pulls: input.cards.map((c) => ({
        customer_id: input.customer_id,
        pack_id: input.pack_id,
        card_id: c.card_id,
        order_id: null,
        rolled_at: new Date(),
        recorded_value_usd: c.recorded_value_usd,
        open_id: input.open_id,
      })),
      ledger: {
        customerId: input.customer_id,
        openId: input.open_id,
        price: input.price,
        packId: input.pack_id,
        channel: 'batch',
      },
    })) as PullRecord[];

    return new StepResponse(pulls, {
      pullIds: pulls.map((p) => p.id),
      open_id: input.open_id,
    });
  },
  async (data: CompensateData, { container }) => {
    if (!data?.pullIds?.length) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.deletePulls(data.pullIds);
    await packs.deleteLedgerEntryByRef('SP', data.open_id);
  },
);

export default recordPullsBatchStep;
