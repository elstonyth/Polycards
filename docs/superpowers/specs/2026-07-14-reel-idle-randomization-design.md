# Reel Idle-Strip Randomization — Design

- **Date:** 2026-07-14
- **Status:** Approved design, pre-plan
- **Scope:** Storefront slot machine idle/decoy strips only
  (`src/lib/hreel.ts`, `src/app/slots/[slug]/SlotMachineClient.tsx`,
  `src/app/slots/[slug]/SlotReelStack.tsx`). Winner selection, landing physics,
  the press-launch mechanic (#147), and the win-rate lock (PRD §3.7/§8) are
  explicitly **out of scope and must not change**.
- **Follow-ups (separate specs, boss doc `polycard.docx` 2026-07-14):** Pull-Odds
  panel with auto-balancing Common %, "Cards in this pack" → "Top Hits" with
  admin-selected rarity categories, Vault select-mode redesign, "Me" page
  Show-Go layout with showcase + quick-access grid, Vault NEW-card red-dot flow,
  processing modal. None of these are part of this design.

## Problem

Every reel shows the **identical Pokémon sequence at the identical position** on
every page load and after every spin. Root cause: the idle strip is a pure
deterministic tiling — `buildHReelStrip` fills cell `i` with
`pool[(i + colIndex*4) % pool.length]` (src/lib/hreel.ts:237), where `pool` is
`buildDecoyPool(pack cards)` in stable card order. The drift always starts
centered on `IDLE_BASE_INDEX = 5`. So the reel at rest — and the preserved
`keepCells` a press launches through — always reads the same species in the
same order.

The spin **runway** is already randomized per spin (mulberry32 seeded by the
`Date.now()` spin nonce ⊕ column — `buildPressStrip`), and the **winner** is
decided upstream (server draw / `demoDraw`). Only the idle tiling is fixed.

## Decision (user-approved)

**Approach A + per-reel shuffles:** each reel gets its own independently
shuffled copy of the decoy pool, reshuffled on every page visit AND on every
return-to-idle after a spin. The strip stays a *periodic* tiling (period =
pool length) — required for the seamless idle-drift wrap — but the order within
the period is random per reel per idle cycle.

Rejected: random seed offset into the existing formula (only shifts the start,
order stays fixed); non-periodic random strip (breaks the seamless wrap, or
degenerates into this approach).

## Design

### 1. `shuffleCells` — new pure helper (src/lib/hreel.ts)

```ts
export function shuffleCells(
  cells: readonly HReelCell[],
  rand: () => number = Math.random,
): HReelCell[]
```

Fisher–Yates copy-shuffle (never mutates input). `rand` is injectable so unit
tests seed it. Lives beside the other pure strip helpers; no other change to
`hreel.ts` — `buildHReelStrip`, `buildPressStrip`, and the `(i + seed*4)`
tiling formula are untouched (the `colIndex*4` offset becomes redundant on top
of per-reel shuffles but is harmless, and leaving it keeps the diff zero
there).

### 2. SlotMachineClient — decoy pool becomes per-reel state

Replace the single memoized `decoyCards` with:

```tsx
const basePool = useMemo(() => buildDecoyPool(pool), [pool]);
// SSR-safe initial value (unshuffled copies); the effect below randomizes.
const [decoyPools, setDecoyPools] = useState<HReelCell[][]>(() =>
  Array.from({ length: reels }, () => basePool),
);
useEffect(() => {
  if (phase !== 'idle') return;
  setDecoyPools(Array.from({ length: reels }, () => shuffleCells(basePool)));
}, [phase, reels, basePool]);
```

One effect covers every randomization point:

- **Mount:** `phase` starts `'idle'` → shuffles immediately after hydration.
  The server HTML and first client paint use the unshuffled `basePool`
  (identical → no hydration mismatch); the shuffled order lands one effect-tick
  later, before sprites finish lazy-loading.
- **Return-to-idle after a spin:** the reshuffle lands on the same transition
  where `ReelStrip` already teleports the strip position back to base — the
  cut the reveal theater has always covered (ReelStrip.tsx:181-183). No new
  class of visual event.
- **Reel count change (idle-only by design, `canAdjustReels`):** pools array
  stays in sync with `reels`. **Accepted trade-off:** adjusting the count
  reshuffles all reels, so untouched strips swap content mid-idle; this
  coincides with the add/remove layout animation and is cosmetic. The
  alternative (stale array length) would give a new reel `undefined` →
  `DECOY_DEXES` fallback → **non-pack Pokémon on the reel**, a correctness
  bug. Cosmetic blip beats correctness bug.

### 3. SlotReelStack — pool per strip

Prop `decoyCards?: readonly HReelCell[]` becomes
`decoyPools?: readonly (readonly HReelCell[])[]`; strip `i` receives
`decoyCards={decoyPools?.[i]}`. `ReelStrip` keeps its existing `decoyCards`
prop and is **unchanged**, as is all physics (`vault-reel.ts`).
`SlotMachineClient` is the sole `SlotReelStack` consumer; `SlotReelStack` is
the sole `ReelStrip` consumer — the prop rename is fully contained.

## Why the win-lock and spin feel cannot regress

- **Winner path untouched:** the outcome is resolved before the reel moves
  (server `openBatch` / demo draw); `buildPressStrip` still pins that winner at
  the dynamically chosen index with the gated tease at `winIndex − 1`. This
  design only reorders the *filler* cells around it.
- **Seamless press launch (#147) preserved by construction:** pools mutate only
  while `phase === 'idle'`; pressing spin leaves `'idle'` before winners
  arrive, so when `ReelStrip` builds `keepCells` it reads the exact same
  `decoyCards` prop that painted the on-screen idle frame.
- **Odds display, published rates, rarity flicker rules:** decoys still come
  only from the pack's own (dex, rarity) pairs — a shuffle changes order, not
  membership.

## Edge cases

- **Empty pack pool:** `shuffleCells([]) → []` → existing curated
  `DECOY_DEXES` fallback in `ReelStrip`/`buildHReelStrip` (both check
  `length > 0`). Unchanged.
- **Single-card pool:** shuffle is a no-op; reel legitimately shows one
  species, as today.
- **Reduced motion:** strip rests sharp (no drift) but still gets the shuffled
  order. No interaction.

## Testing

- **Unit (`src/lib/__tests__/hreel.test.ts`):** `shuffleCells` preserves length
  and multiset, does not mutate its input, is deterministic under an injected
  seeded rng, handles empty/single-element pools.
- **Repo gates:** `npm run check` (lint + typecheck + build); the PostToolUse /
  Stop typecheck hooks stay green.
- **Visual QA (per repo rules — production server, Playwright scripts, not
  Chrome MCP):** `npm run build` → `pwsh scripts/serve-standalone.ps1 -Port
  4000` → run `scripts/qa-slot-machine.mjs` and `scripts/qa-demo-spin.mjs`;
  screenshot two fresh page loads and confirm different starting Pokémon and
  different per-reel orders; spin once and confirm the return-to-idle strip
  differs from the pre-spin strip.

## Footprint

~10 lines `hreel.ts`, ~12 lines `SlotMachineClient.tsx`, ~6 lines
`SlotReelStack.tsx`, one unit-test block. No dependency, schema, or backend
changes.
