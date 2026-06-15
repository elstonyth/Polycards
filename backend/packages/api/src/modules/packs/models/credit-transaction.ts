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
    // USD decimal (never cents). Positive = credit, negative = spend.
    amount: model.bigNumber(),
    reason: model.enum(["buyback", "topup", "pack_open", "adjustment"]),
    // The pull this credit came from (buyback rows only; null for top-ups).
    // UNIQUE — the DB itself guarantees a pull can never be credited twice,
    // whatever races the API layer loses (Postgres ignores NULLs in unique
    // indexes, so top-up rows don't collide).
    pull_id: model.text().unique().nullable(),
    // Payment-gateway reference (top-up rows only; null for buybacks). Today
    // the mock gateway's fake reference; the real gateway's charge id later.
    reference: model.text().nullable(),
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
