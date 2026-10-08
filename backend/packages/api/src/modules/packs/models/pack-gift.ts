import { model } from '@medusajs/framework/utils';

// pack_gift — an admin-granted, unopened Pack held for one customer (spec
// 2026-10-07 §3.1). Shown on the Vault page but NOT a Pull: ADR 0001 stands,
// the vault is still a Pull status. An Open claims a gift (opened_at +
// open_id) before the charge and stamps the pull it became (pull_id).
//
// Unopened = not revoked, no pull, and either never claimed or claimed longer
// ago than the claim lease (a crashed open whose rollback never ran) — see
// UNOPENED_GIFT_SQL in service.ts. One row per pack: a grant of N writes N
// rows sharing one grant_key.
export const PackGift = model
  .define('pack_gift', {
    id: model.id({ prefix: 'pgift' }).primaryKey(),
    customer_id: model.text(),
    pack_id: model.text(), // = Pack.slug
    // The pack price at grant time — what the gift counts toward the daily
    // mint ceiling (ADJUST_DAILY_MINT_MAX_RM), like a credit grant.
    value_myr: model.bigNumber(),
    // Admin note, never shown to the customer.
    note: model.text(),
    granted_by: model.text(),
    // The grant's idempotency anchor, shared by the N rows of one grant.
    grant_key: model.text(),
    open_id: model.text().nullable(),
    pull_id: model.text().nullable(),
    opened_at: model.dateTime().nullable(),
    revoked_at: model.dateTime().nullable(),
    revoked_by: model.text().nullable(),
  })
  .indexes([
    {
      name: 'IDX_pack_gift_customer_pack',
      on: ['customer_id', 'pack_id', 'created_at'],
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_pack_gift_grant_key',
      on: ['grant_key'],
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_pack_gift_open_id',
      on: ['open_id'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default PackGift;
