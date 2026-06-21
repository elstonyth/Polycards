import { model } from "@medusajs/framework/utils";

// commission — the lifecycle/audit record paired 1:1 with a commission credit
// row (credit_transaction). Money lives in the ledger; this tracks provenance +
// state. Phase 2a writes only kind='direct', status 'pending'|'available'.
export const Commission = model
  .define("commission", {
    id: model.id().primaryKey(),
    // The credit_transaction row that paid this commission (1:1).
    credit_transaction_id: model.text().unique(),
    beneficiary: model.text(), // the sponsor who earned it
    source_transaction_id: model.text(), // the recruit's open_id
    generation: model.number(), // 1 for direct
    kind: model.enum(["direct", "override"]).default("direct"),
    status: model
      .enum(["pending", "available", "suspended", "reversed"])
      .default("pending"),
    matures_at: model.dateTime(),
    effective_pct: model.number(), // snapshot of the pct used (forward-only config)
    reversal_transaction_id: model.text().nullable(),
  })
  .indexes([
    {
      name: "IDX_commission_beneficiary",
      on: ["beneficiary"],
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_commission_source_transaction_id",
      on: ["source_transaction_id"],
      where: "deleted_at IS NULL",
    },
  ]);

export default Commission;
