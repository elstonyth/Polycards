import { model } from '@medusajs/framework/utils';

// One configurable task (spec 2026-08-24 Phase B). `kind` picks the cadence:
// weekly tasks reset on the task week (Mon 00:00 MYT — the player-facing
// week, deliberately NOT the Tuesday settlement week); achievements are
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
  // Optional run window, the same datetime-local pair the Weekly Challenge
  // schedule uses. null/null = runs from now until retired. Outside the
  // window a task is neither shown nor claimable; `active` stays the manual
  // kill switch on top of it.
  starts_at: model.dateTime().nullable(),
  ends_at: model.dateTime().nullable(),
});

export default TaskDefinition;
