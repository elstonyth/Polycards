import { model } from '@medusajs/framework/utils';

// ledger_entry — the operator-facing money/vault event log (POLYCARD-BACK
// §5). Go-forward only (D4): no backfill of pre-epic events, so history
// before this ships shows via the existing pull/credit_transaction views,
// never through this table. One row per source event; `ref_id` anchors the
// (type, ref_id) idempotency index below, chosen per-writer so it is
// ALSO the natural join key back to the row it describes (see
// modules/packs/service.ts recordLedgerEntry callers). wallet_delta/
// vault_delta are independently nullable — most writers only move one side
// (e.g. AD only ever touches wallet_delta).
export const LedgerEntry = model
  .define('ledger_entry', {
    id: model.id().primaryKey(),
    display_id: model.text().unique(),
    type: model.enum(['TP', 'SP', 'SE', 'OD', 'RF', 'AD', 'WP']),
    customer_id: model.text(),
    occurred_at: model.dateTime(),
    // MYR, signed. bigNumber (NOT number) — money — so this carries a
    // raw_wallet_delta/raw_vault_delta jsonb sidecar; the migration for this
    // table hand-writes both halves (see Migration20260728210000).
    wallet_delta: model.bigNumber().nullable(),
    vault_delta: model.bigNumber().nullable(),
    // Type-specific fields (LedgerPayload in ../ledger.ts). Nullable at the
    // DB level for defensiveness; every writer in this epic always supplies one.
    payload: model.json().nullable(),
    // The source row this event describes (see per-writer ref_id scheme in
    // this plan's Architecture section). Required — an entry with no ref_id
    // cannot be deduplicated and is a bug in the caller, not a valid state.
    ref_id: model.text(),
  })
  .indexes([
    // Idempotency (spec §5.3: "Idempotent per (type, ref_id) unique index").
    {
      name: 'IDX_ledger_entry_type_ref_id',
      on: ['type', 'ref_id'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
    // Admin list: per-player wallet/vault history, newest first.
    {
      name: 'IDX_ledger_entry_customer_id_occurred_at',
      on: ['customer_id', 'occurred_at'],
      where: 'deleted_at IS NULL',
    },
    // Admin list: the type filter tabs.
    {
      name: 'IDX_ledger_entry_type_occurred_at',
      on: ['type', 'occurred_at'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default LedgerEntry;
