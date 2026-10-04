import { Modules } from '@medusajs/framework/utils';
import type {
  AuthIdentityDTO,
  IAuthModuleService,
  ProviderIdentityDTO,
} from '@medusajs/framework/types';

/**
 * The email+password login LINKED to this customer — its provider entity_id —
 * or null for an account with no password (a Google signup, or an account
 * store/customers/link-google has attached Google to).
 *
 * "Linked" means the auth identity's app_metadata.customer_id is this
 * customer. Matching on the customer's email instead also finds an UNLINKED
 * emailpass identity that anyone registered with that address — an email
 * signup attempted on a Google account's address leaves exactly that behind
 * (register succeeds, POST /store/customers then 422s). Such an identity signs
 * into nothing, but the email match treated it as this account's password:
 * on 2026-09-30 three Google users were asked for a password they never had
 * (a modal with no password field, one SMS per retry), and a session thief
 * could have registered one to skip the old-phone proof on a phone change.
 *
 * One definition for every "does this account have a password" question, so
 * the storefront (GET /store/customers/me/account `hasPassword`) and the
 * routes that act on the answer can never disagree again.
 */
export async function linkedEmailpassLogin(
  scope: { resolve: <T>(key: string) => T },
  customerId: string,
): Promise<string | null> {
  return (
    (await linkedEmailpassIdentity(scope, customerId))?.provider.entity_id ??
    null
  );
}

/**
 * The same password login as linkedEmailpassLogin, as the rows that hold it:
 * its auth identity (with every provider identity on it) and the emailpass
 * provider identity itself — for store/customers/link-google, which removes it.
 */
export async function linkedEmailpassIdentity(
  scope: { resolve: <T>(key: string) => T },
  customerId: string,
): Promise<{
  identity: AuthIdentityDTO;
  provider: ProviderIdentityDTO;
} | null> {
  const auth = scope.resolve<IAuthModuleService>(Modules.AUTH);
  const identities = await auth.listAuthIdentities(
    { app_metadata: { customer_id: customerId } },
    { relations: ['provider_identities'] },
  );
  for (const identity of identities) {
    for (const provider of identity.provider_identities ?? []) {
      if (provider.provider === 'emailpass') return { identity, provider };
    }
  }
  return null;
}
