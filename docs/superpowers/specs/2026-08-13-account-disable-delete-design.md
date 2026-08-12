# Customer Self-Service: Disable Account & Delete Account

**Date:** 2026-08-13
**Status:** Approved
**Scope:** Storefront (customer-facing) self-service. Admin disable/enable (POLYCARD-BACK §4.2) already exists and is untouched except for the `disabled_cause` backfill.

## Summary

Two new customer-facing account functions, surfaced in the account Settings page:

- **Disable account** — reversible. The customer disables their own account; logging back in with the correct password offers a one-click reactivation.
- **Delete account** — permanent. The customer's personal data is purged, personal data inside retained financial rows is scrubbed to a minimum, and login becomes impossible forever. Money records (amounts, statuses, gateway ids, timestamps) are retained as anonymous books.

Decisions made during brainstorming:

| Question | Decision |
|---|---|
| Actor | Customer self-service (admin disable already shipped) |
| Delete data scope | Delete personal data, keep the business books |
| PII inside retained financial rows | Scrub to minimum (account number → last4, holder name and shipping address nulled) |
| Delete guards | Block until settled (zero balance, nothing pending, no unsettled cards) |
| Re-enable path for self-disable | Log in with the correct password → explicit "reactivate?" confirm |
| Delete confirmation UX | Re-enter password + type `DELETE`, immediate execution |
| Google-only accounts (no password) | Typed-`DELETE` only, no password step (see Residual risk) |
| Reversibility | Disable: reversible by the customer. Delete: irreversible, even by an admin |

## 1. Data model

`customer_account_state` (backend/packages/api/src/modules/packs/models/customer-account-state.ts) gains one column:

- `disabled_cause: enum('admin', 'self').nullable()` — mirrors the existing `cause` column used by `frozen`.

Migration: add the column; backfill `disabled_cause = 'admin'` for every existing row with `disabled = true` (every current disable is admin-made — there is no self-disable path yet).

`setAccountDisabled` gains a `cause` input. The admin disable route passes `'admin'`; the new self-disable path passes `'self'`. Its existing advisory lock, audit row, and single-transaction discipline are unchanged.

**`disabled_cause` reads fail closed.** Every guard tests `cause === 'self'` to grant the self-disabled behavior, never `cause === 'admin'` to deny it. A NULL cause (backfill miss, a future writer, a race) must behave as an admin disable — a full block — not as a login bypass.

## 2. Backend routes (store API, session-authenticated)

### POST /store/customers/me/disable
- Calls `setAccountDisabled({ customerId, cause: 'self', disabled: true })`. The actor is the customer, taken from `auth_context.actor_id`, never from the body.
- Idempotent: disabling an already-self-disabled account is a no-op success.
- An admin-disabled account never reaches this route — the session guard blocks it first.

### POST /store/customers/me/reactivate
- Succeeds only when `disabled_cause === 'self'`. Anything else (admin, or NULL) returns 403 with the existing support message.
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
   - `DEPOSIT_PENDING` — no in-flight `globepay_deposit`. Production credits deposits via the reconcile sweep, so one can land hours after a delete and credit a scrubbed account.
   - `CARDS_UNSETTLED` — no `pull` in status `vaulted` or `delivering`. A vaulted pull is an owned asset the customer can still sell for credits.
   - `DELIVERY_IN_FLIGHT` — no `delivery_order` in a non-terminal status (anything other than `completed` / `canceled`). Nothing may still be shipping to an address that is about to be erased.
