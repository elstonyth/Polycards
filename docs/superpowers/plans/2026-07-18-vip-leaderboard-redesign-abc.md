# VIP & Leaderboard Redesign — Phase A+B+C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `/vip` into a swipeable 100-level ladder with a benefits list and the relocated daily box (A), remove the user-facing points balance from all profile surfaces (B), and rename the "Daily" nav tab to "Task" with a placeholder Challenge hub (C).

**Architecture:** A widens the *already-fetched* `GET /store/vip` to return the full ladder, then the storefront renders it with the existing `GalleryRail` carousel + pure benefit helpers. B is a display/type/derivation deletion (points is never stored). C is a nav-label + route-disposition change. The leaderboard's own points and the full Weekly Challenge are **out of scope** (deferred to sub-project D).

**Tech Stack:** Next.js App Router + TypeScript + Tailwind (storefront `src/`), `motion/react` (Framer Motion v12) for the carousel, Zod (only via `src/lib/data/schemas.ts`), Vitest (storefront unit), Medusa + raw SQL + Jest (backend `backend/packages/api/`).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-18-vip-leaderboard-redesign-design.md`. Every task's requirements implicitly include §1.2 (confirmed decisions) of that spec.
- **Marker = `highest_level_ever`** (monotonic), never `current_level`, for "your level".
- **Money on the storefront is MYR only** via `rm` / `rm0` / `compact` from `@/lib/format`; a raw USD value must never render behind "RM".
- **Zod import rule:** only `src/lib/data/schemas.ts` may import `zod`; all other files import schemas from there.
- **Design tokens (DESIGN.md):** chase-gold (`bg-chase` / `text-chase`) for VIP milestones + progress bars; `bg-buyback` for money-positive. No raised center tab / FAB.
- **Type gate:** the repo's PostToolUse + Stop typecheck hooks must stay green for storefront **and** backend. `npm run test` (vitest) for storefront units; backend Jest integration tests need the `pokenic-postgres` test DB.
- **Do NOT touch:** the `credit_transaction` ledger; the per-card marketplace `points` badge (`MockCard.points`, `products.ts` `meta.points`, `MarketplaceClient` `+Npts`); the leaderboard's `points` (that is sub-project D).
- **Commit style:** conventional commits, one per task minimum, ending with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

---

## File Structure

**Sub-project A — VIP page**
- Modify `backend/packages/api/src/api/store/vip/route.ts` — add `levels[]` + `direct_referral_pct` to the response.
- Modify `backend/packages/api/integration-tests/http/store-vip.spec.ts` — assert the new payload.
- Modify `src/lib/data/schemas.ts` — extend `VipSchema` with `levels`.
- Modify `src/lib/actions/vip.ts` — `Vip.levels`, `VipLevel` type, `mapVipLevels` helper.
- Create `src/lib/actions/__tests__/vip-levels.test.ts` — unit-test `mapVipLevels`.
- Create `src/app/(account)/vip/vip-benefits.ts` — pure `milestoneBenefits()` helper.
- Create `src/app/(account)/vip/__tests__/vip-benefits.test.ts` — unit-test it.
- Create `src/app/(account)/vip/VipBenefits.tsx` — the benefits-list component.
- Create `src/app/(account)/vip/VipLevelCarousel.tsx` — the level carousel (wraps `GalleryRail`).
- Modify `src/app/(account)/vip/page.tsx` — compose carousel + benefits + daily box + vouchers.
- Modify `src/app/daily/page.tsx` — redirect to `/vip`.

**Sub-project B — Points removal**
- Modify `src/app/(account)/me/MeAppearance.tsx` — drop `points` from `MeHeader`.
- Modify `src/app/(account)/me/page.tsx` — delete the Points-balance card; full-width Invite friends.
- Modify `src/lib/profile-view.ts` — drop `ProfileViewUser.points` + mappings.
- Modify `src/lib/data/profiles.ts` — drop `PublicProfile.stats.points`.
- Modify `src/lib/mock/users.ts` — drop `MockUser.points`.
- Modify `src/app/profile/[user]/ProfileClient.tsx` — remove the Points stat tile.
- Modify `src/app/social/SocialClient.tsx` — remove the `pts` fragment.
- Modify `src/app/how-it-works/page.tsx` — update the "Earn points" copy.
- Modify `src/lib/data/__tests__/profiles.test.ts`, `src/lib/__tests__/profile-view.test.ts`.
- Modify `backend/packages/api/src/api/store/profiles/[handle]/route.ts` — stop emitting `stats.points`.
- Modify `backend/packages/api/src/modules/packs/service.ts` — delete `packOpenSpendCents()`.
- Modify `backend/packages/api/integration-tests/http/public-profile.spec.ts`.
- Delete `public/images/app/points-coin.webp`.

**Sub-project C — Nav rename + `/daily` disposition**
- Modify `src/components/app-shell/tabs.ts` — `Daily`→`Task`, `/daily`→`/task`, icon.
- Create `src/app/task/page.tsx` — "coming soon" shell.
- Modify `src/app/(account)/rewards/page.tsx` — redirect `/daily`→`/vip`.
- Modify `src/lib/site.ts` — sitemap `/daily`→`/task`.
- Modify `src/app/(account)/me/page.tsx` — "Today's box" link `/daily`→`/vip`.
- Modify `DESIGN.md` — §5 nav label.

---

## SUB-PROJECT A — VIP page redesign

### Task A1: Backend — expose the full ladder from `GET /store/vip`

**Files:**
- Modify: `backend/packages/api/src/api/store/vip/route.ts`
- Test: `backend/packages/api/integration-tests/http/store-vip.spec.ts`

**Interfaces:**
- Produces (wire shape, additive — existing fields unchanged):
  ```jsonc
  {
    "level": number, "highest_level_ever": number, "spend": number,
    "next": { ... } | null,
    "levels": [ { "level": number, "threshold": number,
      "reward": { "voucher_amount": number, "box_tier": string,
                  "frame_unlock": boolean, "direct_referral_pct": number } } ]
  }
  ```

- [ ] **Step 1: Write the failing test.** In `store-vip.spec.ts`, add a case asserting the ladder is returned (place it beside the existing `GET /store/vip` assertions; match the file's existing fixture/harness style):

```ts
it('returns the full 100-level ladder with reward columns', async () => {
  const res = await api.get('/store/vip', authHeaders);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.data.levels)).toBe(true);
  expect(res.data.levels).toHaveLength(100);
  const l2 = res.data.levels.find((l: any) => l.level === 2);
  expect(l2).toMatchObject({
    level: 2,
    reward: {
      voucher_amount: expect.any(Number),
      box_tier: expect.any(String),
      frame_unlock: expect.any(Boolean),
      direct_referral_pct: expect.any(Number),
    },
  });
  // strictly increasing thresholds
  const thresholds = res.data.levels.map((l: any) => l.threshold);
  expect([...thresholds].sort((a, b) => a - b)).toEqual(thresholds);
});
```

- [ ] **Step 2: Run it to confirm it fails.** From `backend/packages/api`:

```bash
corepack yarn jest integration-tests/http/store-vip.spec.ts -t "full 100-level ladder"
```
Expected: FAIL — `res.data.levels` is `undefined`. (Needs the `pokenic-postgres` test DB running.)

- [ ] **Step 3: Add `direct_referral_pct` to the select and build the `levels` response.** In `route.ts`, extend the `select` array (currently `['level','spend_threshold','voucher_amount','box_tier','frame_unlock']`) with `'direct_referral_pct'`, add it to the `ladder` map, and build + return `levels`:

```ts
// in the listVipLevels call:
select: ['level', 'spend_threshold', 'voucher_amount', 'box_tier', 'frame_unlock', 'direct_referral_pct'],

