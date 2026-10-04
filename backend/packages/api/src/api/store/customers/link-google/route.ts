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
import { linkedEmailpassIdentity } from '../../../utils/linked-login';
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
// The link is the actor write core makes at registration
// (`app_metadata.customer_id`, the exact shape of setAuthAppMetadataStep), and
// the customer row is untouched. A password login on the account does not
// survive it (operator decision 2026-10-04): Google proved control of this
// mailbox and email signup never does, so that password may have been set by
// someone who never could. The account signs in with Google only from here and
// is gated like any Google-only account (the phone-change route's Google
// branches; the phone password reset refuses it).
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

  // The password login goes BEFORE the link, and the order is load-bearing.
  // Any failure up to the link leaves this Google identity unlinked, so the
  // customer's next "Continue with Google" comes back through this route and
  // finishes the job. Linking first could strand a linked Google sign-in next
  // to a surviving password: that next sign-in already carries the account
  // and never returns here. So a failed removal fails the request.
  const passwordLogin = await linkedEmailpassIdentity(req.scope, customer.id);
  if (passwordLogin) {
    // Hard deletes — utils/account-deletion.ts has why a soft-deleted
    // provider identity would hold its (entity_id, provider) slot forever.
    // Core's register gives each login an auth identity of its own, so this one
    // normally holds the password alone and goes whole (its provider identity
    // cascades). One that also holds another login keeps it: only the emailpass
    // provider identity goes.
    if (passwordLogin.identity.provider_identities?.length === 1)
      await auth.deleteAuthIdentities([passwordLogin.identity.id]);
    else await auth.deleteProviderIdentities([passwordLogin.provider.id]);
  }

  await auth.updateAuthIdentities({
    id: identity.id,
    app_metadata: { ...(identity.app_metadata ?? {}), customer_id: customer.id },
  });

  // Tell the account its password login is gone — the same mechanism and
  // logging rules as the phone-change notice
  // (store/phone-verification/change/route.ts). Best-effort, after the link,
  // and it NEVER throws: the link is already written, so failing here would
  // report a failed sign-in for one that worked.
  if (passwordLogin) {
    try {
      // Same predicate medusa-config.ts registers the provider on.
      if (isResendConfigured(process.env)) {
        const notifications = req.scope.resolve<INotificationModuleService>(
          Modules.NOTIFICATION,
        );
        await notifications.createNotifications({
          to: email,
          channel: 'email',
          template: GOOGLE_LINKED_TEMPLATE,
        });
      }
    } catch {
      // PRIVACY: customer id only. The provider's error text names the failed
      // recipient, so it is not interpolated either.
      req.scope
        .resolve('logger')
        .warn(
          `[link-google] could not email the password-removal notice for customer ${customer.id} — Google already linked`,
        );
    }
  }
  res.json({ customer_id: customer.id });
}
