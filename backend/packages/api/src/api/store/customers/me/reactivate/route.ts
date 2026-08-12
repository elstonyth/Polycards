import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

const DISABLED_MESSAGE =
  'This account has been disabled. Please contact support.';

// POST /store/customers/me/reactivate — lifts a customer's OWN disable.
//
// The one path the session guard lets a self-disabled bearer reach. It
// re-checks the cause itself rather than trusting that carve-out, so an admin
// disable can never be lifted here even if the guard were rewired: an admin
// block is a support decision and only /admin/customers/:id/enable undoes it.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const cause = await packs.accountDisabledCause(customerId);
  if (cause === 'admin') {
    throw new MedusaError(MedusaError.Types.FORBIDDEN, DISABLED_MESSAGE);
  }
  // Already active — idempotent success, so a retry or a double-submit from the
  // login prompt is not an error.
  if (cause === null) {
    res.json({ disabled: false });
    return;
  }
  await packs.setAccountDisabled({
    customerId,
    adminId: customerId,
    disabled: false,
    reason: 'Customer reactivated their own account.',
    cause: 'self',
  });
  res.json({ disabled: false });
}
