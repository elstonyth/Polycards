import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import {
  normalizeRealName,
  REAL_NAME_INVALID_ADMIN,
} from '../../../../../utils/real-name';

type Body = { real_name?: unknown; reason?: unknown };

// POST /admin/customers/:id/real-name — customer service corrects a player's
// real name (spec 2026-10-06). The customer sets it once and can never change
// it themselves (store/customers/me/real-name); this is the only other writer.
// Same validation as the customer's write, a mandatory reason, and an audit row
// in the same transaction. admin_id comes from the verified auth_context, never
// the body; admin routes are framework-auth-protected. A saved bank's holder is
// the real name (owner, 2026-11-16), so adminSetRealName carries the correction
// to the saved banks in the old name, and refuses a name a bank cannot carry.
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
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      REAL_NAME_INVALID_ADMIN,
    );
  }
  // A mistyped id must 404, not leave an orphan account-state row and an
  // audit row behind (retrieveCustomer throws NOT_FOUND).
  await req.scope
    .resolve<ICustomerModuleService>(Modules.CUSTOMER)
    .retrieveCustomer(customerId, { select: ['id'] });
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.adminSetRealName({
    customerId,
    adminId,
    realName,
    reason: reason.trim(),
  });
  res.json({ real_name: realName });
}
