# Storefront display changes: How It Rips, top-hit value, pack card grid, odds range

**Date:** 2026-07-29
**Status:** Approved (design)
**Scope:** Storefront only. No backend change.

Four independent display changes, grouped because they all land in the same
two surfaces (home page, pack detail) and share one build/verify cycle.

---

## 1. Remove "How It Rips"

The home page's trust-engine section comes out.

- `src/app/page.tsx` — drop `<HowItRips />` (line ~69) and its import.
- Delete `src/components/home/HowItRips.tsx`.
- Leave `src/components/HowItWorksSteps.tsx` and the `/how-it-works` route
  alone — different component, still linked from `/me` and the footer.

Section numbering in `page.tsx`'s comments shifts (`04 → 03` etc.); update the
comments so they stay honest.

---

## 2. Home top-hit value → the pack's highest-value card

### Current behaviour

`src/app/page.tsx` builds `chaseByPack` from `details[i]?.topHits[0]`.
`topHits` is **admin-ordered** (`src/lib/data/packs.ts:262` — filtered on
`top_hit_order != null`, sorted by that order). So the value on the home page is
the admin's *first pick*, not the pack's highest-value card. `HeroBoard` renders
it as the headline; `TierShelf` renders it as `Top chase RM …`.

### Change

Read from `pool` instead:

```ts
const chaseByPack = new Map<string, PackCard | null>(
  lookupPacks.map((p, i) => [p.id, details[i]?.pool[0] ?? null]),
);
```

`pool` is already sorted descending by display price in `getPackDetail`
(`packs.ts:255`), so `pool[0]` **is** the highest-value card in the pack. Its
`value` already carries the per-card markup (`market_multiplier`, default 1.2)
because the backend computes `marketPriceMyr = FMV × FX × multiplier`.

`HeroBoard.tsx` and `TierShelf.tsx` need no edit — same `PackCard` shape.

