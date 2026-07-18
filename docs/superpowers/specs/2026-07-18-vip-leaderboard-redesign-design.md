# VIP & Leaderboard Redesign — Design Spec

- **Date:** 2026-07-18
- **Status:** Draft — awaiting review
- **Author:** brainstorming session (Claude + Elston)
- **Branch:** `claude/vip-reward-redesign-d654d6`

---

## 1. Context

The storefront has **two independent reward systems** that this redesign must keep
strictly separate (per `CONTEXT.md`'s ubiquitous language):

- **System A — VIP Reward** (per-user): a 100-level ladder driven by cumulative
  real-money ("external-funded") spend. Each rung unlocks a milestone **voucher**,
  a **daily-box tier** (upgrades every 10 levels), an avatar **frame** (every 10
  levels), and a **referral %**. Backend is already fully built and seeded from
  `Workbook1.xlsx` (the "VIP reward system.xlsx" workbook), pinned cell-by-cell by
  `vip-levels-workbook.unit.spec.ts`.
- **System B — Leaderboard Reward** (community): today a per-user board ranked by
  **spend**. The redesign turns it into a **Weekly Pulled Value Challenge** with a
  community pool, milestone stages, and a top-10 weekly payout.

### 1.1 Decomposition & sequencing (decided)

The work splits into four sub-projects of very different size and risk:

| | Sub-project | Size | Migration | Money |
|---|---|---|---|---|
| **A** | VIP page redesign (level carousel + benefits + daily box) | S | No | No |
| **B** | Points removal (profile surfaces) | S–M | No | No |
| **C** | Nav rename (`Daily`→`Task`) + `/daily` disposition | S | No | No |
| **D** | Weekly Pulled Value Challenge | XL | **Yes** | **Yes** |

**This spec covers A + B + C** — they ship together as one low-risk change with no
migrations and no money movement. **D gets its own spec/plan cycle** (charter in §6).

### 1.2 Confirmed decisions

1. Sequence: **A + B + C first; D own spec.**
2. Leaderboard metric (D): **pulled value frozen in RM at pull time, incl. the ~20%
   market multiplier** (new snapshot column).
3. Nav: **Task = Challenge hub; Ranks = standings; daily box moves to `/vip`.**
4. Challenge model (D): **exactly as referenced** — community pool → 4 cumulative
   milestone stages → top-10 personal weekly payout.
5. Carousel: **all 100 levels; "your level" = `highest_level_ever`** (monotonic);
   windowed rendering for performance.
6. Benefits list: **voucher + box tier (human name) + frame + referral %.**
7. Phase-1 daily box / Task: **move the daily box into `/vip` now; retire `/daily`;
   the renamed Task tab lands on a "Weekly Challenge coming soon" shell** until D.
8. `/me` grid after removing the Points-balance card: **"Invite friends" spans full
   width.**

**Derived boundary (not re-asked):** the leaderboard's own `points` value is *both*
its display number *and* its sort key, so removing it and re-ranking on pulled value
are the **same change** — that belongs to **D**. Phase-1 points removal (B) therefore
covers only the **profile surfaces** (`/me`, `/profile`, `/social`, marketing copy).
The `/leaderboard` board keeps its current points display until D replaces the metric
wholesale. This avoids an awkward interim board.

---

## 2. Sub-project A — VIP page redesign

**Goal:** replace the current single-next-rung `/vip` page with a swipeable carousel
of all 100 levels (showgo.gg style), a per-level progress bar, a "Level Privilege
Benefits" list, and the relocated daily free box + voucher claims — all on one VIP hub
page.

### 2.1 Backend — widen `GET /store/vip`

`backend/packages/api/src/api/store/vip/route.ts` **already fetches all 100 rungs**
(`listVipLevels`, `take: 1000`) and discards everything but the next rung. Change:

- Add `direct_referral_pct` (and `box_tier`, already selected) to the `select`.
- Serialize a new `levels` array alongside the existing fields:
  ```ts
  levels: Array<{
    level: number
    threshold: number          // spend_threshold (cumulative MYR)
    reward: {
      voucher_amount: number
      box_tier: string         // 'a'..'j' | 'Z'
      frame_unlock: boolean
      direct_referral_pct: number
    }
  }>
  ```
- Keep the existing `{ level, highest_level_ever, spend, next }` fields unchanged
  (backward compatible; `/me` still reads them).
- **Box-tier human name:** the route returns the tier letter. The friendly label
  (e.g. "Bronze Box") is resolved storefront-side from a small tier→label map, OR the
  route optionally joins `reward_box.name` per tier. Default: **static storefront map**
  (simplest; the tier letters are a fixed enum). Revisit only if operators rename boxes.

**No model change, no migration.** This is a serializer widening.

### 2.2 Storefront action + schema

- `src/lib/data/schemas.ts` — extend `VipSchema` with the `levels` array (mirrors the
  wire shape above).
- `src/lib/actions/vip.ts` — map `levels` snake→camel; add `levels: VipLevel[]` to the
  `Vip` type where `VipLevel = { level, threshold, reward: { voucherAmount, boxTier,
  frameUnlock, directReferralPct } }`.

### 2.3 Frontend — the VIP hub page

`src/app/(account)/vip/page.tsx` is rebuilt to compose, top to bottom:

1. **Level carousel** (new client component, e.g. `VipLevelCarousel.tsx`):
   - Reuses the drag/snap mechanics of `src/app/slots/[slug]/GalleryRail.tsx`
     (Framer Motion `drag="x"`, velocity snap, neighbour peek, prev/next buttons,
     "N of 100" indicator) — **restyled** for level cards, not a drop-in.
   - Renders all 100 levels but **windows** the DOM (only render the visible slice +
     a small buffer) so 100 rungs stay performant.
   - Opens centered on the user's **`highest_level_ever`**.
   - Each level card shows: level number, the rung's headline reward, and a
     **reached / current / locked** state derived from `highest_level_ever`
     (reached ≤ highest; current = highest; locked > highest).
   - **Per-level progress bar** on the current/next card: `spend` vs that rung's
     `threshold` (reuse the existing `pct = min(100, spend/threshold*100)` formula,
     generalized per rung). Chase-gold fill (`bg-chase`, per DESIGN.md — VIP milestones).
2. **Level Privilege Benefits** list (new): for each level, the benefits it unlocks —
   voucher (`rm(voucherAmount)`), box-tier upgrade (human name, shown where it changes
   every 10 levels), frame unlock (shown every 10 levels), referral % (shown where it
   changes). L1 is a non-granting entry tier — must not imply a reward.
3. **Daily free box** (relocated from `/daily`): the box hero (tier from
   `highest_level_ever`), "Open box" draw, draws-per-day cap + countdown,
   `PrizeReveal`, and "Prizes to ship." Moves `DailyClient`'s box/ship UI here; keeps
   `drawDailyBox()` / `withdrawPrize()` actions unchanged.
4. **Voucher claims** (`VipVouchers`, unchanged): claimable/claimed level-up vouchers,
   fed by `getDaily()`.

`/vip` continues to call `Promise.all([getVip(), getDaily()])` — both are already wired.

### 2.4 Data notes / traps

- **Marker = `highest_level_ever`** (monotonic), not `current_level` (drops on refund).
  Both are returned by the route; use `highest_level_ever`.
- **SEN vs MYR unit trap:** lifetime spend is stored in sen internally but the route
  already returns `spend` and `threshold` in MYR — the storefront stays in MYR.
- The carousel benefit ("this level gives an RMx voucher") is the **config** value from
  the ladder; the actual claimable voucher is a separate **grant** record (`VipVouchers`)
  — do not conflate them in the UI.

### 2.5 Files touched (A)

- `backend/packages/api/src/api/store/vip/route.ts` (widen select + response)
- `backend/packages/api/integration-tests/http/store-vip.spec.ts` (assert `levels[]`)
- `src/lib/data/schemas.ts` (`VipSchema.levels`)
- `src/lib/actions/vip.ts` (`Vip.levels`, mapping)
- `src/app/(account)/vip/page.tsx` (rebuild as hub)
- `src/app/(account)/vip/VipLevelCarousel.tsx` (new)
- `src/app/(account)/vip/VipBenefits.tsx` (new; or inline)
- Daily-box UI moved from `src/app/daily/DailyClient.tsx` into a `/vip` section
  (new `src/app/(account)/vip/DailyBox.tsx` or reuse the component in place).

---

## 3. Sub-project B — Points removal (profile surfaces)

**Goal:** completely remove the user-facing "Points" balance from the profile
surfaces (the `99.4M Points` figure and the "Points balance" card from the
screenshots). Points is **not stored** — it is derived (`spend × 100`) — so there is
**no migration and no FK risk**; this is display + type + derivation deletion.

### 3.1 Remove (display)

- `src/app/(account)/me/MeAppearance.tsx` — `MeHeader`: drop the `points` prop and the
  `{compact(points)} Points` figure in the header stat line.
- `src/app/(account)/me/page.tsx` — delete the "Points balance" card (the whole right
  tile, lines ~312–360, incl. `points-coin.webp`); **"Invite friends" spans full
  width** (drop the 2-col grid to a single full-width tile). Stop passing `points` to
  `MeHeader`.
- `src/app/profile/[user]/ProfileClient.tsx` — remove the `Points` stat tile.
- `src/app/social/SocialClient.tsx` — remove the `{compact(u.points)} pts` fragment.
- `src/app/how-it-works/page.tsx` — update the "Earn points…" leaderboard copy.
- Delete asset `public/images/app/points-coin.webp` (orphaned after the card is gone).

### 3.2 Remove (types / derivation)

- `src/lib/data/profiles.ts` — drop `PublicProfile.stats.points`.
- `src/lib/profile-view.ts` — drop `ProfileViewUser.points` + its mappings
  (`toProfileView`, `mockProfileView`).
- `src/lib/mock/users.ts` — drop `MockUser.points` + the two generators.
- `backend/.../api/store/profiles/[handle]/route.ts` — stop emitting `stats.points`;
  keep `pulls` / `volume` / `by_rarity` (from `profileStatsForCustomer`).
- `backend/.../modules/packs/service.ts` — delete `packOpenSpendCents()` (used **only**
  by the profile route; dead after). **Do NOT touch** `profileStatsForCustomer()` or the
  `credit_transaction` ledger.

### 3.3 Tests to update (B)

- `src/lib/data/__tests__/profiles.test.ts` (points fixture)
- `src/lib/__tests__/profile-view.test.ts` (points fixtures)
- `backend/.../integration-tests/http/public-profile.spec.ts` (asserts `stats.points`)

### 3.4 Explicitly NOT touched in B

- **Leaderboard points** (`LeaderboardClient.tsx`, `/store/leaderboard` route,
  `LeaderboardEntry.points`, `LeaderboardEntrySchema.points`, `leaderboard.spec.ts`,
  `leaderboardTop`'s `points`) — moves to **D** (same change as the re-rank).
- **Per-card `points` badge** (marketplace `+Npts`, `MockCard.points`,
  `products.ts` `meta.points`) — a **different, unrelated** concept. Must survive.

---

## 4. Sub-project C — Nav rename + `/daily` disposition

**Goal:** rename the "Daily" tab to "Task", retire the now-empty `/daily` route (its
box moved to `/vip` in A), and land the Task tab on a lightweight
"Weekly Challenge coming soon" shell until D builds the real hub.

### 4.1 Changes

- `src/components/app-shell/tabs.ts` — `TABS[0]`:
  `{ label: 'Task', href: '/task', icon: ListChecks }` (icon TBD — `ListChecks` /
  `Target` / `Swords`; `CalendarCheck` no longer fits). Both `TabBar.tsx` and
  `AppHeader.tsx` read `tab.label`/`icon`, so both update from this one edit.
- New `src/app/task/page.tsx` — the shell: a "Weekly Pulled Value Challenge —
  launching soon" placeholder (public, not gated, matching current Daily/Ranks), with a
  brief teaser and a link to the current `/leaderboard` (Ranks). Replaced by D's hub.
- `src/app/daily/page.tsx` — becomes a **redirect to `/vip`** (the box lives there now).
- Update inbound links: `/me` "Today's box" (`/daily`→`/vip`), `/vip`'s own
  "daily box" link (now same page — anchor/remove), the legacy `/rewards`→`/daily`
  redirect (→ `/vip`), and `src/lib/site.ts` sitemap (`/daily`→`/task` + `/vip`).
- `DESIGN.md` §5 (Navigation) — update the nav contract label `Daily`→`Task`.

### 4.2 Notes / traps

- **`getDaily()` is a hidden fan-out** feeding `/vip`, `/vouchers`, `/me` (box status)
  and the retired `/daily`. Repurposing the *route* is safe because those surfaces read
  the *action*, not the page. The `GET /store/daily` contract and `getDaily()`/
  `claimVoucher()`/`drawDailyBox()` actions are **unchanged**.
- **Logged-out daily box:** moving the box to `/vip` (gated account area) means the
  logged-out `JoinPrompt` teaser under the dormant box is lost. The public Task shell
  can carry a "join" CTA instead. Minor UX change to accept.
- Page headings/metadata (`"Daily Rewards"`) are independent literals — update them so
  nothing still says "Daily."

### 4.3 Files touched (C)

- `src/components/app-shell/tabs.ts`
- `src/app/task/page.tsx` (new shell)
- `src/app/daily/page.tsx` (→ redirect)
- `src/app/(account)/me/page.tsx`, `src/app/(account)/vip/page.tsx` (inbound links)
- `src/app/(account)/rewards/page.tsx` (redirect target)
- `src/lib/site.ts` (sitemap)
- `DESIGN.md` (§5)

---

## 5. Cross-cutting

### 5.1 Order within phase 1

1. **A backend widening** (route + schema + action) — unblocks the carousel.
2. **A frontend** (carousel + benefits + daily-box relocation).
3. **B** points removal (profile surfaces + backend profile route + tests).
4. **C** nav rename + `/daily` disposition + Task shell.

A, B, C are largely independent; B and C do not touch A's files. Can be built in
parallel and merged together.

### 5.2 Testing & verification

- **Type gate:** the repo's PostToolUse + Stop typecheck hooks are the hard gate —
  storefront + backend must stay green.
- **A:** `store-vip.spec.ts` asserts the `levels[]` payload; visual check of the
  carousel (Playwright capture, per the repo's visual-first policy) — reached/current/
  locked states, progress bar, benefits list, daily-box draw still works on `/vip`.
- **B:** update the 3 named tests; grep-verify no remaining profile `points` reference;
  confirm the marketplace `+Npts` badge and leaderboard points are untouched.
- **C:** verify tab renders "Task", `/daily`→`/vip` redirect, `/task` shell renders,
  no dead `/daily` inbound links, sitemap updated.
- **Browser verification** on `/vip`, `/me`, `/task`, `/leaderboard` (the preview
  workflow) before claiming done.

### 5.3 Risks

- **Carousel performance:** 100 cards → window the DOM; do not render all 100 at once.
- **Points-schema sequencing:** `PublicProfileSchema.stats` is a loose object (does not
  enforce `points`), so dropping backend `stats.points` won't fail validation — safe.
  (The *leaderboard* schema's required `points` is untouched in phase 1.)
- **Daily-box relocation** is the largest single A change (moving a big client
  component); keep the box logic identical, only rehome it.

---

## 6. Deferred — Sub-project D charter (own spec cycle)

Captured here so decisions aren't lost. **D is NOT designed in this spec** — it gets
its own brainstorming → spec → plan cycle because it adds a migration, a community pool,
milestone config, weekly close/settlement, a **real-money payout** (idempotency- and
security-sensitive), and a new admin surface.

### 6.1 Confirmed for D

- **Snapshot column** `pulled_value_myr` on `pull` (or a sidecar table), written at roll
  time in `record-pull.ts` / `open-pack.ts` = `displayMarketPrice(card.market_value, fx,
  card.market_multiplier)` — **frozen RM incl. the ~20% multiplier.** Inputs already in
  hand at roll time. **Edge:** `resolveFxRateStrict` throws on missing FX and the pull
  path is payment-critical — FX-unavailable must **not** fail a paid open (fallback rate
  or defer-snapshot strategy required).
- **Re-rank** `leaderboardTop` on Σ `pulled_value_myr` (replaces the spend/points sort).
  This is where leaderboard **points is removed** (display + schema + types + route +
  `leaderboard.spec.ts`).
- **Community weekly pool** = Σ all eligible pulls' `pulled_value_myr` for the week.
- **4 cumulative milestone stages** (thresholds + per-stage rewards config).
- **Top-10 personal weekly payout** at week close.
- **Task hub UI** = pool progress + stages + your weekly pulled value + top 10;
  **Ranks** stays the standings board.
- Eligibility default = `source='pack'` pulls (reward-box draws excluded, as today).

### 6.2 Open questions for D's spec

- Fixed calendar weeks (which timezone anchors reset + payout?) vs rolling 7-day.
- Exact 4 stage thresholds and what each stage unlocks.
- Payout **currency**: credits, vouchers, or the "featured cards" in the reference.
- Does the personal pulled-value board **replace** the spend board or coexist?
- **Backfill:** reconstruct existing pulls' value from `CardPriceHistory`, or
  forward-only (older pulls contribute 0)?
- Live pool total **consistency/cache** across instances (current 30s in-process cache
  won't hold — Redis / materialized counter?).
- Are stages/rewards **operator-configurable** (new admin + tables) or fixed config?
- Payout **settlement idempotency** (no double-credit on re-settlement) — security review.

---

## 7. Out of scope

- VIP spend **thresholds** are workbook-seeded code (`vip-levels.data.ts`), not
  admin-editable; reading them for the carousel is fine, making them operator-tunable is
  not part of this work.
- The `vip_level.prizes` JSON and the `'prize'` grant kind exist but are unused (null
  throughout the seed) — not surfaced.
- All of Sub-project D (see §6).
