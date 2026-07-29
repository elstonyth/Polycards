# Suspend VIP Reward Pages, Vouchers, Daily Box & Referrals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-29-suspend-vip-referral-surfaces-design.md`

**Goal:** Remove every storefront surface for VIP reward claiming (vouchers, daily box) and referrals, while keeping VIP level accrual visible on `/me`.

**Architecture:** Pure deletion + strip. Five route directories deleted (404), six entry points stripped, three notification templates de-linked. No feature flags (deleted 2026-07-20 precedent); git revert is the undo. Backend untouched — grants keep recording invisibly.

**Tech Stack:** Next.js App Router (storefront only), vitest for the copy test.

## Global Constraints

- **Storefront only.** Nothing under `backend/` changes in this plan.
- **VIP level accrual stays visible:** `/me` keeps the LV number, progress bar, and threshold labels (spec §Decisions).
- **Keep as unreferenced orphans** (do NOT delete): `src/lib/actions/daily.ts`, `src/lib/actions/referral.ts`, `src/lib/referral-cookie.ts`, `src/components/rewards/PrizeReveal.tsx`, `src/app/(account)/vip/vip-benefits.ts` + its `__tests__/vip-benefits.test.ts`.
- **Working tree hygiene:** the repo has unrelated uncommitted changes (`SiteFooter.tsx`, `about/page.tsx`, `CookieConsent.tsx`, `backend/**`, `plans/README.md`). Stage files **explicitly by path** in every commit — never `git add -A` / `git add .`.
- **Worktree:** execute this plan in a worktree per the superpowers `using-git-worktrees` skill (consent pre-granted). Run `npm install` in a fresh worktree. Verify on a self-built port (`:4100`), not the main tree's `:4000` (see memory: worktree prod-serve staleness).
- The Stop hook type-checks storefront + backend; a leftover import of a deleted file fails the build — that is the primary regression net.

---

### Task 1: Delete the five route directories

**Files:**
- Delete: `src/app/(account)/vip/page.tsx`, `src/app/(account)/vip/VipBenefits.tsx`, `src/app/(account)/vip/VipVouchers.tsx`, `src/app/(account)/vip/VipLevelCarousel.tsx`
- Delete: `src/app/(account)/referrals/` (entire dir: `page.tsx`, `ReferralsClient.tsx`)
- Delete: `src/app/vouchers/` (entire dir)
- Delete: `src/app/daily/` (entire dir: `page.tsx`, `DailyClient.tsx`)
- Delete: `src/app/invite/` (entire dir: `[handle]/page.tsx`, `[handle]/InviteClient.tsx` — after this the `invite` folder is empty; remove the folder)
- Keep: `src/app/(account)/vip/vip-benefits.ts`, `src/app/(account)/vip/__tests__/vip-benefits.test.ts`

**Interfaces:**
- Produces: 404s on `/vip`, `/vouchers`, `/daily`, `/referrals`, `/invite/*`. Later tasks assume these routes no longer exist.

- [ ] **Step 1: Confirm nothing outside the deleted trees imports the deleted files**

Run:
```bash
grep -rn "VipBenefits\|VipVouchers\|VipLevelCarousel\|ReferralsClient\|DailyClient\|InviteClient" src --include=*.tsx --include=*.ts | grep -v "src/app/(account)/vip/\|src/app/(account)/referrals/\|src/app/daily/\|src/app/invite/\|src/app/vouchers/"
```
Expected: no output. (If a hit appears, stop and re-read the importer before deleting anything.)

Also confirm the kept data map is only imported by files being deleted or its own test:
```bash
grep -rn "vip-benefits" src --include=*.tsx --include=*.ts
```
Expected: hits only inside `src/app/(account)/vip/` (the page/components being deleted, the kept `vip-benefits.ts` itself, and its `__tests__`).

- [ ] **Step 2: Delete**

```bash
git rm "src/app/(account)/vip/page.tsx" "src/app/(account)/vip/VipBenefits.tsx" "src/app/(account)/vip/VipVouchers.tsx" "src/app/(account)/vip/VipLevelCarousel.tsx"
git rm -r "src/app/(account)/referrals" "src/app/vouchers" "src/app/daily" "src/app/invite"
```

- [ ] **Step 3: Typecheck — expect FAILURES in files this plan strips next**

Run: `npm run typecheck`
Expected: errors ONLY in `src/app/(account)/me/page.tsx` (links `/vip` etc. still compile — links are strings, so this may actually pass) — realistically this passes because no live file imports the deleted modules. If it fails anywhere else, investigate before proceeding.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(suspend): delete vip/vouchers/daily/referrals/invite routes (404)"
```

---

### Task 2: Strip `/me` — level card link, voucher tail, daily-box line, Vouchers tile, Invite card

**Files:**
- Modify: `src/app/(account)/me/page.tsx`

**Interfaces:**
- Consumes: routes deleted in Task 1 (this task removes the links that pointed at them).
- Produces: `/me` renders the VIP level card as a non-interactive `<div>`; no `getDaily()` call remains.

- [ ] **Step 1: Remove the daily/voucher data fetch**

In the imports (lines ~1-30): delete `import { getDaily } from '@/lib/actions/daily';` and delete `Ticket` from the `lucide-react` import (used only by the Vouchers tile). Keep `ChevronRight` (still used by the Wallet header and quick links) — verify with a quick in-file search before assuming.

In the `Promise.all` (~line 60):
```ts
// BEFORE
const [walletResult, handle, vipResult, dailyResult, avatarFrames] =
  await Promise.all([
    getWallet(),
    getOwnProfileHandle(),
    getVip(),
    getDaily(),
    getAvatarFrames(),
  ]);
