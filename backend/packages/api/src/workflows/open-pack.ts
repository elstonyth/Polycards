import { randomUUID } from "node:crypto";
import {
  createWorkflow,
  WorkflowResponse,
  transform,
} from "@medusajs/framework/workflows-sdk";
import { emitEventStep } from "@medusajs/medusa/core-flows";
import { rollPackStep } from "./steps/roll-pack";
import { chargePackOpenStep } from "./steps/charge-pack-open";
import { claimFreePackStep } from "./steps/claim-free-pack";
import { recordPullStep } from "./steps/record-pull";
import { decrementCardStockStep } from "./steps/decrement-card-stock";
import { settleVipStep } from "./steps/settle-vip";

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

    // Free welcome pack: consume the one-time claim before the charge seam.
    // { free:false } for every normal pack — the step is a no-op there. It
    // lives INSIDE the workflow so its compensation (hand the claim back) only
    // ever fires while THIS open is rolling back.
    const claim = claimFreePackStep(input);

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
    const recordInput = transform({ input, card, charged, claim }, (d) => ({
      customer_id: d.input.customer_id,
      pack_id: d.input.pack_id,
      card_id: d.card.handle,
      // Free pulls record NO pulled value — they must never move the
      // leaderboard/challenge aggregates (same stance as reward pulls).
      recorded_value_usd: d.claim.free ? null : d.card.recorded_value_usd,
      open_id: d.charged.open_id,
      source: d.claim.free ? ("free" as const) : ("pack" as const),
    }));
    const pull = recordPullStep(
      transform({ recordInput, charge }, (d) => ({ ...d.recordInput, price: d.charge.price })),
    );

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

    // Settle VIP IN the saga: grant every ladder rung this open crossed and
    // advance vip_member_state before the response returns. Best-effort — a
    // grant hiccup never voids the paid open (sim day-3 vip-integrity HIGH;
    // see settle-vip.ts).
    const vipEvent = transform({ input, charged }, (d) => ({
      customer_id: d.input.customer_id,
      open_id: d.charged.open_id,
    }));
    settleVipStep(vipEvent);

    // Emit vip.spend_settled as the redelivery healer for the settle above
    // (Phase 3b). ONE event per open, carrying the customer_id and open_id.
    // Step is renamed to avoid the "already defined" collision with the
    // pack.opened emitEventStep above (both use emitEventStep's default id).
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
