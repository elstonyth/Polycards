import {
  ContainerRegistrationKeys,
  Modules,
} from '@medusajs/framework/utils';
import type {
  IAuthModuleService,
  ICustomerModuleService,
  INotificationModuleService,
  Logger,
  MedusaContainer,
} from '@medusajs/framework/types';
import { deleteFilesWorkflow } from '@medusajs/medusa/core-flows';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';

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

export type AccountDeletionResult =
  | { ok: true }
  | { ok: false; reason: string; detail: string };

// The single definition of "delete an account" — moved here verbatim from
// POST /store/customers/me/delete (store/customers/me/delete/route.ts) so an
// operator-initiated deletion (src/scripts/delete-customer-account.ts) can run
// the exact same sequence a customer's own self-service delete runs.
//
// Personal data is destroyed and login becomes impossible forever; the money
// records survive as anonymous books (see purgeAccountPacksData). The order
// below is load-bearing and governed by
// docs/adr/0006-account-deletion-destroys-pii-retains-anonymous-books.md — see
// the route for the full recovery-window rationale that order protects.
//
// This does NOT run the caller's proof-of-intent check (password
// verification, or an operator's own authorization) — that is the caller's
// responsibility, before this is invoked. It also does not log or throw on a
// preflight refusal; it returns `{ ok: false, reason, detail }` having
// written nothing, and it is the caller's job to log and surface that refusal
// however fits its own context (an HTTP error for the route, a non-zero exit
// for the script).
export async function purgeAndDeleteAccount(
  scope: MedusaContainer,
  customerId: string,
): Promise<AccountDeletionResult> {
  const logger = scope.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const auth = scope.resolve<IAuthModuleService>(Modules.AUTH);
  const customers = scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const notifications = scope.resolve<NotificationModuleWithDelete>(
    Modules.NOTIFICATION,
  );
  const packs = scope.resolve<PacksModuleService>(PACKS_MODULE);

  // 2. Settlement guards. `reason` is the whole client-facing contract: the
  //    framework's error handler sends only { code, type, message }, so a
  //    `detail` property on the error would be silently dropped. The sentence
  //    the customer reads comes from the storefront's DELETE_COPY map; the
  //    numbers live in the log line below, where support can find them.
  const preflight = await packs.deleteAccountPreflight(customerId);
  if (!preflight.ok) {
    return { ok: false, reason: preflight.reason, detail: preflight.detail };
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
  // Chunked: deleteNotifications is a generated MedusaService method that
  // hands the whole id array straight to one `DELETE ... WHERE id IN (...)`
  // (mikro-orm-repository.js's `delete`, no batching) — one bind param per
  // id against Postgres's 65,535-parameter ceiling. A heavy long-lived
  // account's notification history can exceed that in one statement.
  for (let i = 0; i < addressed.length; i += 1_000) {
    await notifications.deleteNotifications(
      addressed.slice(i, i + 1_000).map((n) => n.id),
    );
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
  //    load-bearing for what recovery there is (see the route header for its
  //    real, narrow shape).
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
    await deleteFilesWorkflow(scope)
      .run({ input: { ids: [avatarFileId] } })
      .catch((error) => {
        logger.error(
          `[account-delete] avatar file delete FAILED for ${customerId} — object ${avatarFileId} is now ORPHANED in the bucket and this log is the only surviving record of its id (${(error as Error).message})`,
        );
      });
  }

  return { ok: true };
}
