import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import { ASSISTANT_MODULE } from '../../../modules/assistant';
import type AssistantModuleService from '../../../modules/assistant/service';
import { accessFor } from '../assistant/access';

// GET /admin/assistant-review (spec 2026-10-29, the owner's "review all the
// questions users ask"): every staff member's chats, newest first, with who
// asked and what each cost. Super admins only: checked here, because RBAC's
// assistant_review:read also passes `*:read` (the desk bots).
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (!accessFor(req.scope, req.auth_context).superAdmin) {
    res.status(403).json({ message: 'Only super admins review chats.' });
    return;
  }
  // Whole numbers: Medusa drops a `take` that is not one and loads every row.
  const limit = Math.min(
    Math.max(Math.trunc(Number(req.query.limit)) || 50, 1),
    200,
  );
  const offset = Math.max(Math.trunc(Number(req.query.offset)) || 0, 0);
  const assistant = req.scope.resolve<AssistantModuleService>(ASSISTANT_MODULE);
  const [conversations, count] =
    await assistant.listAndCountAssistantConversations(
      {},
      {
        order: { last_message_at: 'DESC' },
        take: limit,
        skip: offset,
        // Chats staff deleted stay here: the owner reviews every question.
        withDeleted: true,
      },
    );
  const ids = conversations.map((c) => c.id);
  const messages = ids.length
    ? await assistant.listAssistantMessages(
        { conversation_id: ids },
        {
          select: ['conversation_id', 'role', 'cost_usd', 'error'],
          withDeleted: true,
        },
      )
    : [];
  const userIds = [...new Set(conversations.map((c) => c.user_id))];
  const users = userIds.length
    ? await req.scope
        .resolve(Modules.USER)
        .listUsers({ id: userIds }, { select: ['id', 'email'] })
    : [];
  const email = new Map(users.map((u) => [u.id, u.email]));
  res.json({
    count,
    limit,
    offset,
    conversations: conversations.map((c) => {
      const own = messages.filter((m) => m.conversation_id === c.id);
      return {
        id: c.id,
        title: c.title,
        user_id: c.user_id,
        user_email: email.get(c.user_id) ?? null,
        questions: own.filter((m) => m.role === 'user').length,
        failed: own.filter((m) => m.role === 'assistant' && m.error).length,
        cost_usd: own.reduce((sum, m) => sum + Number(m.cost_usd ?? 0), 0),
        last_message_at: c.last_message_at,
        deleted: !!c.deleted_at,
      };
    }),
  });
}
