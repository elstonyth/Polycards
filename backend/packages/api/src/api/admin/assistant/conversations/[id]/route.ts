import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ASSISTANT_MODULE } from '../../../../../modules/assistant';
import type AssistantModuleService from '../../../../../modules/assistant/service';
import { messageView } from '../../views';

// GET/DELETE /admin/assistant/conversations/:id — one of the asker's own
// chats. Someone else's answers 404, like one that does not exist.

async function own(req: AuthenticatedMedusaRequest) {
  const assistant = req.scope.resolve<AssistantModuleService>(ASSISTANT_MODULE);
  const [conversation] = await assistant.listAssistantConversations(
    { id: req.params.id, user_id: req.auth_context.actor_id },
    { take: 1 },
  );
  return { assistant, conversation };
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { assistant, conversation } = await own(req);
  if (!conversation) {
    res.status(404).json({ message: 'That conversation was not found.' });
    return;
  }
  // The newest 500, oldest first: a long chat must still show its latest.
  const messages = await assistant.listAssistantMessages(
    { conversation_id: conversation.id },
    { order: { created_at: 'DESC' }, take: 500 },
  );
  res.json({
    conversation: { id: conversation.id, title: conversation.title },
    messages: messages.reverse().map(messageView),
  });
}

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { assistant, conversation } = await own(req);
  if (!conversation) {
    res.status(404).json({ message: 'That conversation was not found.' });
    return;
  }
  await assistant.softDeleteAssistantConversations([conversation.id]);
  res.json({ id: conversation.id, deleted: true });
}
