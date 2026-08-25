# ADR 0007 — The referral programme is removed, not suspended

- **Status**: Accepted
- **Date**: 2026-08-24
- **Supersedes (in part)**: [ADR 0004 — Reward economy suspension](0004-reward-economy-suspension.md), for referrals only. The VIP / Reward Box / Voucher / Daily suspension it records is unchanged.

## Context

ADR 0004 suspended the reward surfaces on 2026-07-29 (#294) as a *revertible*
change: storefront routes 404, backend stays live, kept orphans carry a
SUSPENDED banner so the next reader does not prune them and turn the revert into
a rewrite.

Referrals stopped fitting that shape almost immediately. #427 deleted
`linkSponsor` and `POST /store/referral` as a security fix — the cycle probe was
an unbounded recursive CTE that could pin a pooled connection until the pool was
exhausted. That left the programme with no writer: no new
`referral_relationship` row could be created, so the commission fan-out inside
`settleOpen` was unreachable for every customer created after that date, and the
maturity job had nothing new to mature. ADR 0004's 2026-08-15 amendment already
recorded that restoring referrals would be a rebuild rather than a revert.

What remained was a substantial amount of live-looking code backing a programme
that could not run: the sponsor tree and commission tables, the fan-out in the
most load-bearing money function in the module, three ledger reason values, an
hourly cron, four admin routes, a Customer-360 referral tree and commissions
table with reverse/suspend/unsuspend actions, a per-level commission rate on all
100 VIP rungs, and a writerless `RF` ledger event type.

The operator has decided to rebuild referrals from scratch. Keeping the old
shape around would constrain that rebuild to a schema and vocabulary nobody
chose.

## Decision

Remove the referral programme outright — code and schema — rather than leave it
suspended.

Removed: `referral_relationship` and `commission` tables; the commission fan-out
in `settleOpen`; `referralSummary` / `referralTreeFor` / `commissionsForBeneficiary`
/ `matureDueCommissions` / `reverseCommission` / `suspendCommission` /
`unsuspendCommission` / `lockedCommissionCents`; the hourly `mature-commissions`
job and its `commission_matured` feed template; `/admin/commissions/*` and the
customer referral-tree + commissions routes; the admin Customer-360 referral
sections; the `direct_referral` / `team_override` / `commission_reversal` ledger
reasons and `credit_transaction.generation`; the `RF` ledger event type; the
commission knobs on `rewards_settings`; and `vip_level.direct_referral_pct`.

Kept deliberately:

- **`credit_transaction.source_transaction_id`** — also stamped on `pack_open`
  charge rows, and it is the open-settlement idempotency key. Not commission-only.
- **`deleteCreditTransactionsGuarded`** — the commission lifecycle was its only
  dependent, so it now guards nothing, but the credit ledger is append-only and
  the seal test keeps a single delete chokepoint for whatever depends on it next.
- **`reverseOpen`** — still the saga compensation for a settled open; it now
  refunds only the recruit's debit.
- **VIP levels, the daily box, vouchers and frames** — still suspended under
  ADR 0004, not removed.

The `/referrals` and `/invite/*` paths left the dead-route guards in
`src/lib/notifications/__tests__/copy.test.ts` and `scripts/qa-suspend-surfaces.mjs`.
They are no longer suspended surfaces awaiting a revert; they are free for the
rebuilt system to claim.

## Consequences

- Restoring the old programme is no longer possible from this repository's
  history alone in any cheap way. That is intended: the replacement is a new
  design, not this one revived.
- `Migration20260824131342` is destructive and **refuses to run** if any
  `referral_relationship` row, `commission` row, or commission-reason
  `credit_transaction` row exists. A deployment holding such rows fails its
  pre-deploy migrate job with a readable message instead of destroying money
  history — resolve the data first, then re-run. The pre-launch wipe left
  production at zero, so the guard is expected to pass silently.
- `walletSummary` no longer returns `locked` or `next_unlock`, and
  `availableBalance` is now the raw balance with the freeze gate on top. Nothing
  else could lock credit.
- `/admin/economy` no longer reports `directReferral` / `teamOverride` /
  `commissionReversal`, and `net` is `revenue − payouts` with no commission
  bleed term.
- The vocabulary entries for Commission / Sponsor / Recruit are gone from
  `CONTEXT.md`. A rebuilt programme should re-establish its own terms rather
  than inherit these.
