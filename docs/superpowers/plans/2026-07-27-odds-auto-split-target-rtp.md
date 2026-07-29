# Odds Auto-Split by Target RTP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One admin action that sets every unlocked card's win rate to hit a pack-level target RTP, following the existing rarity ladder, and reports every card whose fair rate falls below the storable minimum.

**Architecture:** Two new pure exports in `@acme/odds-math` — `proposeRarities` (value-banded tiers) and `solveOddsForRtp` (a chase-budget solve with a 1 bps floor cascade). The solver is a *preview-time input generator*: it emits decimal pcts that flow through the unchanged `computeSetWeights` → `balanceOdds` → save pipeline, so no write path, inheritance rule, or draw path changes. A `target_rtp_bps` column on `pack` persists the target, saved through the existing odds POST route.

**Tech Stack:** TypeScript strict, `@acme/odds-math` (CJS workspace package), Medusa v2 + MikroORM hand-written migrations, Jest (backend unit + http shards), Mercur admin (Vite + @medusajs/ui + react-query + vitest).

**Spec:** `docs/superpowers/specs/2026-07-27-odds-auto-split-target-rtp-design.md`

## Global Constraints

- **Branch from `feat/epic3-odds`**, not master. This builds on Epic 3's 3-set odds, `balanceOdds`, and EV/RTP columns.
- **Worktree** (consent pre-granted): `git worktree add .worktrees/odds-autosplit -b feat/odds-autosplit feat/epic3-odds`. Then `corepack yarn install` from `backend/`, and PowerShell `Copy-Item` for `backend/packages/api/.env` (bash `cp` is blocked by the guard-secrets hook).
- **`corepack yarn build` in `backend/packages/odds-math` after EVERY source change there.** `main` is `dist/index.js`; consumers load a stale dist otherwise and fail with confusing "Cannot find module" or silently-old behavior.
- **TypeScript strict, no `any`.** Named exports, 2-space indent.
- **Probabilities are fractions `[0,1]` in the math, percentages `0–100` on the wire.** `pct` fields everywhere are percentages. Never mix.
- **`TOTAL_BPS = 10000`** and `pack_odds.weight` is an integer — smallest storable non-zero rate is **1 bps = 0.01%**.
- **`balanceOdds` owns bps rounding.** The solver emits decimal pcts and must NOT round to bps itself.
- **Commits:** `git commit -F <message-file>`. Never PowerShell here-strings in Git Bash. Conventional commits.
- **A global formatter hook rewrites backend double-quotes to single quotes on every Edit/Write.** Expect it; do not fight it.

## File Structure

| File | Responsibility |
| --- | --- |
| `backend/packages/odds-math/src/index.ts` | Add `proposeRarities`, `solveOddsForRtp`, `MIN_PCT` and their types beside `balanceOdds`. First value-aware exports; values arrive as arguments so the package stays dependency-free. |
| `backend/packages/odds-math/src/__tests__/propose-rarities.unit.spec.ts` | Band boundaries + bronze-pack fixture. |
| `backend/packages/odds-math/src/__tests__/solve-rtp.unit.spec.ts` | Solve, feasible band, typed errors, floor cascade, tier collapse. |
| `backend/packages/api/src/modules/packs/models/pack.ts` | `target_rtp_bps` column. |
| `backend/packages/api/src/modules/packs/migrations/Migration20260729000000.ts` | Additive integer column, default 7000. |
| `backend/packages/api/src/api/admin/packs/[slug]/odds/route.ts` | GET exposes `target_rtp_bps`; POST accepts and persists it. |
| `backend/apps/admin/src/lib/packs-api.ts` | Type additions. |
| `backend/apps/admin/src/lib/odds-rows.ts` | `rowsToSolveInput`, `applySolveResult`, `applyRarityProposals` — pure, vitest-covered. |
| `backend/apps/admin/src/lib/odds-rows.test.ts` | Tests for the three helpers above. |
| `backend/apps/admin/src/routes/packs/[slug]/page.tsx` | Target RTP field, Auto-split action, report panel. |
| `backend/apps/admin/src/i18n/en.json` | Copy. |
| `backend/packages/api/integration-tests/http/pack-auto-split.spec.ts` | End-to-end: saved auto-split reproduces the floored RTP. |

---

### Task 1: `proposeRarities` — value-banded rarity tiers

**Files:**
- Modify: `backend/packages/odds-math/src/index.ts`
- Test: `backend/packages/odds-math/src/__tests__/propose-rarities.unit.spec.ts`

**Interfaces:**
- Consumes: existing `OddsRarity`, `RARITY_WEIGHT`, `RARITIES` from the same module.
- Produces: `RarityProposalRow { card_id: string; value: number }`, `RarityProposal { card_id: string; rarity: OddsRarity }`, `proposeRarities(rows: RarityProposalRow[], packPrice: number): RarityProposal[]`.

- [ ] **Step 1: Write the failing test**

Create `backend/packages/odds-math/src/__tests__/propose-rarities.unit.spec.ts`:

```ts
import { proposeRarities } from '../index';

// bronze-pack display prices (FMV USD x 4.091 fx x 1.2 markup), RM 50 ticket.
const BRONZE = [
  { card_id: 'pw-pikachu', value: 24.55 },
  { card_id: 'pw-bulbasaur', value: 39.27 },
  { card_id: 'pw-jolteon', value: 122.73 },
  { card_id: 'pw-gengar', value: 589.1 },
  { card_id: 'pw-charizard', value: 1718.22 },
  { card_id: 'mega-dragonite', value: 1829.51 },
  { card_id: 'pw-mewtwo', value: 4418.28 },
  { card_id: 'pikachu-grey-felt', value: 4856.08 },
  { card_id: 'pikachu-ex-238', value: 4860.11 },
  { card_id: 'mega-charizard-x', value: 9867.49 },
];

const tierOf = (rows: { card_id: string; value: number }[], price: number) =>
  Object.fromEntries(proposeRarities(rows, price).map((p) => [p.card_id, p.rarity]));

describe('proposeRarities', () => {
  it('tiers the bronze-pack pool against its RM 50 ticket', () => {
    expect(tierOf(BRONZE, 50)).toEqual({
      'pw-pikachu': 'Common',
      'pw-bulbasaur': 'Common',
      'pw-jolteon': 'Uncommon',
      'pw-gengar': 'Rare',
      'pw-charizard': 'Rare',
      'mega-dragonite': 'Rare',
      'pw-mewtwo': 'Mythical',
      'pikachu-grey-felt': 'Mythical',
      'pikachu-ex-238': 'Mythical',
      'mega-charizard-x': 'Legendary',
    });
  });

  it('treats each band edge as the START of the higher tier', () => {
    const edges = [
      { card_id: 'c', value: 100 }, // exactly 2x  -> Uncommon
      { card_id: 'u', value: 500 }, // exactly 10x -> Rare
      { card_id: 'r', value: 2500 }, // exactly 50x -> Mythical
      { card_id: 'm', value: 7500 }, // exactly 150x -> Legendary
      { card_id: 'l', value: 20000 }, // exactly 400x -> Immortal
    ];
    expect(tierOf(edges, 50)).toEqual({
      c: 'Uncommon',
      u: 'Rare',
      r: 'Mythical',
      m: 'Legendary',
      l: 'Immortal',
    });
  });

  it('degrades to Common on an unusable price or value', () => {
    const rows = [{ card_id: 'a', value: 9999 }];
    expect(tierOf(rows, 0)).toEqual({ a: 'Common' });
    expect(tierOf(rows, Number.NaN)).toEqual({ a: 'Common' });
    expect(tierOf([{ card_id: 'a', value: Number.NaN }], 50)).toEqual({ a: 'Common' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `backend/packages/odds-math`: `npx jest propose-rarities -t 'bronze-pack'`
Expected: FAIL — `proposeRarities is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/packages/odds-math/src/index.ts`:

```ts
// ── Rarity proposal (auto-split support) ────────────────────────────────────
// Tier a card by its value as a MULTIPLE OF THE TICKET, so the mapping is
// explainable and stays stable as prices drift. Pure: the caller supplies
// display prices (FMV x fx x markup); odds-math never reads the DB.

