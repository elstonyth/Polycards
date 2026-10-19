import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { generateReferralCode } from '../../../utils/referral-code';
import { ensureProfileHandleWorkflow } from '../../../workflows/ensure-profile-handle';
import { listReferralFriends } from './friends';

// GET /store/referral — the logged-in customer's referral panel: their
// referral code (the storefront composes the /r/<code> link and QR from it),
// their profile handle, live this-week downline turnover, the tier rate that
// turnover currently lands on, the projected Wednesday payout, and settled
// history, plus the friends they invited (public names only, see friends.ts).
// Handle and code are both lazily ensured, same as GET /store/profiles/me.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // ONE instant for the week totals and each friend's week spend, so a read
  // across the Tuesday 00:00 MYT cutover cannot mix two weeks.
  const now = new Date();
  // Two writers, disjoint global locks: the handle workflow writes first_name
  // under `username:alloc` and then metadata.handle under
  // `profile_handle:alloc` + `metadata:<id>`; assignReferralCode writes
  // metadata under `referral_code:alloc` + `metadata:<id>`. Every metadata
  // write re-reads the blob inside `metadata:<id>`, and each takes its global
  // lock BEFORE that one, so running them side by side cannot lose either
  // write or deadlock.
  const [{ result }, code, summary, friends] = await Promise.all([
    ensureProfileHandleWorkflow(req.scope).run({
      input: { customer_id: customerId },
    }),
    packs.assignReferralCode({ customerId, generate: generateReferralCode }),
    packs.referralStorefrontSummary({ customerId, now }),
    listReferralFriends(req.scope, { customerId, now }),
  ]);

  res.json({ handle: result.handle, code, ...summary, friends });
}
