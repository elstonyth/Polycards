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
- **Not idempotent, and it does not need to be.** A second call rewrites `disabled_at` and appends another audit row — it is not a no-op, and claiming otherwise would be a property the code does not have.
- **A repeat call IS reachable, and is refused rather than swallowed.** `/disable` is deliberately NOT in `SELF_DISABLED_ALLOWED_PATHS`, so a self-disabled session gets 403 `ACCOUNT_SELF_DISABLED`. That path is live because the Settings page renders for a self-disabled customer (`/store/customers/me` is carved out), and the Danger zone shows the Disable button there. The storefront maps that code to copy saying the account is already disabled and naming the way back — an earlier draft let it fall through to the generic "Something went wrong", which was a lie on the first surface a customer sees.
- An admin-disabled account never reaches this route — the session guard blocks it first.

### POST /store/customers/me/reactivate

- Writes only when the account is self-disabled. The three states are distinct, and conflating the last two is a real bug:
  - **not disabled at all** (`accountDisabledCause` returns `null`) — 200 `{ disabled: false }`, no write. This is NOT an error case: an admin can re-enable the account between the customer's login and their tap on the reactivate confirm, and answering that with "contact support" would strand a customer whose account is already working. It also makes a double-submit harmless.
  - **self-disabled** (`'self'`) — the write happens.
  - **anything else** (`'admin'` today, and any cause value a future release adds) — 403 with the existing support message.
- The test is `!== 'self'` to refuse, never `=== 'admin'` to refuse. Denying only the value you can name and allowing the rest is a fail-OPEN: an unexpected cause would reactivate the account. That bug was written and caught during implementation, so it is worth stating plainly rather than leaving to the reader.
- Clears `disabled`, `disabled_cause`, `disabled_at`; writes an audit row.
- This is one of **four** paths a self-disabled session may call — see §3 for the full set and why each earns its place. It started as the only one; `/delete` and `/account` were added so a self-disabled customer need not reactivate merely to leave, and `/store/customers/me` because without it the account layout redirects and the Settings page never renders at all.

### POST /store/customers/me/delete

Body: `{ password?: string }`. Steps, in order:

1. **Proof of intent.**
   - Accounts with an emailpass identity: re-verify `password` against that identity. A wrong password fails here and nothing else runs.
   - Google-only accounts (no emailpass identity): no password step; the typed-`DELETE` confirmation is the only gate. See Residual risk.
2. **Settlement guards** — all six must pass, in the order below (cheapest first, and each returns immediately so the customer gets ONE actionable instruction rather than a list). Each failure returns 400 with a machine-readable `reason` code plus the human copy, so the UI renders a specific instruction rather than a generic error:
   - `ACCOUNT_FROZEN` — checked **first**, and it deliberately outranks the balance check below rather than deferring to it. A freeze is an active hold on the account, and the purge destroys the very evidence the freeze exists to preserve: it HARD-deletes `player_payout_details` (bank name, full account number, holder name) and blanks `globepay_withdrawal.account_holder_name`. So a frozen account is refused as frozen even when it also holds a balance — `BALANCE_NOT_ZERO` is unreachable while the freeze stands, and that is the intended reading order, not an accident of the `if` sequence. Nothing else here would catch it either: `frozen` is orthogonal to `disabled`, so no session guard rejects a frozen caller, and `rawLedgerBalanceCents` is deliberately freeze-blind, so a frozen account whose raw balance happens to be exactly 0 clears every other gate. Only support can lift a freeze, which is why this is the one reason code whose storefront link points at `/contact` instead of a page the customer can act on.
   - `BALANCE_NOT_ZERO` — the **raw ledger balance** must be exactly `0`. Read it as `SUM(ROUND(amount * 100))` over `credit_transaction` for the customer, the same scan `availableBalance` uses internally. **Do NOT call `availableBalance()`**: it returns 0 for a frozen account and also subtracts `lockedCommissionCents`, so a frozen account holding funds — or one whose balance exactly equals its locked commission — would read as 0 and pass a naive guard. The test is `!== 0`, not `> 0`: a clawback-negative account owes money and must not be able to delete its way out of the debt.
   - `WITHDRAWAL_PENDING` — no `globepay_withdrawal` in status `pending` or `held`.
   - `DEPOSIT_PENDING` — no `globepay_deposit` in a non-terminal status: `pending` **or `expired`**. Production credits deposits via the reconcile sweep, so one can land hours after a delete and credit a scrubbed account — and the sweep re-reads `expired` rows and flips them to `settled`, so `expired` means "not landed yet", not "finished". Filtering on `pending` alone lets the exact failure through: transfer doesn't land, row expires, customer deletes at balance 0, transfer arrives, sweep credits an ownerless account.
   - `CARDS_UNSETTLED` — no `pull` in status `vaulted` or `delivering`. A vaulted pull is an owned asset the customer can still sell for credits.
   - `DELIVERY_IN_FLIGHT` — no `delivery_order` in a non-terminal status (anything other than `completed` / `canceled`). Nothing may still be shipping to an address that is about to be erased.

   **The polarity of these enumerations is mixed, and a future editor has to know which kind they are touching.** Two guards list the states that BLOCK (`globepay_withdrawal` → `['pending','held']`, `globepay_deposit` → `['pending','expired']`); the delivery guard lists the states that DON'T (`status: { $nin: ['completed','canceled'] }`, and `service.ts:3840-3845` argues the choice there). A positive list fails **open** when a status is added: the new state is simply not in the list, so the guard waves it through and the purge runs on an account with value still in flight. A `$nin` list fails closed, because the terminal half is the half that does not grow.

   Both positive lists are exhaustive **today** — verified against the models and the live CHECK constraints: `globepay_withdrawal.status ∈ (pending, settled, failed, held)` and `globepay_deposit.status ∈ (pending, settled, failed, expired)`, so what each list omits is exactly the two terminal states. No bug, today.

   It is recorded because the failure mode has already had its dress rehearsal: `globepay_withdrawal` gained `'held'` in `Migration20260811220000` — **two days before this branch**. Had the branch been written on the other side of that migration, `WITHDRAWAL_PENDING` would have shipped as a positive list missing a live non-terminal state, and a delete would have walked straight past a withdrawal sitting in admin approval. Adding a status is a routine change; noticing that it silently widens a delete guard is not.

   **Rule for anyone adding a status to either table: update the matching list in `deleteAccountPreflight` (`service.ts:3790-3823`) in the same commit, and treat the new status as non-terminal until proven otherwise.** Converting these two to `$nin` on the terminal set — the delivery guard's shape — closes the class rather than the instance, and is the preferred fix the next time either is touched.

