# Customer Self-Service: Disable Account & Delete Account

**Date:** 2026-08-13
**Status:** Approved
**Scope:** Storefront (customer-facing) self-service. Admin disable/enable (POLYCARD-BACK §4.2) already exists and is untouched except for the `disabled_cause` backfill.

## Summary

Two new customer-facing account functions, surfaced in the account Settings page:

- **Disable account** — reversible. The customer disables their own account; logging back in with the correct password offers a one-click reactivation.
- **Delete account** — permanent. The customer's personal data is purged, personal data inside retained financial rows is scrubbed to a minimum, and login becomes impossible forever. Money records (amounts, statuses, gateway ids, timestamps) are retained as anonymous books.

Decisions made during brainstorming:

| Question                           | Decision                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| Actor                              | Customer self-service (admin disable already shipped)                              |
| Delete data scope                  | Delete personal data, keep the business books                                      |
| PII inside retained financial rows | Scrub to minimum (account number → last4, holder name and shipping address nulled) |
| Delete guards                      | Block until settled (zero balance, nothing pending, no unsettled cards)            |
| Re-enable path for self-disable    | Log in with the correct password → explicit "reactivate?" confirm                  |
| Delete confirmation UX             | Re-enter password + type `DELETE`, immediate execution                             |
| Google-only accounts (no password) | Typed-`DELETE` only, no password step (see Residual risk)                          |
| Reversibility                      | Disable: reversible by the customer. Delete: irreversible, even by an admin        |

## 1. Data model

`customer_account_state` (backend/packages/api/src/modules/packs/models/customer-account-state.ts) gains one column:

- `disabled_cause: enum('admin', 'self').nullable()` — mirrors the existing `cause` column used by `frozen`.

Migration: add the column; backfill `disabled_cause = 'admin'` for every existing row with `disabled = true` (every current disable is admin-made — there is no self-disable path yet).

`setAccountDisabled` gains a `cause` input. The admin disable route passes `'admin'`; the new self-disable path passes `'self'`. Its existing advisory lock, audit row, and single-transaction discipline are unchanged.

**`disabled_cause` reads fail closed.** Every guard tests `cause === 'self'` to grant the self-disabled behavior, never `cause === 'admin'` to deny it. A NULL cause (backfill miss, a future writer, a race) must behave as an admin disable — a full block — not as a login bypass.

## 2. Backend routes (store API, session-authenticated)

### POST /store/customers/me/disable

- Calls `setAccountDisabled({ customerId, cause: 'self', disabled: true })`. The actor is the customer, taken from `auth_context.actor_id`, never from the body.
- **Not idempotent, and it does not need to be.** A second call rewrites `disabled_at` and appends another audit row — it is not a no-op, and claiming otherwise would be a property the code does not have. It is also unreachable: once the account is self-disabled the session guard allows exactly one path, `/reactivate`, so a repeat `/disable` never reaches the handler.
- An admin-disabled account never reaches this route — the session guard blocks it first.

### POST /store/customers/me/reactivate

- Writes only when the account is self-disabled. The three states are distinct, and conflating the last two is a real bug:
  - **not disabled at all** (`accountDisabledCause` returns `null`) — 200 `{ disabled: false }`, no write. This is NOT an error case: an admin can re-enable the account between the customer's login and their tap on the reactivate confirm, and answering that with "contact support" would strand a customer whose account is already working. It also makes a double-submit harmless.
  - **self-disabled** (`'self'`) — the write happens.
  - **anything else** (`'admin'` today, and any cause value a future release adds) — 403 with the existing support message.
- The test is `!== 'self'` to refuse, never `=== 'admin'` to refuse. Denying only the value you can name and allowing the rest is a fail-OPEN: an unexpected cause would reactivate the account. That bug was written and caught during implementation, so it is worth stating plainly rather than leaving to the reader.
- Clears `disabled`, `disabled_cause`, `disabled_at`; writes an audit row.
- This is the ONLY /store route a self-disabled session may call (see §3).

