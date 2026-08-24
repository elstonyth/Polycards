import { model } from '@medusajs/framework/utils';

// One payable line: customer x kind within a settlement run. amount_cents is
// frozen at close time (basis x rate, floored to the cent). The Wednesday pay
// step writes one credit_transaction per line and stamps paid_transaction_id;
// the paired ledger row's (type='RF', ref_id=<line id>) partial unique index
// is the pay-step idempotency key, so a crashed pay job re-run skips every
// already-paid line.
export const WeeklySettlementLine = model
  .define('weekly_settlement_line', {
    id: model.id().primaryKey(),
    settlement_id: model.text(),
    customer_id: model.text(),
    kind: model.enum(['referral_commission', 'vip_rebate']),
    basis_cents: model.number(),
    rate_bp: model.number(),
    amount_cents: model.number(),
    status: model.enum(['pending', 'voided', 'paid']).default('pending'),
    void_reason: model.text().nullable(),
    voided_by: model.text().nullable(), // admin actor id; null for system voids
    paid_transaction_id: model.text().nullable(),
  })
  .indexes([
    {
      name: 'IDX_wsl_settlement',
      on: ['settlement_id'],
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_wsl_customer',
      on: ['customer_id'],
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_wsl_settlement_customer_kind_unique',
      on: ['settlement_id', 'customer_id', 'kind'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
  ]);

export default WeeklySettlementLine;
