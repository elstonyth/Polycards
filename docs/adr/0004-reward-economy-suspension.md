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
`src/lib/actions/referral.ts`, `src/lib/referral-cookie.ts` (30-day cookie
revert hazard — see its own header), `src/components/rewards/PrizeReveal.tsx`,
`src/components/rewards/WithdrawForm.tsx` (full banner); `src/components/account/ui.tsx`
and `src/lib/format.ts`'s `voucherLabel` (inline "(suspended 2026-07-29)" /
"UNUSED while … suspended" notes, not the full banner block); and — added
alongside this ADR — `src/app/(account)/vip/vip-benefits.ts` and
`src/app/(account)/ReferralCookieClaim.tsx` (full banner).

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