### POST /store/customers/me/delete

Body: `{ password?: string }`. Steps, in order:

1. **Proof of intent.**
   - Accounts with an emailpass identity: re-verify `password` against that identity. A wrong password fails here and nothing else runs.
   - Google-only accounts (no emailpass identity): no password step; the typed-`DELETE` confirmation is the only gate. See Residual risk.
2. **Settlement guards** — all must pass. Each failure returns 400 with a machine-readable `reason` code plus the human copy, so the UI renders a specific instruction rather than a generic error:
   - `BALANCE_NOT_ZERO` — the **raw ledger balance** must be exactly `0`. Read it as `SUM(ROUND(amount * 100))` over `credit_transaction` for the customer, the same scan `availableBalance` uses internally. **Do NOT call `availableBalance()`**: it returns 0 for a frozen account and also subtracts `lockedCommissionCents`, so a frozen account holding funds — or one whose balance exactly equals its locked commission — would read as 0 and pass a naive guard. The test is `!== 0`, not `> 0`: a clawback-negative account owes money and must not be able to delete its way out of the debt.
   - `WITHDRAWAL_PENDING` — no `globepay_withdrawal` in status `pending` or `held`.
   - `DEPOSIT_PENDING` — no `globepay_deposit` in a non-terminal status: `pending` **or `expired`**. Production credits deposits via the reconcile sweep, so one can land hours after a delete and credit a scrubbed account — and the sweep re-reads `expired` rows and flips them to `settled`, so `expired` means "not landed yet", not "finished". Filtering on `pending` alone lets the exact failure through: transfer doesn't land, row expires, customer deletes at balance 0, transfer arrives, sweep credits an ownerless account.
   - `CARDS_UNSETTLED` — no `pull` in status `vaulted` or `delivering`. A vaulted pull is an owned asset the customer can still sell for credits.
   - `DELIVERY_IN_FLIGHT` — no `delivery_order` in a non-terminal status (anything other than `completed` / `canceled`). Nothing may still be shipping to an address that is about to be erased.
