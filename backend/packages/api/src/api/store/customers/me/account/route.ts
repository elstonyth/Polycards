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
// `hasPassword` is false for a Google-only signup, which changes the delete
// modal: there is no password to ask for. Answering it up front is the
// difference between a correct form and a Delete button that always fails.
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
  const [passwordLogin, groupPolicy, partnerBp] = await Promise.all([
    // The same definition the phone-change and phone password-reset routes act
    // on, so this answer and theirs cannot disagree (see linkedEmailpassLogin).
    linkedEmailpassLogin(req.scope, customerId),
    resolveGroupPolicyForCustomer(req.scope, customerId),
    packs
      .partnerBpForCustomers([customerId])
      .then((m) => m.get(customerId) ?? null),
  ]);
  const hasPassword = passwordLogin !== null;
  // Partner groups (spec 2026-09-09): what the account tree needs to skip the
  // phone modal and to replace the withdrawal form with a notice. Both are UX
  // — the backend gates (requirePhoneVerified, blockGroupWithdrawals) are the
  // enforcement, so a stale answer here can never move money.
  const policy = groupPolicy?.policy;
  res.json({
    hasPassword,
    policy: {
      partner: partnerBp !== null,
      withdrawals_blocked: policy?.withdrawals_blocked === true,
      verification_exempt: policy?.verification_exempt === true,
    },
  });
}
