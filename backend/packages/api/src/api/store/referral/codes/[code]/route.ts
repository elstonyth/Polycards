import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/types';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import {
  publicProfileFields,
  seedOf,
} from '../../../../../utils/profile-handle';
import {
  findBindableReferrer,
  normalizeReferralCode,
} from '../../../../../utils/referral-code';

// GET /store/referral/codes/:code — PUBLIC "does this code belong to someone"
// check behind the /r/<code> link and the signup form's code field. Answers
// with the referrer's public display fields only (the same name + handle the
// leaderboard prints — never email or id). Everything else is a 404, a
// disabled account included (findBindableReferrer), so a dead code fails at
// the link where the visitor can see it rather than silently inside the
// post-signup bind. IP rate-limited in middlewares.ts.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const notFound = () =>
    new MedusaError(MedusaError.Types.NOT_FOUND, 'Referral code not found');

  const code = normalizeReferralCode(req.params.code);
  if (!code) throw notFound();

  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const referrer = await findBindableReferrer(customers, packs, code);
  if (!referrer) throw notFound();

  const { name, handle } = publicProfileFields(referrer, seedOf(referrer.id));
  res.json({ code, name, handle });
}
