import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/types';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { findCustomerByReferralCode } from '../../../../utils/customer-by-handle';
import { normalizeReferralCode } from '../../../../utils/referral-code';

// POST /store/referral/bind { referrer_code } — permanent one-shot
// attribution of the LOGGED-IN customer to the referrer whose code they
// signed up with (typed into the form, or carried by the /r/<code> cookie).
// The storefront fires this right after signup, so every outcome is a 200
// with a result body — only a malformed code is a 400. Rate-limited in
// middlewares.ts.
export async function POST(
  req: AuthenticatedMedusaRequest<{ referrer_code?: unknown }>,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const code = normalizeReferralCode(req.body?.referrer_code);
  if (!code) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'referrer_code must be an 8-character referral code.',
    );
  }

  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const referrer = await findCustomerByReferralCode(customers, code);
  // A disabled referrer is hidden by the public lookup; the bind must agree,
  // or a code validated before the disable still attaches a downline to an
  // account the operator shut (review 2026-09-03).
  if (!referrer || (await packs.isAccountDisabled(referrer.id))) {
    res.json({ bound: false, reason: 'referrer_not_found' });
    return;
  }

  // The signup-window fact the service needs and cannot read itself (the
  // packs module cannot see the customer module).
  const me = await customers.retrieveCustomer(customerId, {
    select: ['id', 'created_at'],
  });

  const result = await packs.bindReferral({
    customerId,
    referrerId: referrer.id,
    createdAt: new Date(me.created_at),
  });
  res.json(result);
}
