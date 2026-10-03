import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type {
  IAuthModuleService,
  ICustomerModuleService,
  INotificationModuleService,
} from '@medusajs/framework/types';
import { isResendConfigured } from '../../../../modules/resend/options';
import { GOOGLE_LINKED_TEMPLATE } from '../../../../modules/resend/templates';

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
// The actor link is `app_metadata.customer_id`, the exact shape of core's
// setAuthAppMetadataStep. The customer row is untouched. The account's
// password login is REMOVED (see the revoke below): from then on it is a
// Google account, gated the way one is (the phone-change route asks for the
// old-phone proof, and phone password-reset answers "signs in with Google").
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

  // Revoke the account's password login (operator decision 2026-09-30).
  // Signup never verifies an email, so anyone could have registered this
  // address with a password of their own; Google has just proven it, and a
  // password nobody proved must not survive into the owner's account (the
  // pre-hijack: the attacker would keep logging in with it, add a bank account
  // and cash out the owner's deposits). An owner who did set that password
  // simply signs in with Google from now on — the notice below says so.
  //
  // BEFORE the link, deliberately: once the Google identity carries the
  // customer id, core's callback resolves it directly and never sends it back
  // here — so a revoke that failed AFTER linking would never be retried, and
  // the password would outlive the link. Failing first leaves nothing linked;
  // the next Google sign-in comes back through this route and retries both.
  //
  // Only identities that are purely emailpass: a Google login is never
  // collateral.
  const linked = await auth.listAuthIdentities(
    { app_metadata: { customer_id: customer.id } },
    { relations: ['provider_identities'] },
  );
  const passwordLogins = linked.filter((i) => {
    const providers = (i.provider_identities ?? []).map((p) => p.provider);
    return providers.length > 0 && providers.every((p) => p === 'emailpass');
  });
  if (passwordLogins.length > 0) {
    await auth.deleteAuthIdentities(passwordLogins.map((i) => i.id));
  }

  await auth.updateAuthIdentities({
    id: identity.id,
    app_metadata: {
      ...(identity.app_metadata ?? {}),
      customer_id: customer.id,
    },
  });

  // Best-effort, after the link commits, and it NEVER throws — same stance as
  // the phone-change notice: the account change already happened.
  if (passwordLogins.length > 0 && isResendConfigured(process.env)) {
    try {
      await req.scope
        .resolve<INotificationModuleService>(Modules.NOTIFICATION)
        .createNotifications({
          to: email,
          channel: 'email',
          template: GOOGLE_LINKED_TEMPLATE,
          data: {},
        });
    } catch {
      // PRIVACY: customer id only — a provider's error text names the
      // recipient, so it is not interpolated.
      req.scope
        .resolve('logger')
        .warn(
          `[link-google] could not email the password-removed notice for customer ${customer.id}`,
        );
    }
  }
  res.json({ customer_id: customer.id });
}
