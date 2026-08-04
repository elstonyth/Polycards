import { model } from '@medusajs/framework/utils';

// challenge_schedule — a Weekly Challenge queued to take over LATER.
//
// The live challenge stays exactly where it was: the challenge_stage table.
// This is a queue in front of it, so the operator can write next week's
// milestone ladder without disturbing the one currently paying out. When
// `starts_at` has passed, the hourly settle job promotes the row (writes its
// `stages` through the normal saveChallengeStages path) and stamps
// `applied_at`, which is also the idempotency gate — a promoted row is never
// promoted twice.
//
// `stages` holds the SAME shape POST /admin/challenge/stages accepts:
// `{ stage_number, threshold_myr, rank_rewards }[]`. Kept as one json column
// rather than a second stage table on purpose — a queued edition is an inert
// blob until promotion, so it needs no per-stage identity, no unique
// stage_number index, and no bigNumber column (which would drag a `raw_*`
// jsonb sibling into the migration).
//
// `label` is the operator's own note ("Chinese New Year week"), never used by
// the promotion logic.
export const ChallengeSchedule = model
  .define('challenge_schedule', {
    id: model.id().primaryKey(),
    starts_at: model.dateTime(),
    label: model.text().nullable(),
    stages: model.json(),
    applied_at: model.dateTime().nullable(),
  })
  .indexes([
    {
      // The promotion query: due-and-unapplied, oldest first.
      name: 'IDX_challenge_schedule_pending',
      on: ['starts_at'],
      where: 'applied_at IS NULL AND deleted_at IS NULL',
    },
  ]);

export default ChallengeSchedule;
