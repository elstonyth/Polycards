import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { IAuthModuleService } from '@medusajs/framework/types';

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
  const auth = req.scope.resolve<IAuthModuleService>(Modules.AUTH);
  const identities = await auth.listAuthIdentities(
    { app_metadata: { customer_id: customerId } },
    { relations: ['provider_identities'] },
  );
  const hasPassword = identities.some((identity) =>
    (identity.provider_identities ?? []).some(
      (provider) => provider.provider === 'emailpass',
    ),
  );
  res.json({ hasPassword });
}