// in the ladder map, add the field:
.map((r) => ({
  level: r.level,
  spend_threshold: Number(r.spend_threshold),
  voucher_amount: Number(r.voucher_amount),
  box_tier: r.box_tier as string,
  frame_unlock: r.frame_unlock as boolean,
  direct_referral_pct: Number(r.direct_referral_pct),
}))

// after `next` is computed, before res.json:
const levels = ladder.map((r) => ({
  level: r.level,
  threshold: r.spend_threshold,
  reward: {
    voucher_amount: r.voucher_amount,
    box_tier: r.box_tier,
    frame_unlock: Boolean(r.frame_unlock),
    direct_referral_pct: r.direct_referral_pct,
  },
}));

res.json({ level, highest_level_ever: highest, spend, next, levels });
```

- [ ] **Step 4: Run the test to confirm it passes.**

```bash
corepack yarn jest integration-tests/http/store-vip.spec.ts
```
Expected: PASS (all cases, including the existing ones).

- [ ] **Step 5: Commit.**

```bash
git add backend/packages/api/src/api/store/vip/route.ts backend/packages/api/integration-tests/http/store-vip.spec.ts
git commit -m "feat(vip): expose full level ladder from GET /store/vip"
```

---

### Task A2: Storefront — parse and map the ladder in `getVip`

**Files:**
- Modify: `src/lib/data/schemas.ts` (`VipSchema`)
- Modify: `src/lib/actions/vip.ts` (`Vip`, `VipLevel`, `mapVipLevels`)
- Test: `src/lib/actions/__tests__/vip-levels.test.ts`

**Interfaces:**
- Consumes: the A1 wire shape.
- Produces:
  ```ts
  export type VipLevel = {
    level: number; threshold: number;
    reward: { voucherAmount: number; boxTier: string;
              frameUnlock: boolean; directReferralPct: number };
  };
  export function mapVipLevels(raw: RawVipLevel[]): VipLevel[];
  // Vip gains: levels: VipLevel[]
  ```

- [ ] **Step 1: Write the failing test.** Create `src/lib/actions/__tests__/vip-levels.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapVipLevels } from '@/lib/actions/vip';