// AFTER
const [walletResult, handle, vipResult, avatarFrames] = await Promise.all([
  getWallet(),
  getOwnProfileHandle(),
  getVip(),
  getAvatarFrames(),
]);
```

- [ ] **Step 2: Unwrap the level card from its `/vip` link**

At ~line 121, the level card body is wrapped in `<Link href="/vip" className="group flex items-center gap-3">…</Link>`. Replace the `Link` open/close tags with a `div`:

```tsx
<div className="flex items-center gap-3">
```
and remove the `transition-opacity group-hover:opacity-90` classes from the inner `min-w-0 flex-1` div (the hover affordance goes with the link). Everything inside — LV heading, progressbar, threshold labels, `vip-badge.webp` emblem — stays byte-identical.

- [ ] **Step 3: Drop the voucher tail**

At ~line 174, in the "N more to LV M" paragraph, delete these two lines:
```tsx
{vipResult.vip.next.reward.voucherAmount > 0 &&
  ` — unlocks a ${rm0(vipResult.vip.next.reward.voucherAmount)} voucher`}
```
The paragraph ends at `{vipResult.vip.next.level}`.

- [ ] **Step 4: Drop the "Today's box" block**

Delete the entire `{dailyResult.ok && ( <p className="mt-2 border-t border-white/5 pt-2 …"> … </p> )}` block (~lines 203-240, three `<Link>`s to `/vip` ×2 and `/vouchers` ×1). The level card's outer `rounded-2xl` div now contains only the (unwrapped) card body.

- [ ] **Step 5: Drop the Vouchers quick-access tile**

In `QUICK_ACCESS` (~line 42), delete the line:
```ts
{ label: 'Vouchers', href: '/vouchers', icon: Ticket },
```

- [ ] **Step 6: Drop the Invite friends card**

Delete the whole `{/* Invite friends */}` `<Link href="/referrals" …>…</Link>` block (~lines 346-370, includes the `invite-gift.webp` `<Image>`).

- [ ] **Step 7: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean. Unused-import errors here mean a leftover (`getDaily`, `Ticket`) — fix by deleting the import, not by suppressing.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(account)/me/page.tsx"
git commit -m "feat(suspend): strip vip/voucher/daily/referral entry points from /me"
```

---

### Task 3: Strip the remaining entry points — layout, tabs, TheGame, robots

**Files:**
- Modify: `src/app/(account)/layout.tsx`
- Modify: `src/components/app-shell/tabs.ts`
- Modify: `src/components/home/TheGame.tsx`
- Modify: `src/app/robots.ts`

**Interfaces:**
- Produces: no component auto-claims referral cookies; the Me tab's `match` array no longer names deleted routes.

- [ ] **Step 1: layout.tsx — drop ReferralCookieClaim**

Delete `import ReferralCookieClaim from './ReferralCookieClaim';` (line 4) and the `<ReferralCookieClaim />` element (line ~20). Leave `src/app/(account)/ReferralCookieClaim.tsx` itself on disk (orphan, per Global Constraints).

- [ ] **Step 2: tabs.ts — prune dead match prefixes**

In the Me tab's `match` array, delete `'/referrals'`, `'/vouchers'`, and `'/vip'`:
```ts
match: [
  '/wallet',
  '/settings',
  '/orders',
  '/transactions',
  '/bank-withdrawal',
  '/notifications',
],
```

- [ ] **Step 3: TheGame.tsx — VIP-only teaser copy**

Line ~76: `100 VIP LEVELS. TWO-TIER REFERRALS.` → `100 VIP LEVELS.`
The sub-line below it reads `Every rip levels you up — and your crew's rips pay you twice.` — the second clause is the referral pitch. Replace the whole paragraph content with:
```tsx
Every rip levels you up.
```
Update the file-header comment (line ~16): `the VIP/referral loop teaser` → `the VIP loop teaser`.

- [ ] **Step 4: robots.ts — drop the /referrals disallow**

Delete the `'/referrals',` line from the `disallow` array.

