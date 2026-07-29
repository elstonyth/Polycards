import { model } from '@medusajs/framework/utils';

// ledger_sequence — one row per (type, year, quarter) scope (e.g.
// "TP-26-Q3"), holding the last-issued serial for modules/packs/ledger.ts's
// nextSerial(). Allocation locks THIS row (SELECT ... FOR UPDATE) inside the
// same transaction as the ledger_entry insert it is issuing an id for — see
// PacksModuleService.recordLedgerEntry. No gaps required, only uniqueness
// (spec §5.2); last_serial is nullable so a brand-new scope starts at NULL
// and nextSerial(null) mints "a0001".
export const LedgerSequence = model
  .define('ledger_sequence', {
    id: model.id().primaryKey(),
    scope: model.text().unique(),
    last_serial: model.text().nullable(),
  });

export default LedgerSequence;
