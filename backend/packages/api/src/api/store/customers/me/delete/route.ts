import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from '@medusajs/framework/utils';
import type {
  IAuthModuleService,
  ICustomerModuleService,
  INotificationModuleService,
  Logger,
} from '@medusajs/framework/types';
import { deleteFilesWorkflow } from '@medusajs/medusa/core-flows';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

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

/**
 * INotificationModuleService declares create/retrieve/list only — the module
 * class extends MedusaService({ Notification }), which GENERATES the delete
 * methods, so the runtime has `deleteNotifications` while the published
 * interface does not. Widened here rather than casting to `any`.
 *
 * `deleteNotifications` (hard) and never `softDeleteNotifications`: a
 * soft-deleted row still holds the address and the payload, which is the whole
 * thing this step exists to remove.
 */
type NotificationModuleWithDelete = INotificationModuleService & {
  deleteNotifications(ids: string[]): Promise<void>;
};

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
//   - There is NO automated retry. This route is purgeAccountPacksData's only
//     caller — no admin route, no script entry point — so a failed purge is
//     finished by hand.
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
//     that consult it, payCommission's fan-out and settleChallengeWeek, SKIP
//     every customer it names. Leave it behind and the recovered account looks
//     entirely alive — it logs in, spins, deposits, withdraws — while referral
//     commission and weekly-challenge winnings stop permanently, with no error
//     and nothing on any surface that explains why. Marking a half-purged
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
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const notifications = req.scope.resolve<NotificationModuleWithDelete>(
    Modules.NOTIFICATION,
  );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

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

  // 2. Settlement guards. `reason` is the whole client-facing contract: the
  //    framework's error handler sends only { code, type, message }, so a
  //    `detail` property on the error would be silently dropped. The sentence
  //    the customer reads comes from the storefront's DELETE_COPY map; the
  //    numbers live in the log line below, where support can find them.
  const preflight = await packs.deleteAccountPreflight(customerId);
  if (!preflight.ok) {
    logger.info(
      `[account-delete] refused ${customerId}: ${preflight.reason} — ${preflight.detail}`,
    );
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, preflight.reason);
  }

  // 3. Packs-side scrub + delete + audit (one packs transaction, which re-runs
  //    the guards above under the credit advisory lock).
  await packs.purgeAccountPacksData(customerId);
  logger.info(`[account-delete] packs data purged for ${customerId}`);

  // 4. Notification rows. NOT keyed by customer_id — `notification.to` stores
  //    the recipient verbatim, and this app writes it under TWO conventions:
  //    the email channel addresses the EMAIL (subscribers/password-reset.ts:119,
  //    topup-receipt/withdrawal-receipt/saved-account-notice) and the in-app
  //    customer feed addresses the CUSTOMER ID (modules/packs/notify-feed.ts:39).
  //    Both are personal data — the feed payloads carry bank names and account
  //    last4, the email payloads carry reset URLs — so both are queried, and the
  //    "anonymous books" rationale does not reach either. Do NOT narrow this
  //    back to the email alone: that silently leaves the entire feed history,
  //    including the bank details the purge just scrubbed out of
  //    globepay_withdrawal, behind.
  //
  //    Read the address and delete them BEFORE the scrub below overwrites it.
  //    If this step fails the address is still intact, so a re-run finds the
  //    rows again.
  const { email } = await customers.retrieveCustomer(customerId);
  const addressed = await notifications.listNotifications({
    to: [email, customerId],
  });
  if (addressed.length > 0) {
    await notifications.deleteNotifications(addressed.map((n) => n.id));
  }
  logger.info(
    `[account-delete] ${addressed.length} notification(s) removed for ${customerId}`,
  );

  // 5. Customer-side. Addresses first, then the metadata blob — which holds the
  //    saved bank accounts, the public handle and the avatar — then the row's
  //    own identity columns.
  //
  //    The metadata clear MUST precede the soft delete: mutateCustomerMetadata
  //    is scoped `AND deleted_at IS NULL` and raises NOT_FOUND against an
  //    already-soft-deleted row.
  const addresses = await customers.listCustomerAddresses({
    customer_id: customerId,
  });
  if (addresses.length > 0) {
    await customers.deleteCustomerAddresses(addresses.map((a) => a.id));
  }
  // Boxed because the id is read inside the SAME callback that empties the
  // blob: a plain `let` assigned only in a callback narrows to `never` at the
  // `if` below, and re-reading the blob afterwards would find {} — on a retry
  // the avatar object would then never be deleted at all. The repo's own idiom
  // returns the previous id alongside the new blob
  // (store/profile/avatar/route.ts:43-58).
  const captured: { avatarFileId: string | null } = { avatarFileId: null };
  await packs.mutateCustomerMetadata({
    customerId,
    mutate: (metadata) => {
      captured.avatarFileId =
        typeof metadata.avatar_file_id === 'string'
          ? metadata.avatar_file_id
          : null;
      return {};
    },
  });
  await customers.updateCustomers(customerId, {
    // The scrub is required because the email IS personal data. It is NOT what
    // frees the address for a future signup — IDX_customer_email_has_account_
    // unique is partial (WHERE deleted_at IS NULL), so the soft delete below
    // already releases that slot.
    email: `deleted_${customerId}@removed.invalid`,
    first_name: null,
    last_name: null,
    phone: null,
    // Reachable despite never being a field we render: Medusa's stock store
    // validators accept company_name on create AND update, and
    // rejectCustomerMetadata only guards `metadata`. It names the person, so it
    // goes with the rest of them.
    company_name: null,
  });
  logger.info(`[account-delete] customer row scrubbed for ${customerId}`);

  // 6. Auth identities — the point of no return, and last among the steps that
  //    can still fail.
  //
  //    HARD delete, never softDeleteAuthIdentities:
  //    IDX_provider_identity_provider_entity_id on (entity_id, provider) has NO
  //    deleted_at predicate, so a soft-deleted identity would keep occupying
  //    the (email, 'emailpass') slot forever and lock this person out of ever
  //    signing up again. No deleteProviderIdentities follow-up is needed:
  //    provider_identity.auth_identity_id is ON DELETE CASCADE
  //    (@medusajs/auth Migration20240529080336), so the child rows go with it.
  //
  //    This is also why we do NOT use Medusa's own removeCustomerAccountWorkflow
  //    (core-flows/customer/workflows/remove-customer-account). That workflow
  //    only UNLINKS the identity — setAuthAppMetadataStep(value: null) — and
  //    leaves the provider_identity row, and with it the customer's email
  //    address, in the database permanently. For a flow whose entire purpose is
  //    erasing personal data that is the wrong outcome twice over: the email
  //    survives as PII, and its unique slot stays taken so the person can never
  //    register again.
  const identities = await auth.listAuthIdentities({
    app_metadata: { customer_id: customerId },
  });
  if (identities.length > 0) {
    await auth.deleteAuthIdentities(identities.map((i) => i.id));
  }
  logger.info(`[account-delete] auth identities removed for ${customerId}`);

  // 7. Soft-delete the customer row — AFTER the identities, and this order is
  //    load-bearing for what recovery there is (see the header for its real,
  //    narrow shape).
  //
  //    mutateCustomerMetadata (step 5) is scoped `AND deleted_at IS NULL`, so it
  //    raises NOT_FOUND against an already-soft-deleted row, and getCustomer()
  //    cannot read one either. Soft-deleting earlier would therefore turn a
  //    failure at step 6 from "hard to finish" into "impossible to finish
  //    through any code path at all". Last, so every step that can fail runs
  //    against a live row.
  await customers.softDeleteCustomers([customerId]);
  logger.info(`[account-delete] customer soft-deleted: ${customerId}`);

  // 8. Best-effort avatar cleanup. A file-provider outage must never be what
  //    fails an account deletion — same discipline as the avatar-replace path.
  //
  //    Swallowed, but NOT silent, and the log line is the entire point: step 5
  //    already emptied `metadata`, so the moment this catch returns the id
  //    exists NOWHERE — not on the customer row, not in the audit row, not in
  //    any other step's log. The object itself survives in the public Spaces
  //    bucket, addressable by URL, and it is a photograph of a person on a route
  //    whose whole contract is that the person does not survive. Logging the id
  //    is the only handle an operator has left to sweep the orphan with.
  if (captured.avatarFileId) {
    const avatarFileId = captured.avatarFileId;
    await deleteFilesWorkflow(req.scope)
      .run({ input: { ids: [avatarFileId] } })
      .catch((error) => {
        logger.error(
          `[account-delete] avatar file delete FAILED for ${customerId} — object ${avatarFileId} is now ORPHANED in the bucket and this log is the only surviving record of its id (${(error as Error).message})`,
        );
      });
  }

  res.json({ deleted: true });
}
