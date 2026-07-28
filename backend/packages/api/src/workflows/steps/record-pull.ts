import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { PACKS_MODULE } from "../../modules/packs";
import type PacksModuleService from "../../modules/packs/service";

type RecordPullInput = {
  customer_id: string;
  pack_id: string; // = Pack.slug
  card_id: string; // = Card.handle (the won card)
  recorded_value_usd: number; // draw-time USD pulled value snapshot (roll-pack)
  // The open_id (uuid) the charge row stored in source_transaction_id — the
  // money<->card audit link stamped on the pull.
  open_id: string;
  price: number; // the pack-open debit, from chargePackOpenStep — threads
                 // into the paired SP ledger row (see open-pack.ts).
};

// record-pull — the one mutation in the open-pack workflow: append a row to the
// Pull ledger. Compensated by delete, so if a LATER step throws (e.g. the future
// payment step that slots in before this one is reordered, or the event step
// fails) the orphaned Pull is rolled back. order_id is null until checkout is
// wired with payment; rolled_at is stamped at execution time (new Date() is fine
// inside a step — the load-time ban only applies to the composition body).
export const recordPullStep = createStep(
  "record-pull",
  async (input: RecordPullInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

    const [pull] = await packs.recordPullsWithLedger({
      pulls: [
        {
          customer_id: input.customer_id,
          pack_id: input.pack_id,
          card_id: input.card_id,
          order_id: null,
          rolled_at: new Date(),
          recorded_value_usd: input.recorded_value_usd,
          open_id: input.open_id,
        },
      ],
      ledger: {
        customerId: input.customer_id,
        openId: input.open_id,
        price: input.price,
        packId: input.pack_id,
        channel: "single",
      },
    });
    return new StepResponse(pull, { id: pull.id, open_id: input.open_id });
  },
  async (data: { id: string; open_id: string } | undefined, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    // In-flight workflow rollback (a LATER step in this open failed) — this
    // is NOT the post-commit reverseOpen path (see Global Constraints): the
    // pull and its ledger row were written together and neither is a
    // settled fact yet, so both are deleted, not clawed back.
    await packs.deletePulls(data.id);
    await packs.deleteLedgerEntryByRef("SP", data.open_id);
  }
);

export default recordPullStep;
