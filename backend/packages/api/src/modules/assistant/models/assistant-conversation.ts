import { model } from '@medusajs/framework/utils';

// One chat thread of one admin user. Each user lists only their own; super
// admins read every thread on the review page.
export const AssistantConversation = model
  .define('assistant_conversation', {
    id: model.id({ prefix: 'aiconv' }).primaryKey(),
    user_id: model.text(),
    title: model.text(),
    last_message_at: model.dateTime(),
  })
  .indexes([
    {
      name: 'IDX_assistant_conversation_user_id',
      on: ['user_id', 'last_message_at'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default AssistantConversation;
