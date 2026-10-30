import { model } from '@medusajs/framework/utils';

// ProcurementSnapshot — the purchasing to-buy list as the 12am stock run left
// it (owner, 2026-10-28: "procurement only updates once a day at 12am, after
// the order statuses update"). One row per night; the procurement route reads
// the newest. to_buy is `{ rows: ToBuyRow[] }` (procurement-view.ts), frozen,
// so a GRN saved during the day does not reshuffle the list purchasing is
// working from.
export const ProcurementSnapshot = model
  .define('procurement_snapshot', {
    id: model.id().primaryKey(),
    taken_at: model.dateTime(),
    to_buy: model.json(),
  })
  .indexes([
    {
      name: 'IDX_procurement_snapshot_taken_at',
      on: ['taken_at'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default ProcurementSnapshot;
