import { model } from '@medusajs/framework/utils';

// A task the assistant runs by itself on a schedule (owner, 2026-10-29:
// "make sure it is able to do the scheduled tasks" — what the Growth desk's
// 12am top hits and Monday posts did on Discord). It runs as the staff member
// who set it, with their roles at run time, and its answers land in one chat
// of theirs. Times are Malaysia time.
export const AssistantSchedule = model
  .define('assistant_schedule', {
    id: model.id({ prefix: 'aisch' }).primaryKey(),
    user_id: model.text(),
    title: model.text(),
    instruction: model.text(),
    every: model.enum(['day', 'week']),
    // 'HH:MM', Malaysia time.
    at_time: model.text(),
    // 1 = Monday … 7 = Sunday, for weekly ones.
    weekday: model.number().nullable(),
    enabled: model.boolean().default(true),
    next_run_at: model.dateTime(),
    last_run_at: model.dateTime().nullable(),
    last_error: model.text().nullable(),
    // Where the answers go; made on the first run.
    conversation_id: model.text().nullable(),
  })
  .indexes([
    {
      name: 'IDX_assistant_schedule_due',
      on: ['enabled', 'next_run_at'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default AssistantSchedule;
