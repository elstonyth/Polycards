import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from '@medusajs/framework/utils';
import type { IAuthModuleService, Logger } from '@medusajs/framework/types';
import { purgeAndDeleteAccount } from '../../../../utils/account-deletion';

/**
 * The emailpass identity for a customer, or null when they signed up with
 * Google only. Resolved through the AUTH IDENTITY rather than customer.email
 * for the same reason the login guard does it: nothing reconciles the customer
 * row's email column with provider_identities.entity_id.
 */
async function emailpassEntityId(
  auth: IAuthModuleService,
  customerId: string,
): Promise<string | null> {
  const identities = await auth.listAuthIdentities(
    { app_metadata: { customer_id: customerId } },
    { relations: ['provider_identities'] },
  );
  for (const identity of identities) {
    for (const provider of identity.provider_identities ?? []) {
      if (provider.provider === 'emailpass') return provider.entity_id;
    }
  }
  return null;
}

// POST /store/customers/me/delete — permanent, customer-initiated deletion.
//
// Personal data is destroyed and login becomes impossible forever; the money
// records survive as anonymous books (see purgeAccountPacksData).
//
// This is NOT one transaction, and pretending otherwise would mislead whoever
// reads it next: the purge spans the packs module, the customer module, the
// notification module, the auth module and the file provider, and a Medusa
// sharedContext covers one module only. What holds instead is ORDERING —
// everything that can still fail runs before the two irreversible steps, so a
// partial failure leaves the account in a state a human can finish from.
//
// Be honest about what recovery actually exists, because it is thinner than
// "just re-run it" suggests and this is a deletion path:
//   - There is NO automated retry. purgeAndDeleteAccount (api/utils/account-
//     deletion.ts) now has a second caller — the operator-run
//     scripts/delete-customer-account.ts — but that is a fresh one-shot
//     deletion an operator chooses to run, not a resume of a partial purge,
//     so a failed purge is still finished by hand.
//   - The customer cannot retry. Step 3 commits the account-state tombstone,
//     and from then on the blanket /store/* session guard 403s their bearer.
//   - An operator retry means: un-disable, reset the password, authenticate as
//     the customer. That works ONLY for a failure before step 6, because step 6
//     destroys the identity there would be anything to reset.
//   - RECOVERING an account instead of finishing the purge takes one more step
//     that has nothing to do with logging in: DELETE that customer's
//     `delete_account` row from admin_action_audit (written in step 3, inside
//     the packs transaction). It is not bookkeeping to tidy later — it is the
//     row `deletedCustomerIds` (modules/packs/service.ts) reads, and both paths
//     that consult it, settleChallengeWeek among them, SKIP every customer it
//     names. Leave it behind and the recovered account looks entirely alive —
//     it logs in, spins, deposits, withdraws — while weekly-challenge winnings
//     stop permanently, with no error and nothing on any surface that explains
//     why. Marking a half-purged
//     account as deleted is deliberate and correct; un-marking it is what makes
//     recovery real.
//   - A failure at or after step 6 needs manual intervention against the
//     database. Nothing in this codebase automates it.
// The step order below is what keeps the FIRST of those windows open; it is not
// a promise of self-healing.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const logger = req.scope.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const auth = req.scope.resolve<IAuthModuleService>(Modules.AUTH);

  // 1. Proof of intent. An account with a password must prove it; a Google-only
  //    account has none to prove, and the typed-DELETE confirmation in the UI is
  //    its only gate (accepted risk, recorded in the spec).
  const entityId = await emailpassEntityId(auth, customerId);
  if (entityId) {
    const password = (req.body as { password?: unknown } | null)?.password;
    if (typeof password !== 'string' || password === '') {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'PASSWORD_REQUIRED',
      );
    }
    // No cast: every field of AuthenticationInput is optional, so the body-only
    // shape typechecks as it stands — the same call the phone-change route
    // already makes at phone-verification/change/route.ts:151-153.
    const attempt = await auth.authenticate('emailpass', {
      body: { email: entityId, password },
    });
    if (!attempt.success) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'PASSWORD_INCORRECT',
      );
    }
  }

  // 2-8. Settlement guards, the packs/customer/notification/auth purge, and
  //    the best-effort avatar cleanup all live in purgeAndDeleteAccount
  //    (api/utils/account-deletion.ts) — the single definition of "delete an
  //    account", shared with the operator script
  //    (scripts/delete-customer-account.ts). It runs its own preflight and
  //    writes nothing when refused; `reason` is the whole client-facing
  //    contract in that case — the framework's error handler sends only
  //    { code, type, message }, so a `detail` property on the error would be
  //    silently dropped. The sentence the customer reads comes from the
  //    storefront's DELETE_COPY map; the numbers live in the log line below,
  //    where support can find them.
  const result = await purgeAndDeleteAccount(req.scope, customerId);
  if (!result.ok) {
    logger.info(
      `[account-delete] refused ${customerId}: ${result.reason} — ${result.detail}`,
    );
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, result.reason);
  }

  res.json({ deleted: true });
}
