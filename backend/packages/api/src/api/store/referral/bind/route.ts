import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/types';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { findCustomerByHandle } from '../../../../utils/customer-by-handle';
import { HANDLE_RE } from '../../../../utils/profile-handle';

// POST /store/referral/bind { referrer_handle } — permanent one-shot
// attribution of the LOGGED-IN customer to the referrer whose handle they
// signed up through. The storefront fires this blind right after signup when
// an invite cookie is present, so every outcome is a 200 with a result body —
// only a malformed handle is a 400. Rate-limited in middlewares.ts.
export async function POST(
  req: AuthenticatedMedusaRequest<{ referrer_handle?: string }>,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const handle = req.body?.referrer_handle;
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'referrer_handle must be a valid profile handle.',
    );
  }

  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const referrer = await findCustomerByHandle(customers, handle);
  if (!referrer) {
    res.json({ bound: false, reason: 'referrer_not_found' });
    return;
  }

  // The signup-window fact the service needs and cannot read itself (the
  // packs module cannot see the customer module).
  const me = await customers.retrieveCustomer(customerId, {
    select: ['id', 'created_at'],
  });

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const result = await packs.bindReferral({
    customerId,
    referrerId: referrer.id,
    createdAt: new Date(me.created_at),
  });
  res.json(result);
}