- [ ] **Step 5: Typecheck, commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add "src/app/(account)/layout.tsx" src/components/app-shell/tabs.ts src/components/home/TheGame.tsx src/app/robots.ts
git commit -m "feat(suspend): drop referral cookie claim, tab matches, home teaser, robots entry"
```

---

### Task 4: De-link the notification copy (TDD via the existing copy test)

**Files:**
- Modify: `src/lib/notifications/copy.ts`
- Test: `src/lib/notifications/__tests__/copy.test.ts`

**Interfaces:**
- Consumes: `NotificationCopy` type — `href: string | null`, `action: string | null` (already nullable; "Always set together with href").
- Produces: `vip_level_up` and `voucher_claimed` entries with `href: null, action: null`; `reward_won` voucher copy without the "claim it on the VIP page" instruction.

- [ ] **Step 1: Write the failing test additions**

In `src/lib/notifications/__tests__/copy.test.ts`, add:

```ts
it('never links into the suspended VIP surfaces', () => {
  // /vip, /vouchers, /daily, /referrals 404 while the reward economy is
  // suspended (spec 2026-07-29) — a feed row must not deep-link to them.
  const dead = ['/vip', '/vouchers', '/daily', '/referrals'];
  for (const t of TEMPLATES) {
    const c = copyFor(t);
    expect(dead).not.toContain(c.href);
    // Body copy must not instruct a claim on the VIP page either.
    const body = c.body({
      amount_myr: 25,
      level: 3,
      levels: [3],
      prize_kind: 'voucher',
      status: 'shipped',
    });
    if (body) expect(body.toLowerCase()).not.toContain('vip page');
  }
});
```

Note: this test file may already assert `href: '/vip'` for these templates elsewhere — run the suite first and note every assertion the change will break; update those assertions to the new `null` values in Step 3.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- copy`
Expected: FAIL — `vip_level_up.href === '/vip'`, `voucher_claimed.href === '/vip'`, and the voucher body contains "VIP page".

- [ ] **Step 3: Edit copy.ts**

- `vip_level_up`: `href: '/vip'` → `href: null`, `action: 'View VIP'` → `action: null`.
- `voucher_claimed`: `href: '/vip'` → `href: null`, `action: 'View VIP'` → `action: null`.
- `reward_won` body, voucher branch:
```ts
// BEFORE
return strOf(data, 'prize_kind') === 'voucher'
  ? `You won a ${rm(amount)} voucher — claim it on the VIP page.`
  : `You won ${rm(amount)} in credit.`;
// AFTER
return strOf(data, 'prize_kind') === 'voucher'
  ? `You won a ${rm(amount)} voucher.`
  : `You won ${rm(amount)} in credit.`;
```
- Also fix the stale comment above that branch (it says "until it is claimed on /vip") — reword to "until it is claimed (claiming is suspended alongside the VIP page — spec 2026-07-29)".
- Leave `reward_won.href: '/rewards'` alone — `/rewards` is the account rewards route, which is NOT in this suspension's delete list.
- Update any pre-existing assertions found in Step 1.

- [ ] **Step 4: Run tests**

Run: `npm test -- copy`
Expected: PASS, full file green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/copy.ts src/lib/notifications/__tests__/copy.test.ts
git commit -m "feat(suspend): de-link vip/voucher notification copy from suspended routes"
```

---

### Task 5: Build, browser QA, wrap up

**Files:**
- Create: `scripts/qa-suspend-surfaces.mjs` (throwaway Playwright QA, follows the `scripts/qa-*.mjs` idiom)

- [ ] **Step 1: Full check**

Run: `npm run check` (lint + typecheck + build)
Expected: clean. (CI runs exactly this; the format hook trap means backend files must NOT appear in `git status` — confirm none do.)

- [ ] **Step 2: Serve the production build**

```bash
npm run build
pwsh scripts/serve-standalone.ps1 -Port 4100
```
(Worktree → `:4100`; make sure `.env.local` was copied into the worktree or packs 401 — memory: launch-stack worktree gotchas.)

- [ ] **Step 3: Playwright QA script**

Write `scripts/qa-suspend-surfaces.mjs`, modelled on any existing `scripts/qa-*.mjs` (chromium, `PW_BASE ?? http://localhost:4100`):
1. GET `/vip`, `/vouchers`, `/daily`, `/referrals`, `/invite/anything` → assert response status 404 for each.
2. Home `/` → assert page text does NOT contain `TWO-TIER REFERRALS`.
3. Screenshot `/` and (logged out) `/me` redirect target to `docs/research/qa-suspend-home.png`.
4. Logged-in `/me` check needs a session — reuse the throwaway-customer recipe from memory (launch-stack notes) if a backend is running; otherwise assert the four 404s + home copy only and note the manual gap in the summary output.

Run: `node scripts/qa-suspend-surfaces.mjs`
Expected: all assertions pass; read the PNGs back with the Read tool to eyeball.

- [ ] **Step 4: Final grep sweep (spec §Verification)**

```bash
grep -rn "href=\"/vip\|href=\"/referrals\|href=\"/vouchers\|href=\"/daily" src
```
Expected: exactly one hit — `src/components/rewards/PrizeReveal.tsx:114` (kept orphan).

- [ ] **Step 5: Commit the QA script**

```bash
git add scripts/qa-suspend-surfaces.mjs
git commit -m "test(suspend): playwright QA for suspended-surface 404s and home copy"
```