export interface RarityProposalRow {
  card_id: string;
  /** MYR display price (FMV x fx x per-card multiplier). */
  value: number;
}

export interface RarityProposal {
  card_id: string;
  rarity: OddsRarity;
}

// EXCLUSIVE upper bound of each tier as a multiple of pack price; anything at
// or above the last bound is Immortal.
const RARITY_BANDS: { max: number; rarity: OddsRarity }[] = [
  { max: 2, rarity: 'Common' },
  { max: 10, rarity: 'Uncommon' },
  { max: 50, rarity: 'Rare' },
  { max: 150, rarity: 'Mythical' },
  { max: 400, rarity: 'Legendary' },
];

export function proposeRarities(
  rows: RarityProposalRow[],
  packPrice: number,
): RarityProposal[] {
  const priceOk = Number.isFinite(packPrice) && packPrice > 0;
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const value = Number(row.value);
    // Unusable inputs degrade to Common rather than throwing — a stale form
    // must not break the editor's preview.
    if (!priceOk || !Number.isFinite(value) || value < 0) {
      return { card_id: row.card_id, rarity: 'Common' as OddsRarity };
    }
    const multiple = value / packPrice;
    const band = RARITY_BANDS.find((b) => multiple < b.max);
    return { card_id: row.card_id, rarity: band ? band.rarity : 'Immortal' };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `backend/packages/odds-math`: `npx jest propose-rarities`
Expected: PASS, 3 tests.

- [ ] **Step 5: Rebuild the dist and commit**

```bash
cd backend/packages/odds-math && corepack yarn build && cd -
git add backend/packages/odds-math/src/index.ts backend/packages/odds-math/src/__tests__/propose-rarities.unit.spec.ts
git commit -m "feat(odds): proposeRarities — tier cards by value against the ticket price"
```

---

### Task 2: `solveOddsForRtp` — chase-budget solve, no floor yet

**Files:**
- Modify: `backend/packages/odds-math/src/index.ts`
- Test: `backend/packages/odds-math/src/__tests__/solve-rtp.unit.spec.ts`

**Interfaces:**
- Consumes: `TOTAL_BPS`, `RARITY_WEIGHT`, `RARITIES`, `OddsRarity`, and the module-private `rarityWeight(rarity: string): number` helper (already defined near the top of `index.ts`).
- Produces: `MIN_PCT: number` (= 0.01), `RtpSolveRow { card_id, locked, rarity, value, pct }`, `FlooredRow { card_id, fairPct, appliedPct }`, `RtpSolveResult { error, computed, floored, tierCollapse, achievedRtp }`, `solveOddsForRtp(rows, packPrice, targetRtp): RtpSolveResult`. `targetRtp` is a FRACTION (0.7), `pct` values are PERCENTAGES.

**Row grouping — get this right, it is the whole design.** Mirroring `balanceOdds`:
- **locked** (any rarity) → fixed, solver never changes them.
- **chase** = unlocked AND rarity !== 'Common' → the solver sets these; `balanceOdds` will later take them verbatim because non-Common rows are "pinned" there.
- **absorbers** = unlocked AND rarity === 'Common' → the solver computes them, and `balanceOdds` recomputes the identical value as an even split of the remainder (identical only because all Commons share `RARITY_WEIGHT` 500).

- [ ] **Step 1: Write the failing test**

Create `backend/packages/odds-math/src/__tests__/solve-rtp.unit.spec.ts`:

```ts
import { solveOddsForRtp, type RtpSolveRow } from '../index';

// A pool with NO sub-1-bps rates, so this task's math is testable without the
// floor cascade: two cheap Commons and one modest chase card.
const SIMPLE: RtpSolveRow[] = [
  { card_id: 'cheap-a', locked: false, rarity: 'Common', value: 20, pct: 0 },
  { card_id: 'cheap-b', locked: false, rarity: 'Common', value: 40, pct: 0 },
  { card_id: 'chase', locked: false, rarity: 'Rare', value: 500, pct: 0 },
];

const pctOf = (r: ReturnType<typeof solveOddsForRtp>, id: string) =>
  r.computed.find((c) => c.card_id === id)?.pct ?? Number.NaN;

describe('solveOddsForRtp', () => {
  it('hits the target RTP exactly when nothing needs flooring', () => {
    const res = solveOddsForRtp(SIMPLE, 50, 0.7);
    expect(res.error).toBeNull();
    expect(res.achievedRtp).toBeCloseTo(0.7, 6);
    // Commons average 30; chase is 500. EV 35 => c = 5/470.
    expect(pctOf(res, 'chase')).toBeCloseTo((5 / 470) * 100, 6);
    expect(res.floored).toEqual([]);
  });

  it('always totals 100%', () => {
    const res = solveOddsForRtp(SIMPLE, 50, 0.7);
    const total = res.computed.reduce((s, c) => s + c.pct, 0);
    expect(total).toBeCloseTo(100, 6);
  });

  it('leaves locked rows untouched and solves over the rest', () => {
    const rows: RtpSolveRow[] = [
      { card_id: 'pinned', locked: true, rarity: 'Rare', value: 500, pct: 2 },
      ...SIMPLE,
    ];
    const res = solveOddsForRtp(rows, 50, 0.9);
    expect(res.error).toBeNull();
    expect(pctOf(res, 'pinned')).toBe(2);
    expect(res.achievedRtp).toBeCloseTo(0.9, 6);
  });

  it('reports the reachable band instead of clamping an impossible target', () => {
    const res = solveOddsForRtp(SIMPLE, 50, 0.1);
    expect(res.computed).toEqual([]);
    expect(res.error).toMatch(/this pool reaches/);
    expect(res.error).toMatch(/Lower the target, raise the price/);
  });

  it('errors cleanly on degenerate pools', () => {
    const noAbsorber: RtpSolveRow[] = [
      { card_id: 'a', locked: false, rarity: 'Rare', value: 100, pct: 0 },
    ];
    expect(solveOddsForRtp(noAbsorber, 50, 0.7).error).toMatch(/unlocked Common/);

    const noChase: RtpSolveRow[] = [
      { card_id: 'a', locked: false, rarity: 'Common', value: 100, pct: 0 },
    ];
    expect(solveOddsForRtp(noChase, 50, 0.7).error).toMatch(/non-Common/);

    const sameValue: RtpSolveRow[] = [
      { card_id: 'a', locked: false, rarity: 'Common', value: 100, pct: 0 },
      { card_id: 'b', locked: false, rarity: 'Rare', value: 100, pct: 0 },
    ];
    expect(solveOddsForRtp(sameValue, 50, 0.7).error).toMatch(/same average value/);

    expect(solveOddsForRtp(SIMPLE, 0, 0.7).error).toMatch(/Pack price/);
    expect(solveOddsForRtp([], 50, 0.7).error).toMatch(/No cards/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `backend/packages/odds-math`: `npx jest solve-rtp`
Expected: FAIL — `solveOddsForRtp is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/packages/odds-math/src/index.ts`:

```ts
// ── Target-RTP auto-split (POLYCARD-BACK auto-split spec) ───────────────────
// Solve a single CHASE BUDGET `c` — the total probability mass across unlocked
// non-Common rows. Inside the budget the rarity ladder's relative proportions
// are preserved exactly; unlocked Commons absorb the rest. EV is LINEAR in `c`,
// so this is a closed form, not a search.
//
// Rejected alternative: exponentiating the ladder. It hits the target but
// collapses the tail (bronze-pack needs k ~ 6.15, pushing Legendary to 1 in
// 4 trillion), which defeats the point of a chase card.

/** Smallest storable non-zero win rate: 1 bps. */
export const MIN_PCT = 100 / TOTAL_BPS;

export interface RtpSolveRow {
  card_id: string;
  locked: boolean;
  rarity: string;
  /** MYR display price (FMV x fx x per-card multiplier). */
  value: number;
  /** Pinned win % (0-100). Read ONLY when `locked`. */
  pct: number;
}

export interface FlooredRow {
  card_id: string;
  /** The rate the solve wanted (%), below the 1 bps floor. */
  fairPct: number;
  /** What it was pinned to instead — always MIN_PCT. */
  appliedPct: number;
}

export interface RtpSolveResult {
  /** Non-null => do NOT apply. */
  error: string | null;
  /** Win % (0-100) per card, INPUT ORDER. Empty when `error` is set. */
  computed: { card_id: string; pct: number }[];
  /** Chase rows pinned up to the floor. Empty when nothing floored. */
  floored: FlooredRow[];
  /** Tiers whose every chase row sits at the floor (only when >= 2 tiers). */
  tierCollapse: OddsRarity[];
  /** Achieved RTP as a FRACTION (0.703 = 70.3%); null when `error`. */
  achievedRtp: number | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Ladder-weighted mean value; 0 for an empty group. */
const ladderMean = (rows: RtpSolveRow[]): number => {
  const w = rows.reduce((s, r) => s + rarityWeight(r.rarity), 0);
  if (w <= 0) return 0;
  return rows.reduce((s, r) => s + rarityWeight(r.rarity) * r.value, 0) / w;
};

/** Spread `c` over the free chase rows and `M - c` over the absorbers. */
const distribute = (
  all: RtpSolveRow[],
  chaseFree: RtpSolveRow[],
  absorbers: RtpSolveRow[],
  fixedPct: Map<string, number>,
  c: number,
  M: number,
): { card_id: string; pct: number }[] => {
  const wH = chaseFree.reduce((s, r) => s + rarityWeight(r.rarity), 0);
  const wC = absorbers.reduce((s, r) => s + rarityWeight(r.rarity), 0);
  const byId = new Map<string, number>(fixedPct);
  for (const r of chaseFree) {
    byId.set(r.card_id, wH > 0 ? (100 * c * rarityWeight(r.rarity)) / wH : 0);
  }
  for (const r of absorbers) {
    byId.set(r.card_id, wC > 0 ? (100 * (M - c) * rarityWeight(r.rarity)) / wC : 0);
  }
  return all.map((r) => ({ card_id: r.card_id, pct: byId.get(r.card_id) ?? 0 }));
};

const rtpOf = (
  computed: { card_id: string; pct: number }[],
  byId: Map<string, RtpSolveRow>,
  packPrice: number,
): number =>
  computed.reduce(
    (s, c) => s + (c.pct / 100) * (byId.get(c.card_id)?.value ?? 0),
    0,
  ) / packPrice;

export function solveOddsForRtp(
  rows: RtpSolveRow[],
  packPrice: number,
  targetRtp: number,
): RtpSolveResult {
  const fail = (error: string): RtpSolveResult => ({
    error,
    computed: [],
    floored: [],
    tierCollapse: [],
    achievedRtp: null,
  });

  const safe = Array.isArray(rows) ? rows : [];
  if (safe.length === 0) return fail('No cards to configure.');
  if (!Number.isFinite(packPrice) || packPrice <= 0) {
    return fail('Pack price must be greater than 0 to solve for RTP.');
  }
  if (!Number.isFinite(targetRtp) || targetRtp <= 0) {
    return fail('Target RTP must be greater than 0%.');
  }
  if (safe.some((r) => !Number.isFinite(r.value) || r.value < 0)) {
    return fail('Every card needs a value of 0 or more.');
  }

  const locked = safe.filter((r) => r.locked);
  const chase = safe.filter((r) => !r.locked && r.rarity !== 'Common');
  const absorbers = safe.filter((r) => !r.locked && r.rarity === 'Common');

  if (absorbers.length === 0) {
    return fail(
      'No unlocked Common card to absorb the remainder. Set one card to Common and unlock it.',
    );
  }
  if (chase.length === 0) {
    return fail('No unlocked non-Common card to give a chase budget to.');
  }

  const lockedMass = locked.reduce((s, r) => s + r.pct / 100, 0);
  const M = 1 - lockedMass;
  if (M <= 0) {
    return fail('Locked win rates already use the full 100%. Unlock a card to auto-split.');
  }
  const lockedEv = locked.reduce((s, r) => s + (r.pct / 100) * r.value, 0);

  const targetEv = targetRtp * packPrice;
  const vC = ladderMean(absorbers);
  const vH = ladderMean(chase);
  if (vH === vC) {
    return fail(
      'Chase and Common cards have the same average value, so no split changes the RTP.',
    );
  }

  const c = (targetEv - lockedEv - M * vC) / (vH - vC);
  if (c < 0 || c > M) {
    const a = lockedEv + M * vC;
    const b = lockedEv + M * vH;
    const minEv = Math.min(a, b);
    const maxEv = Math.max(a, b);
    return fail(
      `Target ${round2(targetRtp * 100)}% needs EV RM ${round2(targetEv)}; ` +
        `this pool reaches RM ${round2(minEv)}-RM ${round2(maxEv)} ` +
        `(${round2((minEv / packPrice) * 100)}%-${round2((maxEv / packPrice) * 100)}%). ` +
        'Lower the target, raise the price, or change the pool.',
    );
  }

  const fixedPct = new Map<string, number>(locked.map((r) => [r.card_id, r.pct]));
  const computed = distribute(safe, chase, absorbers, fixedPct, c, M);
  const byId = new Map(safe.map((r) => [r.card_id, r]));

  return {
    error: null,
    computed,
    floored: [],
    tierCollapse: [],
    achievedRtp: rtpOf(computed, byId, packPrice),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `backend/packages/odds-math`: `npx jest solve-rtp`
Expected: PASS, 5 tests. Then `npx jest` — all existing suites still green.

- [ ] **Step 5: Rebuild the dist and commit**

```bash
cd backend/packages/odds-math && corepack yarn build && cd -
git add backend/packages/odds-math/src/index.ts backend/packages/odds-math/src/__tests__/solve-rtp.unit.spec.ts
git commit -m "feat(odds): solveOddsForRtp — closed-form chase-budget solve for a target RTP"
```

---

### Task 3: The 1 bps floor cascade and its report

**Files:**
- Modify: `backend/packages/odds-math/src/index.ts` (replace the tail of `solveOddsForRtp`)
- Test: `backend/packages/odds-math/src/__tests__/solve-rtp.unit.spec.ts` (append)

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: no signature change. `RtpSolveResult.floored` and `.tierCollapse` now populate, and `.achievedRtp` reports the *floored* RTP, which is at or above target.

**Why a cascade and not one pass:** flooring a row consumes mass and EV, which forces the re-solve to shrink the remaining budget, which can push *more* rows below the floor. On `bronze-pack` this runs three passes — Legendary floors first, then all three Mythicals.

- [ ] **Step 1: Write the failing test**

Append to `backend/packages/odds-math/src/__tests__/solve-rtp.unit.spec.ts`:

```ts
import { MIN_PCT, RARITY_WEIGHT } from '../index';

// The real bronze-pack pool with corrected (value-banded) rarities.
const BRONZE: RtpSolveRow[] = [
  { card_id: 'pw-pikachu', locked: false, rarity: 'Common', value: 24.55, pct: 0 },
  { card_id: 'pw-bulbasaur', locked: false, rarity: 'Common', value: 39.27, pct: 0 },
  { card_id: 'pw-jolteon', locked: false, rarity: 'Uncommon', value: 122.73, pct: 0 },
  { card_id: 'pw-gengar', locked: false, rarity: 'Rare', value: 589.1, pct: 0 },
  { card_id: 'pw-charizard', locked: false, rarity: 'Rare', value: 1718.22, pct: 0 },
  { card_id: 'mega-dragonite', locked: false, rarity: 'Rare', value: 1829.51, pct: 0 },
  { card_id: 'pw-mewtwo', locked: false, rarity: 'Mythical', value: 4418.28, pct: 0 },
  { card_id: 'pikachu-grey-felt', locked: false, rarity: 'Mythical', value: 4856.08, pct: 0 },
  { card_id: 'pikachu-ex-238', locked: false, rarity: 'Mythical', value: 4860.11, pct: 0 },
  { card_id: 'mega-charizard-x', locked: false, rarity: 'Legendary', value: 9867.49, pct: 0 },
];

describe('solveOddsForRtp — 1 bps floor', () => {
  it('never emits a chase row below the floor', () => {
    const res = solveOddsForRtp(BRONZE, 50, 0.7);
    expect(res.error).toBeNull();
    const chase = res.computed.filter((c) => !['pw-pikachu', 'pw-bulbasaur'].includes(c.card_id));
    for (const row of chase) expect(row.pct).toBeGreaterThanOrEqual(MIN_PCT);
  });

  it('cascades: the Legendary floors first, then all three Mythicals', () => {
    const res = solveOddsForRtp(BRONZE, 50, 0.7);
    const ids = res.floored.map((f) => f.card_id).sort();
    expect(ids).toEqual(
      ['mega-charizard-x', 'pikachu-ex-238', 'pikachu-grey-felt', 'pw-mewtwo'].sort(),
    );
  });

  it('reports fair vs applied for each floored row', () => {
    const res = solveOddsForRtp(BRONZE, 50, 0.7);
    const legendary = res.floored.find((f) => f.card_id === 'mega-charizard-x');
    expect(legendary).toBeDefined();
    expect(legendary!.appliedPct).toBe(MIN_PCT);
    expect(legendary!.fairPct).toBeLessThan(MIN_PCT);
  });

  it('overshoots the target upward, never downward', () => {
    const res = solveOddsForRtp(BRONZE, 50, 0.7);
    expect(res.achievedRtp).toBeGreaterThanOrEqual(0.7);
    expect(res.achievedRtp).toBeLessThan(0.72);
  });

  it('flags the tier collapse when two tiers both sit at the floor', () => {
    const res = solveOddsForRtp(BRONZE, 50, 0.7);
    expect(res.tierCollapse).toEqual(['Legendary', 'Mythical']);
  });

  it('still totals 100% after flooring', () => {
    const res = solveOddsForRtp(BRONZE, 50, 0.7);
    const total = res.computed.reduce((s, c) => s + c.pct, 0);
    expect(total).toBeCloseTo(100, 6);
  });

  it('reports nothing floored on a pool that does not need it', () => {
    const res = solveOddsForRtp(SIMPLE, 50, 0.7);
    expect(res.floored).toEqual([]);
    expect(res.tierCollapse).toEqual([]);
    expect(res.achievedRtp).toBeCloseTo(0.7, 6);
  });

  it('keeps the ladder ordering among rows that did not floor', () => {
    const res = solveOddsForRtp(BRONZE, 50, 0.7);
    const pct = (id: string) => res.computed.find((c) => c.card_id === id)!.pct;
    // Uncommon (weight 300) must stay above Rare (weight 150).
    expect(RARITY_WEIGHT.Uncommon).toBeGreaterThan(RARITY_WEIGHT.Rare);
    expect(pct('pw-jolteon')).toBeGreaterThan(pct('pw-gengar'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `backend/packages/odds-math`: `npx jest solve-rtp -t 'floor'`
Expected: FAIL — `floored` is `[]` and chase rows sit below `MIN_PCT`.

- [ ] **Step 3: Write the implementation**

In `backend/packages/odds-math/src/index.ts`, replace everything in `solveOddsForRtp` from the `const c = (targetEv ...)` line to the final `return` with:

```ts
  // Solve, floor, re-solve. Flooring consumes mass and EV, which shrinks the
  // next budget and can push further rows under the floor — so iterate until
  // stable. Each pass only ADDS to `flooredIds`, bounded by the row count.
  const flooredIds = new Set<string>();
  const floored: FlooredRow[] = [];
  const byId = new Map(safe.map((r) => [r.card_id, r]));
  let computed: { card_id: string; pct: number }[] | null = null;
  let bandError: string | null = null;

  for (let pass = 0; pass <= chase.length; pass += 1) {
    const free = chase.filter((r) => !flooredIds.has(r.card_id));
    const flooredMass = (flooredIds.size * MIN_PCT) / 100;
    const flooredEv = chase
      .filter((r) => flooredIds.has(r.card_id))
      .reduce((s, r) => s + (MIN_PCT / 100) * r.value, 0);

    const mFree = M - flooredMass;
    if (mFree <= 0) {
      bandError =
        'Too many cards need the 1 in 10,000 minimum to fit in 100%. Remove cards from the pool.';
      break;
    }

    const fixedPct = new Map<string, number>(locked.map((r) => [r.card_id, r.pct]));
    for (const id of flooredIds) fixedPct.set(id, MIN_PCT);

    // Every chase row floored: the absorbers simply take what is left.
    if (free.length === 0) {
      computed = distribute(safe, [], absorbers, fixedPct, 0, mFree);
      break;
    }

    const vHFree = ladderMean(free);
    if (vHFree === vC) {
      bandError =
        'Chase and Common cards have the same average value, so no split changes the RTP.';
      break;
    }

    const cFree = (targetEv - lockedEv - flooredEv - mFree * vC) / (vHFree - vC);
    if (cFree < 0 || cFree > mFree) {
      const a = lockedEv + flooredEv + mFree * vC;
      const b = lockedEv + flooredEv + mFree * vH;
      const minEv = Math.min(a, b);
      const maxEv = Math.max(a, b);
      bandError =
        `Target ${round2(targetRtp * 100)}% needs EV RM ${round2(targetEv)}; ` +
        `this pool reaches RM ${round2(minEv)}-RM ${round2(maxEv)} ` +
        `(${round2((minEv / packPrice) * 100)}%-${round2((maxEv / packPrice) * 100)}%). ` +
        'Lower the target, raise the price, or change the pool.';
      break;
    }

    const trial = distribute(safe, free, absorbers, fixedPct, cFree, mFree);
    const trialPct = new Map(trial.map((t) => [t.card_id, t.pct]));
    const below = free.filter((r) => (trialPct.get(r.card_id) ?? 0) < MIN_PCT);

    if (below.length === 0) {
      computed = trial;
      break;
    }
    for (const r of below) {
      floored.push({
        card_id: r.card_id,
        fairPct: trialPct.get(r.card_id) ?? 0,
        appliedPct: MIN_PCT,
      });
      flooredIds.add(r.card_id);
    }
  }

  if (bandError) return fail(bandError);
  if (!computed) return fail('Could not solve a distribution for this target.');

  // A tier has "collapsed" when every one of its chase rows sits at the floor.
  // Reported only when 2+ tiers collapse, since that is when the ladder stops
  // conveying anything to the player.
  const collapsed = new Set<OddsRarity>();
  for (const rarity of RARITIES) {
    const tierRows = chase.filter((r) => r.rarity === rarity);
    if (tierRows.length > 0 && tierRows.every((r) => flooredIds.has(r.card_id))) {
      collapsed.add(rarity);
    }
  }

  return {
    error: null,
    computed,
    floored,
    tierCollapse: collapsed.size >= 2 ? RARITIES.filter((r) => collapsed.has(r)) : [],
    achievedRtp: rtpOf(computed, byId, packPrice),
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `backend/packages/odds-math`: `npx jest solve-rtp`
Expected: PASS, 13 tests (5 from Task 2, 8 new). Then `npx jest` — all suites green.

- [ ] **Step 5: Rebuild the dist and commit**

```bash
cd backend/packages/odds-math && corepack yarn build && cd -
git add backend/packages/odds-math/src/index.ts backend/packages/odds-math/src/__tests__/solve-rtp.unit.spec.ts
git commit -m "feat(odds): floor sub-1-bps chase rates and report the deviation"
```

---

### Task 4: `pack.target_rtp_bps` — column, migration, route plumbing

**Files:**
- Modify: `backend/packages/api/src/modules/packs/models/pack.ts`
- Create: `backend/packages/api/src/modules/packs/migrations/Migration20260729000000.ts`
- Modify: `backend/packages/api/src/api/admin/packs/[slug]/odds/route.ts`

**Interfaces:**
- Produces: `pack.target_rtp_bps: number` (integer bps, default 7000). GET `/admin/packs/:slug/odds` response `pack` block gains `target_rtp_bps: number`. POST `/admin/packs/:slug/odds` body accepts optional `target_rtp_bps?: number` — absent means "leave unchanged".

**Why it saves through the odds route, not the pack route:** the pack update route requires a FULL pack payload (title, image, buyback…) which the odds editor does not hold, and its activation guard would reject an active empty-pool pack. The target belongs to the page that edits it.

- [ ] **Step 1: Write the failing test**

Create `backend/packages/api/integration-tests/http/pack-target-rtp.spec.ts`:

```ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const ADMIN_EMAIL = 'target-rtp-admin@polycards.test';
const PASSWORD = 'supersecret-test-pw';

const PACK_BODY = {
  title: 'Target RTP Pack',
  category: 'pokemon',
  price: 50,
  image: '/cdn/test-pack.webp',
  buyback_percent: 90,
  boost: false,
  rank: 0,
  status: 'draft',
};

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('pack target_rtp_bps', () => {
      let adminHeaders: Record<string, string>;

      beforeEach(async () => {
        const token = await mintSuperAdmin(getContainer(), api, ADMIN_EMAIL, PASSWORD);
        adminHeaders = { Authorization: `Bearer ${token}` };
        const created = await unwrapResponse(
          api.post('/admin/packs', { ...PACK_BODY, slug: 'rtp-pack' }, { headers: adminHeaders }),
        );
        expect(created.status).toBe(201);
      });

      it('defaults to 7000 bps and round-trips a new value', async () => {
        const first = await unwrapResponse(
          api.get('/admin/packs/rtp-pack/odds', { headers: adminHeaders }),
        );
        expect(first.status).toBe(200);
        expect(first.data.pack.target_rtp_bps).toBe(7000);

        const saved = await unwrapResponse(
          api.post(
            '/admin/packs/rtp-pack/odds',
            { entries: [], target_rtp_bps: 8500 },
            { headers: adminHeaders },
          ),
        );
        expect(saved.status).toBe(200);

        const second = await unwrapResponse(
          api.get('/admin/packs/rtp-pack/odds', { headers: adminHeaders }),
        );
        expect(second.data.pack.target_rtp_bps).toBe(8500);
      });

      it('leaves the stored value alone when the key is absent', async () => {
        await unwrapResponse(
          api.post(
            '/admin/packs/rtp-pack/odds',
            { entries: [], target_rtp_bps: 8500 },
            { headers: adminHeaders },
          ),
        );
        await unwrapResponse(
          api.post('/admin/packs/rtp-pack/odds', { entries: [] }, { headers: adminHeaders }),
        );
        const res = await unwrapResponse(
          api.get('/admin/packs/rtp-pack/odds', { headers: adminHeaders }),
        );
        expect(res.data.pack.target_rtp_bps).toBe(8500);
      });

      it('rejects an out-of-range or non-integer target', async () => {
        for (const bad of [0, -1, 1_000_001, 70.5, 'seventy']) {
          const res = await unwrapResponse(
            api.post(
              '/admin/packs/rtp-pack/odds',
              { entries: [], target_rtp_bps: bad },
              { headers: adminHeaders },
            ),
          );
          expect(res.status).toBe(400);
        }
      });
    });
  },
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `backend/packages/api`:
`NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http npx jest integration-tests/http/pack-target-rtp.spec.ts`
Expected: FAIL — `target_rtp_bps` is `undefined`.

- [ ] **Step 3a: Add the model field**

In `backend/packages/api/src/modules/packs/models/pack.ts`, directly after the `buyback_percent` line:

```ts
  // Target RTP for the odds auto-split, in BASIS POINTS (7000 = 70%). Integer
  // via model.number() on purpose: model.bigNumber() is two columns (numeric +
  // a raw_* jsonb sidecar) and a hand-written migration that omits the raw_
  // half passes mocked tests then fails on the first real insert.
  target_rtp_bps: model.number().default(7000),
```

- [ ] **Step 3b: Add the migration**

Create `backend/packages/api/src/modules/packs/migrations/Migration20260729000000.ts`:

```ts
import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Auto-split target RTP in basis points (7000 = 70%). Additive with a default,
// so existing packs backfill without a data migration. Expand-safe.
export class Migration20260729000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "pack" add column if not exists "target_rtp_bps" integer not null default 7000;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "pack" drop column if exists "target_rtp_bps";`);
  }
}
```

- [ ] **Step 3c: Expose it on GET and accept it on POST**

In `backend/packages/api/src/api/admin/packs/[slug]/odds/route.ts`, add to the `res.json({ pack: { ... } })` block, after `price`:

```ts
      target_rtp_bps: pack.target_rtp_bps ?? 7000,
```

Then add this coercion helper beside `setPct`:

```ts
// Optional on every odds save: ABSENT means "leave the stored target alone".
// Bounds are wide (0.01% - 10000%) because a target above 100% is a legitimate
// loss-leader promo; only nonsense is rejected.
export function coerceTargetRtpBps(raw: unknown): number | undefined {
  const v = (raw as Record<string, unknown>)?.target_rtp_bps;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1_000_000) {
    bad(`'target_rtp_bps' must be an integer between 1 and 1000000.`);
  }
  return v as number;
}
```

And in the POST handler, after the entries are coerced and the odds workflow has run, persist it:

```ts
  const targetRtpBps = coerceTargetRtpBps(req.body ?? {});
  if (targetRtpBps !== undefined) {
    const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
    await packs.updatePacks([{ id: pack.id, target_rtp_bps: targetRtpBps }]);
  }
```

> Coerce the target BEFORE running the odds workflow so a bad value 400s without
> writing odds. Move the `coerceTargetRtpBps` call above the workflow run and
> keep only the `updatePacks` call after it.

- [ ] **Step 4: Run migration and tests**

```bash
cd backend/packages/api && corepack yarn db:migrate && cd -
```
Run from `backend/packages/api`:
`NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http npx jest integration-tests/http/pack-target-rtp.spec.ts`
Expected: PASS, 3 tests. Then run `pack-activation-guard.spec.ts` to confirm no regression.

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/modules/packs/models/pack.ts backend/packages/api/src/modules/packs/migrations/Migration20260729000000.ts "backend/packages/api/src/api/admin/packs/[slug]/odds/route.ts" backend/packages/api/integration-tests/http/pack-target-rtp.spec.ts
git commit -m "feat(odds): persist a per-pack target RTP in basis points"
```

---

### Task 5: Admin mapping helpers

**Files:**
- Modify: `backend/apps/admin/src/lib/packs-api.ts`
- Modify: `backend/apps/admin/src/lib/odds-rows.ts`
- Test: `backend/apps/admin/src/lib/odds-rows.test.ts`

**Interfaces:**
- Consumes: `EditRow` and `mapOddsToRows` from `odds-rows.ts`; `solveOddsForRtp`, `proposeRarities`, `RtpSolveResult`, `RarityProposal` from `@acme/odds-math`.
- Produces: `rowsToSolveInput(rows: EditRow[]): RtpSolveRow[]`, `applyRarityProposals(rows: EditRow[], proposals: RarityProposal[]): EditRow[]`, `applySolveResult(rows: EditRow[], result: RtpSolveResult, set: 1 | 2 | 3): EditRow[]`. All pure, all return NEW arrays.

- [ ] **Step 1: Write the failing test**

Append to `backend/apps/admin/src/lib/odds-rows.test.ts`. The file already
imports `type EditRow` for its existing tests — if it does not, add it to the
existing `./odds-rows` import rather than creating a second import statement:

```ts
import { applyRarityProposals, applySolveResult, rowsToSolveInput } from './odds-rows';

const row = (over: Partial<EditRow> = {}): EditRow => ({
  card_id: 'c1',
  name: 'Card',
  image: '',
  slab_image: null,
  rarity: 'Common',
  market_value: 100,
  stock: null,
  currentPct: 0,
  locked: false,
  pctInput: '0',
  pctInput2: '',
  pctInput3: '',
  topHitInput: '',
  ...over,
});

describe('auto-split mapping helpers', () => {
  it('maps editor rows to solver rows using the display price', () => {
    const rows = [row({ card_id: 'a', market_value: 24.55, locked: true, pctInput: '12.5' })];
    expect(rowsToSolveInput(rows)).toEqual([
      { card_id: 'a', locked: true, rarity: 'Common', value: 24.55, pct: 12.5 },
    ]);
  });

  it('treats a blank or malformed pct as 0 rather than NaN', () => {
    expect(rowsToSolveInput([row({ pctInput: '' })])[0].pct).toBe(0);
    expect(rowsToSolveInput([row({ pctInput: '12.' })])[0].pct).toBe(12);
    expect(rowsToSolveInput([row({ pctInput: 'abc' })])[0].pct).toBe(0);
  });

  it('applies rarity proposals without touching other fields', () => {
    const rows = [row({ card_id: 'a' }), row({ card_id: 'b' })];
    const out = applyRarityProposals(rows, [{ card_id: 'b', rarity: 'Legendary' }]);
    expect(out[0].rarity).toBe('Common');
    expect(out[1].rarity).toBe('Legendary');
    expect(out).not.toBe(rows);
    expect(rows[1].rarity).toBe('Common');
  });

  it('writes solved rates into the input for the targeted set only', () => {
    const rows = [row({ card_id: 'a', pctInput: '1', pctInput2: '', pctInput3: '' })];
    const result = {
      error: null,
      computed: [{ card_id: 'a', pct: 42.5 }],
      floored: [],
      tierCollapse: [],
      achievedRtp: 0.7,
    };
    const set2 = applySolveResult(rows, result, 2);
    expect(set2[0].pctInput).toBe('1');
    expect(set2[0].pctInput2).toBe('42.5');
    expect(set2[0].pctInput3).toBe('');
  });

  it('applies nothing when the solve errored', () => {
    const rows = [row({ card_id: 'a', pctInput: '1' })];
    const result = {
      error: 'nope',
      computed: [],
      floored: [],
      tierCollapse: [],
      achievedRtp: null,
    };
    expect(applySolveResult(rows, result, 1)).toEqual(rows);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `backend/apps/admin`: `npx vitest run src/lib/odds-rows.test.ts`
Expected: FAIL — the three helpers are not exported.

- [ ] **Step 3: Write the implementation**

First, in `backend/apps/admin/src/lib/packs-api.ts`, add `target_rtp_bps: number;` to the `PackOddsResponse['pack']` type and extend the odds `mutate` input:

```ts
        odds: {
          query: (input: { $slug: string }) => Promise<PackOddsResponse>;
          mutate: (input: {
            $slug: string;
            entries: OddsInput[];
            target_rtp_bps?: number;
          }) => Promise<{ odds: ComputedOdd[] }>;
        };
```

Then append to `backend/apps/admin/src/lib/odds-rows.ts`:

```ts
import {
  type RarityProposal,
  type RtpSolveResult,
  type RtpSolveRow,
} from '@acme/odds-math';

// A free-typed rate input ('' while the operator is mid-edit, '12.' etc.)
// must never reach the solver as NaN — it would poison every downstream sum.
const numOr0 = (s: string): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

/** Editor rows -> solver input. `value` is the DISPLAY price, matching the
 *  Value column and the EV/RTP tiles. */
export const rowsToSolveInput = (rows: EditRow[]): RtpSolveRow[] =>
  rows.map((r) => ({
    card_id: r.card_id,
    locked: r.locked,
    rarity: r.rarity,
    value: r.market_value,
    pct: numOr0(r.pctInput),
  }));

/** Stage proposed tiers as unsaved edits. Returns a new array; rows without a
 *  proposal are untouched. */
export const applyRarityProposals = (
  rows: EditRow[],
  proposals: RarityProposal[],
): EditRow[] => {
  const byId = new Map(proposals.map((p) => [p.card_id, p.rarity]));
  return rows.map((r) => {
    const rarity = byId.get(r.card_id);
    return rarity ? { ...r, rarity } : { ...r };
  });
};

/** Stage solved rates into the targeted set's input. A failed solve applies
 *  nothing — the caller surfaces `result.error`. */
export const applySolveResult = (
  rows: EditRow[],
  result: RtpSolveResult,
  set: 1 | 2 | 3,
): EditRow[] => {
  if (result.error) return rows;
  const byId = new Map(result.computed.map((c) => [c.card_id, c.pct]));
  return rows.map((r) => {
    const pct = byId.get(r.card_id);
    if (pct === undefined) return { ...r };
    // Trim float noise; the editor stores rates as free-typed strings.
    const text = String(Math.round(pct * 1e6) / 1e6);
    if (set === 1) return { ...r, pctInput: text };
    if (set === 2) return { ...r, pctInput2: text };
    return { ...r, pctInput3: text };
  });
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `backend/apps/admin`: `npx vitest run src/lib/odds-rows.test.ts`
Expected: PASS — the 5 new tests plus every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add backend/apps/admin/src/lib/odds-rows.ts backend/apps/admin/src/lib/odds-rows.test.ts backend/apps/admin/src/lib/packs-api.ts
git commit -m "feat(admin): mapping helpers between editor rows and the RTP solver"
```

---

### Task 6: Editor UI — target field, auto-split action, report panel

**Files:**
- Modify: `backend/apps/admin/src/routes/packs/[slug]/page.tsx`
- Modify: `backend/apps/admin/src/i18n/en.json`

**Interfaces:**
- Consumes: `rowsToSolveInput`, `applyRarityProposals`, `applySolveResult` (Task 5); `solveOddsForRtp`, `proposeRarities`, `MIN_PCT` (Tasks 1–3); `pack.target_rtp_bps` from the odds GET (Task 4).
- Produces: no exports; UI only.

- [ ] **Step 1: Add the copy**

In `backend/apps/admin/src/i18n/en.json`, inside the existing `packs.editor` object:

```json
      "targetRtp": "Target RTP %",
      "autoSplit": "Auto-split odds",
      "autoSplitDone": "Applied — review the rarities and rates, then save.",
      "autoSplitRtp": "Resulting RTP: {{rtp}}% (target {{target}}%)",
      "autoSplitFloored": "{{count}} card(s) pinned at the 1 in 10,000 minimum — they will drop more often than the target implies:",
      "autoSplitFlooredRow": "{{name}}: fair 1 in {{fair}}, actual 1 in {{actual}}",
      "autoSplitCollapse": "These tiers are all at the minimum and are indistinguishable to players: {{tiers}}. Raise the pack price or remove the most valuable cards.",
      "autoSplitSetWarning": "Auto-splitting set {{n}} gives it explicit rates and ends its inheritance from the previous set.",
```

- [ ] **Step 2: Write the failing check**

There is no component test harness for this page; the gate is manual plus typecheck. Run from `backend/apps/admin`: `npx tsc -b`
Expected at this point: PASS (nothing added yet). This step establishes the baseline — record that it is green before editing.

- [ ] **Step 3: Wire the state and the action**

In `backend/apps/admin/src/routes/packs/[slug]/page.tsx`, add imports:

```ts
import { MIN_PCT, proposeRarities, solveOddsForRtp } from '@acme/odds-math';
import {
  applyRarityProposals,
  applySolveResult,
  rowsToSolveInput,
} from '../../../lib/odds-rows';
```

Add state beside the existing `useState` calls:

```ts
  const [targetRtpInput, setTargetRtpInput] = useState('70');
  const [autoSplitError, setAutoSplitError] = useState<string | null>(null);
  const [autoSplitReport, setAutoSplitReport] = useState<{
    achievedRtp: number;
    floored: { name: string; fairPct: number }[];
    tierCollapse: string[];
  } | null>(null);
```

Seed the target from the server snapshot wherever `seededFrom` is applied:

```ts
    if (seededFrom?.pack.target_rtp_bps != null) {
      setTargetRtpInput(String(seededFrom.pack.target_rtp_bps / 100));
    }
```

Add the handler (place it beside the other row mutators, after `toggleLock`):

```ts
  // Auto-split: propose value-banded rarities, solve the chase budget for the
  // target RTP, and stage BOTH as unsaved edits. Nothing is persisted until the
  // operator hits save — the report is how they learn the pack is mispriced.
  const autoSplit = (set: 1 | 2 | 3) => {
    if (!rows || !seededFrom) return;
    setAutoSplitError(null);
    setAutoSplitReport(null);

    const price = seededFrom.pack.price;
    const target = Number(targetRtpInput) / 100;

    const proposals = proposeRarities(
      rows.map((r) => ({ card_id: r.card_id, value: r.market_value })),
      price,
    );
    const retiered = applyRarityProposals(rows, proposals);

    const result = solveOddsForRtp(rowsToSolveInput(retiered), price, target);
    if (result.error) {
      setAutoSplitError(result.error);
      return;
    }

    setRows(applySolveResult(retiered, result, set));
    setAutoSplitReport({
      achievedRtp: result.achievedRtp ?? 0,
      floored: result.floored.map((f) => ({
        name: rows.find((r) => r.card_id === f.card_id)?.name ?? f.card_id,
        fairPct: f.fairPct,
      })),
      tierCollapse: result.tierCollapse,
    });
  };
```

- [ ] **Step 4: Render the control and the report**

In the editor header, beside the existing per-set EV/RTP tiles:

```tsx
        <div className="flex items-end gap-x-2">
          <div>
            <Label htmlFor="target-rtp" size="xsmall">
              {t('packs.editor.targetRtp')}
            </Label>
            <Input
              id="target-rtp"
              className="w-24"
              type="number"
              min={0.01}
              step={0.01}
              value={targetRtpInput}
              onChange={(e) => setTargetRtpInput(e.target.value)}
            />
          </div>
          <Button
            size="small"
            variant="secondary"
            disabled={!rows || saving}
            onClick={() => autoSplit(1)}
          >
            {t('packs.editor.autoSplit')}
          </Button>
        </div>
```

Directly below it, the report:

```tsx
        {autoSplitError && (
          <Alert variant="error" className="mt-2">
            {autoSplitError}
          </Alert>
        )}
        {autoSplitReport && (
          <Alert variant="warning" className="mt-2">
            <Text size="small">
              {t('packs.editor.autoSplitRtp', {
                rtp: (autoSplitReport.achievedRtp * 100).toFixed(2),
                target: targetRtpInput,
              })}
            </Text>
            {autoSplitReport.floored.length > 0 && (
              <>
                <Text size="small" className="mt-1">
                  {t('packs.editor.autoSplitFloored', {
                    count: autoSplitReport.floored.length,
                  })}
                </Text>
                <ul className="mt-1 list-disc pl-5">
                  {autoSplitReport.floored.map((f) => (
                    <li key={f.name}>
                      <Text size="small">
                        {t('packs.editor.autoSplitFlooredRow', {
                          name: f.name,
                          fair: Math.round(100 / f.fairPct).toLocaleString(),
                          actual: Math.round(100 / MIN_PCT).toLocaleString(),
                        })}
                      </Text>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {autoSplitReport.tierCollapse.length > 0 && (
              <Text size="small" className="mt-1">
                {t('packs.editor.autoSplitCollapse', {
                  tiers: autoSplitReport.tierCollapse.join(', '),
                })}
              </Text>
            )}
          </Alert>
        )}
```

Import `Alert` and `Label` from `@medusajs/ui` if they are not already imported in this file.

- [ ] **Step 5: Send the target on save**

In the existing odds save handler, add the target to the mutation payload:

```ts
      target_rtp_bps: Math.round(Number(targetRtpInput) * 100),
```

- [ ] **Step 6: Verify**

Run from `backend/apps/admin`: `npx tsc -b && npx eslint src --max-warnings 0`
Expected: both clean.

Then start the stack and check by hand on `/dashboard/packs/bronze-pack`:
1. Target RTP shows 70.
2. Auto-split populates the Rarity dropdowns (Mega Charizard → Legendary) and the Set 1 rates.
3. The report names four floored cards and the Legendary/Mythical collapse.
4. Nothing persisted until Save; a reload before saving restores the old values.

- [ ] **Step 7: Commit**

```bash
git add "backend/apps/admin/src/routes/packs/[slug]/page.tsx" backend/apps/admin/src/i18n/en.json
git commit -m "feat(admin): auto-split action with target RTP and a floored-card report"
```

---

### Task 7: End-to-end integration test

**Files:**
- Create: `backend/packages/api/integration-tests/http/pack-auto-split.spec.ts`

**Interfaces:**
- Consumes: `solveOddsForRtp` and `proposeRarities` from `@acme/odds-math`; `mintSuperAdmin`, `unwrapResponse` from `./utils`; `packTheoreticalRtp` from `../../src/modules/packs/economy`.
- Produces: nothing.

**What this proves that the unit tests cannot:** that solver output survives `coerceOddsEntries` → `computeSetWeights` → `balanceOdds` → integer bps storage and still reads back at the expected RTP. It asserts the **floored** RTP, not the nominal target.

- [ ] **Step 1: Write the failing test**

Create `backend/packages/api/integration-tests/http/pack-auto-split.spec.ts`:

```ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { proposeRarities, solveOddsForRtp } from '@acme/odds-math';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { packTheoreticalRtp } from '../../src/modules/packs/economy';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const ADMIN_EMAIL = 'auto-split-admin@polycards.test';
const PASSWORD = 'supersecret-test-pw';
const PRICE = 50;

// Values here are RAW USD FMV; the route converts to display price. Chosen so
// the display prices reproduce the bronze-pack shape.
const CARDS = [
  { handle: 'as-pikachu', usd: 5 },
  { handle: 'as-bulbasaur', usd: 8 },
  { handle: 'as-jolteon', usd: 25 },
  { handle: 'as-gengar', usd: 120 },
  { handle: 'as-charizard', usd: 350 },
  { handle: 'as-dragonite', usd: 372.67 },
  { handle: 'as-mewtwo', usd: 900 },
  { handle: 'as-grey-felt', usd: 989.18 },
  { handle: 'as-pikachu-ex', usd: 990 },
  { handle: 'as-mega-charizard', usd: 2010 },
];

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('auto-split round trip', () => {
      let adminHeaders: Record<string, string>;
      let packs: PacksModuleService;

      beforeEach(async () => {
        const container = getContainer();
        const token = await mintSuperAdmin(container, api, ADMIN_EMAIL, PASSWORD);
        adminHeaders = { Authorization: `Bearer ${token}` };
        packs = container.resolve<PacksModuleService>(PACKS_MODULE);

        await packs.createCards(
          CARDS.map((c) => ({
            handle: c.handle,
            name: c.handle,
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: c.usd,
            image: '/cdn/test-card.webp',
          })),
        );

        const created = await unwrapResponse(
          api.post(
            '/admin/packs',
            {
              slug: 'auto-split-pack',
              title: 'Auto Split Pack',
              category: 'pokemon',
              price: PRICE,
              image: '/cdn/test-pack.webp',
              buyback_percent: 90,
              boost: false,
              rank: 0,
              status: 'draft',
            },
            { headers: adminHeaders },
          ),
        );
        expect(created.status).toBe(201);

        const members = await unwrapResponse(
          api.post(
            '/admin/packs/auto-split-pack/members',
            { card_ids: CARDS.map((c) => c.handle) },
            { headers: adminHeaders },
          ),
        );
        expect(members.status).toBe(200);
      });

      it('stored weights reproduce the solved (floored) RTP', async () => {
        const snapshot = await unwrapResponse(
          api.get('/admin/packs/auto-split-pack/odds', { headers: adminHeaders }),
        );
        expect(snapshot.status).toBe(200);

        const rows = snapshot.data.odds as {
          card_id: string;
          market_value: number;
          locked: boolean;
          pct: number;
        }[];

        const proposals = new Map(
          proposeRarities(
            rows.map((r) => ({ card_id: r.card_id, value: r.market_value })),
            PRICE,
          ).map((p) => [p.card_id, p.rarity]),
        );

        const solved = solveOddsForRtp(
          rows.map((r) => ({
            card_id: r.card_id,
            locked: r.locked,
            rarity: proposals.get(r.card_id) ?? 'Common',
            value: r.market_value,
            pct: r.pct,
          })),
          PRICE,
          0.7,
        );
        expect(solved.error).toBeNull();
        // The floor pushes the achievable RTP above the nominal 70% target.
        expect(solved.achievedRtp).toBeGreaterThanOrEqual(0.7);

        const saved = await unwrapResponse(
          api.post(
            '/admin/packs/auto-split-pack/odds',
            {
              entries: solved.computed.map((c) => ({
                card_id: c.card_id,
                locked: false,
                pct: c.pct,
                rarity: proposals.get(c.card_id) ?? 'Common',
              })),
              target_rtp_bps: 7000,
            },
            { headers: adminHeaders },
          ),
        );
        expect(saved.status).toBe(200);

        const stored = await packs.listPackOdds(
          { pack_id: 'auto-split-pack' },
          { take: 50 },
        );
        expect(stored.reduce((s, o) => s + o.weight, 0)).toBe(10000);
        // Every chase card must remain winnable after integer rounding.
        expect(stored.every((o) => o.weight >= 1)).toBe(true);

        const reread = await unwrapResponse(
          api.get('/admin/packs/auto-split-pack/odds', { headers: adminHeaders }),
        );
        const byId = new Map(
          (reread.data.odds as { card_id: string; market_value: number }[]).map((r) => [
            r.card_id,
            r.market_value,
          ]),
        );
        // OddsValue's field is `market_value` (not `fmv`) and PackRtp returns
        // `rtp_pct` as a PERCENTAGE — verified against economy.ts.
        const rtp = packTheoreticalRtp(
          stored.map((o) => ({
            weight: o.weight,
            market_value: byId.get(o.card_id) ?? 0,
          })),
          PRICE,
        );
        expect(rtp).not.toBeNull();
        expect(rtp!.rtp_pct).toBeCloseTo(solved.achievedRtp! * 100, 0);
      });
    });
  },
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `backend/packages/api`:
`NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http npx jest integration-tests/http/pack-auto-split.spec.ts`
Expected: FAIL if any earlier task is incomplete. If every task landed, this may pass first time — that is acceptable for an integration test whose job is regression protection.

- [ ] **Step 3: Fix whatever it surfaces**

Most likely failure: `weight >= 1` fails because `balanceOdds` re-rounds a floored 0.01% down. If so, the solver's floor is being lost in the bps conversion — verify `Math.round(0.01 * 100) === 1` holds in `balanceOdds`'s `clampBps` path and fix there, not by loosening the assertion.

- [ ] **Step 4: Run the whole backend suite**

Run from `backend/packages/api`:
`NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http npx jest integration-tests/http`
Expected: all green, including `pack-activation-guard.spec.ts`.

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/integration-tests/http/pack-auto-split.spec.ts
git commit -m "test(odds): auto-split output survives the save pipeline at the floored RTP"
```

---

## Final verification

- [ ] `cd backend/packages/odds-math && corepack yarn build && npx jest` — green
- [ ] `cd backend/packages/api && npx jest` (unit) — green
- [ ] `cd backend/packages/api && NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http npx jest integration-tests/http` — green
- [ ] `cd backend/apps/admin && npx tsc -b && npx eslint src --max-warnings 0 && npx vitest run` — green
- [ ] `cd backend && corepack yarn build` — green
- [ ] Manual: `/dashboard/packs/bronze-pack` auto-split produces the spec's table and report

## Known follow-ups (NOT in this plan)

- Auto-split buttons for sets 2 and 3. Task 6 wires `autoSplit(set)` to accept the set but only renders a set-1 button; sets 2/3 need the inheritance-warning confirm (`packs.editor.autoSplitSetWarning`, already added to i18n) before they are exposed.
- `bronze-pack` is `status = active` at 9720% RTP. This plan ships the tool; someone must still fix the live row and check whether production carries the same weights.
