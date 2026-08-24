import { model } from '@medusajs/framework/utils';

// One configurable task (spec 2026-08-24 Phase B). `kind` picks the cadence:
// weekly tasks reset on the referral week (Tue 00:00 MYT); achievements are
// once-per-account. `requirement` and `reward` are the discriminated unions in
// tasks.ts (validated by validateTaskDefinition before every write — the DB
// stores whatever JSON it is handed). Progress is COMPUTED on read from the
// underlying facts (check-ins, pulls, vip state); only claims are stored.
export const TaskDefinition = model.define('task_definition', {
  id: model.id().primaryKey(),
  kind: model.enum(['weekly', 'achievement']),
  title: model.text(),
  requirement: model.json(),
  reward: model.json(),
  active: model.boolean().default(true),
  sort: model.number().default(0),
});

export default TaskDefinition;
