import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { accessFor } from '../access';
import { ConfirmRefused, openProposal, saveProposal } from '../confirm';

// POST /admin/assistant/confirm {token}: the person taps Save on a note or a
// scheduled task the assistant proposed (confirm.ts). Only their own, only
// within 30 minutes; checked again as their roles stand now.

type Body = { token?: unknown };

export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const access = accessFor(req.scope, req.auth_context);
  const config = req.scope.resolve(
    ContainerRegistrationKeys.CONFIG_MODULE,
  ).projectConfig;
  const proposal = openProposal(
    req.body?.token,
    access.userId,
    config.http.jwtSecret as string,
  );
  if (!proposal) {
    res.status(400).json({
      code: 'confirm_expired',
      message: 'This has expired or is not yours to save. Ask again.',
    });
    return;
  }
  try {
    const saved = await saveProposal(proposal, access, req.scope);
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .info(
        `[assistant] confirmed ${proposal.kind} user=${access.userId} id=${saved.id}`,
      );
    res.json({
      saved: true,
      kind: proposal.kind,
      id: saved.id,
      next_run_at: saved.next_run_at ?? null,
    });
  } catch (err) {
    if (err instanceof ConfirmRefused) {
      res.status(400).json({ code: 'confirm_refused', message: err.message });
      return;
    }
    throw err;
  }
}