**Verified: pools are per-pack.** The `ponytail:` comment at `page.tsx:38` and
the "Phase 5a" note at `packs.ts:225` both claim every pack shares one card
pool — that is **stale**. `GET /store/packs/:slug` queries
`listPackOdds({ pack_id: slug })`
(`backend/.../api/store/packs/[slug]/route.ts:71`), which is genuinely
pack-scoped, and live data confirms it (Diamond's top card RM 22,377.23 vs
Bronze's RM 9,869.90). So `pool[0]` differs per pack and the shelf will not
render one identical chase value down every row. Fix the two stale comments
while in the file.

### Consequences (accepted)

- A pack with no admin-curated Top Hits now shows a chase value where it
  previously showed none. This is intended: the user asked for the pack's
  highest value, not the curated pick.
- The pack-detail "Top Hits" section keeps its admin ordering. Only the *home*
  headline changes.

### Edge case

`getPackDetail` sorts on `marketPriceMyr ?? market_value`, mixing MYR and raw
USD when an older backend omits `marketPriceMyr`. Such a card renders `'—'`.
If `pool[0].value === '—'`, fall back to the first pool entry whose `value` is
not `'—'`; if none, `null` (no chase rendered, current empty behaviour).

---

## 3. "Cards in this pack" — collapsed to one row, Mythical and above

### Current behaviour

`PoolByRarity` renders every rarity tier present in the pool as its own
horizontally-swipeable rail, rarest first. A 40-card pool is 6 stacked rails.

### Change

`PoolByRarity` gains a collapsed/expanded state (client component already).

- **Filter:** only tiers in `TOP_RARITIES` (`src/lib/rarity.ts:37` =
  `Immortal`, `Legendary`, `Mythical`) are ever rendered. Common / Uncommon /
  Rare never appear in this section. Reuse the constant — do not write a new
  filter.
- **Collapsed (default):** ONE row — the **6 highest-value** cards drawn from
  the Mythical+ set, flat (no per-tier headers), in the existing rail markup
  (`overflow-x-auto`, hidden scrollbar) — so a narrow viewport swipes sideways
  rather than wrapping to a second line. Ordering is inherited: `pool` is
  already value-sorted descending, so filtering preserves it.
- **Expanded (after tap):** the current per-tier rail layout, restricted to
  Mythical+ tiers, with their headers, counts, and published pull chances.
- **Affordance:** a button below the row — `Show all N cards` / `Show less`,
  where N is the Mythical+ count. Hidden entirely when the Mythical+ count
  ≤ 6 (nothing to expand to).
- **Empty:** zero Mythical+ cards → the whole "Cards in this pack" section is
  not rendered (the caller already guards on `pool.length > 0`; add a second
  guard on the filtered set).

The subhead copy `Every card and its current market price, rarest first.`
becomes `The rarest cards in this pack and their current market price.` — the
old line is now false.

### Reduced-motion

The expand is a state toggle, not an animation. No `useInView` involvement, so
nothing new to gate on `prefers-reduced-motion`.

---

## 4. Pull Odds: "Overall win rate" → price range

### Current behaviour

`PublishedOddsList` (`src/app/slots/[slug]/OddsSheet.tsx:14-38`) takes
`overall: number | null` and renders a header row `Overall win rate … 78%`.

### Change

The header row becomes the pack's card-value range:

```
Card value range          RM 45.20 – RM 9,869.90
```

`PublishedOddsList`'s prop changes from `overall: number | null` to
`range: { min: string; max: string } | null`. `null` hides the row exactly as
`overall === null` does today.

Derivation, in the caller:

```ts
const values = pool.map((c) => priceNumber(c.value)).filter((v) => v > 0);
const range = values.length
  ? { min: formatValue(Math.min(...values)), max: formatValue(Math.max(...values)) }
  : null;
```

`priceNumber` (`packs-data.ts:137`) returns 0 for `'—'`, so the filter drops
unpriced cards. Both helpers already exist — no new formatting code.

**The 20% markup needs no work.** Card display values are already
`FMV × FX × market_multiplier` with `market_multiplier` defaulting to 1.2
(`modules/packs/models/card.ts:62`, migration `Migration20260701120000`). The
range reads marked-up prices by construction.

### Three call sites — all must change together

| File | Line | Note |
| --- | --- | --- |
| `src/app/slots/[slug]/PackDetailClient.tsx` | 504 | `pool` in scope. |
| `src/app/slots/[slug]/SlotMachineClient.tsx` | 1027 | `pool` is a prop (line 96/106) — in scope, may be `[]` → `range: null`. |
| `src/app/slots/[slug]/OddsSheet.tsx` | 73-79, 119 | `OddsSheet` threads the prop through to `PublishedOddsList`. |

The caption `Published rates for this pack.` stays.

### Consequence (accepted)

The published overall win-rate percentage stops being displayed anywhere on the
storefront. It remains stored on the pack (`published_odds.overall`) and stays
editable in the admin odds editor — this is a display removal, not a data
change. Per-rarity published chances are unaffected.

---

## Verification

Build + serve the production bundle (never `next dev` — see CLAUDE.md):

```
npm run build
pwsh scripts/serve-standalone.ps1 -Port 4000
```

Then, with a Playwright script in `scripts/` screenshotting to
`docs/research/`:

- `/` — no "HOW IT RIPS" section; the Diamond Pack row's `Top chase` equals the
  highest-value card on `/slots/diamond-pack`, not the admin's first Top Hit.
- `/slots/bronze-pack` — "Cards in this pack" is one row of ≤6 cards, all
  Mythical or above; tapping `Show all` reveals the Mythical+ tier rails; no
  Common/Rare/Uncommon card appears in the section.
- `/slots/bronze-pack` — the Pull Odds panel's first row reads
  `Card value range   RM x – RM y`, with `y` matching the pack's top card.
- `/slots/bronze-pack/spin?demo=1` — the odds sheet shows the same range row.
  (bronze-pack is the only spinnable pack locally.)

Unit test for the range derivation (genuine logic, per `.claude/rules/common/testing.md`):
a `src/lib/__tests__` case covering all-priced, some-`'—'`, and all-`'—'` pools.
