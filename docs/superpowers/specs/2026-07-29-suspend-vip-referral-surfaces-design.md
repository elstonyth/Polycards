# Suspend VIP reward pages, vouchers, daily box, and referrals

**Date:** 2026-07-29
**Status:** Approved (design)
**Scope:** Storefront only. No backend change.

## Problem

Two feature families are being pulled from the storefront:

1. **VIP reward claiming** — the `/vip` page, its voucher list, and the daily
   reward box. Operator is suspending the reward economy while the daily
   tasks/missions system is designed.
2. **Referrals** — the two-tier referral programme. It carries known bugs
   (see the 2026-07-25 referral investigation), so it comes off the storefront
   entirely rather than shipping broken.

What **stays**: VIP *level accrual*. Topping up still advances a customer's VIP
level, and `/me` still shows the level number and progress bar. Only the
*reward* half of VIP is hidden.

## Decisions

| Question | Decision |
| --- | --- |
| Dead routes: 404 or redirect? | **Delete the route directories → 404.** Matches the 2026-07-20 orphan-route purge precedent. Old `/invite/<handle>` links in the wild will 404. |
| Feature flags? | **No.** `src/lib/features.ts` was deleted 2026-07-20 for exactly this reason — flags that gate removed routes are dead weight. Git history is the undo. |
| Server actions / libs? | **Left in place, unreferenced** (`lib/actions/daily.ts`, `lib/actions/referral.ts`, `lib/referral-cookie.ts`, `components/rewards/PrizeReveal.tsx`). `lib/actions/vip.ts` stays *referenced* — `/me` still calls `getVip()`. Deleting the others buys nothing and makes the restore a rewrite instead of a revert. |
| `/me` VIP card | Keeps the LV number, progress bar, and threshold labels. Loses the link, the voucher tail, and the daily-box line. |

### Assumption — NOT answered by the operator

**Backend VIP grants keep running unchanged.** `grantLevelUpRewards` keeps
writing `vip_reward_grant` rows on level-up; the daily-box roll keeps working.
Nothing renders them.

