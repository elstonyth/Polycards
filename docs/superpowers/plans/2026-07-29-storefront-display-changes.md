# Storefront Display Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-29-storefront-display-changes-design.md`

**Goal:** Remove How It Rips, make the home "top chase" the pack's true highest-value card, collapse "Cards in this pack" to a Mythical+ teaser row, and replace the odds panel's "Overall win rate" with the pack's card-value range.

**Architecture:** Four independent display edits on two surfaces (home, pack detail). One new pure helper (`poolValueRange`) carries the only new logic and the only new unit test; everything else is composition changes verified by the Playwright capture loop.

**Tech Stack:** Next.js App Router, Tailwind, vitest (unit), Playwright scripts in `scripts/`.

## Global Constraints

- **Storefront only.** No backend change.
- **No new formatting code:** reuse `priceNumber` (`src/lib/packs-data.ts:137`) and `formatValue` (`src/lib/packs-format.ts:42`).
- **Mythical+ = `TOP_RARITIES` / `isTopRarity`** from `src/lib/rarity.ts` — never a hand-rolled rarity list.
- **Collapsed teaser N = 6** highest-value Mythical+ cards.
- Range row label: `Card value range`; value `{min} – {max}` (en dash, spaces). `null` range hides the row.
- Subhead copy for the collapsed section: `The rarest cards in this pack and their current market price.`
- **Working tree hygiene:** unrelated uncommitted changes exist — stage explicitly by path, never `git add -A`.
- **Worktree** (superpowers `using-git-worktrees`, pre-consented); `npm install` after creating it; verify on a self-built `:4100`.
- Verify against the production build (`npm run build` + `pwsh scripts/serve-standalone.ps1`), never `next dev`.

---

### Task 1: Remove "How It Rips"

**Files:**
- Modify: `src/app/page.tsx`
- Delete: `src/components/home/HowItRips.tsx`

**Interfaces:**
- Produces: home section order becomes Hero → marquee → shelf → Recent Pulls → TheGame → FinalCta.

- [ ] **Step 1: Confirm the component's only importer is the home page**

Run: `grep -rn "HowItRips" src --include=*.tsx`
Expected: exactly two files — `src/app/page.tsx` (import + element) and the component itself. Do NOT touch `HowItWorksSteps.tsx` or `/how-it-works` (different feature, stays).

- [ ] **Step 2: Edit page.tsx**

Delete the import `import HowItRips from '@/components/home/HowItRips';` and the block:
```tsx
{/* 03 — trust engine */}
<HowItRips />
```
Renumber the section comments that follow so they stay honest: `{/* 04 — live proof */}` → `03`, `{/* 05 — podium + loop teaser */}` → `04`, `{/* 06 — closer */}` → `05`.

- [ ] **Step 3: Delete the component**

```bash
git rm src/components/home/HowItRips.tsx
```

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/app/page.tsx
git commit -m "feat(home): remove the How It Rips section"
```

---

### Task 2: Home top chase = the pack's highest-value card

**Files:**
- Modify: `src/app/page.tsx` (chase derivation + stale comment)
- Modify: `src/lib/data/packs.ts` (stale "Phase 5a" comment only — no logic change)

**Interfaces:**
- Consumes: `PackDetail.pool: PackCard[]` — value-sorted descending by `getPackDetail`; `PackCard.value: string` (`'RM 1,234.56'` or `'—'`).
- Produces: `chaseByPack: Map<string, PackCard | null>` now holding the highest-**priced** pool card (first entry whose `value !== '—'`), consumed unchanged by `HeroBoard` / `TierShelf`.

- [ ] **Step 1: Change the chase derivation**

In `src/app/page.tsx`:
```ts
// BEFORE
const chaseByPack = new Map<string, PackCard | null>(
  lookupPacks.map((p, i) => [p.id, details[i]?.topHits[0] ?? null]),
);
// AFTER — pool is value-sorted desc, so the first PRICED entry is the pack's
// highest-value card ('—' = an older backend omitted marketPriceMyr; falling
// through it keeps a fake headline off the shelf).
const chaseByPack = new Map<string, PackCard | null>(
  lookupPacks.map((p, i) => [
    p.id,
    details[i]?.pool.find((c) => c.value !== '—') ?? null,
  ]),
);
```

- [ ] **Step 2: Fix the two stale shared-pool comments (spec §2, verified stale)**

In `src/app/page.tsx` the `ponytail:` comment above `lookupPacks` claims "every pack shares one card pool … these N parallel lookups fetch identical payloads". Replace that sentence with:
```
// ponytail: pools are per-pack (listPackOdds is pack_id-scoped), so these N
// lookups are genuinely distinct; collapse to a short-TTL cache only if the
// home render cost ever shows up in traces.
```
In `src/lib/data/packs.ts`, the `getPackDetail` doc comment's "Phase 5a: every pack draws from one shared card pool, so this detail is pool-wide (identical across packs) — the storefront reuses it when the user switches sibling packs." — delete that paragraph (it is false today).

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/app/page.tsx src/lib/data/packs.ts
git commit -m "feat(home): top chase reads the pack's highest-value pool card"
```

