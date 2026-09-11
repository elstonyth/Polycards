import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type {
  IAuthModuleService,
  ICustomerModuleService,
} from '@medusajs/framework/types';

// POST /store/customers/link-google — attach a Google sign-in to the account
// that already holds its email.
//
// Medusa's registration (POST /store/customers with a register token) refuses
// an email that already has an account, and core has no linking step of its
// own. So a customer who registered with a password and later pressed
// "Continue with Google" was sent away to find that password (prod,
// 2026-09-10: two refusals in a minute, then a password login). The operator's
// rule is that a Google sign-in never needs a password, so the storefront
// calls this on that refusal instead.
//
// Why the register token is proof enough: the Google provider only issues an
// identity for an id_token whose `email_verified` is true, and copies that
// email into the provider identity's `user_metadata` — the same claim a
// password-reset email rests on. The email is read from THERE, never from the
// request body. An emailpass register token has no Google identity and is
// refused: signup never verifies its email.
//
// Only the actor link is written (`app_metadata.customer_id`, the exact shape
// of core's setAuthAppMetadataStep). The customer row is untouched, so a
// password account stays a password account — and stays gated the way one is
// (the phone-change route keeps asking it for the password).
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { actor_id, auth_identity_id } = req.auth_context ?? {};
  if (actor_id) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Request already authenticated as a customer.',
    );
  }
  if (!auth_identity_id) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const auth = req.scope.resolve<IAuthModuleService>(Modules.AUTH);
  const identity = await auth.retrieveAuthIdentity(auth_identity_id, {
    relations: ['provider_identities'],
  });
  const google = (identity.provider_identities ?? []).find(
    (provider) => provider.provider === 'google',
  );
  const rawEmail = google?.user_metadata?.email;
  if (typeof rawEmail !== 'string' || rawEmail.trim() === '') {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Only a Google sign-in can be linked to an existing account.',
    );
  }
  // Same normalization the storefront applies at signup, so this finds the
  // exact row whose existence made core refuse the registration.
  const email = rawEmail.trim().toLowerCase();

  const customers = req.scope.resolve<ICustomerModuleService>(
    Modules.CUSTOMER,
  );
  const [customer] = await customers.listCustomers(
    { email, has_account: true },
    { select: ['id'], take: 1 },
  );
  if (!customer) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'No account uses this email.',
    );
  }

  await auth.updateAuthIdentities({
    id: identity.id,
    app_metadata: { ...(identity.app_metadata ?? {}), customer_id: customer.id },
  });
  res.json({ customer_id: customer.id });
}
