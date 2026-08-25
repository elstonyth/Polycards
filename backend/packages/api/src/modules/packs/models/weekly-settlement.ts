import { model } from '@medusajs/framework/utils';

// One row per closed referral week (Tue 00:00 MYT start — the "TUES CHECK"
// of the operator's cycle). week_start is the UNIQUE idempotency key for the
// Tuesday close job: a re-run that finds the row already present is a no-op.
// Lifecycle: draft -> approved (admin gate) -> paid (Wednesday job).
// void = the whole run cancelled before any line was paid.
export const WeeklySettlement = model.define('weekly_settlement', {
  id: model.id().primaryKey(),
  week_start: model.dateTime().unique(), // UTC instant of Tue 00:00 MYT
  status: model.enum(['draft', 'approved', 'paid', 'void']).default('draft'),
  approved_by: model.text().nullable(), // admin actor id
  approved_at: model.dateTime().nullable(),
  paid_at: model.dateTime().nullable(),
  total_commission_cents: model.number().default(0),
});

export default WeeklySettlement;
