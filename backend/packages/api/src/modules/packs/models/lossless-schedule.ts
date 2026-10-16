import { model } from '@medusajs/framework/utils';

// lossless_schedule — an admin-scheduled Lossless Mode window: while it is
// live, the chosen packs' INSTANT (30s reveal) buyback pays 100% instead of the
// configured rate. The decision logic is pure (lossless.ts); this is only the
// row it reads.
//
// No status column: upcoming / live / ended / cancelled is derived from
// starts_at, ends_at and cancelled_at at read time (losslessStatus), so a
// window can never be "live" in the table while the clock says otherwise.
// Cancelling stamps `cancelled_at` rather than deleting, which keeps the row
// (and its audit trail) and ends a live window immediately.
//
// `pack_slugs` null = every eligible pack; otherwise only those slugs. Slugs,
// not ids, so the list reads the same in the audit log and survives a pack
// being re-created. Kept as one json column — it is an inert list read whole.
export const LosslessSchedule = model
  .define('lossless_schedule', {
    id: model.id().primaryKey(),
    starts_at: model.dateTime(),
    ends_at: model.dateTime(),
    pack_slugs: model.json().nullable(),
    cancelled_at: model.dateTime().nullable(),
    created_by: model.text(),
  })
  .indexes([
    {
      // The hot read: every window that has not yet ended (losslessWindows).
      name: 'IDX_lossless_schedule_ends_at',
      on: ['ends_at'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default LosslessSchedule;