This was asked and the answer that came back described the `/me` UI ("still
shows the progress, just unable to tap into the VIP pages") — which settles the
display question, not the grant question. Defaulted to *keep granting* because
it makes unsuspending a UI-only change with no backfill: every level a customer
crossed while suspended already has its grant row waiting.

**Say so if you want grants stopped instead** — that is a one-line change in
`grantLevelUpRewards`, but levels crossed during the suspension would then never
pay, and resuming would need a backfill script.

## Changes

### 1. Routes deleted

```
src/app/(account)/vip/page.tsx
src/app/(account)/vip/VipBenefits.tsx
src/app/(account)/vip/VipVouchers.tsx
src/app/(account)/vip/VipLevelCarousel.tsx
src/app/(account)/referrals/    (page.tsx, ReferralsClient.tsx)
src/app/vouchers/
src/app/daily/                  (page.tsx, DailyClient.tsx)
src/app/invite/[handle]/        (page.tsx, InviteClient.tsx)
```

**`src/app/(account)/vip/vip-benefits.ts` and its `__tests__/vip-benefits.test.ts`
stay.** They are the benefit-copy data map, not UI — deleting them would make
resuming a data-restore rather than the pure-UI change this whole no-flags
decision rests on. They keep their current path (unreferenced but tested), so
restoring `/vip` is: re-add the page + its three components, done.

`src/lib/actions/__tests__/vip-levels.test.ts` and `vip-map.test.ts` also stay —
they cover level maths, which is still live.

Next.js only treats `page.tsx`/`route.ts` as routable, so leaving non-route
files under `(account)/vip/` does not resurrect the URL. Verify the 404 anyway
(see Verification).

### 2. Entry points stripped

| File | Line (approx) | Change |
| --- | --- | --- |
| `src/app/(account)/me/page.tsx` | 121 | Unwrap the level card from `<Link href="/vip">` — render the same markup as a plain `<div>`. Drop the `group` hover affordance. |
| `src/app/(account)/me/page.tsx` | 174-175 | Drop the `— unlocks a RM X voucher` tail from the "N more to LV M" line. |
| `src/app/(account)/me/page.tsx` | 203-232 | Drop the entire "Today's box: — · N to claim · N claimed" block. |
| `src/app/(account)/me/page.tsx` | 60-65 | Drop `getDaily()` from the `Promise.all` and its `dailyResult` binding + import. |
| `src/app/(account)/me/page.tsx` | 42 | Drop the `Vouchers` quick-access tile. Drop the now-unused `Ticket` import. |
| `src/app/(account)/me/page.tsx` | 346-362 | Drop the "Invite friends" card (`href="/referrals"`, `invite-gift.webp`). |
| `src/app/(account)/layout.tsx` | 4, 20 | Drop `<ReferralCookieClaim />` and its import — it auto-claims a referral cookie on every account-tree mount. |
| `src/components/app-shell/tabs.ts` | 37-38 | Prune `/referrals`, `/vouchers`, `/vip` from the Me tab's `match` array, so the tab can't light up for routes that 404. |
| `src/components/home/TheGame.tsx` | 76 | `100 VIP LEVELS. TWO-TIER REFERRALS.` → `100 VIP LEVELS.` Update the file-header comment (line 16) which describes a "VIP/referral loop teaser". |
| `src/app/robots.ts` | 15 | Drop the `/referrals` disallow entry. |

### 3. Notification copy

`src/lib/notifications/copy.ts` templates that deep-link to `/vip`:

- `vip_level_up` (line ~78-93) — keep the notification, drop `href: '/vip'` and
  `action: 'View VIP'`. Level-ups still happen and are still worth telling the
  customer about; they just have nowhere to go.
- `voucher_claimed` (line ~163-178) — same treatment.
- The box-prize voucher branch (line ~148-154): the copy says "claim it on the
  VIP page". Reword to drop the instruction.

Backend keeps emitting these events. The storefront renders them without a
dead link. This is the "stop rendering, not stop emitting" side of the choice —
picked because it needs no backend deploy and unsuspending is a copy revert.

### 4. What is deliberately NOT touched

- `src/lib/actions/vip.ts` — `/me` still calls `getVip()`.
- `src/lib/actions/vip-map.ts`, `levelProgressPct` — still powering the bar.
- Backend: `vip_reward_grant`, `reward_box`, `reward_draw`, `commission`,
  `referral_relationship` models, jobs, and admin surfaces all stay live.
- The admin dashboard's VIP/referral/rewards pages. Operators keep their tools.

## Verification

- `npm run build` clean; the Stop-hook typecheck is the real gate (removing an
  import without removing its use is the likely failure).
- `pwsh scripts/serve-standalone.ps1 -Port 4000`, logged-in customer:
  - `/me` renders the LV bar with progress, **no** voucher tail, **no** box
    line, **no** Vouchers tile, **no** Invite card, and tapping the level card
    does nothing.
  - `/vip`, `/vouchers`, `/daily`, `/referrals`, `/invite/anything` all 404.
  - The Me tab does not highlight on those URLs.
- `grep -rn "href=\"/vip\|href=\"/referrals\|href=\"/vouchers\|href=\"/daily" src`
  returns only `components/rewards/PrizeReveal.tsx:114` — an orphan whose sole
  importer (`DailyClient`) is deleted, kept dead-code-with-dead-link by the
  revert-friendly decision above. No *reachable* component links to a deleted
  route. (The full link inventory before this change: `me/page.tsx` lines 121,
  205, 218 → `/vip`; 227 → `/vouchers`; 348 → `/referrals`; plus
  `PrizeReveal.tsx:114` — the first five die with the §2 edits.)

## Reversal

`git revert` the commit. Backend state is untouched, so a restored `/vip` page
finds every grant row it would have had.
