import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import type { IFileModuleService } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
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
    // Voice rows only carry what reading aloud cost.
    { conversation_id: conversation.id, role: ['user', 'assistant'] },
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
  // Its stored speech (speak/route.ts) and the images drawn in it (public
  // files: a screenshot can carry customer data into one) go too. Best
  // effort: the chat is already gone for the asker either way.
  try {
    const rows = await assistant.listAssistantMessages(
      { conversation_id: conversation.id, role: ['voice', 'assistant'] },
      { select: ['tools', 'images'] },
    );
    const fileIds = rows
      .flatMap((r) => [
        (r.tools as { file_id?: unknown } | null)?.file_id,
        ...(Array.isArray(r.images)
          ? (r.images as { file_id?: unknown }[]).map((i) => i?.file_id)
          : []),
      ])
      .filter((f): f is string => typeof f === 'string');
    if (fileIds.length) {
      await req.scope
        .resolve<IFileModuleService>(Modules.FILE)
        .deleteFiles(fileIds);
    }
  } catch (err) {
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(
        `[assistant] stored speech or images not deleted: ${(err as Error)?.message}`,
      );
  }
  res.json({ id: conversation.id, deleted: true });
}
