import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import { linkedEmailpassLogin } from '../../../../utils/linked-login';
import type PacksModuleService from '../../../../../modules/packs/service';
import { resolveGroupPolicyForCustomer } from '../../../../../modules/packs/group-policy';

// GET /store/customers/me/account — what the storefront needs to know about an
// account before it renders anything that depends on the account's state.
//
// `hasPassword` is false for a Google-only account. The storefront raises its
// required-phone gate only for that password-less cohort: the phone-change
// route asks a password account for its password, and the gate has no field
// for it.
//
// Deliberately NOT a disabled/enabled read. Disabling is an ADMIN action only,
// and the session guard 403s a disabled customer on every /store route — so
// nothing the storefront renders for a live session can depend on it, and a
// field saying otherwise would invite exactly that.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [passwordLogin, groupPolicy, partnerBp, verification] =
    await Promise.all([
      // The same definition the phone-change and phone password-reset routes act
      // on, so this answer and theirs cannot disagree (see linkedEmailpassLogin).
      linkedEmailpassLogin(req.scope, customerId),
      resolveGroupPolicyForCustomer(req.scope, customerId),
      packs
        .partnerBpForCustomers([customerId])
        .then((m) => m.get(customerId) ?? null),
      packs.getVerificationState(customerId),
    ]);
  const hasPassword = passwordLogin !== null;
  // Partner groups (spec 2026-09-09): what the account tree needs to skip the
  // phone modal and to replace the withdrawal form with a notice. Both are UX
  // — the backend gates (requirePhoneVerified, blockGroupWithdrawals) are the
  // enforcement, so a stale answer here can never move money.
  const policy = groupPolicy?.policy;
  res.json({
    hasPassword,
    // Real name + phone lock (spec 2026-10-06). `realName` is the caller's OWN
    // name (this route is bearer-authed to the account it describes): the
    // account layout raises the real-name gate when it is null, and Settings
    // shows it read-only once set. `phoneVerified` decides whether Settings
    // still offers the add/verify flow — a verified phone is locked, and the
    // change route refuses it (store/phone-verification/change).
    realName: verification.realName,
    phoneVerified: verification.phoneVerified,
    policy: {
      partner: partnerBp !== null,
      withdrawals_blocked: policy?.withdrawals_blocked === true,
      verification_exempt: policy?.verification_exempt === true,
    },
  });
}
