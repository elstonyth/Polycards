import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { IAuthModuleService } from '@medusajs/framework/types';

// GET /store/customers/me/account — what the Settings page needs to render the
// Danger zone correctly before the customer clicks anything.
//
// `hasPassword` is false for a Google-only signup, which changes the delete
// modal: there is no password to ask for. Answering it up front is the
// difference between a correct form and a Delete button that always fails.
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
