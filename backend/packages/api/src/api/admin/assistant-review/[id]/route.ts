import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ASSISTANT_MODULE } from '../../../../modules/assistant';
import type AssistantModuleService from '../../../../modules/assistant/service';
import { messageView } from '../../assistant/views';

// GET /admin/assistant-review/:id — any staff member's chat, whole, for the
// super admins' review page.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const assistant = req.scope.resolve<AssistantModuleService>(ASSISTANT_MODULE);
  const [conversation] = await assistant.listAssistantConversations(
    { id: req.params.id },
    { take: 1 },
  );
  if (!conversation) {
    res.status(404).json({ message: 'That conversation was not found.' });
    return;
  }
  const messages = await assistant.listAssistantMessages(
    { conversation_id: conversation.id },
    { order: { created_at: 'ASC' }, take: 500 },
  );
  res.json({
    conversation: {
      id: conversation.id,
      title: conversation.title,
      user_id: conversation.user_id,
    },
    messages: messages.map(messageView),
  });
}
