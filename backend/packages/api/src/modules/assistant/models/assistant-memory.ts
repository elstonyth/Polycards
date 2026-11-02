import { model } from '@medusajs/framework/utils';

// What the assistant was asked to remember (owner, 2026-10-29: "it will
// search through its own memories"). A personal note is seen only by the
// staff member who saved it; a shared note — saved by a super admin — by
// everyone, e.g. "Crazy Sunday runs 10pm to midnight".
export const AssistantMemory = model
  .define('assistant_memory', {
    id: model.id({ prefix: 'aimem' }).primaryKey(),
    scope: model.enum(['user', 'shared']),
    user_id: model.text(),
    content: model.text(),
  })
  .indexes([
    {
      name: 'IDX_assistant_memory_scope_user',
      on: ['scope', 'user_id'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default AssistantMemory;