3. **Purge — ordered and idempotent, NOT one transaction.** The purge spans four separate systems (the packs module, the customer module, the auth module, and the file provider). A Medusa `sharedContext` transaction covers one module only, so a single all-or-nothing transaction across them is not achievable, and a workflow's compensation cannot un-delete a purge. Claiming atomicity here would be a lie an implementer would then rely on.

   What is guaranteed instead: **each module's own writes are transactional**, the steps run in a fixed order chosen so the most failure-prone step is last and harmless, and the whole route is **idempotent** so a partial failure can simply be re-run. The order is load-bearing:

   1. Packs-module scrub — financial-row PII, `player_payout_details` delete, `notification_read` delete, and the `customer_account_state` **tombstone**. One packs transaction, and it re-runs the settlement guards inside its own advisory lock (see §5).
   2. Delete the `notification` rows addressed to the customer — **`to: [email, customerId]`, both conventions, never the email alone** (see the "Deleted outright" entry below). Read the email FIRST, because the scrub in the next step overwrites it and it is the only thing that finds the email-channel half; the `customerId` half is stable and needs no pre-read. This is a notification-module write, not part of the packs transaction: the packs module service has no container and cannot reach that module. If this step fails the address is still intact, so a re-run finds the rows again.
   3. Customer-module writes — delete addresses, clear `metadata` via `mutateCustomerMetadata`, scrub `email`/names/`phone`.
   4. Hard-delete the auth identities. The point of no return for logging in, and the last step that can still fail.
   5. **Soft-delete the customer row — last.** `mutateCustomerMetadata` is scoped `AND deleted_at IS NULL` and raises NOT_FOUND against a soft-deleted row, so soft-deleting any earlier would make a failure at step 4 unrecoverable: the re-run would die at step 3, and the customer could not even reach the page to trigger it, because `getCustomer()` cannot read a soft-deleted row either. Keeping it last is what makes every preceding step run against a live, still-loginable row.
   6. Best-effort delete of the avatar file object, failure swallowed (the same discipline the avatar-replace cleanup already uses) — a file-provider outage must never be what fails an account deletion. **Swallowed, but logged with the file id**, which is the one thing that makes the swallow survivable: step 3 has already emptied `metadata`, so on a provider failure the id exists nowhere else at all, and the orphaned object — a photograph of a person — would sit in the public bucket with nothing left that names it. The log line is the operator's only handle for a sweep.

   A failure anywhere before step 4 leaves a scrubbed but still-loginable account, which the customer can simply retry. A failure at step 5 is recoverable only **within the current token's TTL**: the identities are already gone, so the retry has to ride the bearer that was minted before the delete (JWT auth is pure verification with no DB lookup, and the framework default TTL is one day). Do NOT reorder the steps to "fix" that — soft-delete-last is what keeps every step that can fail running against a live row. The route logs at every step boundary so a partial run is diagnosable rather than silent.

   **Not Medusa's `removeCustomerAccountWorkflow`.** The stock workflow (`core-flows/customer/workflows/remove-customer-account`) only _unlinks_ the auth identity — `setAuthAppMetadataStep(value: null)` — and leaves the `provider_identity` row, and with it the customer's email address, in the database permanently. For a flow whose whole purpose is erasing personal data that fails twice: the email survives as PII, and its unique slot stays occupied so the person can never register again. Its `app_metadata: { customer_id }` filter shape is, however, the officially supported one and is what this route reuses to find the identities.

   **Deleted outright:**
   - Medusa customer addresses.
   - `player_payout_details` (pure PII, no money on the row).
   - `notification_read` rows.
   - `notification` rows addressed to the customer. There is no `customer_id` column — `notification.to` stores the recipient verbatim, and this app writes it under **two conventions**, so the purge queries **both**: `to: [email, customerId]`.
     - The **email channel** addresses the EMAIL (`subscribers/password-reset.ts:119` — which also puts the reset URL in `data` — plus the withdrawal and top-up receipts, the saved-account notice with `bank_name` + `account_last4`, and phone-verification).
     - The **in-app feed** addresses the CUSTOMER ID (`modules/packs/notify-feed.ts:39` writes `to: args.receiverId`).

     **Do NOT narrow this back to the email alone.** Both halves are personal data — the feed payloads carry bank names and account last4, the email payloads carry reset URLs — so the "anonymous books" rationale reaches neither: they are the personal data, not a reference to it. Dropping the `customerId` half would silently leave the entire feed history behind, including the bank details the purge just scrubbed out of `globepay_withdrawal`. Only the email half depends on ordering, and it must be read BEFORE the customer-row scrub overwrites it.

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

   **Known and accepted limit — admin free text outlives the purge.** `customer_account_state.frozen_reason` and `frozen_by` are written by the freeze paths (`service.ts:1854`, `service.ts:2646`) and cleared by nothing: `unfreezeCustomer` writes only `frozen: false` / `unfrozen_at` / `unfreeze_cause` (`service.ts:3155-3167`), and the delete tombstone above writes only the `disabled_*` fields (`service.ts:3997-4002`). So an operator's own prose about this person — which can name them, or describe what they did — survives the delete, on a row this purge otherwise rewrites.

   Nulling those two columns would be theatre. The same sentence is also in `admin_action_audit.reason`, and that table is retained **by design** (see the list above) as the only surviving record of irreversible operator action. Erasing one copy while an untouched copy of the same text sits one table over buys the appearance of erasure and nothing else. Everything else in this section is a genuine purge; this is the single place where "the customer's personal data is gone" is not literally true, and it is written down rather than fixed because the fix is a policy decision, not a code one — it means either giving up the admin audit trail or making `reason` a field operators cannot write prose into. Whoever revisits it must handle `frozen_reason`, `frozen_by` **and** `admin_action_audit.reason` in one change, or the text just moves.

