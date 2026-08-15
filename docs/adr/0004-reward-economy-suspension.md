# The reward economy is suspended, not retired

PR #294 (2026-07-29) pulled VIP reward claiming (`/vip`, its voucher list, the
daily reward box) and the two-tier referral programme
(`/vouchers`, `/daily`, `/rewards`, `/referrals`, `/invite/[handle]`) off the
storefront. Referrals carried known bugs (2026-07-25 referral investigation)
and the operator was suspending the reward economy while a daily
tasks/missions system is designed — see
`docs/superpowers/specs/2026-07-29-suspend-vip-referral-surfaces-design.md`
for the full decision table. VIP *level accrual* stayed live: topping up
still advances a customer's level, and `/me` still shows the level number
and progress bar. Only the reward-granting half of VIP went dark.

We chose suspend-and-revert over delete-and-rebuild: the dead routes were
deleted (404, matching the 2026-07-20 orphan-route purge precedent — no
feature flags, since `src/lib/features.ts` was already deleted for exactly
this reason), but the server actions and libraries they called stay in the
tree, unreferenced, each carrying a `SUSPENDED` banner
(`src/lib/actions/daily.ts:1-8` is the exemplar). The backend routes these
call are all still live — nothing on the backend was suspended. This means
restoring the surfaces later is a revert (delete the banner, re-add the
route), not a rewrite. The convention: a file belonging to a suspended
surface carries the banner and stays, "so the next reader doesn't prune them
and turn the revert into a rewrite."

Known holders as of this ADR, carrying either the full `SUSPENDED` banner or
an equivalent inline note: `src/lib/actions/daily.ts`,
`src/lib/actions/referral.ts` (**deleted by #427, 2026-08-12** — see the
Amended section below), `src/lib/referral-cookie.ts` (**deleted by #427** —
carried a 30-day cookie revert hazard note; see the Amended section),
`src/components/rewards/PrizeReveal.tsx`,
`src/components/rewards/WithdrawForm.tsx` (full banner); `src/components/account/ui.tsx`
and `src/lib/format.ts`'s `voucherLabel` (inline "(suspended 2026-07-29)" /
"UNUSED while … suspended" notes, not the full banner block); and — added
alongside this ADR — `src/app/(account)/vip/vip-benefits.ts` and
`src/app/(account)/ReferralCookieClaim.tsx` (**deleted by #427** — carried the
full banner).

## Consequences

- Grep `SUSPENDED` before deleting anything that looks like an unreferenced
  orphan in this codebase. A file carrying the banner is deliberate, not
  dead code.
- `CONTEXT.md`'s "Rewards, VIP, and referrals" glossary section describes
  these surfaces in the present tense; a marker line under that heading
  points here so a reader doesn't mistake vocabulary-for-a-suspended-surface
  as vocabulary-for-a-live-surface.
- **Review-by: 2026-10-01.** If the reward economy has not been restored (or
  the daily tasks/missions system has not shipped as its replacement) by
  then, decide retire-vs-restore explicitly rather than letting the
  suspension drift indefinitely. Whoever picks this up next should check
  both this ADR and the 2026-07-29 suspension spec (which carries the same
  review-by line) before acting.

## Amended 2026-08-15 — partially superseded by #427

PR #427 (`b49ba094`, 2026-08-12) deleted three of the holders named above:
`src/lib/actions/referral.ts`, `src/lib/referral-cookie.ts`, and
`src/app/(account)/ReferralCookieClaim.tsx`. This was a security fix, not a
tidy-up, and it makes the "revert, not a rewrite" claim above **false for the
referral half** of this ADR.

**What was deleted and why.** `linkSponsor`'s cycle probe was a recursive CTE
with `UNION ALL`, no depth bound and no dedup. Against a cyclic sponsor graph
where the sought id is not on the walk it never terminated, pinning a pooled
DB connection until the pool exhausted — a real DoS, and the route it served
(`POST /store/referral`) was the one suspended-surface route with no feature
gate. Postgres does not detect cycles without an explicit `CYCLE` clause, and
`statement_timeout` cannot be set through `databaseDriverOptions`, so the fix
was to stop reaching the code at all: #427 removed `linkSponsor`,
`POST /store/referral` and its middleware entry, and the storefront referral
surfaces (`ReferralCookieClaim`, the referral cookie helpers).

**Corrected claim.** VIP reward claiming and the daily box are unaffected —
their holders (`daily.ts`, `PrizeReveal.tsx`, `WithdrawForm.tsx`,
`vip-benefits.ts`, the `account/ui.tsx` / `format.ts` inline notes) are
untouched, and restoring them is still a revert: delete the banner, re-add
the route. **Referrals are not.** Restoring the referral write path now means
rebuilding `linkSponsor` (with an actual cycle guard this time) and the
storefront surfaces from scratch — a REBUILD, not a revert.

**Deliberately kept**, and still live: the `commission` and
`referral_relationship` models, the three `credit_transaction` reason values,
`mature-commissions.ts`, `lockedCommissionCents`, and the admin
referral/commission read/repair routes. `credit_transaction` is an
append-only ledger and balance reads must keep working over every row ever
written, so dropping a reason value the history can carry would break the
ledger's self-description. `mature-commissions.ts` only matures *existing*
rows — deleting it would strand any pending commission as permanently locked
and silently cut those customers' withdrawable balance. With no writer left
(no `linkSponsor`, no new `referral_relationship` rows), all of these drain
to zero on their own rather than needing an active retirement step. The
commission fan-out in `settleOpen` is left in place behind a `SUSPENDED`
banner — gated on a `referral_relationship` lookup and now unreachable for
any new customer — because excising it means surgery on the atomic
open-settlement seam and was judged to deserve its own reviewed change.

This does not change the review-by date or the retire-vs-restore decision
above — it corrects what "restore" costs for one half of it.

See also: `docs/superpowers/specs/2026-07-29-suspend-vip-referral-surfaces-design.md`
and `docs/superpowers/plans/2026-07-29-suspend-vip-referral-surfaces.md`, both
of which named `referral.ts` / `referral-cookie.ts` as "keep, do not delete"
and now carry their own one-line pointers to this amendment.
