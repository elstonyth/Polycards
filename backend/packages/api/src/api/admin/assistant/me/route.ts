import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ASSISTANT_MODULE } from '../../../../modules/assistant';
import type AssistantModuleService from '../../../../modules/assistant/service';
import { accessFor, allowedTools } from '../access';
import { TOOLS } from '../tools';

// GET /admin/assistant/me: what the assistant can do for the person asking —
// the chat page shows it ("you can ask about…") and picks its suggestions
// from it. Whether a key is set, never the key.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const access = accessFor(req.scope, req.auth_context);
  const tools = await allowedTools(access, TOOLS);
  const assistant = req.scope.resolve<AssistantModuleService>(ASSISTANT_MODULE);
  const settings = await assistant.settings();
  res.json({
    super_admin: access.superAdmin,
    key_set: !!settings.openrouter_key_sealed,
    chat_model: settings.chat_model,
    tools: tools.map((t) => ({ name: t.name, label: t.label })),
  });
}
