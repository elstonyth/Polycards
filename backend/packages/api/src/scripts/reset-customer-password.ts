import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';

// Resets the emailpass password for an EXISTING storefront CUSTOMER — the
// customer-side twin of reset-admin-password.ts, and needed for the same
// reason: a DB cloned from prod carries prod's password hashes, so the seeded
// test customer can't be logged into locally (POST /auth/customer/emailpass
// answers 401 with the password everyone assumes is set).
//
// Logs identify the account by customer.id, never email: unlike the admin
// twin (operator's own email), this handles a CUSTOMER's email — PII that
// must not land in aggregated prod console logs.
// Local/operator tool only — it needs DB + container access, never an HTTP
// route. Reads CUST_EMAIL / CUST_PASSWORD from env; nothing is hardcoded.
// Run (from backend/packages/api):
//   CUST_EMAIL=test@pokenic.app CUST_PASSWORD='...' \
//     corepack yarn medusa exec ./src/scripts/reset-customer-password.ts
export default async function resetCustomerPassword({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const email = process.env.CUST_EMAIL;
  const password = process.env.CUST_PASSWORD;

  if (!email || !password) {
    logger.warn('RESET: CUST_EMAIL / CUST_PASSWORD not set — nothing to do');
    return;
  }

  const customerModule: any = container.resolve(Modules.CUSTOMER);
  const authService: any = container.resolve(Modules.AUTH);

  const [customer] = await customerModule.listCustomers({ email });
  if (!customer) {
    logger.warn('RESET: no customer with that email — sign up on the storefront instead');
    return;
  }

  // Same delete-then-register dance as the admin script, and the same
  // unavoidable window: emailpass keys provider_identity on entity_id=email, so
  // register() collides while the old identity exists, and the old hash can't be
  // restored (register needs plaintext). A failure in that window is LOUD and
  // FATAL so the operator knows to re-run immediately.
  const identities = await authService.listAuthIdentities(
    { provider_identities: { entity_id: email, provider: 'emailpass' } },
    { relations: ['provider_identities'] },
  );
  for (const identity of identities) {
    await authService.deleteAuthIdentities([identity.id]);
  }

  const { authIdentity, error } = await authService.register('emailpass', {
    body: { email, password },
  });
  if (error || !authIdentity) {
    const cause =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : JSON.stringify(error);
    throw new Error(
      `RESET: emailpass register FAILED after the old identity was deleted — ` +
        `customer ${customer.id} currently has NO login. Re-run this script immediately with ` +
        `the same CUST_PASSWORD to restore access. Cause: ${cause}`,
    );
  }
  // Re-link to the EXISTING customer row so the pull history, vault and wallet
  // survive — a fresh signup would strand all of it on the old customer id.
  await authService.updateAuthIdentities({
    id: authIdentity.id,
    app_metadata: { customer_id: customer.id },
  });

  logger.info(`RESET: password updated for customer ${customer.id}`);
}
