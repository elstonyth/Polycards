# Money-path data-accuracy audit — 2026-08-17

Scope: every path that moves money or reports it — the GlobePay365 deposit and
payout loops, the `credit_transaction` balance ledger, the `ledger_entry`
operator log, and the admin surfaces that read them. Written before the
"gateway data lives in this app" change so the two can be read together.

Verdict up front: **the internal ledger is sound and well-defended. The gap is
the gateway mirror.** Everything GlobePay tells us about the *cost and identity*
of a settlement — the fee, the net, the bank reference — is received, typed, and
thrown away. That is the reason an operator still has to log into GlobePay365 to
learn what a month actually earned.

---

## A. What is already correct (verified, not assumed)

These were checked against the enforcing code or constraint, not against the
comment claiming them.

| Invariant | Enforced by |
| --- | --- |
| Balance = Σ`credit_transaction.amount`, no mutable balance column | Model has no balance field; every reader sums (`creditBalance`, `walletSummary`, `creditSummary`) |
| A pull can never be credited twice | `credit_transaction.pull_id` UNIQUE (DB, not app) |
| A deposit callback replayed N times credits once | `topupIdempotencyReference` anchored on the **signed** `MerchantTransactionId`, deduped under the per-customer `credit:` advisory lock in `mutateCreditAtomic` |
| A failed payout refunds exactly once | `withdrawalRefundReference` — one anchor shared by all three observers (submit error, callback, sweep) |
| A payout can never be submitted while the balance still shows the money | debit-before-submit ordering in `startGlobePayWithdrawal`, gate + debit in one locked transaction (`withdrawForCashout`) |
| Idempotency-Key replay is race-safe | partial unique index `UQ_globepay_withdrawal_customer_idempotency_key`, predicate `status <> 'failed'`, matched by the read |
| Money arithmetic never drifts on floats | every aggregate is `ROUND(amount * 100)::bigint` in SQL; `credit-summary.ts` / `economy.ts` fold in integer sen |
| An unknown ledger reason cannot silently vanish from the P&L | `ledgerTotals` throws on an unrecognised reason |
| Customer id on a deposit/payout is never client-supplied | both store routes take `req.auth_context.actor_id`; the row is written **before** the gateway call, so a callback always maps back to a real customer |
| Ledger Σ == balance across the money loop | `integration-tests/http/ledger-conservation.spec.ts` — but see F1, its coverage is narrower than its name |

## B. Findings — gateway data that never reaches this app

### B1 — `NetAmount` is received on every settlement and never stored — **the blocker**

`NetAmount` (gross minus GlobePay's fee — confirmed with the provider
2026-07-22) arrives in four places and is persisted in none:

- `api/hooks/globepay/deposit/route.ts:49` — declared on the callback type, read never
- `api/hooks/globepay/withdrawal/route.ts:42` — same
- `globepay-client.ts` `DepositDetail.netAmount` — returned by requery, dropped by the sweep
- `globepay-client.ts` `WithdrawalDetail.netAmount` — same

Consequence, stated plainly: **this app cannot compute what a week or a month
actually earned.** It knows gross in and gross out; the fee is only in
GlobePay's back office. `/admin/economy` reports `topups` and `cashout` at
gross, so every period figure the operator reads is optimistic by the whole
processing fee.

### B2 — `BankReferenceNo` / `UniqueReferenceNo` received and dropped

Same four sites. These are the handles a bank quotes in a dispute. Without them,
"the customer says the transfer never arrived" is answerable only by logging into
the gateway. `gateway_transaction_id` is *their* id, not the *bank's*.

### B3 — merchant balance is never read by the running system

`checkBalance()` (`globepay-client.ts:432`) returns `currentBalance`,
`availableBalance`, `t1Balance`. Its only caller in the entire repo is the
one-off CLI `src/scripts/check-globepay.ts`. No route, no job, no table, no
history. The operator cannot see the payout float without logging in — and a
payout refused for `PMT10013` (insufficient balance) is indistinguishable in
this app from a payout refused for bad bank details.

### B4 — no gateway-side period report exists

`/admin/economy` does have `from`/`to` and daily/weekly/monthly presets, so the
gap is narrower than "no report" — but it reads `credit_transaction` **only**.
Nothing anywhere groups `globepay_deposit` / `globepay_withdrawal` by period.
The admin Deposits and Withdrawals pages are row listings with no totals at all.

Also worth naming: the economy presets are **rolling windows** (last 7 / last 30
days), not calendar weeks or months. That is a defensible product choice, but it
does not line up with a gateway statement, which is calendar-bounded — so even
the gross figures cannot be compared to GlobePay's month without recomputing.

### B5 — nothing ever cross-checks the gateway tables against the ledger