3. **Purge — one transaction.** Any step failing rolls the whole thing back and leaves the account fully intact and usable.

   **Deleted outright:**
   - Medusa customer addresses.
   - `player_payout_details` (pure PII, no money on the row).
   - `notification_read` rows.
   - The avatar file object in Spaces (from `metadata.avatar_file_id`) — the stored object itself, not just the id.
   - All auth identities for the customer: emailpass and google, via `deleteAuthIdentities` / `deleteProviderIdentities` (both confirmed present on `IAuthModuleService`).

   **Scrubbed on the customer row:**
   - `email` → `deleted_<customer_id>@removed.invalid`.
   - `first_name`, `last_name`, `phone` → null.
   - `metadata` → cleared. **This blob is where the personal data actually lives**: `bank_accounts` (saved payout destinations, with full account numbers), `handle` (public profile identity), `avatar_file_id`, `avatar_url`, `equipped_frame_level`. There is no saved-bank-accounts table.
   - The customer row is then soft-deleted (Medusa `deleted_at`).

   **The email scrub is load-bearing, not cosmetic.** The unique index is on `(email, has_account)`, so a soft-deleted row that kept its address would keep occupying that slot and block the same person from ever signing up again. Do not "simplify" it away.

   **Scrubbed on retained financial rows** (the operator's chosen minimum):
   - `globepay_withdrawal`: `account_number` → last 4 digits only, `account_holder_name` → null, `bank_code` kept. Amounts, statuses, gateway ids, `verify_outcome`, `failure_reason`, timestamps all intact. Precedent: `setPayoutDetails` already records bank name + last4 in its audit row for exactly this reason. Accepted cost: a payout dispute raised after the delete cannot be settled by quoting the full destination account.
   - `delivery_order`: `ship_name`, `ship_address_1`, `ship_address_2`, `ship_city`, `ship_province`, `ship_postal_code`, `ship_phone` → nulled. Status, timestamps, tracking number and proof images kept. Only terminal orders can exist at this point — guard `DELIVERY_IN_FLIGHT` guarantees it.
   - `customer_account_state` row soft-deleted.

4. **Retained untouched:** `credit_transaction`, `ledger_entry`, `ledger_sequence`, `globepay_deposit`, `pull`, `commission`, `vip_member_state`, `admin_action_audit`, and `referral_relationship`. The referral rows stay because upline/downline chains and commission attribution reference them — deleting one dangles a downline's upline. All of these carry only a `customer_id` that no longer resolves to a person.

The delete route must write the metadata clear through the customer **module service** directly, not through `POST /store/customers/me` — `rejectCustomerMetadata` (api/utils/customer-metadata-guard.ts) refuses any metadata write on that route by design.

Rate-limit the delete route with the existing rate-limit util: with a password field, it is otherwise a password oracle.

## 3. Guard changes (backend/packages/api/src/api/utils/disabled-guard.ts)

- **Login-time guard** (`blockDisabledEmailpassLogin`): keeps blocking, and stops blocking only when `disabled_cause === 'self'`. A self-disabled customer's login proceeds and mints a token — the password must be proven before any reactivation is offered, and refusing at the token exchange would leak account state on a wrong-password attempt.
- **Session guard** (`blockDisabledCustomerSession`): unchanged for admin-disabled sessions. For `disabled_cause === 'self'` it allows exactly one path through: `POST /store/customers/me/reactivate`. **This carve-out is a `req.path` check inside the existing guard, not a new middleware entry.** The guard is a blanket `/store/*` matcher that the routes sorter hoists into the `global` bucket ahead of per-route entries, so a separately-registered exception would never fire.
- The session guard's 403 carries a machine-readable code — `ACCOUNT_SELF_DISABLED` for a self-disable, the existing admin message otherwise — so the storefront can distinguish the two without regex-matching prose. The fragile-by-nature string-pattern list in `src/lib/actions/auth.ts` is exactly what this avoids.
- Both guards keep the fail-closed pattern (unexpected error → `next(e)` → 500, never a silent pass).

`isAccountDisabled` gains a cause-returning variant so both guards and the reactivate route share one read.

## 4. Storefront

### Settings page (src/app/(account)/settings/page.tsx)
A new "Danger zone" panel below the existing Profile and Privacy panels, following the existing `Panel` + account UI conventions:

- **Disable account** — button → confirm modal (explains: your account is blocked until you log back in and reactivate) → server action → logout → redirect home.
- **Delete account** — button → modal with a password field (omitted for Google-only accounts, which show a short "you signed in with Google, so type DELETE to confirm" line instead) and a type-`DELETE` input. Confirm stays disabled until the literal string matches and, where applicable, a password is entered. On a guard failure the modal renders the specific instruction for the returned `reason` code, with a link to the relevant account page (wallet / withdrawals / vault / orders). On success: logout plus a simple goodbye screen.

The page already knows whether the customer has a password (Google-only accounts are detectable from the auth identity providers) — it renders the correct variant up front rather than a button that always fails.

### Login flow (src/lib/actions/auth.ts + login UI)
After a successful login, the first authenticated fetch returns 403 with code `ACCOUNT_SELF_DISABLED`. The storefront catches that code and shows a "Your account is disabled — reactivate?" confirm:

- **Confirm** → call the reactivate route → continue to the account as normal.
- **Cancel** → logout, return to the login screen.

The existing pattern-matching in `auth.ts` keeps handling the admin-disabled message unchanged.

### Public surfaces after a delete
`publicProfileFields` (backend/packages/api/src/utils/profile-handle.ts) is already undefined-safe: a deleted customer resolves to no record, so a ranked player renders as `Collector ####` with `handle: null` and `avatarUrl: null`. The leaderboard, the challenge top-N and `pulls/recent` therefore keep working with the row present and anonymous. This is the intended behavior, and it gets a test so a future refactor cannot turn the first real delete into a 500 on a public page.

## 5. Error handling

- The purge is a single transaction — a partial purge is impossible.
- Guard reads take the same `credit:<customerId>` advisory lock the freeze/disable paths use, so a concurrent spin, sell or withdrawal cannot race the zero-balance check.
- All new routes return MedusaError types consistent with the framework's status mapping (UNAUTHORIZED → 401, FORBIDDEN → 403, INVALID_DATA → 400).

## 6. Testing

- **Unit:** cause fail-closed (NULL cause blocks like admin); login guard passes `self`, blocks `admin` and NULL; session guard carve-out fires only for the reactivate path and only for `self`; each settlement guard blocks with its own reason code; the raw-balance read is not `availableBalance` (a frozen account holding funds must fail `BALANCE_NOT_ZERO`); a negative balance blocks; password re-verify failure; Google-only path skips the password step; idempotent self-disable.
- **Integration:** self-disable → login → reactivate → account works. Delete on a settled account → login fails as invalid credentials (not "disabled") → **re-signup with the same email succeeds and creates a fresh, empty account** (this is what proves the email scrub and the identity deletion actually freed the unique slot, and it settles whether the module's delete is soft or hard) → ledger rows, deposits and audit rows still present and unchanged → the withdrawal row's `account_number` is last4 and its holder name is null.
- **Public-surface:** the leaderboard and challenge top-N render a deleted-but-ranked player as `Collector ####` without throwing.
- **Storefront unit:** the `ACCOUNT_SELF_DISABLED` code path in the auth action; the delete modal's enable/disable logic and its Google-only variant.

## Residual risk (accepted)

A stolen customer session cookie can delete a Google-only account, because typed-`DELETE` is the only gate there. Bounded, and accepted by the operator: delete runs only on a settled account (zero balance, nothing pending, no unsettled cards), so an attacker destroys history rather than money — and the same stolen token already reaches the withdrawal path, which is the larger exposure. Revisit if account-takeover griefing shows up in support.

## Out of scope (v1)

- Google OAuth re-authentication as delete proof (chosen against; see Residual risk).
- A grace period or pending-deletion window (the operator chose immediate and irreversible).
- Admin-side hard delete.
- An email confirmation of the deletion (addable later via the existing Resend module).
- Blocking delete on unfulfilled `vip_reward_grant` rows — considered and excluded because the rewards and voucher surfaces are SUSPENDED (#294), so no live grant path can strand value.
