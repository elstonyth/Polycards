import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ASSISTANT_MODULE } from '../../../../modules/assistant';
import type AssistantModuleService from '../../../../modules/assistant/service';

// GET /admin/assistant/conversations: the asker's own chats, newest first.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const assistant = req.scope.resolve<AssistantModuleService>(ASSISTANT_MODULE);
  const conversations = await assistant.listAssistantConversations(
    { user_id: req.auth_context.actor_id },
    { order: { last_message_at: 'DESC' }, take: 50 },
  );
  res.json({
    conversations: conversations.map((c) => ({
      id: c.id,
      title: c.title,
      last_message_at: c.last_message_at,
    })),
  });
}
