import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { DISABLED_MESSAGE } from '../../../../utils/disabled-guard';

// POST /store/customers/me/disable — the customer's own reversible disable.
//
// Orthogonal to the admin §4.2 lever and to `frozen`: this touches no funds and
// no admin state, it only blocks the account until the customer logs back in
// and reactivates.
//
// A repeat /disable never reaches this handler at all: once the account is
// self-disabled, the blanket /store/* session guard lets that bearer through to
// /store/customers/me/reactivate and nothing else, so a second submit is a 403
// ACCOUNT_SELF_DISABLED rather than a second write.
//
// An ADMIN-disabled customer never reaches this handler either: the same guard
// rejects their request first.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // Defence in depth, and NOT dead code — do not delete it as unreachable.
  // Unreachable is a property of the session guard's ordering, not of this
  // route: the guard 403s any disabled customer first, so `cause` is null here
  // today. But the write below stamps disabled_cause='self' UNCONDITIONALLY, so
  // an admin-disabled customer who ever did reach this handler would launder
  // their admin ban into a self ban and then lift it via /reactivate — a
  // privilege escalation out of a support decision. Granting only on null (not
  // disabled) or 'self' (already self-disabled, a harmless re-stamp) closes
  // that, and mirrors the independent re-check the sibling reactivate route
  // already performs for the same reason.
  const cause = await packs.accountDisabledCause(customerId);
  if (cause !== null && cause !== 'self') {
    throw new MedusaError(MedusaError.Types.FORBIDDEN, DISABLED_MESSAGE);
  }
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