describe('mapVipLevels', () => {
  it('maps snake_case wire rows to camelCase VipLevel', () => {
    const out = mapVipLevels([
      {
        level: 2,
        threshold: 3.09,
        reward: {
          voucher_amount: 2,
          box_tier: 'a',
          frame_unlock: false,
          direct_referral_pct: 2,
        },
      },
    ]);
    expect(out).toEqual([
      {
        level: 2,
        threshold: 3.09,
        reward: {
          voucherAmount: 2,
          boxTier: 'a',
          frameUnlock: false,
          directReferralPct: 2,
        },
      },
    ]);
  });

  it('returns [] for an empty ladder', () => {
    expect(mapVipLevels([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

```bash
npx vitest run src/lib/actions/__tests__/vip-levels.test.ts
```
Expected: FAIL — `mapVipLevels` is not exported.

- [ ] **Step 3a: Extend `VipSchema`.** In `src/lib/data/schemas.ts`, inside `VipSchema`'s object (after `next`), add:

```ts
  levels: z
    .array(
      z.looseObject({
        level: finite,
        threshold: finite,
        reward: z.looseObject({
          voucher_amount: finite,
          box_tier: z.string(),
          frame_unlock: z.boolean(),
          direct_referral_pct: finite,
        }),
      }),
    )
    .default([]),
```
(`.default([])` keeps parsing resilient against an older backend that predates A1.)

- [ ] **Step 3b: Add the type, helper, and mapping in `vip.ts`.** Add near the top exports:

```ts
export type VipLevel = {
  level: number;
  threshold: number;
  reward: {
    voucherAmount: number;
    boxTier: string;
    frameUnlock: boolean;
    directReferralPct: number;
  };
};

type RawVipLevel = {
  level: number;
  threshold: number;
  reward: {
    voucher_amount: number;
    box_tier: string;
    frame_unlock: boolean;
    direct_referral_pct: number;
  };
};

export function mapVipLevels(raw: RawVipLevel[]): VipLevel[] {
  return raw.map((r) => ({
    level: r.level,
    threshold: r.threshold,
    reward: {
      voucherAmount: r.reward.voucher_amount,
      boxTier: r.reward.box_tier,
      frameUnlock: r.reward.frame_unlock,
      directReferralPct: r.reward.direct_referral_pct,
    },
  }));
}
```
Add `levels: VipLevel[]` to the `Vip` type, and in the success return of `getVip` add:

```ts
        levels: mapVipLevels((v.levels ?? []) as RawVipLevel[]),
```

- [ ] **Step 4: Run the test to confirm it passes.**

```bash
npx vitest run src/lib/actions/__tests__/vip-levels.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/lib/data/schemas.ts src/lib/actions/vip.ts src/lib/actions/__tests__/vip-levels.test.ts
git commit -m "feat(vip): parse and map the full ladder in getVip"
```

---

### Task A3: Benefits helper + list component

**Files:**
- Create: `src/app/(account)/vip/vip-benefits.ts`
- Create: `src/app/(account)/vip/VipBenefits.tsx`
- Test: `src/app/(account)/vip/__tests__/vip-benefits.test.ts`

**Interfaces:**
- Consumes: `VipLevel[]` (Task A2).
- Produces:
  ```ts
  export type Milestone = { level: number; perks: string[] };
  export function milestoneBenefits(levels: VipLevel[]): Milestone[];
  export function VipBenefits({ levels }: { levels: VipLevel[] }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test.** Create `src/app/(account)/vip/__tests__/vip-benefits.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { milestoneBenefits } from '../vip-benefits';
import type { VipLevel } from '@/lib/actions/vip';

const lvl = (
  level: number,
  boxTier: string,
  frameUnlock: boolean,
  directReferralPct: number,
): VipLevel => ({
  level,
  threshold: level,
  reward: { voucherAmount: 0, boxTier, frameUnlock, directReferralPct },
});

describe('milestoneBenefits', () => {
  it('emits a row only where a frame/box/referral perk changes', () => {
    const levels = [
      lvl(1, 'a', false, 1),
      lvl(2, 'a', false, 2), // referral bump
      lvl(9, 'a', false, 2),
      lvl(10, 'b', true, 2), // frame + box upgrade
    ];
    expect(milestoneBenefits(levels)).toEqual([
      { level: 2, perks: ['Referral rate → 2%'] },
      {
        level: 10,
        perks: ['New avatar frame', 'Daily box upgrades to Tier B'],
      },
    ]);
  });

  it('never emits a change row for the first level (no prior to compare)', () => {
    expect(milestoneBenefits([lvl(1, 'a', false, 1)])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

```bash
npx vitest run "src/app/(account)/vip/__tests__/vip-benefits.test.ts"
```
Expected: FAIL — module not found.

- [ ] **Step 3a: Implement the helper.** Create `src/app/(account)/vip/vip-benefits.ts`:

```ts
import type { VipLevel } from '@/lib/actions/vip';

export type Milestone = { level: number; perks: string[] };

/**
 * The "big" VIP perks by level: frame unlocks, daily-box tier upgrades, and
 * referral-rate bumps — i.e. rungs where something changes vs the previous
 * rung. Per-level vouchers are shown on the carousel cards, not here, so this
 * summary stays scannable. L1 has no prior to compare, so it never emits a
 * change row (frame_unlock is false at L1 anyway).
 */
export function milestoneBenefits(levels: VipLevel[]): Milestone[] {
  const out: Milestone[] = [];
  let prevTier: string | null = null;
  let prevReferral: number | null = null;
  for (const l of levels) {
    const perks: string[] = [];
    if (l.reward.frameUnlock) perks.push('New avatar frame');
    if (prevTier !== null && l.reward.boxTier !== prevTier) {
      perks.push(`Daily box upgrades to Tier ${l.reward.boxTier.toUpperCase()}`);
    }
    if (prevReferral !== null && l.reward.directReferralPct !== prevReferral) {
      perks.push(`Referral rate → ${l.reward.directReferralPct}%`);
    }
    if (perks.length > 0) out.push({ level: l.level, perks });
    prevTier = l.reward.boxTier;
    prevReferral = l.reward.directReferralPct;
  }
  return out;
}
```

- [ ] **Step 3b: Implement the list component.** Create `src/app/(account)/vip/VipBenefits.tsx`:

```tsx
import type { VipLevel } from '@/lib/actions/vip';
import { milestoneBenefits } from './vip-benefits';

/** "Level Privilege Benefits" — the milestone perks (frames, box upgrades,
 *  referral bumps) by level. Per-level vouchers live on the carousel cards. */
export function VipBenefits({ levels }: { levels: VipLevel[] }) {
  const milestones = milestoneBenefits(levels);
  if (milestones.length === 0) return null;
  return (
    <section aria-labelledby="vip-benefits-heading" className="mt-6">
      <h2
        id="vip-benefits-heading"
        className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-neutral-400"
      >
        Level Privilege Benefits
      </h2>
      <ol className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
        {milestones.map((m, i) => (
          <li
            key={m.level}
            className={`flex items-start gap-3 px-4 py-3 ${
              i > 0 ? 'border-t border-white/5' : ''
            }`}
          >
            <span className="font-heading text-chase shrink-0 text-sm">
              LV {m.level}
            </span>
            <span className="text-[13px] text-white/80">
              {m.perks.join(' · ')}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
```

- [ ] **Step 4: Run the test to confirm it passes.**

```bash
npx vitest run "src/app/(account)/vip/__tests__/vip-benefits.test.ts"
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit.**

```bash
git add "src/app/(account)/vip/vip-benefits.ts" "src/app/(account)/vip/VipBenefits.tsx" "src/app/(account)/vip/__tests__/vip-benefits.test.ts"
git commit -m "feat(vip): milestone benefits helper + Level Privilege Benefits list"
```

---

### Task A4: The level carousel

**Files:**
- Create: `src/app/(account)/vip/VipLevelCarousel.tsx`

**Interfaces:**
- Consumes: `VipLevel[]` (A2), `GalleryRail` from `src/app/slots/[slug]/GalleryRail.tsx` (`{ count, activeIndex, onIndexChange, reduced, children:(i)=>ReactNode }`), `rm0` from `@/lib/format`.
- Produces: `VipLevelCarousel({ levels, highestLevel, spend })`.

> **Note (ponytail):** reuses `GalleryRail`, which renders all `count` items. 100 lightweight level cards is acceptable; if it ever measures slow, add windowing to `GalleryRail`. This intentionally relaxes the spec's "window the DOM" wording in favor of reuse.

- [ ] **Step 1: Create the component.** `src/app/(account)/vip/VipLevelCarousel.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { Check, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm0 } from '@/lib/format';
import type { VipLevel } from '@/lib/actions/vip';
import { GalleryRail } from '@/app/slots/[slug]/GalleryRail';

type State = 'reached' | 'current' | 'locked';

function stateFor(level: number, highestLevel: number): State {
  if (level < highestLevel) return 'reached';
  if (level === highestLevel) return 'current';
  return 'locked';
}

function LevelCard({
  level,
  highestLevel,
  spend,
}: {
  level: VipLevel;
  highestLevel: number;
  spend: number;
}) {
  const state = stateFor(level.level, highestLevel);
  // Progress of lifetime spend toward THIS rung's threshold (100% once reached).
  const pct =
    level.threshold > 0
      ? Math.min(100, Math.round((spend / level.threshold) * 100))
      : 100;
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-[300px] flex-col rounded-2xl border p-5',
        state === 'current'
          ? 'border-chase/60 bg-chase/[0.06]'
          : state === 'reached'
            ? 'border-white/15 bg-white/[0.04]'
            : 'border-white/5 bg-white/[0.02]',
      )}
    >
      <div className="flex items-center justify-between">
        <span
          className={cn(
            'font-heading text-3xl',
            state === 'locked' ? 'text-white/40' : 'text-chase',
          )}
        >
          LV {level.level}
        </span>
        {state === 'reached' && (
          <Check className="text-buyback-fg h-5 w-5" aria-label="Reached" />
        )}
        {state === 'current' && (
          <span className="bg-chase rounded-full px-2 py-0.5 text-[11px] font-bold text-neutral-950">
            YOU
          </span>
        )}
        {state === 'locked' && (
          <Lock className="h-4 w-4 text-white/40" aria-label="Locked" />
        )}
      </div>

      <ul className="mt-4 space-y-1.5 text-[13px] text-white/80">
        {level.reward.voucherAmount > 0 && (
          <li>{rm0(level.reward.voucherAmount)} voucher</li>
        )}
        <li>Tier {level.reward.boxTier.toUpperCase()} daily box</li>
        {level.reward.frameUnlock && <li>New avatar frame</li>}
        <li>{level.reward.directReferralPct}% referral rate</li>
      </ul>

      <div className="mt-4">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="bg-chase h-full rounded-full"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[10px] font-semibold text-neutral-500">
          <span>{rm0(Math.min(spend, level.threshold))}</span>
          <span>{rm0(level.threshold)}</span>
        </div>
      </div>
    </div>
  );
}

export function VipLevelCarousel({
  levels,
  highestLevel,
  spend,
}: {
  levels: VipLevel[];
  highestLevel: number;
  spend: number;
}) {
  const reduced = useReducedMotion() ?? false;
  const initial = Math.max(
    0,
    levels.findIndex((l) => l.level === highestLevel),
  );
  const [index, setIndex] = useState(initial);

  if (levels.length === 0) return null;

  return (
    <div className="mt-2">
      <GalleryRail
        count={levels.length}
        activeIndex={index}
        onIndexChange={setIndex}
        reduced={reduced}
      >
        {(i) => (
          <LevelCard
            level={levels[i]}
            highestLevel={highestLevel}
            spend={spend}
          />
        )}
      </GalleryRail>
    </div>
  );
}
```

- [ ] **Step 2: Type-check (no unit test — presentational; verified visually in A5).**

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors in the new file.

- [ ] **Step 3: Commit.**

```bash
git add "src/app/(account)/vip/VipLevelCarousel.tsx"
git commit -m "feat(vip): swipeable 100-level carousel (reuses GalleryRail)"
```

---

### Task A5: Rebuild the `/vip` page + retire `/daily`

**Files:**
- Modify: `src/app/(account)/vip/page.tsx`
- Modify: `src/app/daily/page.tsx`

**Interfaces:**
- Consumes: `getVip()` (`Vip.levels`, `highestLevelEver`, `spend`, `next`), `getDaily()` (`DailyState`), `VipLevelCarousel`, `VipBenefits`, `VipVouchers`, `DailyClient` (default export, `{ initial: DailyState }`).

- [ ] **Step 1: Rebuild `src/app/(account)/vip/page.tsx`.** Replace the file body with:

```tsx
import type { Metadata } from 'next';
import { AccountHeader, StatCards } from '@/components/account/ui';
import { getDaily } from '@/lib/actions/daily';
import { getVip } from '@/lib/actions/vip';
import { rm } from '@/lib/format';
import DailyClient from '@/app/daily/DailyClient';
import { VipLevelCarousel } from './VipLevelCarousel';
import { VipBenefits } from './VipBenefits';
import { VipVouchers } from './VipVouchers';

export const metadata: Metadata = { title: 'VIP' };

export default async function VipPage() {
  const [res, dailyRes] = await Promise.all([getVip(), getDaily()]);
  if (!res.ok) {
    return (
      <>
        <AccountHeader title="VIP" sub="Your level and progress." />
        <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/60">
          {res.error}
        </p>
      </>
    );
  }
  const v = res.vip;
  return (
    <>
      <AccountHeader title="VIP" sub="Swipe your level ladder and see every reward." />
      <StatCards
        items={[
          { label: 'Level', value: `${v.level}` },
          { label: 'Highest ever', value: `${v.highestLevelEver}` },
          { label: 'Lifetime spend', value: rm(v.spend) },
        ]}
      />

      <VipLevelCarousel
        levels={v.levels}
        highestLevel={v.highestLevelEver}
        spend={v.spend}
      />

      <VipBenefits levels={v.levels} />

      {/* Daily free box (relocated from /daily — a VIP-tier benefit). */}
      {dailyRes.ok && (
        <div className="mt-6">
          <DailyClient initial={dailyRes.state} />
        </div>
      )}

      {/* Level-up voucher claims. */}
      {dailyRes.ok && (
        <VipVouchers
          initialClaimable={dailyRes.state.vouchers.claimable.filter(
            (g) => g.kind === 'voucher',
          )}
          initialClaimed={dailyRes.state.vouchers.claimed.filter(
            (g) => g.kind === 'voucher',
          )}
          redemptionEnabled={dailyRes.state.redemptionEnabled}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Redirect `/daily` to `/vip`.** Replace `src/app/daily/page.tsx` with:

```tsx
import { redirect } from 'next/navigation';

// The daily free box moved onto /vip (it's a VIP-tier benefit). The "Task" tab
// now points at the Weekly Challenge (/task). Keep this redirect so old links,
// bookmarks, and the /rewards → daily hop still land on the box.
export default function DailyPage(): never {
  redirect('/vip');
}
```
(`JoinPrompt.tsx` and `DailyClient.tsx` stay — `DailyClient` is now imported by `/vip`; `JoinPrompt` becomes unused and may be deleted in a later cleanup.)

- [ ] **Step 3: Verify in the browser** (per the repo's preview workflow). Launch the stack, log in as the customer, open `/vip`:
  - carousel centers on the customer's highest level; swipe left/right works; reached/current/locked states render; per-card progress bars fill.
  - the Level Privilege Benefits list shows milestone rows.
  - the daily box renders and "Open box" still draws.
  - `/daily` redirects to `/vip`.
  Capture a screenshot as proof.

- [ ] **Step 4: Type gate.**

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors.

- [ ] **Step 5: Commit.**

```bash
git add "src/app/(account)/vip/page.tsx" "src/app/daily/page.tsx"
git commit -m "feat(vip): rebuild /vip as level hub + relocate daily box; /daily → /vip"
```

---

## SUB-PROJECT B — Points removal (profile surfaces)

### Task B1: Remove points from `/me` (header + balance card)

**Files:**
- Modify: `src/app/(account)/me/MeAppearance.tsx`
- Modify: `src/app/(account)/me/page.tsx`

- [ ] **Step 1: Drop `points` from `MeHeader`.** In `MeAppearance.tsx`:
  - Remove `points` from the `MeHeader` props destructure and its type (the `points: number | null` line).
  - Replace the stats paragraph (the `{pulls !== null && points !== null && (...)}` block) with a pulls-only version:

```tsx
          {pulls !== null && (
            <p className="mt-1 text-[13px] text-neutral-400">
              <span className="font-semibold text-white">{num(pulls)}</span>{' '}
              Pulls
            </p>
          )}
```
  - Remove the now-unused `compact` import (leave `num`).

- [ ] **Step 2: Update `/me` page.** In `src/app/(account)/me/page.tsx`:
  - Remove `points={profile ? profile.stats.points : null}` from the `<MeHeader ...>` call.
  - Delete the entire "Points balance" `<Link>` (the right tile of the `grid grid-cols-2` block) and change the wrapper so **Invite friends spans full width**: replace `<div className="grid grid-cols-2 gap-4">` with `<div>` and drop the closing partner so only the Invite-friends `<Link>` remains (keep its classes; it now fills the row).
  - Remove the now-unused `compact` import if nothing else on the page uses it (grep first: `compact(` in this file — the points card was the only user; remove it from the `@/lib/format` import).

- [ ] **Step 3: Type gate + grep check.**

```bash
npx tsc --noEmit -p tsconfig.json
grep -n "points" "src/app/(account)/me/page.tsx" "src/app/(account)/me/MeAppearance.tsx"
```
Expected: tsc clean; grep returns nothing.

- [ ] **Step 4: Commit.**

```bash
git add "src/app/(account)/me/page.tsx" "src/app/(account)/me/MeAppearance.tsx"
git commit -m "refactor(me): remove points balance card + header points stat"
```

---

### Task B2: Remove points from profile view-model, mocks, and public surfaces

**Files:**
- Modify: `src/lib/profile-view.ts`, `src/lib/data/profiles.ts`, `src/lib/mock/users.ts`
- Modify: `src/app/profile/[user]/ProfileClient.tsx`, `src/app/social/SocialClient.tsx`, `src/app/how-it-works/page.tsx`
- Test: `src/lib/data/__tests__/profiles.test.ts`, `src/lib/__tests__/profile-view.test.ts`

- [ ] **Step 1: Update the failing tests first (RED).**
  - In `src/lib/__tests__/profile-view.test.ts`, remove `points` from every `stats: { ... }` fixture and any `expect(...).points` assertion.
  - In `src/lib/data/__tests__/profiles.test.ts`, remove `points: 50` (and any points assertion) from the stats fixture.

- [ ] **Step 2: Run them to confirm they fail against current code.**

```bash
npx vitest run src/lib/__tests__/profile-view.test.ts src/lib/data/__tests__/profiles.test.ts
```
Expected: FAIL — current `toProfileView`/`mockProfileView` still read `.points`, or the type still requires it. (If they pass because fixtures were the only reference, that's fine — proceed; the goal is green after Step 3.)

- [ ] **Step 3: Remove the field + mappings.**
  - `src/lib/profile-view.ts`: delete `points: number;` from `ProfileViewUser`; delete `points: profile.stats.points,` in `toProfileView`; delete `points: user.points,` in `mockProfileView`.
  - `src/lib/data/profiles.ts`: delete `points: number;` from `PublicProfile.stats`.
  - `src/lib/mock/users.ts`: delete `points: number;` from `MockUser` and remove the two points generators (the `points:` assignments in the two user factories).
  - `src/app/profile/[user]/ProfileClient.tsx`: delete the stat-array entry `{ icon: Star, label: 'Points', value: compact(user.points) }`; remove now-unused imports (`Star`, and `compact` if unused elsewhere in the file).
  - `src/app/social/SocialClient.tsx`: change `{compact(u.points)} pts · #{u.rank}` to `#{u.rank}`; remove now-unused `compact` import if unused elsewhere.
  - `src/app/how-it-works/page.tsx`: rewrite the "Earn points on every purchase. Top collectors win weekly prizes…" copy to remove "points" (e.g. "Rip packs to climb the weekly leaderboard. Top collectors win prizes.").

- [ ] **Step 4: Run tests + type gate.**

```bash
npx vitest run src/lib/__tests__/profile-view.test.ts src/lib/data/__tests__/profiles.test.ts
npx tsc --noEmit -p tsconfig.json
```
Expected: PASS + clean.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/profile-view.ts src/lib/data/profiles.ts src/lib/mock/users.ts "src/app/profile/[user]/ProfileClient.tsx" src/app/social/SocialClient.tsx src/app/how-it-works/page.tsx src/lib/__tests__/profile-view.test.ts src/lib/data/__tests__/profiles.test.ts
git commit -m "refactor(profile): remove points from view-model, mocks, and public surfaces"
```

---

### Task B3: Backend — stop emitting profile points + delete dead helper

**Files:**
- Modify: `backend/packages/api/src/api/store/profiles/[handle]/route.ts`
- Modify: `backend/packages/api/src/modules/packs/service.ts`
- Test: `backend/packages/api/integration-tests/http/public-profile.spec.ts`

- [ ] **Step 1: Update the test first (RED).** In `public-profile.spec.ts`, remove the `stats.points` assertions (the `points: N × PACK_PRICE × 100` expectations). Keep the `pulls` / `volume` / `by_rarity` assertions.

- [ ] **Step 2: Remove the points emission + call.** In `profiles/[handle]/route.ts`:
  - Delete `const points = await packs.packOpenSpendCents(customer.id)` (the line that computes points).
  - Remove `points: Math.round(points),` from the `stats` object in the response.

- [ ] **Step 3: Delete the now-dead helper.** In `service.ts`, delete the entire `packOpenSpendCents(...)` method (used only by the profile route). **Do NOT** touch `profileStatsForCustomer` or `leaderboardTop`.

- [ ] **Step 4: Run the test + type gate.**

```bash
cd backend/packages/api
corepack yarn jest integration-tests/http/public-profile.spec.ts
corepack yarn tsc --noEmit
```
Expected: PASS + clean. (Needs the `pokenic-postgres` test DB.)

- [ ] **Step 5: Commit.**

```bash
git add "backend/packages/api/src/api/store/profiles/[handle]/route.ts" backend/packages/api/src/modules/packs/service.ts backend/packages/api/integration-tests/http/public-profile.spec.ts
git commit -m "refactor(profile-api): stop emitting stats.points; drop packOpenSpendCents"
```

---

### Task B4: Delete the orphaned points-coin asset

**Files:**
- Delete: `public/images/app/points-coin.webp`

- [ ] **Step 1: Confirm no remaining references.**

```bash
grep -rn "points-coin" src public
```
Expected: no matches (B1 removed the only user).

- [ ] **Step 2: Delete + commit.**

```bash
git rm public/images/app/points-coin.webp
git commit -m "chore(assets): remove orphaned points-coin.webp"
```

---

## SUB-PROJECT C — Nav rename + `/daily` disposition

### Task C1: Rename the tab `Daily` → `Task`

**Files:**
- Modify: `src/components/app-shell/tabs.ts`
- Modify: `DESIGN.md`

- [ ] **Step 1: Edit `tabs.ts`.** Change the import `CalendarCheck` → `ListChecks` (from `lucide-react`), and `TABS[0]`:

```ts
  { label: 'Task', href: '/task', icon: ListChecks },
```
(Both `TabBar.tsx` and `AppHeader.tsx` read `tab.label`/`tab.icon`, so they update automatically — no edits there.)

- [ ] **Step 2: Update the nav contract doc.** In `DESIGN.md` §5 (Navigation), change the tab list label `Daily` → `Task` and its description (`Daily = daily reward` → `Task = weekly challenge`).

- [ ] **Step 3: Type gate + commit.**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/components/app-shell/tabs.ts DESIGN.md
git commit -m "feat(nav): rename Daily tab to Task (/task)"
```

---

### Task C2: The Task "coming soon" shell

**Files:**
- Create: `src/app/task/page.tsx`

- [ ] **Step 1: Create the shell.** `src/app/task/page.tsx`:

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { Trophy } from 'lucide-react';
import { pillVariants } from '@/components/ui/pill';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Task',
  description: 'The Weekly Pulled Value Challenge on Polycards.',
};

// Placeholder until sub-project D ships the full Weekly Pulled Value Challenge
// (community pool + milestone stages + top-10 payout). Public, like the board.
export default function TaskPage() {
  return (
    <div className="px-fluid mx-auto w-full max-w-md py-16 text-center">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-900">
        <Trophy className="text-chase h-7 w-7" aria-hidden />
      </span>
      <h1 className="font-heading mt-4 text-3xl text-white">
        WEEKLY CHALLENGE
      </h1>
      <p className="mx-auto mt-2 max-w-[40ch] text-sm leading-relaxed text-neutral-400">
        The Weekly Pulled Value Challenge is launching soon — every pack you rip
        will build the community pool and put you on the weekly board.
      </p>
      <Link href="/leaderboard" className={cn(pillVariants({ size: 'md' }), 'mt-6')}>
        View the leaderboard
      </Link>
    </div>
  );
}
```

- [ ] **Step 2: Verify the route renders + tab lights up.** Browser: open `/task` (renders the shell), confirm the bottom-nav "Task" tab shows the new label/icon and is active on `/task`. Screenshot as proof.

- [ ] **Step 3: Commit.**

```bash
git add src/app/task/page.tsx
git commit -m "feat(task): Weekly Challenge coming-soon shell"
```

---

### Task C3: Fix inbound links + sitemap

**Files:**
- Modify: `src/app/(account)/rewards/page.tsx`
- Modify: `src/lib/site.ts`
- Modify: `src/app/(account)/me/page.tsx`

- [ ] **Step 1: Repoint the `/rewards` redirect.** In `rewards/page.tsx`, change `redirect('/daily')` → `redirect('/vip')`.

- [ ] **Step 2: Update the sitemap.** In `src/lib/site.ts`, change `'/daily'` → `'/task'` in `ROUTES`.

- [ ] **Step 3: Repoint the `/me` "Today's box" link.** In `me/page.tsx`, change the `<Link href="/daily">` around "Today's box" to `href="/vip"`.

- [ ] **Step 4: Sweep for any remaining stale `/daily` links.**

```bash
grep -rn "href=\"/daily\"\|'/daily'\|\"/daily\"" src
```
Expected: only `src/app/daily/page.tsx` (the redirect target itself) — repoint any other UI link found to `/vip` (box) or `/task` (challenge) as appropriate.

- [ ] **Step 5: Type gate + commit.**

```bash
npx tsc --noEmit -p tsconfig.json
git add "src/app/(account)/rewards/page.tsx" src/lib/site.ts "src/app/(account)/me/page.tsx"
git commit -m "chore(nav): repoint /daily inbound links to /vip and /task"
```

---

## Final Verification

- [ ] **Storefront units:** `npm run test` — all green (incl. the new `vip-levels` + `vip-benefits` suites).
- [ ] **Type gate:** `npx tsc --noEmit -p tsconfig.json` (storefront) and `cd backend/packages/api && corepack yarn tsc --noEmit` (backend) — both clean.
- [ ] **Backend integration** (test DB up): `store-vip.spec.ts` + `public-profile.spec.ts` green.
- [ ] **Browser smoke** (preview workflow): `/vip` (carousel + benefits + box + vouchers), `/me` (no points anywhere, Invite friends full-width), `/task` (shell + active tab), `/leaderboard` (unchanged — still shows its points; that's D), `/daily`→`/vip` redirect. Screenshots captured.
- [ ] **Grep guard:** `grep -rn "\.points\b" src` shows only the per-card marketplace badge (`meta.points`, `MockCard.points`, `MarketplaceClient`) and the leaderboard (`LeaderboardEntry.points`, deferred to D) — no profile points remain.

---

## Self-Review notes (author)

- **Spec coverage:** A (widen route A1 · parse A2 · benefits A3 · carousel A4 · page+relocate A5), B (me B1 · profile/mocks/public B2 · backend B3 · asset B4), C (tab C1 · shell C2 · links C3). All spec §2–§4 items map to a task.
- **Deliberate deviations flagged:** (1) carousel reuses `GalleryRail` (renders all 100) rather than DOM-windowing — ponytail note in A4; (2) box tier shown as `Tier X box` (existing convention) rather than an admin box name — friendly names are a trivial `reward_box.name` follow-up, not fabricated here; (3) leaderboard points intentionally NOT removed in B (it is D's re-rank).
- **Type consistency:** `VipLevel` (A2) is the single shape consumed by A3/A4/A5; `mapVipLevels`/`milestoneBenefits` names match across tasks.
