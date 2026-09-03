import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { generateReferralCode } from '../../../utils/referral-code';
import { ensureProfileHandleWorkflow } from '../../../workflows/ensure-profile-handle';

// GET /store/referral — the logged-in customer's referral panel: their
// referral code (the storefront composes the /r/<code> link and QR from it),
// their profile handle, live this-week downline turnover, the tier rate that
// turnover currently lands on, the projected Wednesday payout, and settled
// history. Handle and code are both lazily ensured, same as
// GET /store/profiles/me.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // Both metadata writers go through the per-customer advisory lock, so
  // running them side by side cannot lose a key.
  const [{ result }, code, summary] = await Promise.all([
    ensureProfileHandleWorkflow(req.scope).run({
      input: { customer_id: customerId },
    }),
    packs.assignReferralCode({ customerId, generate: generateReferralCode }),
    packs.referralStorefrontSummary({ customerId }),
  ]);

  res.json({ handle: result.handle, code, ...summary });
}
