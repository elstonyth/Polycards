import { model } from '@medusajs/framework/utils';

// One turn of a conversation. A user row holds the question (attachments
// counts the screenshots sent with it; their bytes are not kept). An
// assistant row holds the answer, the images it made (uploaded file URLs),
// the tools it ran (name, args, ok, ms) and what it cost on OpenRouter.
// A voice row is an answer read aloud (voice.ts): never shown, it only
// carries the cost, so speaking counts on the day it happens.
export const AssistantMessage = model
  .define('assistant_message', {
    id: model.id({ prefix: 'aimsg' }).primaryKey(),
    conversation_id: model.text(),
    role: model.enum(['user', 'assistant', 'voice']),
    content: model.text(),
    attachments: model.number().default(0),
    images: model.json().nullable(),
    tools: model.json().nullable(),
    model: model.text().nullable(),
    cost_usd: model.float().default(0),
    tokens_in: model.number().default(0),
    tokens_out: model.number().default(0),
    error: model.text().nullable(),
  })
  .indexes([
    {
      name: 'IDX_assistant_message_conversation_id',
      on: ['conversation_id', 'created_at'],
      where: 'deleted_at IS NULL',
    },
    {
      // The daily cap and the review read deleted rows too (withDeleted):
      // unscoped, as on assistant_conversation.
      name: 'IDX_assistant_message_conversation_role_all',
      on: ['conversation_id', 'role', 'created_at'],
      where: null as unknown as string,
    },
  ]);

export default AssistantMessage;