The delete route must write the metadata clear through the customer **module service** directly, not through `POST /store/customers/me` — `rejectCustomerMetadata` (api/utils/customer-metadata-guard.ts) refuses any metadata write on that route by design.

Rate-limit the delete route with its **own** tier in the rate-limit util — not the generic auth limiter. The auth limiter keys on `auth_context.actor_id` here (no `keyOf`), which is a per-customer 50/10s + 300/60s budget: looser than the write tier it would stack with, and ~90× looser than the login path this route's password field is a second front door onto. The tier to mirror is the per-identifier login one (5/60s + 20/h), because it guards the same secret.

## 3. Guard changes (backend/packages/api/src/api/utils/disabled-guard.ts)

- **Login-time guard** (`blockDisabledEmailpassLogin`): keeps blocking, and stops blocking only when `disabled_cause === 'self'`. A self-disabled customer's login proceeds and mints a token — the password must be proven before any reactivation is offered, and refusing at the token exchange would leak account state on a wrong-password attempt.
- **Session guard** (`blockDisabledCustomerSession`): unchanged (and total) for admin-disabled sessions. For `disabled_cause === 'self'` it allows exactly **four** paths through, matched exactly and never as a prefix: `/store/customers/me/reactivate`, `/store/customers/me/delete`, `/store/customers/me/account`, and `/store/customers/me` itself. Reactivate alone was necessary but not sufficient — the Settings page that holds the Delete button renders behind the account layout, which reads `GET /store/customers/me`, and without the last two entries a self-disabled customer is bounced to `/?auth=login` and can reach the delete route by direct API call only. Each admitted path must reach neither money nor auth, and that has to be re-checked per path rather than argued from "reactivate is open anyway"; `SELF_DISABLED_ALLOWED_PATHS` in the guard carries the per-path reasoning. **This carve-out lives inside the existing guard, not as a new middleware entry.** The guard is a blanket `/store/*` matcher that the routes sorter hoists into the `global` bucket ahead of per-route entries, so a separately-registered exception would never fire.
- **The carve-out tests a normalized `req.originalUrl`, never `req.path`.** The guard is registered method-less, which takes the framework's `app.use(matcher, handler)` branch, and Express strips the matched prefix on that branch: inside this handler `req.path` is `'/'` while `req.originalUrl` is the real `/store/customers/me/reactivate`. A `req.path` test is therefore always false — the self-disabled customer is 403'd on reactivate as well and can never recover, which combined with a `/disable` route that needs no password would let a stolen session token brick an account permanently. Every other repo site that reads `req.path` sits on an entry carrying `method:`, which does not strip; the difference is the registration, not the matcher.
- The session guard's 403 carries a machine-readable code — `ACCOUNT_SELF_DISABLED` for a self-disable, the existing admin message otherwise — so the storefront can distinguish the two without regex-matching prose. The fragile-by-nature string-pattern list in `src/lib/actions/auth.ts` is exactly what this avoids.
- Both guards keep the fail-closed pattern (unexpected error → `next(e)` → 500, never a silent pass).

