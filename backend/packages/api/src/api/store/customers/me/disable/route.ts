import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

// POST /store/customers/me/disable — the customer's own reversible disable.
//
// Orthogonal to the admin §4.2 lever and to `frozen`: this touches no funds and
// no admin state, it only blocks the account until the customer logs back in
// and reactivates. Idempotent — disabling an already-self-disabled account is a
// no-op success, because a double-submit must not be an error.
//
// An ADMIN-disabled customer never reaches this handler: the blanket /store/*
// session guard rejects their request first.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // adminId carries the customer's own id: the audit row records who acted, and
  // for a self-service action that is the customer. The reason string is what
  // support sees in the audit timeline, so it says plainly that this was not an
  // operator action.
  await packs.setAccountDisabled({
    customerId,
    adminId: customerId,
    disabled: true,
    reason: 'Customer disabled their own account.',
    cause: 'self',
  });
  res.json({ disabled: true });
}
