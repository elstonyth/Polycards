import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { IAuthModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

// GET /store/customers/me/account — what the storefront needs to know about an
// account before it renders anything that depends on the account's state.
//
// `hasPassword` is false for a Google-only signup, which changes the delete
// modal: there is no password to ask for. Answering it up front is the
// difference between a correct form and a Delete button that always fails.
//
// `disabledCause` is how LOGIN learns to offer reactivation. It is answered here
// rather than inferred from a 403 elsewhere because inference is what already
// broke once: this route and GET /store/customers/me are both in the session
// guard's self-disable carve-out, so a self-disabled customer's login succeeds
// and no call on the login path fails in a way the storefront could read. Any
// scheme that watches for an incidental 403 (e.g. the one /store/profiles/me
// happens to return today) silently stops working the moment that path is
// carved out too — which this feature has now done twice. An explicit field
// cannot rot that way, and `self-service.unit.spec.ts` + the http spec pin it.
//
// The CAUSE, not a bare boolean: only a SELF disable may be offered
// reactivation, and `cause === 'self'` says that exactly. A boolean would make
// the caller reason "an admin-disabled session can't reach this route anyway,
// so true must mean self" — true today, and precisely the kind of implicit
// coupling described above.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const auth = req.scope.resolve<IAuthModuleService>(Modules.AUTH);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [identities, disabledCause] = await Promise.all([
    auth.listAuthIdentities(
      { app_metadata: { customer_id: customerId } },
      { relations: ['provider_identities'] },
    ),
    // Single source of truth, and it already fails closed: a disabled row with
    // a NULL cause resolves to 'admin', never to 'self'.
    packs.accountDisabledCause(customerId),
  ]);
  const hasPassword = identities.some((identity) =>
    (identity.provider_identities ?? []).some(
      (provider) => provider.provider === 'emailpass',
    ),
  );
  res.json({ hasPassword, disabledCause });
}