Two independent records of the same money exist and no code compares them:

- settled `globepay_deposit.amount_settled` vs `credit_transaction` `topup` rows
- settled `globepay_withdrawal.amount` vs `cashout` rows net of refunds

Each individual write is idempotent and correct. What is missing is the
*aggregate* check that catches the case no single write can see: a settled
deposit whose credit never landed (the row update and the credit are two
statements), or a credit with no gateway row behind it. Today that only surfaces
as a customer complaint.

## C. Findings — reporting accuracy

### C1 — `topups` in the economy report counts mock top-ups too

`ledgerTotals` buckets by `reason`, and the mock gateway
(`/store/credits/topup`) writes `reason: 'topup'` exactly like the real one. In
production `ALLOW_MOCK_TOPUP` is off so the buckets agree, but the report has no
way to *prove* that from its own data — which is precisely what B5's
gateway-vs-ledger delta would give it.

### C2 — the withdrawal settle path does not record what was actually paid

The deposit path stores `amount_settled` from the callback. The withdrawal path
stores nothing equivalent: on success it writes `status`, `gateway_status`,
`settled_at` and leaves `amount` as submitted. A settled-amount disagreement is
*logged* (`route.ts:263`) and then lost with the log. Low practical risk (we
instruct the exact figure) but it means the payout side has no settled-amount
column to reconcile against, unlike deposits.

### C3 — `verify_outcome` is a payout forensics column with no reader

Written on every payout-verify invocation (`globepay-withdrawal.ts` model
comment explains why NULL is meaningful), surfaced on no admin screen. It is the
one field that distinguishes "their verification never reached us" — a config
fault — from a genuine refusal.

## D. Findings — customer identity and info

### D1 — `merchantClientId` is our raw customer id, deliberately

`submitDeposit`/`submitWithdrawal` send `merchantClientId: input.customerId`.
That id comes from the verified token only, is opaque, and cannot be used to
reach the account. Correct as designed. The *gateway-side* record therefore
points at a real customer — the reverse direction (their callback → our
customer) is carried by the `globepay_deposit`/`globepay_withdrawal` row, since
their callback does not echo `MerchantClientId`.

### D2 — email on admin lists is joined per page, not stored

`/admin/globepay/deposits` joins `customer_id → email` at read time. Right call
(no stale copies), and the route sets `Cache-Control: no-store` for it. No
finding; recorded so a future "denormalise the email onto the row" idea gets
argued down.

### D3 — destination bank details are stored verbatim on the payout row, masked on the list

`account_number` full on `globepay_withdrawal`, masked to `••••1234` on the
admin list, full value only from the separate `[id]/account` route.
`formatGatewayFailureReason` redacts digit runs, the submitted account number
and the holder name out of the gateway's own error text so an unredacted
provider message cannot put PII back onto the list page. Sound.

## E. Findings — operational gaps already tracked elsewhere

Recorded so this audit is not read as clearing them:

- **E1** — an ambiguous requery refusal on a *withdrawal* waits forever; there is
  no `needs_review` status and no expiry (deposits have one). Tracked as
  `docs/ops/security-verification-checklist.md` item H.
- **E2** — the requery-error taxonomy is unverified: only `PMT10016` is treated
  as not-found, everything else 400 is "ambiguous". Deliberately conservative;
  item D of the same checklist.
- **E3** — the payout callback in `api/hooks/globepay/withdrawal/route.ts` is a
  third near-copy of the refund ordering that `refundGlobePayWithdrawal` owns.
  Two edits, not one, next time that ordering changes.

## F. Test-coverage observations

- **F1** — `ledger-conservation.spec.ts` has exactly one assertion
  ("ledger conserves across topup → open → buyback"). It does **not** cover the
  payout loop, refunds, commissions, or adjustments. The conservation property
  is narrower than the file name suggests.
- **F2** — no test compares the gateway tables to the ledger in aggregate (B5),
  because nothing computes that comparison yet.

---

## What this audit led to

B1, B2, B4 and B5 are addressed by the change that ships alongside this file:
the gateway settlement mirror (net/fee and bank references persisted on both
gateway tables, written from callbacks and from both reconcile sweeps) and
`GET /admin/globepay/settlement` — calendar week/month buckets over the gateway
rows, with the ledger-vs-gateway delta computed per period, plus the live
merchant balance.

B3 is addressed for the *current* balance (read live on that screen). Balance
*history* is deliberately not stored: one snapshot table with a job behind it
buys a chart nobody has asked for yet.

C1, C2, C3, E1–E3 and F1 are left open and are recorded here rather than fixed,
because each needs its own decision (a status + migration for E1, a provider
conversation for E2, a schema column for C2).