`accountDisabledCause` replaces `isAccountDisabled` as the one read both guards and the reactivate route share. `isAccountDisabled` has no callers left afterwards and is deleted with them — a boolean that cannot express the cause is exactly the read this change exists to remove.

## 4. Storefront

### Settings page (src/app/(account)/settings/page.tsx)

A new "Danger zone" panel below the existing Profile and Privacy panels, following the existing `Panel` + account UI conventions:

- **Disable account** — button → confirm modal (explains: your account is blocked until you log back in and reactivate) → server action → logout → redirect home.
- **Delete account** — button → modal with a password field (omitted for Google-only accounts, which show a short "you signed in with Google, so type DELETE to confirm" line instead) and a type-`DELETE` input. Confirm stays disabled until the literal string matches and, where applicable, a password is entered. On a guard failure the modal renders the specific instruction for the returned `reason` code **plus a link to the page that clears it** — one href per reason code, all six, sitting beside the copy map: `/contact` for `ACCOUNT_FROZEN` (only support can lift a freeze), `/wallet`, `/transactions` for both the withdrawal and deposit codes, `/vault`, `/orders`. The two password codes are fixed in the modal itself and deliberately have no entry, so they render copy alone. On success: logout and the existing post-logout home redirect. **No separate goodbye screen** — it would be a route that exists to be seen once by someone who just left, and the home redirect already reads as "you are signed out".

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

