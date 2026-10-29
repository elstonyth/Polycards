import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ASSISTANT_MODULE } from '../../../../modules/assistant';
import type AssistantModuleService from '../../../../modules/assistant/service';
import { accessFor } from '../../assistant/access';
import { messageView } from '../../assistant/views';

const MAX_MESSAGES = 500;

// GET /admin/assistant-review/:id — any staff member's chat, its latest 500
// messages, for the super admins' review page. Checked here: RBAC's
// assistant_review:read also passes `*:read` (the desk bots).
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (!accessFor(req.scope, req.auth_context).superAdmin) {
    res.status(403).json({ message: 'Only super admins review chats.' });
    return;
  }
  const assistant = req.scope.resolve<AssistantModuleService>(ASSISTANT_MODULE);
  const [conversation] = await assistant.listAssistantConversations(
    { id: req.params.id },
    { take: 1, withDeleted: true },
  );
  if (!conversation) {
    res.status(404).json({ message: 'That conversation was not found.' });
    return;
  }
  // Newest first, one extra to tell whether older ones were left out.
  const newest = await assistant.listAssistantMessages(
    { conversation_id: conversation.id },
    {
      order: { created_at: 'DESC' },
      take: MAX_MESSAGES + 1,
      withDeleted: true,
    },
  );
  res.json({
    conversation: {
      id: conversation.id,
      title: conversation.title,
      user_id: conversation.user_id,
    },
    messages: newest.slice(0, MAX_MESSAGES).reverse().map(messageView),
    truncated: newest.length > MAX_MESSAGES,
  });
}