3. **Purge — ordered and idempotent, NOT one transaction.** The purge spans four separate systems (the packs module, the customer module, the auth module, and the file provider). A Medusa `sharedContext` transaction covers one module only, so a single all-or-nothing transaction across them is not achievable, and a workflow's compensation cannot un-delete a purge. Claiming atomicity here would be a lie an implementer would then rely on.

   What is guaranteed instead: **each module's own writes are transactional**, the steps run in a fixed order chosen so the most failure-prone step is last and harmless, and the whole route is **idempotent** so a partial failure can simply be re-run. The order is load-bearing:

   1. Packs-module scrub — financial-row PII, `player_payout_details` delete, `notification_read` delete, and the `customer_account_state` **tombstone**. One packs transaction, and it re-runs the settlement guards inside its own advisory lock (see §5).
   2. Delete the `notification` rows addressed to the customer's email — read the address FIRST, because the scrub in the next step overwrites the only thing that finds them. This is a notification-module write, not part of the packs transaction: the packs module service has no container and cannot reach that module. If this step fails the address is still intact, so a re-run finds the rows again.
   3. Customer-module writes — delete addresses, clear `metadata` via `mutateCustomerMetadata`, scrub `email`/names/`phone`.
   4. Hard-delete the auth identities. The point of no return for logging in, and the last step that can still fail.
   5. **Soft-delete the customer row — last.** `mutateCustomerMetadata` is scoped `AND deleted_at IS NULL` and raises NOT_FOUND against a soft-deleted row, so soft-deleting any earlier would make a failure at step 4 unrecoverable: the re-run would die at step 3, and the customer could not even reach the page to trigger it, because `getCustomer()` cannot read a soft-deleted row either. Keeping it last is what makes every preceding step run against a live, still-loginable row.
   6. Best-effort delete of the avatar file object, failure swallowed (`.catch(() => undefined)`, the same discipline the avatar-replace cleanup already uses). A file-provider outage must never be what fails an account deletion.

   A failure anywhere before step 4 leaves a scrubbed but still-loginable account, which the customer can simply retry. A failure at step 5 is recoverable only **within the current token's TTL**: the identities are already gone, so the retry has to ride the bearer that was minted before the delete (JWT auth is pure verification with no DB lookup, and the framework default TTL is one day). Do NOT reorder the steps to "fix" that — soft-delete-last is what keeps every step that can fail running against a live row. The route logs at every step boundary so a partial run is diagnosable rather than silent.

   **Not Medusa's `removeCustomerAccountWorkflow`.** The stock workflow (`core-flows/customer/workflows/remove-customer-account`) only _unlinks_ the auth identity — `setAuthAppMetadataStep(value: null)` — and leaves the `provider_identity` row, and with it the customer's email address, in the database permanently. For a flow whose whole purpose is erasing personal data that fails twice: the email survives as PII, and its unique slot stays occupied so the person can never register again. Its `app_metadata: { customer_id }` filter shape is, however, the officially supported one and is what this route reuses to find the identities.

   **Deleted outright:**
   - Medusa customer addresses.
   - `player_payout_details` (pure PII, no money on the row).
   - `notification_read` rows.
   - `notification` rows addressed to the customer's email. `notification.to` stores the address verbatim on every email we send (password reset — which also puts the reset URL in `data` — withdrawal and top-up receipts, the saved-account notice with `bank_name` + `account_last4`, phone-verification). They are keyed by email, not `customer_id`, so the "anonymous books" rationale does not reach them: they are the personal data, not a reference to it. The email must therefore be read BEFORE the customer-row scrub overwrites it.
   - The avatar file object in Spaces (from `metadata.avatar_file_id`) — the stored object itself, not just the id.
   - The `delivery_order` `proof_images` references. A doorstep proof photo can show the shipping label or the recipient, which re-exposes exactly what the `ship_*` scrub removes, so the column is nulled with the rest of the shipping fields. **The stored objects themselves are not deleted, and cannot be from here:** the column holds admin-typed http(s) URLs, not file-provider ids (`api/admin/delivery-orders/validate.ts:126`), so there is nothing to hand the file workflow, and guessing an id from a URL path would risk deleting an unrelated object when the URL is external. An object hosted in our own bucket needs an operator sweep. This is the one item on this list where our copy of the reference goes but the artefact may not.
   - All auth identities for the customer: emailpass and google, via **`deleteAuthIdentities`**. No `deleteProviderIdentities` follow-up is needed: `provider_identity.auth_identity_id` is `ON DELETE CASCADE` (`@medusajs/auth` `Migration20240529080336`), so deleting the identity takes its provider rows — and the `(entity_id, provider)` slot — with it.

     **This must be the hard delete, never `softDeleteAuthIdentities`.** `MedusaService` generates `delete*` (hard) and `softDelete*` (soft) as separate methods. The `provider_identity` unique index — `IDX_provider_identity_provider_entity_id` on `(entity_id, provider)` — carries **no `WHERE deleted_at IS NULL` predicate**, so a soft-deleted identity keeps occupying the `(email, 'emailpass')` slot forever and the same person could never sign up again. Verified in the installed `@medusajs/auth` migration and model.

   **Scrubbed on the customer row:**
   - `email` → `deleted_<customer_id>@removed.invalid`.
   - `first_name`, `last_name`, `phone` → null.
   - `metadata` → cleared. **This blob is where the personal data actually lives**: `bank_accounts` (saved payout destinations, with full account numbers), `handle` (public profile identity), `avatar_file_id`, `avatar_url`, `equipped_frame_level`. There is no saved-bank-accounts table.
   - The customer row is then soft-deleted (Medusa `deleted_at`).

   **The email scrub is required for its own sake — it is personal data.** It is deliberately NOT what frees the address for re-signup: `IDX_customer_email_has_account_unique` on `(email, has_account)` is a partial index with `WHERE deleted_at IS NULL`, so the soft delete alone already releases that slot. What actually decides whether re-signup works is the hard delete of the auth identities above. Both are required, for different reasons — do not drop either on the theory that the other covers it.

   **Scrubbed on retained financial rows** (the operator's chosen minimum):
   - `globepay_withdrawal`: `account_number` → last 4 digits only, `account_holder_name` → `''` (the column is NOT NULL — writing null here is a constraint violation on the first real delete), `bank_code` kept. Amounts, statuses, gateway ids, `verify_outcome`, `failure_reason`, timestamps all intact. Precedent: `setPayoutDetails` already records bank name + last4 in its audit row for exactly this reason. Accepted cost: a payout dispute raised after the delete cannot be settled by quoting the full destination account.
   - `delivery_order`: `ship_name`, `ship_address_1`, `ship_city`, `ship_postal_code` → `''` (NOT NULL columns); `ship_address_2`, `ship_province`, `ship_phone` → null. Status, timestamps and tracking number kept; `proof_images` nulled (see above — the column, not the hosted objects). Only terminal orders can exist at this point — guard `DELIVERY_IN_FLIGHT` guarantees it.
   - `customer_account_state` is **tombstoned, not soft-deleted**: `disabled = true`, `disabled_cause = 'admin'`, `disabled_reason = 'Account deleted by the customer.'`. Soft-deleting it is what would re-open the account — the cause read goes through `listCustomerAccountStates`, which excludes soft-deleted rows, so it would return `null` and the session guard would wave every request through. Bearer tokens minted before the delete keep verifying for up to the JWT TTL (auth does no DB lookup), and this row is the only thing that refuses them. `'admin'` rather than `'self'` so the reactivate carve-out can never apply to a deleted account.

4. **Retained untouched:** `credit_transaction`, `ledger_entry`, `ledger_sequence`, `globepay_deposit`, `pull`, `commission`, `vip_member_state`, `admin_action_audit`, and `referral_relationship`. One authorised exception: the purge **appends** one `admin_action_audit` row with the new `delete_account` action (`admin_id` = the customer's own id), because a permanent, irreversible action with no other record is not something support can answer questions about. Nothing existing is modified, and the append is idempotent — a retry does not stack rows. The referral rows stay because upline/downline chains and commission attribution reference them — deleting one dangles a downline's upline. All of these carry only a `customer_id` that no longer resolves to a person.

The delete route must write the metadata clear through the customer **module service** directly, not through `POST /store/customers/me` — `rejectCustomerMetadata` (api/utils/customer-metadata-guard.ts) refuses any metadata write on that route by design.

Rate-limit the delete route with its **own** tier in the rate-limit util — not the generic auth limiter. The auth limiter keys on `auth_context.actor_id` here (no `keyOf`), which is a per-customer 50/10s + 300/60s budget: looser than the write tier it would stack with, and ~90× looser than the login path this route's password field is a second front door onto. The tier to mirror is the per-identifier login one (5/60s + 20/h), because it guards the same secret.

## 3. Guard changes (backend/packages/api/src/api/utils/disabled-guard.ts)

- **Login-time guard** (`blockDisabledEmailpassLogin`): keeps blocking, and stops blocking only when `disabled_cause === 'self'`. A self-disabled customer's login proceeds and mints a token — the password must be proven before any reactivation is offered, and refusing at the token exchange would leak account state on a wrong-password attempt.
- **Session guard** (`blockDisabledCustomerSession`): unchanged for admin-disabled sessions. For `disabled_cause === 'self'` it allows exactly one path through: `POST /store/customers/me/reactivate`. **This carve-out lives inside the existing guard, not as a new middleware entry.** The guard is a blanket `/store/*` matcher that the routes sorter hoists into the `global` bucket ahead of per-route entries, so a separately-registered exception would never fire.
- **The carve-out tests a normalized `req.originalUrl`, never `req.path`.** The guard is registered method-less, which takes the framework's `app.use(matcher, handler)` branch, and Express strips the matched prefix on that branch: inside this handler `req.path` is `'/'` while `req.originalUrl` is the real `/store/customers/me/reactivate`. A `req.path` test is therefore always false — the self-disabled customer is 403'd on reactivate as well and can never recover, which combined with a `/disable` route that needs no password would let a stolen session token brick an account permanently. Every other repo site that reads `req.path` sits on an entry carrying `method:`, which does not strip; the difference is the registration, not the matcher.
- The session guard's 403 carries a machine-readable code — `ACCOUNT_SELF_DISABLED` for a self-disable, the existing admin message otherwise — so the storefront can distinguish the two without regex-matching prose. The fragile-by-nature string-pattern list in `src/lib/actions/auth.ts` is exactly what this avoids.
- Both guards keep the fail-closed pattern (unexpected error → `next(e)` → 500, never a silent pass).

`accountDisabledCause` replaces `isAccountDisabled` as the one read both guards and the reactivate route share. `isAccountDisabled` has no callers left afterwards and is deleted with them — a boolean that cannot express the cause is exactly the read this change exists to remove.

## 4. Storefront

### Settings page (src/app/(account)/settings/page.tsx)

A new "Danger zone" panel below the existing Profile and Privacy panels, following the existing `Panel` + account UI conventions:

- **Disable account** — button → confirm modal (explains: your account is blocked until you log back in and reactivate) → server action → logout → redirect home.
- **Delete account** — button → modal with a password field (omitted for Google-only accounts, which show a short "you signed in with Google, so type DELETE to confirm" line instead) and a type-`DELETE` input. Confirm stays disabled until the literal string matches and, where applicable, a password is entered. On a guard failure the modal renders the specific instruction for the returned `reason` code **plus a link to the page that clears it** — one href per reason code (wallet / withdrawals / vault / orders), sitting beside the copy map. On success: logout and the existing post-logout home redirect. **No separate goodbye screen** — it would be a route that exists to be seen once by someone who just left, and the home redirect already reads as "you are signed out".

The page already knows whether the customer has a password (Google-only accounts are detectable from the auth identity providers) — it renders the correct variant up front rather than a button that always fails.

### Login flow (src/lib/actions/auth.ts + login UI)

After a successful login, the first authenticated fetch returns 403 with code `ACCOUNT_SELF_DISABLED`. The storefront catches that code and shows a "Your account is disabled — reactivate?" confirm:

- **Confirm** → call the reactivate route → continue to the account as normal.
- **Cancel** → logout, return to the login screen.

The existing pattern-matching in `auth.ts` keeps handling the admin-disabled message unchanged.

### Public surfaces after a delete

`publicProfileFields` (backend/packages/api/src/utils/profile-handle.ts) is already undefined-safe: a deleted customer resolves to no record, so a ranked player renders as `Collector ####` with `handle: null` and `avatarUrl: null`. The leaderboard, the challenge top-N and `pulls/recent` therefore keep working with the row present and anonymous. This is the intended behavior, and it gets a test so a future refactor cannot turn the first real delete into a 500 on a public page.

## 5. Error handling

- The purge is ordered and idempotent rather than atomic — see §2.3 for why cross-module atomicity is unavailable and what replaces it.
- **The settlement guards run TWICE, and only the second run is the correctness gate.** The route's preflight is a plain read outside any transaction: it exists to give the customer one actionable reason for the modal, fast. The authoritative check is the same preflight re-run **inside** the packs purge transaction, after it has taken the `credit:<customerId>` advisory lock the freeze/disable paths use; it throws `NOT_ALLOWED` and rolls the purge back. Without that second run the check and the purge sit in different transactions with an unlocked window between them — minutes wide in production, because deposits are credited by the reconcile sweep — and a spin, sell, deposit credit or withdrawal landing in it would be purged straight through.
- All new routes return MedusaError types consistent with the framework's status mapping (UNAUTHORIZED → 401, FORBIDDEN → 403, INVALID_DATA → 400).

## 6. Testing

- **Unit:** cause fail-closed (NULL cause blocks like admin, and so does any unexpected third value); login guard passes `self`, blocks `admin` and NULL; session guard carve-out fires only for the reactivate path and only for `self`, matched on a normalized `originalUrl` (query string and trailing slash included); `rawLedgerBalanceCents` returns both directions of a real SQL result; each settlement guard blocks with its own reason code; the raw-balance read is not `availableBalance` (a frozen account holding funds must fail `BALANCE_NOT_ZERO`); a negative balance blocks; the purge re-runs the guards inside its lock and refuses; the purge's scrubs, deletes, tombstone and audit row; password re-verify failure; Google-only path skips the password step; a deleted account is skipped when the weekly challenge settles.
- **Integration:** self-disable → login → reactivate → account works. Delete on a settled account → login fails as invalid credentials (not "disabled") → a still-valid pre-delete bearer gets 403, not 200 → **re-signup with the same email succeeds and creates a fresh, empty account** (this is what proves the email scrub and the identity deletion actually freed the unique slot, and it settles whether the module's delete is soft or hard) → ledger rows, deposits and audit rows still present and unchanged → the withdrawal row's `account_number` is last4 and its holder name is `''`. Plus a frozen account holding funds: delete → 400 `BALANCE_NOT_ZERO`.
- **Public-surface:** the leaderboard and challenge top-N render a deleted-but-ranked player as `Collector ####` without throwing.
- **Storefront unit:** the `ACCOUNT_SELF_DISABLED` code path in the auth action; the delete modal's enable/disable logic and its Google-only variant.

## Residual risk (accepted)

A stolen customer session cookie can delete a Google-only account, because typed-`DELETE` is the only gate there. Bounded, and accepted by the operator: delete runs only on a settled account (zero balance, nothing pending, no unsettled cards), so an attacker destroys history rather than money — and the same stolen token already reaches the withdrawal path, which is the larger exposure. Revisit if account-takeover griefing shows up in support.

## Out of scope (v1)

- Google OAuth re-authentication as delete proof (chosen against; see Residual risk).
- A grace period or pending-deletion window (the operator chose immediate and irreversible).
- Admin-side hard delete.
- An email confirmation of the deletion (addable later via the existing Resend module).
- Blocking delete on unfulfilled `vip_reward_grant` rows — considered and excluded because the rewards and voucher surfaces are SUSPENDED (#294), so no live grant path can strand value. Confirmed during implementation: no API route, store or admin, reads `vip_reward_grant` at all — grants are written by `grantLevelUpRewards` and nothing can claim them. This becomes a sixth block reason the day a claim surface ships.

## Value that accrues AFTER the delete

A settlement guard can only see value that already exists. Two paths mint value to a customer *after* they are gone, so both are fixed at the paying end rather than as delete-time checks:

- **Weekly challenge settlement.** The challenge is live and `pull` rows are retained by design, so a deleted customer stays in the week's top-10 and settlement would mint them real balance and a real card.
- **Referral commission.** The purge deliberately retains `referral_relationship` rows — severing them would dangle the recruit's upline and rewrite attribution — but the commission fan-out is gated on exactly that lookup. So every pack a surviving recruit opens pays commission to the deleted sponsor's ownerless account, indefinitely. Bounded but not closed by the fact that the referral programme is retired: `linkSponsor` was removed so no new edge can form, yet edges that predate the retirement still pay, deliberately, and production has them.

Both are covered by one shared read, `deletedCustomerIds`, consulted at the two paying sites. The retention decisions themselves stand — skipping the payment is smaller and reversible; deleting the rows would be a money change disguised as a cleanup.
- Blocking delete on a pending weekly-challenge placing. The challenge IS live, and the retained `pull` rows keep a deleted customer ranked, so settlement would otherwise mint real balance and a card to an account with no owner. Handled at the other end instead: the settle path skips a deleted account. That is cheaper than a preflight guard and it also covers a delete that happens after the preflight passed, which a guard cannot.
