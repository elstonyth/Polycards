import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

type Body = { reason?: unknown };

// POST /admin/customers/:id/disable — administrative LOGIN block (§4.2).
// Orthogonal to freeze: this does not touch the customer's funds. admin_id is
// derived from the verified auth_context (NEVER from the body). Admin routes
// are framework-auto-protected — no authenticate() middleware needed.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.params.id;
  const adminId = req.auth_context.actor_id;
  const reason = (req.body as Body)?.reason;
  if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 500) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'A reason (1–500 chars) is required.',
    );
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.setAccountDisabled({
    customerId,
    adminId,
    disabled: true,
    reason: reason.trim(),
  });
  res.json({ disabled: true });
}
