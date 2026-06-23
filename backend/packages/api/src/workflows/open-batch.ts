import { randomUUID } from "node:crypto";
import {
  createWorkflow,
  WorkflowResponse,
  transform,
} from "@medusajs/framework/workflows-sdk";
import { emitEventStep } from "@medusajs/medusa/core-flows";
import { rollPackBatchStep } from "./steps/roll-pack-batch";
import { chargePackBatchStep } from "./steps/charge-pack-batch";
import { recordPullsBatchStep } from "./steps/record-pulls-batch";
import { decrementCardStockBatchStep } from "./steps/decrement-card-stock-batch";

export type OpenBatchInput = {
  pack_id: string;     // = Pack.slug
  customer_id: string; // from the authenticated token — NEVER the request body
  count: number;       // 1–N packs to open in one atomic operation
};

// open-batch — the multi-reel "open N packs" business process.
//
//   roll×N (independent draws) → ONE count×price debit → record N pulls
//     → decrement stock×N (best-effort) → emit N pack.opened events
//
// The saga is all-or-nothing:
//   • chargePackBatchStep is compensated (deletes the charge row on rollback).
//   • recordPullsBatchStep is compensated (deletes every inserted pull row on rollback).
//   • decrementCardStockBatchStep is best-effort (non-fatal errors; compensated +1 per unit).
//
// emitEventStep fires AFTER the whole chain succeeds (Medusa defers emission
// to commit), so a compensated run emits nothing. Passing an array to
// emitEventStep emits one "pack.opened" event per element — one per pull,
// matching the single-open workflow exactly.
//
// The composition body stays pure: no loops, no conditionals, no literals,
// no Date/Math/async. Every derived value goes through transform().
export const openBatchWorkflow = createWorkflow(
  "open-batch",
  function (input: OpenBatchInput) {
    // 1. Roll N winners (independent weighted draws; no compensation — read-only).
    //    rollPackBatchStep only reads pack_id + count from its input type, so
    //    passing the full OpenBatchInput is safe (structural subtyping).
    const cards = rollPackBatchStep(input);

    // One open_id for the whole batch — a count=N open is ONE charge row and pays
    // ONE commission on price×N (spec §9). Mint it before the charge.
    const charged = transform({ input }, (d) => ({
      pack_id: d.input.pack_id,
      customer_id: d.input.customer_id,
      count: d.input.count,
      open_id: randomUUID(),
    }));

    // ── PAYMENT SEAM ──────────────────────────────────────────────────────────
    // Debit count×price atomically from the credit ledger BEFORE pulls are
    // recorded: insufficient credit aborts here (nothing recorded), and a
    // failure later in the chain deletes the charge row via compensation — no
    // unpaid Pull, no paid non-Pull.
    // ─────────────────────────────────────────────────────────────────────────
    const charge = chargePackBatchStep(charged);

    // 2. Build recordPullsBatchStep's input: customer_id + pack_id from the
    //    workflow input, card_ids derived from the rolled cards.
    const recordInput = transform({ input, cards }, (d) => ({
      customer_id: d.input.customer_id,
      pack_id: d.input.pack_id,
      card_ids: d.cards.map((c) => c.handle),
    }));
    const pulls = recordPullsBatchStep(recordInput);

    // 2b. Earmark one physical unit per winning pull (best-effort — a 0-stock
    //     card still wins fine; buyback fulfills it). Compensated by +1 per item.
    const stockInput = transform({ cards, pulls }, (d) => ({
      items: d.pulls.map((p, i) => ({
        card_id: d.cards[i].handle,
        pull_id: p.id,
      })),
    }));
    decrementCardStockBatchStep(stockInput);

    // 3. Emit one pack.opened event per pull. emitEventStep accepts an array
    //    for data — it fires one event per element. Payload matches the single-
    //    open workflow byte-for-byte: { pull_id, pack_id, card_id, customer_id }.
    const eventData = transform({ input, cards, pulls }, (d) =>
      d.pulls.map((p, i) => ({
        pull_id: p.id,
        pack_id: d.input.pack_id,
        card_id: d.cards[i].handle,
        customer_id: d.input.customer_id,
      })),
    );
    emitEventStep({ eventName: "pack.opened", data: eventData });

    // Emit vip.spend_settled for VIP level-up reward processing (Phase 3b).
    // ONE event per batch (not per pull), carrying the customer_id and open_id.
    // Step is renamed to avoid the "already defined" collision with the
    // pack.opened emitEventStep above (both use emitEventStep's default id).
    const vipEvent = transform({ input, charged }, (d) => ({
      customer_id: d.input.customer_id,
      open_id: d.charged.open_id,
    }));
    emitEventStep({ eventName: "vip.spend_settled", data: vipEvent }).config({
      name: "emit-vip-spend-settled-step",
    });

    // 4. Shape the result: arrayized twin of open-pack's result shape.
    const result = transform({ cards, pulls, charge }, (d) => ({
      rolls: d.cards,
      pulls: d.pulls,
      price: d.charge.price,
      total: d.charge.total,
      balance: d.charge.balance,
    }));
    return new WorkflowResponse(result);
  },
);

export default openBatchWorkflow;
