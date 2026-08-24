import { model } from '@medusajs/framework/utils';

// One row per customer per MYT calendar day, written by the explicit
// check-in button on /task (spec 2026-08-24 Phase B — the successor to the
// suspended /daily surface's streak idea, but a plain count: "checkin how
// many days" this week). checkin_date is the 'YYYY-MM-DD' MYT day; the
// unique index is the double-tap guard.
export const DailyCheckin = model
  .define('daily_checkin', {
    id: model.id().primaryKey(),
    customer_id: model.text(),
    checkin_date: model.text(),
  })
  .indexes([
    {
      name: 'IDX_daily_checkin_unique',
      on: ['customer_id', 'checkin_date'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
  ]);

export default DailyCheckin;
