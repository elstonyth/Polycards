import { randomUUID } from "node:crypto";
import {
  createWorkflow,
  WorkflowResponse,
  transform,
} from "@medusajs/framework/workflows-sdk";
import { emitEventStep } from "@medusajs/medusa/core-flows";
import { rollPackStep } from "./steps/roll-pack";
import { chargePackOpenStep } from "./steps/charge-pack-open";
import { recordPullStep } from "./steps/record-pull";
import { decrementCardStockStep } from "./steps/decrement-card-stock";

export type OpenPackInput = {
  pack_id: string; // = Pack.slug
  customer_id: string; // from the authenticated token — NEVER the request body
};

// open-pack — the gacha "open a pack" business process.
//
//   roll (validate + weighted draw) → [payment seam] → record pull
//     → decrement stock (best-effort) → emit
//
// Both mutating steps are compensated (recordPull by delete, the stock
// decrement by +1), so a failure later in the chain rolls everything back
// (recordPull's rollback is proven by the commit-gate test).
// The composition body stays pure: every derived value goes through transform()
// (no literals/conditionals/Date here — that all lives inside the steps).
export const openPackWorkflow = createWorkflow(
  "open-pack",
  function (input: OpenPackInput) {
    // 1. Validate the pack is active and roll a winner over its weighted odds.
    const card = rollPackStep(input);

    // Mint a per-open id (uuid) BEFORE the charge so it can anchor the charge row
    // and (Phase 2a) every commission paid for this open. transform() is the only
    // impure seam in a workflow body — minting here keeps the composition pure.
    const charged = transform({ input }, (d) => ({
      pack_id: d.input.pack_id,
      customer_id: d.input.customer_id,
      open_id: randomUUID(),
    }));

    // ── PAYMENT SEAM (filled, Task A2) ───────────────────────────────────────
    // Debit the pack price from the credit ledger BEFORE the pull is recorded:
    // insufficient credit aborts here (nothing recorded), and a failure later
    // in the chain deletes the charge row via compensation — no unpaid Pull,
    // no paid non-Pull. The mock top-up (A1) is how customers fund this; the
    // real gateway later swaps the top-up seam, not this step.
    // ─────────────────────────────────────────────────────────────────────────
    const charge = chargePackOpenStep(charged);

    // 2. Record the pull (compensated by delete on failure).
    const recordInput = transform({ input, card }, (d) => ({
      customer_id: d.input.customer_id,
      pack_id: d.input.pack_id,
      card_id: d.card.handle,
    }));
    const pull = recordPullStep(recordInput);

    // 2b. Earmark one physical unit for the win (stock is a fulfillment
    //     COUNTER, never a gate — the step is best-effort and a 0-stock card
    //     still wins fine: buyback fulfills it). Flags the pull as
    //     stock_earmarked on success so buyback knows whether to restore.
    //     Compensated by +1.
    const stockInput = transform({ card, pull }, (d) => ({
      card_id: d.card.handle,
      pull_id: d.pull.id,
    }));
    decrementCardStockStep(stockInput);

    // 3. Emit pack.opened for the live-pulls feed / leaderboard subscribers. The
    //    event only fires if the whole workflow succeeds (Medusa defers emission
    //    to commit), so a compensated run emits nothing.
    const eventData = transform({ input, card, pull }, (d) => ({
      pull_id: d.pull.id,
      pack_id: d.input.pack_id,
      card_id: d.card.handle,
      customer_id: d.input.customer_id,
    }));
    emitEventStep({ eventName: "pack.opened", data: eventData });

    // Emit vip.spend_settled for VIP level-up reward processing (Phase 3b).
    // ONE event per open, carrying the customer_id and open_id.
    // Step is renamed to avoid the "already defined" collision with the
    // pack.opened emitEventStep above (both use emitEventStep's default id).
    const vipEvent = transform({ input, charged }, (d) => ({
      customer_id: d.input.customer_id,
      open_id: d.charged.open_id,
    }));
    emitEventStep({ eventName: "vip.spend_settled", data: vipEvent }).config({
      name: "emit-vip-spend-settled-step",
    });

    const result = transform({ card, pull, charge }, (d) => ({
      pull: d.pull,
      card: d.card,
      // Post-charge balance so the storefront can update in place.
      balance: d.charge.balance,
      price: d.charge.price,
    }));
    return new WorkflowResponse(result);
  },
);

export default openPackWorkflow;
