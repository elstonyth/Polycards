# Account deletion destroys PII and retains anonymous books

Customer-initiated account deletion (`POST /store/customers/me/delete`,
`backend/packages/api/src/api/store/customers/me/delete/route.ts`, shipped
in #434) destroys the customer's personal data and makes login on that
identity impossible forever, while retaining every money-relevant row it
touches — stripped of anything that identifies the person, not the row
itself. The design is written up in full at
`docs/superpowers/specs/2026-08-13-account-disable-delete-design.md`; this
ADR records the decision and the two alternatives it rejected, for whoever
next has to explain why a "deleted" account still has rows in the database.

## Decision

Destroy PII, keep the books, and make them anonymous rather than absent.
Concretely: the customer row's email is overwritten
(`deleted_${customerId}@removed.invalid`), addresses are hard-deleted, the
auth identity is **hard**-deleted (`deleteAuthIdentities`, never
`softDeleteAuthIdentities`), and the customer row itself is soft-deleted
last. Financial rows that reference the customer are neither deleted nor
left untouched — they are scrubbed to the operator-chosen minimum and kept,
because they are the books, and the numbers on them still have to
reconcile after the person who generated them is gone.

## Alternatives rejected

**Full hard delete** (removing or nulling every row the customer touched,
including ledger and order history) — rejected because it breaks
reconciliation. `credit_transaction` is an append-only ledger; deleting a
customer's rows from it would leave the sitewide balance sheet unable to
account for money that genuinely moved. The Weekly Challenge, the
leaderboard and `pulls/recent` all read `pull` rows by id with no customer
join required to keep working, so deleting those rows would also 500 or
silently corrupt public surfaces that have nothing to do with the deleted
account.

**Soft-delete-only** (Medusa's stock `removeCustomerAccountWorkflow`, or an
`is_deleted` flag with no further scrub) — rejected on two counts. First it
retains PII: the stock workflow only unlinks the auth identity
(`setAuthAppMetadataStep(value: null)`) and leaves the `provider_identity`
row — and with it the customer's email address — in the database
permanently, which fails the entire point of a deletion flow. Second, that
same untouched `provider_identity` row keeps the email's unique slot
occupied forever, so the customer could never re-register with it — a
"deleted" account that still blocks its own resurrection is not a
deletion, it is a lockout.

## Exact retained columns, and each one's reason

From `purgeAccountPacksData`, `backend/packages/api/src/modules/packs/service.ts:4099-4232`:

- **`globepay_withdrawal`**: `account_number` → last 4 digits only (via
  `right(account_number, 4)`), `account_holder_name` → `''`. `bank_code`,
  amounts, statuses, gateway ids, `verify_outcome`, `failure_reason` and
  timestamps are left intact. Reason: last-4 is what
  `setPayoutDetails` already records in its own audit row for the same
  purpose — a same-bank redirect stays distinguishable from a no-op, and a
  payout dispute can still be triaged by bank + amount + date without the
  full account number.
- **`delivery_order`**: `ship_name`, `ship_address_1`, `ship_city`,
  `ship_postal_code` → `''` (NOT NULL columns); `ship_address_2`,
  `ship_province`, `ship_phone` → `null`; `proof_images` → `null`. Status,
  timestamps and tracking number are kept. Reason: `proof_images` goes with
  the address fields, not the tracking number — a doorstep photo can show
  the label or the recipient, re-exposing exactly what the `ship_*` scrub
  removes. `ship_country_code` is the one shipping field left completely
  alone: it is `NOT NULL`, a bare country is not identifying on its own,
  and it is what lets a shipped order's cost still reconcile.
- **`player_payout_details`** and **`notification_read`**: deleted
  outright. Reason: pure personal data with no business value on the row —
  nothing here needs to survive for the books to balance.
- **`customer_account_state`**: tombstoned, not soft-deleted —
  `disabled = true`, `disabled_reason = 'Account deleted by the
  customer.'`, `disabled_at` stamped (`disabled_by` is left `null`: this is
  a customer-initiated purge, not an admin action). Reason: soft-deleting
  this row is what would *re-open* the account.
  `PacksModuleService#isAccountDisabled` — the same read both guards in
  `backend/packages/api/src/api/utils/disabled-guard.ts` share — goes
  through `listCustomerAccountStates`, which excludes soft-deleted rows, so
  a soft-deleted tombstone would read back as "not disabled" and the
  session guard would wave through a bearer token minted before the delete
  (JWT auth does no DB lookup, and no `jwtExpiresIn` is set, so the
  framework default `1d` applies). This row is upserted, not blindly
  updated, because most customers have never been disabled or frozen and
  have no existing row to update.
  (The design doc's plan section also describes a self-service *disable
  and reactivate* pair with a `disabled_cause` column and an
  `accountDisabledCause` reader — **that half did not ship in #434**; only
  Delete Account did. `disabled_cause` does not exist on the model, and
  `isAccountDisabled` is the unmodified, still-live read. Account Disable
  today is admin-only, via `admin/customers/[id]/disable` +
  `.../enable` — do not cite the design doc's self-disable plan as shipped
  behavior.)
- **`admin_action_audit`**: retained by design, and the purge *appends* to
  it rather than modifying anything existing — one idempotent
  `delete_account` row (`admin_id` = the customer's own id). Reason: a
  permanent, irreversible action with no other record is not something
  support can answer questions about later.
- **Retained completely untouched**: `credit_transaction`, `ledger_entry`,
  `ledger_sequence`, `globepay_deposit`, `pull`, and `vip_member_state`.
  Reason: all of these carry only a `customer_id` that no longer resolves to
  a person once the customer row is scrubbed and soft-deleted — the row is
  already anonymous by construction, so there is nothing left to scrub.
  (`commission` and `referral_relationship` were on this list until the
  referral programme was removed on 2026-08-24, ADR 0007; both tables are
  gone.)

## Accepted residual risk — admin free text outlives the purge

`customer_account_state.frozen_reason` and `frozen_by` are written by the
freeze paths and cleared by nothing: `unfreezeCustomer` writes only
`frozen` / `unfrozen_at` / `unfreeze_cause`, and the delete tombstone above
writes only the `disabled_*` fields. So an operator's own prose about this
person — which can name them, or describe what they did — survives the
delete on a row this purge otherwise rewrites. The identical sentence can
also sit in `admin_action_audit.reason`, which is retained by design as
the only surviving record of irreversible operator action.

Nulling those columns would be theatre: erasing one copy while an
untouched copy of the same text sits one table over buys the *appearance*
of erasure and nothing else. This is the one place in the purge where "the
customer's personal data is gone" is not literally true, and it is left as
a known limit rather than patched, because the fix is a policy decision,
not a code one — either give up the admin audit trail, or stop letting
operators write free-form prose into `reason` fields. Whoever revisits it
must handle `frozen_reason`, `frozen_by` **and** `admin_action_audit.reason`
together, or the text just moves to whichever column was left out.

## Consequences

- A "deleted" customer is not absent from the database — grep for
  `purgeAccountPacksData` before assuming a customer-scoped query needs a
  `deleted_at IS NULL` filter to behave correctly; several of the tables
  above are meant to keep returning that customer's rows forever.
- Public surfaces that read a deleted customer's historical rows
  (leaderboard, Weekly Challenge top-N, `pulls/recent`) must stay
  undefined-safe rather than join-and-crash. `publicProfileFields`
  (`backend/packages/api/src/utils/profile-handle.ts`) already renders a
  deleted-but-ranked player as `Collector ####` with `handle: null` — this
  is the intended behavior, not a bug to fix.
- A stolen customer session cookie can still delete a Google-only account:
  for such an account the session bearer is the only gate, since the
  storefront's typed-`DELETE` confirmation is enforced in the modal, not
  on the route itself.
- Re-signup with the same email is expected to succeed and create a fresh,
  empty account — this is the proof that the email scrub and the hard
  identity delete actually freed the unique slot, not a soft-delete
  hiding the same collision.

**Status: Accepted.** Shipped in #434. See
`docs/superpowers/specs/2026-08-13-account-disable-delete-design.md` for
the full design, including the guard-chain and storefront changes this ADR
does not repeat.
