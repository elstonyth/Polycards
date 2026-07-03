import { model } from "@medusajs/framework/utils";

// CreditTransaction — the customer's site-credit ledger. Balance = Σ(amount)
// per customer (append-only; no mutable balance column to drift). Writers:
// the buyback workflow (+credit, pull-backed), the top-up workflow (+credit,
// gateway-backed), the open-pack charge step (-price, reason "pack_open"),
// and the operator adjust-credits workflow (signed, reason "adjustment").
export const CreditTransaction = model
  .define("credit_transaction", {
    id: model.id().primaryKey(),
    customer_id: model.text(),
    // RM (MYR) decimal (never sen). Positive = credit, negative = spend.
    // ALL ledger money is Ringgit — the only USD in the system is the raw
    // PriceCharting FMV on Card/product rows, converted via the pricing seam.
    amount: model.bigNumber(),
    reason: model.enum([
      "buyback",
      "topup",
      "pack_open",
      "adjustment",
      "direct_referral",
      "team_override",
      "commission_reversal",
      "cashout",
      "voucher_claim",
      "reward_credit",
      "daily_reward",
    ]),
    // The pull this credit came from (buyback rows only; null for top-ups).
    // UNIQUE — the DB itself guarantees a pull can never be credited twice,
    // whatever races the API layer loses (Postgres ignores NULLs in unique
    // indexes, so top-up rows don't collide).
    pull_id: model.text().unique().nullable(),
    // Payment-gateway reference (top-up rows only; null for buybacks). Today
    // the mock gateway's fake reference; the real gateway's charge id later.
    reference: model.text().nullable(),
    // Phase 1b — external-funded sen this row added (top-up, +) or consumed
    // (pack_open, −). 0 for buyback/adjustment. NULL on pre-1b rows (read as 0,
    // forward-only). Signed integer sen; the VIP basis = Σ(−this) over opens.
    external_funded_cents: model.number().nullable(),
    // Phase 2a — the open's stable id (open_id uuid), stamped on the pack_open
    // charge row and on every commission row that pays out for that open. NULL on
    // pre-2a rows and on topup/buyback/adjustment. The commission idempotency
    // index (Task 12) keys on this. Forward-only; never back-filled.
    source_transaction_id: model.text().nullable(),
    // Phase 2a — generation of a commission row (1 = direct sponsor; >1 = override
    // ancestors, Phase 2b). NULL on non-commission rows. Part of the idempotency
    // index so a retried open can't double-pay any single beneficiary at any gen.
    generation: model.number().nullable(),
  })
  // Balance Σ + credits feed + admin gacha all read by customer_id ordered by
  // created_at; composite serves the filter + ORDER BY (+ pagination) in one scan.
  .indexes([
    {
      name: "IDX_credit_transaction_customer_id_created_at",
      on: ["customer_id", "created_at"],
      where: "deleted_at IS NULL",
    },
  ]);

export default CreditTransaction;
