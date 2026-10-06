import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import {
  normalizeRealName,
  REAL_NAME_INVALID,
} from '../../../../../utils/real-name';

type Body = { real_name?: unknown; reason?: unknown };

// POST /admin/customers/:id/real-name — customer service corrects a player's
// real name (spec 2026-10-06). The customer sets it once and can never change
// it themselves (store/customers/me/real-name); this is the only other writer.
// Same validation as the customer's write, a mandatory reason, and an audit row
// in the same transaction. admin_id comes from the verified auth_context, never
// the body; admin routes are framework-auth-protected.
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.params.id;
  const adminId = req.auth_context.actor_id;
  const reason = req.body?.reason;
  if (
    typeof reason !== 'string' ||
    reason.trim() === '' ||
    reason.length > 500
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'A reason (1–500 chars) is required.',
    );
  }
  const realName = normalizeRealName(req.body?.real_name);
  if (!realName) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, REAL_NAME_INVALID);
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.adminSetRealName({
    customerId,
    adminId,
    realName,
    reason: reason.trim(),
  });
  res.json({ real_name: realName });
}