- **Unit:** cause fail-closed (NULL cause blocks like admin, and so does any unexpected third value); login guard passes `self`, blocks `admin` and NULL; session guard carve-out admits exactly the four paths of `SELF_DISABLED_ALLOWED_PATHS` and only for `self`, matched on a normalized `originalUrl` (query string and trailing slash included) and by exact membership, so every sub-path of the four stays blocked; `rawLedgerBalanceCents` returns both directions of a real SQL result; each settlement guard blocks with its own reason code; the raw-balance read is not `availableBalance` (which returns 0 for a frozen account and also subtracts locked commission — either would read a funded account as settled); a negative balance blocks; the purge re-runs the guards inside its lock and refuses; the purge's scrubs, deletes, tombstone and audit row; password re-verify failure; Google-only path skips the password step; a deleted account is skipped when the weekly challenge settles.
- **Integration:** self-disable → login → reactivate → account works. Delete on a settled account → login fails as invalid credentials (not "disabled") → a still-valid pre-delete bearer gets 403, not 200 → **re-signup with the same email succeeds and creates a fresh, empty account** (this is what proves the email scrub and the identity deletion actually freed the unique slot, and it settles whether the module's delete is soft or hard) → ledger rows, deposits and audit rows still present and unchanged → the withdrawal row's `account_number` is last4 and its holder name is `''`. Plus a frozen account holding funds: delete → 400 `ACCOUNT_FROZEN` (the freeze check runs first, so the balance code is unreachable there), asserted alongside `availableBalance` = 0 and `rawLedgerBalanceCents` ≠ 0 on that same account — which is what proves the balance read stayed freeze-blind.
- **Public-surface:** the leaderboard and challenge top-N render a deleted-but-ranked player as `Collector ####` without throwing.
- **Storefront unit:** the `ACCOUNT_SELF_DISABLED` code path in the auth action; the delete modal's enable/disable logic and its Google-only variant; and — on **both** login paths, emailpass and the Google callback — that a FAILED account read still signs the customer in and keeps the cookie. That last pair is the regression test for the deploy-window outage: the storefront and the backend deploy separately, so a storefront running ahead of its backend 404s the account route, and a guard that fails closed there fails every login with a correct password.

## Residual risk (accepted)

A stolen customer session cookie can delete a Google-only account. **For such an account the session is the ONLY gate** — say it that way rather than "typed-`DELETE` is the gate", because the typed confirmation is enforced in the modal, not on the route. It prevents an accidental click; it stops no one who calls the route directly.

Sending the typed word in the request body would not change that. It is a client-supplied constant, so any caller who can reach the route can include it — it would prove the caller read the API, not that a human meant it. The only thing that would actually raise this bar is a real re-authentication (a fresh Google OAuth round-trip), which the operator declined for v1.

Bounded, and accepted: delete runs only on a settled account (zero balance, nothing pending, no unsettled cards), so an attacker destroys history rather than money — and the same stolen token already reaches the withdrawal path, which is the larger exposure. Revisit if account-takeover griefing shows up in support, and revisit it as *re-authentication*, not as a confirmation string.

## Out of scope (v1)

- Google OAuth re-authentication as delete proof (chosen against; see Residual risk).
- A grace period or pending-deletion window (the operator chose immediate and irreversible).
- Admin-side hard delete.
- An email confirmation of the deletion (addable later via the existing Resend module).
- Blocking delete on a pending weekly-challenge placing (see "Value that accrues AFTER the delete"). Handled at the paying end instead: the settle path skips a deleted account. That is cheaper than a preflight guard, and it also covers a delete that lands AFTER the preflight passed — which a guard cannot.
- Blocking delete on unfulfilled `vip_reward_grant` rows — excluded because **nothing is claimable today**, not because nothing can claim. A claim surface already exists: `POST /store/rewards/claim/:grantId` (`api/store/rewards/claim/[grantId]/route.ts`) reads the grant and, for a `voucher`, credits real site credit through `claimReward` (`modules/packs/service.ts:2139`). An earlier review recorded that no route reads `vip_reward_grant` at all; that was wrong, and a delete preflight built on it would be built on a false premise.

  What actually holds the value back is the fail-closed redemption gate. `rewardsRedemptionEnabled()` (`modules/packs/rewards-gate.ts`) is the route's FIRST line and 403s before any read or write, and `claimReward` re-checks it at the mint site (defense-in-depth, `service.ts:2151`). It returns true only when `REWARDS_REDEMPTION_ENABLED` is exactly `'true'`, which is unset — so no grant is claimable by anyone, deleted or live. `/store/rewards/withdraw` sits behind the same gate.

  **Prerequisite of enabling redemption: revisit this exclusion in the same change that sets `REWARDS_REDEMPTION_ENABLED`.** The moment that flag is on, an unclaimed grant is strandable value and becomes a **seventh** settlement block reason — `DeleteBlockReason` already has six members (§5, and `service.ts:392`). Do not treat this as a someday note — the flag flip is the trigger.

## Value that accrues AFTER the delete

A settlement guard can only see value that already exists. Two paths mint value to a customer _after_ they are gone, so both are fixed at the paying end rather than as delete-time checks:

- **Weekly challenge settlement.** The challenge is live and `pull` rows are retained by design, so a deleted customer stays in the week's top-10 and settlement would mint them real balance and a real card.
- **Referral commission.** The purge deliberately retains `referral_relationship` rows — severing them would dangle the recruit's upline and rewrite attribution — but the commission fan-out is gated on exactly that lookup. So every pack a surviving recruit opens pays commission to the deleted sponsor's ownerless account, indefinitely. Bounded but not closed by the fact that the referral programme is retired: `linkSponsor` was removed so no new edge can form, yet edges that predate the retirement still pay, deliberately, and production has them.

Both are covered by one shared read, `deletedCustomerIds`, consulted at the two paying sites. The retention decisions themselves stand — skipping the payment is smaller and reversible; deleting the rows would be a money change disguised as a cleanup.
