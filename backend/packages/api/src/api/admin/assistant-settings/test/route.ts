import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { ASSISTANT_MODULE } from '../../../../modules/assistant';
import { openKey } from '../../../../modules/assistant/key-vault';
import type AssistantModuleService from '../../../../modules/assistant/service';
import { accessFor } from '../../assistant/access';
import { keyInfo } from '../../assistant/openrouter';

// POST /admin/assistant-settings/test: checks the stored key with OpenRouter
// and answers its account (credit used and left), never the key. Super admins
// only, like the settings themselves.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (!accessFor(req.scope, req.auth_context).superAdmin) {
    res.status(403).json({ message: 'Only super admins test the AI key.' });
    return;
  }
  const s = await req.scope
    .resolve<AssistantModuleService>(ASSISTANT_MODULE)
    .settings();
  const secret = req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE)
    .projectConfig.http.jwtSecret as string;
  const key = s.openrouter_key_sealed
    ? openKey(s.openrouter_key_sealed, secret)
    : null;
  if (!key) {
    res.status(400).json({ message: 'No readable key is saved.' });
    return;
  }
  try {
    res.json({ ok: true, account: await keyInfo(key) });
  } catch (err) {
    res.json({ ok: false, message: (err as Error).message });
  }
}