---

### Task 3: Odds panel — "Overall win rate" → card value range

**Files:**
- Modify: `src/lib/packs-format.ts` (new helper)
- Test: `src/lib/__tests__/pool-value-range.test.ts` (new)
- Modify: `src/app/slots/[slug]/OddsSheet.tsx`
- Modify: `src/app/slots/[slug]/PackDetailClient.tsx:504`
- Modify: `src/app/slots/[slug]/SlotMachineClient.tsx:1027`

**Interfaces:**
- Consumes: `priceNumber(price: string): number` (0 for `'—'`); `formatValue(mv: number): string` (`'RM 1,234.56'`); `PackCard.value: string`.
- Produces: `export type PoolValueRange = { min: string; max: string };` and `export function poolValueRange(pool: readonly { value: string }[]): PoolValueRange | null` in `src/lib/packs-format.ts`. `PublishedOddsList` / `OddsSheet` prop `overall: number | null` **replaced by** `range: PoolValueRange | null`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/pool-value-range.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { poolValueRange } from '../packs-format';

describe('poolValueRange', () => {
  it('returns the min and max of priced cards, formatted', () => {
    const pool = [
      { value: 'RM 9,869.90' },
      { value: 'RM 4,861.30' },
      { value: 'RM 45.20' },
    ];
    expect(poolValueRange(pool)).toEqual({
      min: 'RM 45.20',
      max: 'RM 9,869.90',
    });
  });

  it("ignores unpriced '—' cards", () => {
    const pool = [{ value: '—' }, { value: 'RM 100.00' }, { value: '—' }];
    expect(poolValueRange(pool)).toEqual({
      min: 'RM 100.00',
      max: 'RM 100.00',
    });
  });

  it("returns null when nothing is priced (all '—' or empty)", () => {
    expect(poolValueRange([{ value: '—' }])).toBeNull();
    expect(poolValueRange([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- pool-value-range`
Expected: FAIL — `poolValueRange` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/lib/packs-format.ts` (which already imports `formatValue`-adjacent pieces; `priceNumber` comes from `@/lib/packs-data`):

```ts
import { priceNumber } from '@/lib/packs-data';

/** Min–max of a pool's PRICED display values ('—' rows skipped); null when
 *  nothing is priced. Display prices already carry FX × per-card markup —
 *  this is a pure read, no new pricing math. */
export type PoolValueRange = { min: string; max: string };

export function poolValueRange(
  pool: readonly { value: string }[],
): PoolValueRange | null {
  const values = pool.map((c) => priceNumber(c.value)).filter((v) => v > 0);
  if (values.length === 0) return null;
  return {
    min: formatValue(Math.min(...values)),
    max: formatValue(Math.max(...values)),
  };
}
```
(Import-cycle check: `packs-format.ts` already imports from `@/lib/rarity`; confirm `packs-data.ts` does not import `packs-format.ts` — if it does, put the helper in a new `src/lib/pool-range.ts` instead and adjust imports in the later steps.)

- [ ] **Step 4: Run tests**

Run: `npm test -- pool-value-range`
Expected: PASS.

- [ ] **Step 5: Swap the prop in `PublishedOddsList` and `OddsSheet`**

In `src/app/slots/[slug]/OddsSheet.tsx`:

`PublishedOddsList` signature:
```tsx
import type { PoolValueRange } from '@/lib/packs-format';

export function PublishedOddsList({
  odds,
  range,
  rounded = 'xl',
}: {
  /** Published rows (rarest-first). */
  odds: { rarity: Rarity; chance: string }[];
  /** Pack card-value range (display prices, markup included); null hides the row. */
  range: PoolValueRange | null;
  rounded?: 'xl' | '2xl';
}) {
```
Header row (replaces the `overall !== null && (…)` block, same `li` classes):
```tsx
{range !== null && (
  <li className="flex items-center justify-between border-b border-white/5 bg-white/[0.03] px-4 py-3">
    <span className="text-[13px] font-semibold text-white">
      Card value range
    </span>
    <span className="text-[13px] font-semibold tabular-nums text-white">
      {range.min} – {range.max}
    </span>
  </li>
)}
```
`OddsSheet` props: replace `overall: number | null` with `range: PoolValueRange | null` and pass through: `<PublishedOddsList odds={odds} range={range} />`. Delete the now-unused `overall` prop docs.

- [ ] **Step 6: Update the two call sites**

`src/app/slots/[slug]/PackDetailClient.tsx` (~line 504): the odds panel
```tsx
<PublishedOddsList
  odds={publishedRows}
  range={poolValueRange(pool)}
  rounded="2xl"
/>
```
with `import { publishedOddsRows, poolValueRange } from '@/lib/packs-format';` (extend the existing import).

`src/app/slots/[slug]/SlotMachineClient.tsx` (~line 1027):
```tsx
<OddsSheet
  open={oddsOpen}
  onClose={() => setOddsOpen(false)}
  odds={publishedOdds ? publishedOddsRows(publishedOdds) : null}
  range={poolValueRange(pool)}
/>
```
(`pool` is a prop defaulting to `[]` → `poolValueRange([])` → `null` → row hidden. Extend the existing `publishedOddsRows` import with `poolValueRange`.)

- [ ] **Step 7: Confirm no other consumer of the old prop**

Run: `grep -rn "overall" src/app/slots src/lib/packs-format.ts`
Expected: no remaining `overall` prop usage on `PublishedOddsList`/`OddsSheet`; `PublishedOdds.overall` (the data type in `packs-format.ts`/`packs.ts`) legitimately remains — data stays, display goes.

- [ ] **Step 8: Typecheck + full test run + commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/lib/packs-format.ts src/lib/__tests__/pool-value-range.test.ts "src/app/slots/[slug]/OddsSheet.tsx" "src/app/slots/[slug]/PackDetailClient.tsx" "src/app/slots/[slug]/SlotMachineClient.tsx"
git commit -m "feat(odds): show the pack card-value range instead of the overall win rate"
```

---

### Task 4: "Cards in this pack" — Mythical+ only, collapsed teaser row

**Files:**
- Modify: `src/app/slots/[slug]/PackDetailClient.tsx` (filter + guard + subhead)
- Modify: `src/app/slots/[slug]/PoolByRarity.tsx` (collapsed/expanded UI)

**Interfaces:**
- Consumes: `isTopRarity(rarity: string): boolean` from `@/lib/rarity`; `PackCard` (value-sorted pool).
- Produces: `PoolByRarity` props unchanged in shape (`pool`, `tierChances`, `onOpen`) but `pool` now receives the **pre-filtered Mythical+ subset**; new internal `expanded` state.

- [ ] **Step 1: Filter in the caller**

In `PackDetailClient.tsx`, next to the existing `const pool = liveDetail?.pool ?? [];` add:
```ts
// Mythical+ subset for the "Cards in this pack" section (spec 2026-07-29):
// commons/rares are catalogue noise there. Order inherited (pool is
// value-sorted desc). The FULL pool still feeds the demo spin + odds range.
const topPool = pool.filter((c) => isTopRarity(c.rarity));
```
Add `isTopRarity` to the `@/lib/rarity` import (create the import if absent — check the file's current imports first).

Change the section guard and subhead (~line 470):
```tsx
{topPool.length > 0 && (
  <Reveal as="section">
    <h2 className="mb-1 font-heading text-lg font-bold tracking-tight text-white">
      Cards in this pack
    </h2>
    <p className="mb-3 text-[13px] text-white/70">
      The rarest cards in this pack and their current market price.
    </p>
    <PoolByRarity
      pool={topPool}
      tierChances={liveDetail?.publishedOdds?.tiers ?? null}
      onOpen={(card) => setOpenCard(toSeed(card))}
    />
  </Reveal>
)}
```
(Only the guard variable, the subhead string, and `pool={topPool}` change.)

- [ ] **Step 2: Add collapsed/expanded state to PoolByRarity**

`PoolByRarity.tsx` is already `'use client'`. Reshape the component body (props unchanged):

```tsx
import { useState } from 'react';

const TEASER_COUNT = 6;

export function PoolByRarity({ pool, tierChances, onOpen }: { /* unchanged */ }) {
  const [expanded, setExpanded] = useState(false);

  // Existing grouping, untouched (runs on whatever pool the caller passes).
  const groups = RARITY_ORDER.map((rarity) => ({
    rarity,
    cards: pool.filter((c) =>
      isRarity(c.rarity) ? c.rarity === rarity : rarity === 'Common',
    ),
  })).filter((g) => g.cards.length > 0);

  const canExpand = pool.length > TEASER_COUNT;

  return (
    <div className="flex flex-col gap-5">
      {expanded ? (
        /* current groups.map(...) markup, byte-identical */
      ) : (
        /* teaser: ONE flat rail of the top TEASER_COUNT cards (pool is
           value-sorted desc), no tier headers — same rail div as the
           per-tier rails (copy the halo-padding comment + classes verbatim
           from the existing rail) */
        <div className="-mx-4 -my-12 flex gap-2 overflow-x-auto px-10 py-12 sm:gap-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {pool.slice(0, TEASER_COUNT).map((c) => (
            <div key={c.id} className="w-[38%] shrink-0 sm:w-40">
              <CardTile
                card={c}
                sizes="(max-width: 640px) 38vw, 160px"
                onOpen={onOpen}
              />
            </div>
          ))}
        </div>
      )}
      {canExpand && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mx-auto flex min-h-11 items-center gap-1 text-[13px] font-semibold text-white/70 transition-colors hover:text-white"
        >
          {expanded ? 'Show less' : `Show all ${pool.length} cards`}
        </button>
      )}
    </div>
  );
}
```
Notes for the implementer:
- The expanded branch is the CURRENT `groups.map(...)` JSX moved inside the ternary — do not retype it; cut and paste, keeping the long halo-padding comment.
- The teaser rail must reuse the exact rail classes (the `-my-12/py-12` halo-room trick) or slab glows clip.
- When `pool.length <= TEASER_COUNT`, `canExpand` is false: the teaser IS the whole set and no button renders. A single-Immortal pack (bronze) shows one card, no button.
- Update the component doc comment: it currently promises "a 40-common pool costs one row" — rewrite to describe the Mythical+ teaser/expand behaviour and that the caller pre-filters.

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add "src/app/slots/[slug]/PackDetailClient.tsx" "src/app/slots/[slug]/PoolByRarity.tsx"
git commit -m "feat(pack): collapse Cards in this pack to a Mythical+ teaser row"
```

---

### Task 5: Build + Playwright verification

**Files:**
- Create: `scripts/qa-display-changes.mjs`

- [ ] **Step 1: Full check + serve**

```bash
npm run check
pwsh scripts/serve-standalone.ps1 -Port 4100
```
(Worktree serve on `:4100`; `.env.local` copied in. `QA_PACK=pokemon-elite` seeding recipe applies only if the local DB lacks packs — see memory notes.)

- [ ] **Step 2: QA script**

Write `scripts/qa-display-changes.mjs` (chromium, `PW_BASE ?? http://localhost:4100`), asserting:
1. `/` contains no `HOW IT RIPS` text.
2. `/` — for the featured pack row, capture the `Top chase` value; fetch `/slots/<featured-slug>` and assert the same RM string appears as the top card's value (the spec's "highest-value card" check).
3. `/slots/bronze-pack` — "Cards in this pack" section: count rendered `CardTile`s ≤ 6 before any click; every visible tier label ∈ {Immortal, Legendary, Mythical}; if a `Show all N cards` button exists, click it and assert tier headers render and still no Common/Uncommon/Rare label appears in the section.
4. `/slots/bronze-pack` — Pull Odds panel first row text matches `/^Card value range/` and value matches `/RM [\d,.]+ – RM [\d,.]+/`; assert the string `Overall win rate` is absent from the page.
5. `/slots/bronze-pack/spin?demo=1` — open the odds sheet (the existing odds affordance), assert the same `Card value range` row. Probe the sr-only meter idiom per memory notes; cookie-reject first.
Screenshots of each surface to `docs/research/qa-display-*.png`.

Run: `node scripts/qa-display-changes.mjs`
Expected: all assertions pass. Read the PNGs back with the Read tool.

- [ ] **Step 3: Commit**

```bash
git add scripts/qa-display-changes.mjs
git commit -m "test(display): playwright QA for hero chase, card teaser, odds range"
```
