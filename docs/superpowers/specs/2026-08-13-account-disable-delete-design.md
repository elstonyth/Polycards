# Customer Self-Service: Disable Account & Delete Account

**Date:** 2026-08-13
**Status:** Approved
**Scope:** Storefront (customer-facing) self-service. Admin disable/enable (POLYCARD-BACK §4.2) already exists and is untouched except for the `disabled_cause` backfill.

## Summary

Two new customer-facing account functions, surfaced in the account Settings page:

- **Disable account** — reversible. Customer disables their own account; logging back in with the correct password offers a one-click reactivation.
- **Delete account** — permanent. Customer's personal data is purged and login becomes impossible forever. Financial/business records (ledger, withdrawals, payment-provider records, audit rows) are retained as anonymous books.

Decisions made during brainstorming:

| Question | Decision |
|---|---|
| Actor | Customer self-service (admin disable already shipped) |
| Delete data scope | Delete personal data, keep business books |
| Delete guards | Block until settled (zero balance, no pending withdrawal, no undelivered vault cards) |
| Re-enable path for self-disable | Log in with correct password → explicit "reactivate?" confirm |
| Delete confirmation UX | Re-enter password + type `DELETE`, immediate execution |
| Reversibility | Disable: reversible by the customer. Delete: irreversible, even by admin |

## 1. Data model

`customer_account_state` (backend/packages/api/src/modules/packs/models/customer-account-state.ts) gains one column:

- `disabled_cause: enum('admin', 'self').nullable()` — mirrors the existing `cause` column used by `frozen`.

Migration: add the column; backfill `disabled_cause = 'admin'` for every existing row with `disabled = true` (all current disables are admin-made — there is no self-disable path yet). Remember the bigNumber/raw-column rule does not apply here (plain enum), but the migration must be hand-checked against a real insert.

The existing admin disable route starts writing `disabled_cause = 'admin'`. No other admin-side change.

## 2. Backend routes (store API, session-authenticated)

### POST /store/customers/me/disable
- Sets `disabled = true, disabled_cause = 'self', disabled_at = now()` on the caller's account-state row (lazy-created like freeze).
- Writes an audit row (existing admin-action-audit pattern, actor = the customer).
- Idempotent: disabling an already-self-disabled account is a no-op success. An admin-disabled account cannot reach this route (session guard blocks it first).

### POST /store/customers/me/reactivate
- Only succeeds when `disabled_cause = 'self'`. Admin-disabled callers get 403 with the existing support message ("This account has been disabled. Please contact support.").
- Clears `disabled`, `disabled_cause`, `disabled_at`; writes an audit row.
- This is the ONLY /store route a self-disabled session may call (see §3).

### POST /store/customers/me/delete
Body: `{ password: string }`. Steps, in order:

1. **Password re-verification** via the emailpass auth provider for the caller's own identity. Google-only accounts (no emailpass identity) are blocked with a "contact support to delete your account" error in v1 — there is no password to verify.
2. **Settlement guards** — all must pass, each failure returns 400 with a machine-readable reason so the UI can render a specific instruction:
   - `availableBalance() === 0` (inside the money lock, same read the withdrawal path uses) → "withdraw your RM X first".
   - No pending or admin-held withdrawal → "wait for your pending withdrawal to finish".
   - No undelivered vault cards (owned cards not yet shipped/sold) → "ship or sell your vault cards first".
3. **Purge, in one transaction:**
   - Delete: addresses, saved bank accounts, notifications, profile appearance rows, phone-verification state.
   - Scrub the customer row: `email → deleted_<customer_id>@removed.invalid`, `first_name/last_name/phone → null`.
   - Delete ALL auth identities for the customer (emailpass and google) — login becomes impossible permanently; the email address is freed for a fresh, unrelated signup.
   - Soft-delete the customer row (Medusa `deleted_at`) and the account-state row.
4. **Retained untouched:** ledger entries, `ledger_sequence`, withdrawal history, GlobePay records, spin/pack-open history, audit rows. They reference a `customer_id` that no longer resolves to a person — anonymous business books.

Rate-limit the delete route with the existing rate-limit util (it is a password-oracle otherwise).

## 3. Guard changes (backend/packages/api/src/api/utils/disabled-guard.ts)

- **Login-time guard** (`blockDisabledEmailpassLogin`): blocks only `disabled_cause = 'admin'`. A self-disabled customer's login proceeds and mints a token — the password must be proven before any reactivation offer, and refusing at the token exchange would leak account state on a wrong-password attempt.
- **Session guard** (`blockDisabledCustomerSession`): keeps blocking all /store requests for disabled customers, with one carve-out — `POST /store/customers/me/reactivate` is allowed when `disabled_cause = 'self'`. Admin-disabled sessions stay fully blocked (unchanged behavior).
- Both guards keep the fail-closed pattern (unexpected error → next(e) → 500, never a silent pass).

`isAccountDisabled` (packs service) gains a cause-aware variant (or returns the cause) so both guards and the reactivate route share one read.

## 4. Storefront

### Settings page (src/app/(account)/settings/page.tsx)
New "Danger zone" panel below the existing Profile/Privacy panels, following the existing `Panel` + account UI conventions:

- **Disable account** — button → confirm modal (explains: account hidden/blocked until you log back in and reactivate) → server action calls the disable route → logout → redirect home.
- **Delete account** — button → modal with password field and a type-`DELETE` text input; the confirm button stays disabled until both are filled and the literal string matches. On guard failure, the modal shows the specific blocking reason (withdraw balance / pending withdrawal / vault cards) with links to the relevant account pages. On success: logout + a simple goodbye screen.

### Login flow (src/lib/actions/auth.ts + login UI)
After a successful login, if the account is self-disabled (first authenticated fetch returns the 403 with a self-disabled marker, or the login response is enriched), show a "Your account is disabled — reactivate?" confirm:

- **Confirm** → call reactivate route → continue to account as normal.
- **Cancel** → logout, return to login screen.

The existing error-pattern mapping in auth.ts keeps handling the admin-disabled message untouched.

## 5. Error handling

- Delete purge is a single transaction — a partial purge is impossible; any step failing rolls back everything and the account remains intact and usable.
- Guard reads happen inside the same money-lock discipline the withdrawal path uses, so a concurrent spin/withdrawal cannot race the zero-balance check.
- All new routes return MedusaError types consistent with the framework's status mapping (UNAUTHORIZED → 401, FORBIDDEN → 403, INVALID_DATA → 400).

## 6. Testing

- **Unit:** guard cause-split (admin blocked at login, self passes; session carve-out only for reactivate + self); delete guards (nonzero balance, pending withdrawal, held withdrawal, undelivered vault card each block with the right reason); password re-verify failure; Google-only account block; idempotent self-disable.
- **Integration:** full loop — self-disable → login → reactivate → account works; delete (settled account) → login attempt fails with invalid-credentials (not "disabled") → ledger rows and withdrawal history still present and unchanged → re-signup with the same email creates a fresh, empty account.
- **Storefront unit:** auth action mapping for the self-disabled marker; delete modal enable/disable logic.

## Out of scope (v1)

- Google-only account deletion (blocked with support message).
- Grace period / pending-deletion window (user explicitly chose immediate, irreversible).
- Admin-side hard delete.
- Email confirmation of deletion (can be added later via the existing Resend module).
