# POLYCARD-BACK Epic 3 — Odds Sets (win rate 1/2/3), EV/RTP, Customer Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three per-pack odds sets (`weight`, new `weight_2`/`weight_3` bps columns with per-card NULL = inherit-previous-set), selected per customer group (`metadata.odds_set`) server-side at spin time; Common-as-balancer replaces the rarity-remainder split on pack-odds saves; the packs list gains GROUP (RAW/GRADED/MIX) + Real EV/RTP per set + Published EV/RTP; the odds editor gains three win-rate columns and price-based values; the gacha cards list gains sort + bulk add-to-pack; §2.1 nav cleanup.

**Architecture:** `@acme/odds-math` gains a new `balanceOdds` export (Common absorbs the remainder) — `computeOdds` STAYS for the reward/daily-box editors. A shared `computeSetWeights` helper resolves the 3-set inheritance chain and is used by both the odds save step and the pool-membership step, so the invariant "every set resolves to Σ=10000 bps after any save" holds at every write. The draw path resolves the customer's odds set once per open (both the single and the batch chain) and maps `weight` upstream of `pickWonRow`, which stays untouched. EV/RTP math reuses `packTheoreticalRtp`; card price is `market_value(USD) × fx × market_multiplier` via `displayMarketPrice` — **the spec's `fmv_myr` does not exist; FMV is stored in USD** (the one system USD field), so every EV formula carries the FX factor.

**Tech Stack:** Medusa v2 (MikroORM, hand-written migrations), `@acme/odds-math` (CJS workspace package — REBUILD DIST AFTER EVERY CHANGE), Jest (unit + http shards), Mercur admin (Vite + @medusajs/ui + react-query + vitest).

**Spec:** `plans/058-polycard-back-admin-overhaul.md` §2 (decisions D1, D2; corrected EV example RM170, PubEV RM74 — formula wins over the docx's RM210).

## Global Constraints

- **Branch base:** `origin/master` AFTER PR #270 (Epic 1) squash-merges. Verify before branching.
- **Worktree** (consent pre-granted): `EnterWorktree` or `git worktree add .worktrees/epic3-odds -b feat/epic3-odds`; `npm install` (root), `corepack yarn install` (from `backend/`), PowerShell `Copy-Item` for `backend/packages/api/.env` (bash `cp` blocked by guard-secrets), and **`corepack yarn build` in `backend/packages/odds-math` immediately — and again after EVERY odds-math source change** (`main: dist/index.js`; backend tests load the stale dist otherwise and fail with "Cannot find module" or stale behavior). Commit this plan file as the branch's first commit.
- **Migration timestamps RESERVED across the parallel epics:** Epic 3 owns `Migration20260728200000`. Epic 2 (parallel) owns `20260728100000`/`20260728100001`. All sort after Epic 1's `Migration20260727000001`. Never renumber.
- **Backend `.ts` edit trap:** a global formatter hook rewrites backend double-quotes to single quotes on every Edit/Write, causing whole-file churn that fails CI. Edit files under `backend/` via a small node script run through Bash, or `git diff --stat` immediately after each edit; on churn, revert and use the node-script path.
- **Commits:** `git commit -F <message-file>`. NEVER PowerShell here-strings in Git Bash. Conventional commits.
- **Stale LSP diagnostics:** trust `tsc`/jest runs only.
- **SECRET ODDS contract:** per-card weights are never exposed to customers. `GET /store/packs/:slug` must omit `weight_2`/`weight_3` exactly as it omits `weight` (`api/store/packs/[slug]/route.ts:19-25`; `src/lib/data/packs.ts:161-166`). Storefront-displayed odds remain the admin-authored `published_odds` — no per-group disclosure change.
- **`computeOdds` has 4 consumers beyond the pack-odds editor** (`modules/packs/daily-box.ts`, `workflows/steps/set-pack-members.ts`, admin `routes/daily-rewards/page.tsx`, `workflows/steps/save-pack-odds.ts`). Only the two PACK-ODDS paths (`save-pack-odds`, `set-pack-members`) switch to the balancer. `computeOdds` and `RARITY_WEIGHT` stay exported (reward boxes + `scripts/seed-e2e-fixtures.ts:166` depend on them).
- **Expand/contract:** `weight_2`/`weight_3` are additive nullable columns — expand-safe; old code ignores them. Group metadata is additive. No contraction needed this release.
- **Parallel-epic file collisions:** Epic 2 also edits `backend/apps/admin/src/lib/{admin-rest,queries,query-keys}.ts` and `i18n/en.json`. Append Epic 3 additions at the END under a `// ── Epic 3 (Odds) ──` marker (i18n: extend the existing `"packs"`/`"cards"` blocks minimally; new keys at block end).
- **Money/units:** `card.market_value` = USD decimal; `card.market_multiplier` = per-card decimal, default `DEFAULT_MARKET_MULTIPLIER = 1.2` (`pricing.ts:8`); `pack.price` = MYR decimal (NOT cents, field is `price` not `pack_price`); MYR card price = `displayMarketPrice(toMoney(mv), fx, toMoney(mult ?? 1.2))`; fx via `resolveFxRate(packs)` (display, 30 s cache). EV sums run in integer cents (precedent `economy.ts:43-54`).
- **Commands** (from `backend/packages/api` unless noted): `corepack yarn test:unit`; single http spec `NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http npx jest integration-tests/http/<name>.spec.ts --runInBand --forceExit` (needs `pokenic-postgres` up); `corepack yarn check-types`. odds-math (from `backend/packages/odds-math`): `corepack yarn test`, `corepack yarn build`. Admin (from `backend/apps/admin`): `yarn test`, `corepack yarn build`, `corepack yarn lint`. Repo root: `npm run check`.
- **gitleaks:** inline `// gitleaks:allow` on synthetic spec passwords.

---

### Task 1: `balanceOdds` in `@acme/odds-math` (Common as balancer)

**Files:**
- Modify: `backend/packages/odds-math/src/index.ts`
- Test: `backend/packages/odds-math/src/__tests__/balance-odds.unit.spec.ts` (new file — the existing `odds-math.unit.spec.ts` and `computeOdds` are UNTOUCHED)

**Interfaces:**
- Consumes: existing `TOTAL_BPS`, `clampBps`, `OddsInput`, `ComputedOdd`, `OddsResult` (shapes unchanged).
- Produces: `export function balanceOdds(entries: OddsInput[]): OddsResult` — semantics: every non-Common row's `pct` is taken verbatim (locked or not); locked Common rows are pinned verbatim; UNLOCKED Common rows absorb `TOTAL_BPS − Σ(pinned)` split evenly with largest-remainder distribution (deterministic by `card_id` order). Invariants preserved from `computeOdds`: Σ === `TOTAL_BPS` exactly when error-free, input-order independence, never throws, best-effort `computed` even when `error` is set. Note: `locked` on a non-Common row no longer changes the math (everything non-Common is pinned) — it remains the UI pin/protection flag; keep it flowing through unchanged.

- [ ] **Step 1: Write the failing spec**

```ts
import { balanceOdds, TOTAL_BPS } from '../index';

const e = (card_id: string, pct: number, rarity = 'Rare', locked = false) =>
  ({ card_id, locked, pct, rarity });
const common = (card_id: string, pct = 0, locked = false) =>
  ({ card_id, locked, pct, rarity: 'Common' });

describe('balanceOdds — Common absorbs the remainder', () => {
  it('gives Common everything the pinned rows leave (20+30 → Common 50%)', () => {
    const r = balanceOdds([e('a', 20), e('b', 30), common('c')]);
    expect(r.error).toBeNull();
    expect(r.computed.map((c) => c.weight)).toEqual([2000, 3000, 5000]);
  });
  it('splits the remainder evenly across unlocked Commons with largest-remainder', () => {
    const r = balanceOdds([e('a', 10), common('c1'), common('c2'), common('c3')]);
    expect(r.computed.map((c) => c.weight)).toEqual([1000, 3000, 3000, 3000]);
    const r2 = balanceOdds([e('a', 33.33), e('b', 33.33), common('c1'), common('c2')]);
    expect(r2.computed.map((c) => c.weight)).toEqual([3333, 3333, 1667, 1667]);
  });
  it('honors a LOCKED Common verbatim; unlocked Commons absorb the rest', () => {
    const r = balanceOdds([common('pin', 10, true), e('a', 20), common('bal')]);
    expect(r.computed.map((c) => c.weight)).toEqual([1000, 2000, 7000]);
  });
  it('blocks save when Common would go below 0%', () => {
    const r = balanceOdds([e('a', 60), e('b', 50), common('c')]);
    expect(r.error).toMatch(/Common win rate would go below 0%/i);
  });
  it('without an unlocked Common, rates must total exactly 100%', () => {
    expect(balanceOdds([e('a', 40), e('b', 50)]).error).toMatch(/total exactly 100%/i);
    expect(balanceOdds([e('a', 40), e('b', 60)]).error).toBeNull();
  });
  it('rejects out-of-range pinned rates and empty input', () => {
    expect(balanceOdds([e('a', 101), common('c')]).error).toMatch(/between 0% and 100%/i);
    expect(balanceOdds([]).error).toMatch(/no cards/i);
  });
  it('is input-order independent', () => {
    const rows = [e('a', 12.5), common('c2'), e('b', 30), common('c1')];
    const a = balanceOdds(rows);
    const b = balanceOdds([...rows].reverse());
    const byId = (r: typeof a) => new Map(r.computed.map((c) => [c.card_id, c.weight]));
    expect(byId(a)).toEqual(byId(b));
  });
  it('property: any pinned combination sums to exactly TOTAL_BPS or errors (seeded fuzz)', () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 200; i++) {
      const n = 2 + Math.floor(rand() * 6);
      const rows = Array.from({ length: n }, (_, j) =>
        j === 0 ? common(`c${j}`) : e(`p${j}`, Math.floor(rand() * 6000) / 100));
      const r = balanceOdds(rows);
      if (r.error === null) {
        expect(r.computed.reduce((s, c) => s + c.weight, 0)).toBe(TOTAL_BPS);
        expect(r.computed.every((c) => c.weight >= 0)).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Run to verify failure** — from `backend/packages/odds-math`: `corepack yarn test` → FAIL (`balanceOdds` not exported).

- [ ] **Step 3: Implement**

Append to `src/index.ts` (below `computeOdds`; CJS-safe syntax only — the admin Vite build consumes this through `commonjsOptions`):

```ts
// ── Common as balancer (POLYCARD-BACK §2.4) ─────────────────────────────────
// Replaces the rarity-weighted remainder split FOR PACK-ODDS SAVES: every
// non-Common row keeps its submitted pct verbatim (locked or not), locked
// Common rows are pinned too, and UNLOCKED Common rows absorb the remainder
// (even split, largest-remainder rounding → Σ === TOTAL_BPS exactly,
// input-order independent). computeOdds above STAYS for the reward/daily-box
// editors — those pools have no Common-as-balancer concept.
export function balanceOdds(entries: OddsInput[]): OddsResult {
  const safe = Array.isArray(entries) ? entries : [];
  let error: string | null = null;

  const isBalancer = (entry: OddsInput): boolean =>
    entry.locked === false && entry.rarity === 'Common';
  const pinned = safe.filter((entry) => !isBalancer(entry));
  const balancers = safe.filter(isBalancer);

  let pinnedBps = 0;
  const bpsById = new Map<string, number>();
  for (const entry of pinned) {
    const pct = Number(entry.pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      error ??= 'Each win rate must be between 0% and 100%.';
    }
    const bps = clampBps(Math.round((Number.isFinite(pct) ? pct : 0) * 100));
    bpsById.set(entry.card_id, bps);
    pinnedBps += bps;
  }

  if (safe.length === 0) error ??= 'No cards to configure.';
  if (pinnedBps > TOTAL_BPS) {
    error ??= 'Common win rate would go below 0%. Lower the other rates.';
  }
  if (balancers.length === 0 && pinnedBps !== TOTAL_BPS) {
    error ??= 'Without an unlocked Common card, win rates must total exactly 100%.';
  }

  const remainder = Math.max(0, TOTAL_BPS - pinnedBps);
  if (balancers.length > 0) {
    const base = Math.floor(remainder / balancers.length);
    let leftover = remainder - base * balancers.length;
    const ordered = [...balancers].sort((a, b) =>
      a.card_id < b.card_id ? -1 : a.card_id > b.card_id ? 1 : 0,
    );
    for (const entry of ordered) {
      bpsById.set(entry.card_id, base + (leftover > 0 ? 1 : 0));
      if (leftover > 0) leftover -= 1;
    }
  }

  const computed: ComputedOdd[] = safe.map((entry) => {
    const weight = bpsById.get(entry.card_id) ?? 0;
    return { card_id: entry.card_id, weight, locked: entry.locked, pct: weight / 100 };
  });

  return {
    computed,
    error,
    lockedTotalPct: pinnedBps / 100,
    unlockedCount: balancers.length,
  };
}
```

- [ ] **Step 4: Run to verify pass** — `corepack yarn test` (both spec files green — the old `computeOdds` suite must be untouched and green). Then `corepack yarn build` (dist refresh) and `corepack yarn check-types`.

- [ ] **Step 5: Commit** — `feat(odds): balanceOdds — Common-as-balancer split in @acme/odds-math`

---

### Task 2: `weight_2`/`weight_3` columns + `odds-sets.ts` resolution helpers

**Files:**
- Modify: `backend/packages/api/src/modules/packs/models/pack-odds.ts`
- Create: `backend/packages/api/src/modules/packs/migrations/Migration20260728200000.ts`
- Create: `backend/packages/api/src/modules/packs/odds-sets.ts`
- Test: `backend/packages/api/src/modules/packs/__tests__/odds-sets.unit.spec.ts`

**Interfaces:**
- Produces:

```ts
// odds-sets.ts
export type OddsSet = 1 | 2 | 3;
export type SetWeights = { weight: number; weight_2?: number | null; weight_3?: number | null };
export function weightForSet(o: SetWeights, set: OddsSet): number;   // 1→weight, 2→weight_2 ?? weight, 3→weight_3 ?? weight_2 ?? weight
export function coerceOddsSet(v: unknown): OddsSet;                   // 2|'2'→2, 3|'3'→3, anything else→1 (defensive default, D2)
export async function resolveOddsSetForCustomer(container: MedusaContainer, customerId?: string): Promise<OddsSet>;
```

- [ ] **Step 1: Failing unit spec** — cases: `weightForSet` full fallback chain (`{weight:100}`→100/100/100; `{weight:100, weight_2:200}`→100/200/200; `{weight:100, weight_2:200, weight_3:300}`→100/200/300; `{weight:100, weight_3:300}`→100/100/300; explicit `weight_2: 0` is NOT null → set 2 = 0); `coerceOddsSet` table (`2,'2',3,'3'` → themselves; `1,'1',0,4,'x',null,undefined,{}` → 1).

- [ ] **Step 2: Verify failure** — `corepack yarn test:unit --testPathPattern odds-sets` → FAIL.

- [ ] **Step 3: Implement**

`pack-odds.ts` — after `locked`, with a comment extending the file's odds contract block:

```ts
    // Win-rate sets 2 and 3 (POLYCARD-BACK §2.4 / D2). Basis points like
    // `weight` (set 1). NULL = "inherit the previous set" PER CARD (2→1, 3→2)
    // — resolution lives in odds-sets.ts weightForSet(). After any save, every
    // set's RESOLVED weights sum to 10000 (save-pack-odds re-balances all
    // three sets). `locked` is shared across sets; only the pinned % differs.
    weight_2: model.number().nullable(),
    weight_3: model.number().nullable(),
```

(Plain `model.number()` — NO `raw_` sidecar; that trap is `bigNumber()`-only.)

`Migration20260728200000.ts`:

```ts
import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Odds sets 2/3 (POLYCARD-BACK §2.4, D2): additive nullable bps columns on
// pack_odds. NULL = inherit previous set per card, so existing rows need no
// backfill (every pack starts as pure set-1 inheritance). Expand-safe.
export class Migration20260728200000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table if exists "pack_odds" add column if not exists "weight_2" integer null;`);
    this.addSql(`alter table if exists "pack_odds" add column if not exists "weight_3" integer null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "pack_odds" drop column if exists "weight_3";`);
    this.addSql(`alter table if exists "pack_odds" drop column if exists "weight_2";`);
  }
}
```

`odds-sets.ts`:

```ts
import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import type { MedusaContainer } from '@medusajs/framework/types';

export type OddsSet = 1 | 2 | 3;
export type SetWeights = { weight: number; weight_2?: number | null; weight_3?: number | null };

// D2 fallback chain: set 2 empty → set 1; set 3 empty → set 2. Per card.
export const weightForSet = (o: SetWeights, set: OddsSet): number =>
  set === 1 ? o.weight
  : set === 2 ? (o.weight_2 ?? o.weight)
  : (o.weight_3 ?? o.weight_2 ?? o.weight);

// Defensive: anything that is not exactly set 2 or 3 rolls to set 1 (the
// default group's set). Group metadata is admin-written but untyped JSON.
export const coerceOddsSet = (v: unknown): OddsSet =>
  v === 2 || v === '2' ? 2 : v === 3 || v === '3' ? 3 : 1;

// Customer → group → odds_set, resolved SERVER-SIDE at spin time (§2.5).
// No group (or anonymous/demo roll) → set 1. A customer in several groups
// gets the OLDEST group's set (created_at ASC — deterministic, documented).
export async function resolveOddsSetForCustomer(
  container: MedusaContainer,
  customerId?: string,
): Promise<OddsSet> {
  if (!customerId) return 1;
  const customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const [group] = await customers.listCustomerGroups(
    { customers: customerId },
    { take: 1, order: { created_at: 'ASC' } },
  );
  return coerceOddsSet(group?.metadata?.odds_set);
}
```

(`listCustomerGroups({ customers: '<id>' })` verified against the installed `@medusajs/types` — `FilterableCustomerGroupProps.customers?: … | string | string[]`, `CustomerGroupDTO.metadata?: Record<string, unknown>`.)

- [ ] **Step 4: Migrate + verify pass** — `npx medusa db:migrate`; unit spec green; `check-types` clean.

- [ ] **Step 5: Commit** — `feat(odds): pack_odds weight_2/weight_3 + odds-set resolution helpers`

---

### Task 3: `computeSetWeights` + save-pack-odds step (3-set save with balancer)

**Files:**
- Create: `backend/packages/api/src/workflows/steps/compute-set-weights.ts`
- Modify: `backend/packages/api/src/workflows/steps/save-pack-odds.ts`
- Test: `backend/packages/api/src/workflows/steps/__tests__/compute-set-weights.unit.spec.ts`

**Interfaces:**
- Consumes: `balanceOdds` (Task 1 — REBUILD odds-math dist first), `OddsInput`.
- Produces:

```ts
// compute-set-weights.ts
export type SetEntry = OddsInput & { pct_2: number | null; pct_3: number | null };
export type SetWeightsResult = {
  error: string | null;               // first error, prefixed 'Set N: ' for sets 2/3
  rows: {
    card_id: string; locked: boolean;
    weight: number;                    // set 1, always materialized
    weight_2: number | null;           // null = inherit (see storage rule)
    weight_3: number | null;
  }[];
};
export function computeSetWeights(entries: SetEntry[]): SetWeightsResult;
```

**Storage rule (the invariant, document it in the file header):** set 1 always materializes. For set s ∈ {2,3}: if NO entry has an explicit `pct_s`, the whole set stays NULL (pure inheritance — Σ is guaranteed by set 1). Otherwise the set's EFFECTIVE rates (explicit `pct_s`, else the previous set's resolved pct) run through `balanceOdds`, and `weight_s` is stored for (a) every card with an explicit `pct_s` and (b) every unlocked-Common card (the balancer output); cards that inherited stay NULL. Because EVERY save recomputes all three sets, a later set-1 edit refreshes the materialized Common of sets 2/3 — resolved Σ stays 10000 for every set after every save.

- [ ] **Step 1: Failing unit spec** — pure function, no mocks:

1. All `pct_2`/`pct_3` null → every `weight_2`/`weight_3` null; `weight` matches `balanceOdds` on set 1.
2. Explicit `pct_2` on one non-Common card → that card's `weight_2` set; unlocked Common's `weight_2` materialized (absorbs set-2 remainder); untouched non-Common cards' `weight_2` null; resolved set-2 sum (`weight_2 ?? weight`) === 10000.
3. Set 3 inherits set 2's RESOLVED values (chain: explicit pct_2=30 on card a, explicit pct_3=10 on card b → set-3 effective for a is 30).
4. Set-2 error is labeled: pinned set-2 rates exceeding 100 → `error` matches `/^Set 2: /`.
5. Set-1 error propagates unprefixed.
6. Explicit `pct_2: 0` materializes `weight_2: 0` (zero ≠ inherit).

- [ ] **Step 2: Verify failure**, then **Step 3: Implement**

```ts
import { balanceOdds, type OddsInput } from '@acme/odds-math';

export function computeSetWeights(entries: SetEntry[]): SetWeightsResult {
  const set1 = balanceOdds(entries);
  if (set1.error) return { error: set1.error, rows: [] };
  const pctByCard = (r: ReturnType<typeof balanceOdds>) =>
    new Map(r.computed.map((c) => [c.card_id, c.pct]));
  let prev = pctByCard(set1);
  const materialized: (Map<string, number> | null)[] = [];
  for (const setNo of [2, 3] as const) {
    const explicit = (e: SetEntry) => (setNo === 2 ? e.pct_2 : e.pct_3);
    if (!entries.some((e) => explicit(e) !== null)) { materialized.push(null); continue; }
    const eff: OddsInput[] = entries.map((e) => ({
      card_id: e.card_id, locked: e.locked, rarity: e.rarity,
      pct: explicit(e) ?? prev.get(e.card_id) ?? 0,
    }));
    const r = balanceOdds(eff);
    if (r.error) return { error: `Set ${setNo}: ${r.error}`, rows: [] };
    const weights = new Map<string, number>();
    for (const c of r.computed) {
      const src = entries.find((e) => e.card_id === c.card_id)!;
      const isBalancer = src.locked === false && src.rarity === 'Common';
      if (explicit(src) !== null || isBalancer) weights.set(c.card_id, c.weight);
    }
    materialized.push(weights);
    prev = pctByCard(r);
  }
  const [m2, m3] = materialized;
  const w1 = new Map(set1.computed.map((c) => [c.card_id, c.weight]));
  return {
    error: null,
    rows: entries.map((e) => ({
      card_id: e.card_id, locked: e.locked,
      weight: w1.get(e.card_id) ?? 0,
      weight_2: m2 ? (m2.get(e.card_id) ?? null) : null,
      weight_3: m3 ? (m3.get(e.card_id) ?? null) : null,
    })),
  };
}
```

- [ ] **Step 4: Wire into `save-pack-odds.ts`**

- `SavePackOddsInput.entries` type: `OddsInput[]` → `SetEntry[]`.
- Replace `const { computed, error } = computeOdds(input.entries);` (line ~88) with `const { rows, error } = computeSetWeights(input.entries);` and throw on error (same `MedusaError.Types.INVALID_DATA`).
- `updates` map gains `weight_2: r.weight_2, weight_3: r.weight_3`; `OddsSnapshot` (lines 25-30) gains both fields and the snapshot builder copies them (`weight_2: o.weight_2 ?? null` …) — **compensation must restore sets 2/3 or a rollback silently wipes them**.
- The step still returns the set-1 `computed`-equivalent (build `{ card_id, weight, locked, pct: weight/100 }` from `rows`) so the existing editor response contract holds.
- Known adjacent bug, do NOT fix silently (flag in the task report): the step lists existing odds with `take: 1000` while the GET route uses `pageAll` — pre-existing, out of scope.
- Fix the stale comment block in `models/pack-odds.ts:26-34` ("unlocked rows split the remaining bps evenly" → describe the balancer + set columns).

- [ ] **Step 5: Verify** — new unit spec green; `corepack yarn test:unit` full (catches the `save-pack-odds` type ripple in `set-pack-members` — if it breaks compile, add `pct_2: null, pct_3: null` there as a stopgap; Task 5 finishes it); `check-types` clean.

- [ ] **Step 6: Commit** — `feat(odds): 3-set save path — computeSetWeights + save-pack-odds balancer`

---

### Task 4: Admin odds route — GET sets + price values, POST set pcts

**Files:**
- Modify: `backend/packages/api/src/api/admin/packs/[slug]/odds/route.ts`
- Test: `backend/packages/api/src/api/admin/packs/[slug]/odds/__tests__/odds-route.unit.spec.ts` (new — none exists today)

**Interfaces:**
- Consumes: `weightForSet` (Task 2), `SetEntry` (Task 3), `displayMarketPrice`, `DEFAULT_MARKET_MULTIPLIER`, `toMoney`.
- Produces: GET row gains `weight_2`, `weight_3` (raw, nullable), `pct_2`, `pct_3` (RESOLVED effective %, per-set totals), and `market_value` becomes the PRICE (FMV × per-card multiplier — spec §2.4 "Value column shows price"); GET pack block gains `price: toMoney(pack.price)` (the editor needs it for live RTP) and `group: 'RAW' | 'GRADED' | 'MIX' | null` (spec 2.4.8 read-only auto-detect — derive from the loaded cards via `isGraded`; Task 8 exports it, so if Task 8 hasn't landed yet inline the one-line predicate and swap later). POST accepts `pct_2`/`pct_3` per entry (`number | null`; absent coerces to null).

- [ ] **Step 1: Failing unit spec** — extract the POST body coercion into an exported `coerceOddsEntries(raw: unknown): SetEntry[]` (move the existing inline validation loop at lines 127-160 into it; route calls it). Spec cases: valid entry with explicit sets; absent `pct_2` → null; `pct_2: 'x'` → 400-style throw; existing validations (card_id/locked/rarity) intact — port the old loop's cases.

- [ ] **Step 2-3: Fail, then implement**

GET changes (lines ~79-102 region):

```ts
  const fx = await resolveFxRate(packsModuleService);
  // Value column shows PRICE (FMV × per-card multiplier), not raw FMV —
  // POLYCARD-BACK §2.4; matches admin-card.ts displayPrice.
  const totals = {
    1: odds.reduce((s, o) => s + weightForSet(o, 1), 0) || 1,
    2: odds.reduce((s, o) => s + weightForSet(o, 2), 0) || 1,
    3: odds.reduce((s, o) => s + weightForSet(o, 3), 0) || 1,
  };
  // per row:
  market_value: displayMarketPrice(
    toMoney(card.market_value), fx,
    toMoney(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
  ),
  weight: o.weight, weight_2: o.weight_2 ?? null, weight_3: o.weight_3 ?? null,
  pct: round2((weightForSet(o, 1) / totals[1]) * 100),
  pct_2: round2((weightForSet(o, 2) / totals[2]) * 100),
  pct_3: round2((weightForSet(o, 3) / totals[3]) * 100),
```

Pack block: add `price: toMoney(pack.price)`. Update the line-78 comment (no longer "no markup"). POST: `const entries = coerceOddsEntries(body.entries);` then the existing workflow run (input type now `SetEntry[]`).

- [ ] **Step 4: Verify** — unit specs green; `test:unit` + `check-types` clean.
- [ ] **Step 5: Commit** — `feat(odds): odds route — 3-set GET/POST, price-based value column`

---

### Task 5: `set-pack-members` — balancer semantics + set preservation

**Files:**
- Modify: `backend/packages/api/src/workflows/steps/set-pack-members.ts`
- Test: extend its existing unit spec (find `set-pack-members`' spec under `workflows/steps/__tests__/`; if none exists, create `set-pack-members.unit.spec.ts` mocking the packs service like `roll-pack-batch.unit.spec.ts` does)

**Interfaces:**
- Consumes: `computeSetWeights` (Task 3).
- Produces: pool-membership saves preserve surviving cards' explicit sets and keep every set's resolved Σ = 10000; new members join as unlocked, `pct: 0`, `pct_2/pct_3: null` (inherit — spec §2.2: appended cards get rates in the editor afterwards).

- [ ] **Step 1: Failing test** — cases: (a) adding a card to a pool whose Common balances → new member weight 0 bps, Common re-absorbs, survivors' pinned pcts unchanged; (b) removing a card re-balances (Common grows); (c) a survivor with explicit `weight_2` keeps it (passed through as `pct_2 = weight_2 / 100`) and set-2 resolved sum stays 10000; (d) update payload includes `weight_2`/`weight_3` columns.

- [ ] **Step 2-3: Implement** — replace the `computeOdds` call (line ~152) with `computeSetWeights`, building entries:

```ts
    const entries: SetEntry[] = [
      ...survivors.map((o) => ({
        card_id: o.card_id, locked: o.locked,
        pct: (o.weight / originalTotal) * 100,
        rarity: (o.rarity ?? 'Common') as string,
        pct_2: o.weight_2 != null ? o.weight_2 / 100 : null,
        pct_3: o.weight_3 != null ? o.weight_3 / 100 : null,
      })),
      ...toAdd.map((card_id) => ({
        card_id, locked: false, pct: 0,
        rarity: 'Common',   // unchanged from the current step — new members enter as Common
        pct_2: null, pct_3: null,
      })),
    ];
```

(Note the semantic shift, comment it: survivors' pcts are now taken VERBATIM — the old code re-split unlocked survivors by rarity; under the balancer only Common moves.) Writes include `weight_2`/`weight_3` from the result rows.

- [ ] **Step 4: Verify** — spec green; **full** `test:unit` (this step backs the editor pool picker AND the daily flows must stay green); `check-types`.
- [ ] **Step 5: Commit** — `feat(odds): pool membership saves preserve odds sets (balancer semantics)`

---

### Task 6: Draw-path threading — both chains resolve the customer's set

**Files:**
- Modify: `backend/packages/api/src/workflows/steps/roll-pack.ts`
- Modify: `backend/packages/api/src/workflows/steps/roll-pack-batch.ts`
- Modify: `backend/packages/api/src/modules/packs/rollable-pool.ts` (comment only)
- Test: `backend/packages/api/src/workflows/steps/__tests__/roll-pack-set.unit.spec.ts` (new); extend `roll-pack-batch.unit.spec.ts`

**Interfaces:**
- Consumes: `weightForSet`, `resolveOddsSetForCustomer`, `OddsSet` (Task 2).
- Produces: `fetchPackData(packs, packId, set: OddsSet = 1)` — rows come back with `weight` ALREADY resolved for the set (`{ ...o, weight: weightForSet(o, set) }`), so `totalWeight`, `drawFromData`, and `pickWonRow` are untouched; `rollPackStep`/`rollPackBatchStep` resolve the set from `input.customer_id` via `resolveOddsSetForCustomer(container, …)` before fetching. `RollPackBatchInput` gains `customer_id?: string`.

- [ ] **Step 1: Failing tests** — `roll-pack-set.unit.spec.ts`: mock the packs service (`listPacks` + paged `listPackOdds` returning rows with `weight/weight_2/weight_3`); assert `fetchPackData(..., 2)` maps weights via the set-2 fallback chain and `totalWeight` sums the resolved values; set 1 default unchanged. Batch spec: `rollPackBatchStep` with a `customer_id` resolves the set ONCE and every draw uses the resolved weights (mock `resolveOddsSetForCustomer` at the module boundary or seed group metadata through a mocked customer service — follow however `roll-pack-batch.unit.spec.ts` currently mocks the container).

- [ ] **Step 2-3: Implement**

- `roll-pack.ts`: `fetchPackData` signature gains `set: OddsSet = 1`; after the `card_id != null` filter, map `({ ...o, weight: weightForSet(o, set) })` (comment: "resolution happens HERE, once — pickWonRow and every consumer below see plain `weight`"). `rollPackStep`: `const set = await resolveOddsSetForCustomer(container, input.customer_id);` then `fetchPackData(packs, input.pack_id, set)`. **Rewrite the now-false comment at lines 27-32** ("customer_id … unused here — the roll is anonymous") to: carried for odds-set resolution (§2.5); the roll itself is still recorded against the authenticated id downstream.
- `roll-pack-batch.ts`: `RollPackBatchInput` gains `customer_id?: string;` (open-batch already passes the full input by structural subtyping — line 41-42 comment); resolve once before `fetchPackData`, pass the set.
- `rollable-pool.ts`: append to the header comment: "Checks set 1 only — sufficient because every save re-balances all sets to Σ=10000 bps (computeSetWeights), so a pack rollable on set 1 is rollable on every set."

- [ ] **Step 4: Verify** — new + extended specs green; full `test:unit`; `check-types`.
- [ ] **Step 5: Commit** — `feat(odds): resolve customer odds set at spin — single + batch draw chains`

---

### Task 7: Integration — two groups draw from different distributions

**Files:**
- Test: `backend/packages/api/integration-tests/http/odds-sets.spec.ts` (new)

**Interfaces:** consumes everything from Tasks 1-6. This is the spec's acceptance test (§2: "seeded-RNG integration test that two groups draw from different distributions") — implemented with the repo's existing determinism idiom: NOT a seeded RNG, but **degenerate weights** (the existing "single-card pool → deterministic roll" trick from `pack-open-charge.spec.ts`, extended to two cards): set 1 = `[10000, 0]`, set 2 = `[0, 10000]`. Any roll then picks a known card per set.

- [ ] **Step 1: Write the spec**

Boilerplate from `pack-open-charge.spec.ts` (runner, publishable key, admin mint, customer registration + `/store/customers` link + login — reuse its helpers; `// gitleaks:allow` on passwords). Seed via module services: one pack (price 10, active), two cards (`alpha`, `beta`), odds rows `{ card_id: 'alpha', weight: 10000, weight_2: 0 }`, `{ card_id: 'beta', weight: 0, weight_2: 10000 }` (set 3 left null → inherits set 2), FIRM fx row, stock, and enough credit per customer (copy the credit-seeding shape from the same spec). Before writing group-creation code, verify the exact `ICustomerModuleService` method names in `backend/packages/api/node_modules/@medusajs/types/dist/customer/service.d.ts` (`createCustomerGroups`, and the customer↔group link method — grep `CustomerGroup` in that file); then create group `set2-group` with `metadata: { odds_set: 2 }` and add customer B.

Cases:
1. Customer A (no group) opens the pack → pull's card is `alpha` (set 1).
2. Customer B (group set 2) opens → `beta`.
3. Customer B batch-opens (count 2, `/store/packs/:slug/open-batch`) → both `beta` (batch chain threaded).
4. A group with `metadata: { odds_set: 99 }` (junk) → customer C in it draws `alpha` (defensive default to set 1).
5. **Secret-odds regression:** `GET /store/packs/:slug` response JSON, stringified, contains no `"weight` substring (covers `weight`, `weight_2`, `weight_3`).

- [ ] **Step 2: Run** — expect PASS if Tasks 1-6 are correct; debug otherwise (this spec is the epic's money gate — spec §7 requires it before merge).

- [ ] **Step 3: Commit** — `test(odds): two-group distribution + batch threading + secret-odds regression`

---

### Task 8: EV/RTP + Published EV + GROUP — backend

**Files:**
- Modify: `backend/packages/api/src/modules/packs/economy.ts` (+ `publishedEv`)
- Modify: `backend/packages/api/src/modules/packs/card-view.ts` (+ `isGraded`)
- Modify: `backend/packages/api/src/api/admin/packs/route.ts` (list gains stats)
- Test: extend `backend/packages/api/src/modules/packs/__tests__/economy.unit.spec.ts` and `card-view.unit.spec.ts`; create `backend/packages/api/integration-tests/http/packs-list-stats.spec.ts`

**Interfaces:**
- Consumes: `packTheoreticalRtp` (`economy.ts:28` — feed it three weight arrays), `weightForSet`, `displayMarketPrice`, the `valueByHandle` price-map shape from `api/admin/economy/route.ts:53-62` (copy it exactly), pack `published_odds` (`{ overall, tiers }`, tier values are PERCENT 0-100).
- Produces:

```ts
// economy.ts
export function publishedEv(
  tierAvgPrice: Record<string, number>,          // MYR avg card price per rarity tier
  publishedTiers: Record<string, number> | null | undefined,  // percent per tier
): number | null;                                 // MYR 2dp; null when no published tiers
// card-view.ts
export const isGraded = (c: { grader: string }) => c.grader.trim() !== '';
// GET /admin/packs — each pack gains:
//   group: 'RAW' | 'GRADED' | 'MIX' | null,      // null = empty pool
//   ev: { s1: number|null; s2: number|null; s3: number|null },
//   rtp: { s1: number|null; s2: number|null; s3: number|null },   // percent
//   pub_ev: number | null, pub_rtp: number | null
```

- [ ] **Step 1: Failing unit specs**

`economy.unit.spec.ts` additions — the spec's CORRECTED worked examples verbatim:

```ts
  // POLYCARD-BACK §2 acceptance — docx arithmetic corrected: formula wins.
  it('EV worked example: 300×0.2 + 200×0.3 + 100×0.5 = RM170, RTP 56.67%', () => {
    const odds = [
      { weight: 2000, market_value: 300 },
      { weight: 3000, market_value: 200 },
      { weight: 5000, market_value: 100 },
    ];
    expect(packTheoreticalRtp(odds, 300)).toEqual({ ev: 170, rtp_pct: 56.67 });
  });
  it('PubEV worked example: (100+200)/2×20% + (50+60)/2×80% = RM74', () => {
    expect(publishedEv({ Legendary: 150, Common: 55 }, { Legendary: 20, Common: 80 })).toBe(74);
  });
  it('publishedEv: null/empty published tiers → null; unknown tier keys skipped', () => {
    expect(publishedEv({ Common: 50 }, null)).toBeNull();
    expect(publishedEv({ Common: 50 }, {})).toBeNull();
    expect(publishedEv({ Common: 50 }, { Immortal: 100 })).toBeNull();
  });
```

`card-view.unit.spec.ts`: `isGraded({grader: 'PSA'})` true; `{grader: ''}` / `{grader: '  '}` false.

- [ ] **Step 2-3: Implement**

`publishedEv` (integer-cents fold like `packTheoreticalRtp`):

```ts
// Published EV (§2.3): Σ over published tiers of (avg card price in tier) ×
// (published percent / 100). Tiers without a price average are skipped;
// returns null when nothing contributes (no published odds, or none match).
export function publishedEv(
  tierAvgPrice: Record<string, number>,
  publishedTiers: Record<string, number> | null | undefined,
): number | null {
  if (!publishedTiers) return null;
  let cents = 0;
  let any = false;
  for (const [tier, pct] of Object.entries(publishedTiers)) {
    const avg = tierAvgPrice[tier];
    if (!Number.isFinite(avg) || !Number.isFinite(pct)) continue;
    any = true;
    cents += Math.round(avg * 100) * (pct / 100);
  }
  return any ? Math.round(cents) / 100 : null;
}
```

`admin/packs/route.ts`: after the existing pack list load, fan out ONCE (mirror `economy/route.ts:46-104` structurally): `pageAll(listPackOdds({}))`, `pageAll(listCards({}))`, `resolveFxRate`. Build `priceByHandle` (price WITH per-card multiplier — copy `economy/route.ts:53-62`), `graderByHandle`. Per pack: collect its card-odds rows; three `packTheoreticalRtp` calls with `weight: weightForSet(o, s)`; `group` = pool empty → null, all `isGraded` → 'GRADED', none → 'RAW', else 'MIX'; `tierAvgPrice` = mean price per `rarity ?? 'Common'` over pool cards; `pub_ev = publishedEv(tierAvgPrice, pack.published_odds?.tiers)`, `pub_rtp = pub_ev != null && price > 0 ? round2(pub_ev / price * 100) : null`.

- [ ] **Step 4: http spec** — `packs-list-stats.spec.ts`: seed FIRM fx rate 1, one pack price 300, three cards `market_value` 300/200/100 with explicit `market_multiplier: 1` (prices land exactly on the worked example), odds 2000/3000/5000 with `weight_2` = 5000/3000/2000; one card graded (`grader: 'PSA'`). Assert `GET /admin/packs`: `ev.s1 === 170`, `rtp.s1 === 56.67`, `ev.s2 === 230` (0.5×300 + 0.3×200 + 0.2×100 = 150 + 60 + 20), `group === 'MIX'`, and after publishing `{ overall: 100, tiers: { Legendary: 20, Common: 80 } }` on a two-card pack (prices 150/55 via mv=150,mult=1,fx=1 and mv=55) `pub_ev === 74`, `pub_rtp` = `round2(74/price×100)`.

- [ ] **Step 5: Verify** — unit + http green; full `test:unit`, `check-types`.
- [ ] **Step 6: Commit** — `feat(odds): per-set EV/RTP + Published EV + GROUP on admin packs list`

---

### Task 9: Admin packs list UI — GROUP + EV/RTP columns

**Files:**
- Modify: `backend/apps/admin/src/lib/packs-api.ts` (`AdminPack` gains the Task-8 fields)
- Modify: `backend/apps/admin/src/routes/packs/page.tsx`

**Interfaces:**
- Consumes: Task 8 response fields; `rm`, `fmtPct` from `lib/format.ts`.
- Produces: packs table shows GROUP badge + "EV / RTP" (set 1, prominent) columns; a per-row chevron toggles a detail row with EV2/RTP2, EV3/RTP3, PubEV/PubRTP (spec: avoid a 10-column table — secondary line in an expander).

- [ ] **Step 1: Implement**

- `AdminPack` interface: `group: 'RAW' | 'GRADED' | 'MIX' | null; ev: { s1: number | null; s2: number | null; s3: number | null }; rtp: { s1: …; s2: …; s3: … }; pub_ev: number | null; pub_rtp: number | null;`.
- `page.tsx` columns after Status: `<Table.HeaderCell>Group</Table.HeaderCell>`, `<Table.HeaderCell className="text-right">EV / RTP</Table.HeaderCell>`. Cells: `group` → `<Badge size="2xsmall">` (`grey` RAW, `purple` GRADED, `blue` MIX, `—` null); EV cell `ev.s1 != null ? `${rm(ev.s1)} · ${rtp.s1}%` : '—'`.
- Row expander: local `expanded: Set<string>`; a `Button variant="transparent"` chevron per row toggles an extra `<Table.Row>` spanning all columns with a small grid: `Set 2 {rm(ev.s2)} · {rtp.s2}%` / `Set 3 …` / `Published {rm(pub_ev)} · {pub_rtp}%` (em-dash nulls). Note in a comment: sets 2/3 equal set 1 while a pack is pure-inheritance — expected, not a bug.

- [ ] **Step 2: Verify** — `corepack yarn build` + `lint` + `yarn test` clean; dev boot: list renders stats; expander toggles.
- [ ] **Step 3: Commit** — `feat(odds): packs list GROUP + per-set EV/RTP columns`

---

### Task 10: Odds editor — three win-rate columns, live EV/RTP, Published EV header

**Files:**
- Modify: `backend/apps/admin/src/lib/odds-rows.ts` + `odds-rows.test.ts`
- Modify: `backend/apps/admin/src/lib/packs-api.ts` (`OddsRow` + mutate entry types), `backend/apps/admin/src/lib/queries.ts` (`useSaveOdds` vars type)
- Modify: `backend/apps/admin/src/routes/packs/[slug]/page.tsx`

**Interfaces:**
- Consumes: Task 4 GET/POST shapes (`weight_2/weight_3/pct_2/pct_3`, pack `price`, `market_value` = price); `balanceOdds` from `@acme/odds-math` (already CJS-bundled into the admin build via `vite.config.ts` `commonjsOptions`).
- Produces:

```ts
// odds-rows.ts
export type EditRow = { …existing…, pctInput2: string, pctInput3: string };  // '' = inherit
export const mapOddsToRows: (odds: OddsRow[]) => EditRow[];   // pctInputN = weight_N == null ? '' : String(weight_N / 100)
export const rowsToSetEntries: (rows: EditRow[]) => SetEntryLike[];  // pct_N = input === '' ? null : Number(input)
export function previewSets(rows: EditRow[]): {                // client-side mirror of computeSetWeights
  error: string | null;
  pct: Record<1 | 2 | 3, Map<string, number>>;                 // effective % per set per card
};
```

- [ ] **Step 1: Failing vitest** — `odds-rows.test.ts`: mapping round-trips (null weight_2 → `''` → null; explicit 0 → `'0'` → 0); `previewSets` on a 3-row fixture: set-2 explicit edit moves only Common in set 2; error string propagates with `Set 2:` prefix; inherited set-3 mirrors set 2.

- [ ] **Step 2: Implement lib layer** — `previewSets` replicates `computeSetWeights`'s chain with `balanceOdds` (same algorithm, returns pct maps instead of storage rows — keep them adjacent in one function so the two cannot drift is impossible client-side; instead add a comment cross-referencing `workflows/steps/compute-set-weights.ts` and mirror its tests).

- [ ] **Step 3: Rework the editor page**

- Replace the single Win-rate column (lines ~471-486) with three inputs (`Set 1 / Set 2 / Set 3` headers). Set 1 input keeps the current lock-gated behavior for non-Common rows; **unlocked Common rows render read-only computed values with a "balancer" badge** (their rate is derived — editing them is meaningless under §2.4). Sets 2/3 inputs: enabled for non-Common (and locked-Common) rows; empty = inherit — show the effective % as the placeholder, grayed (`placeholder={String(r.pct_2)}`, `text-ui-fg-muted` when `pctInput2 === ''`).
- Live preview (lines ~199-206): `computeOdds(...)` → `previewSets(rows)`; Result column shows set-1 preview; the footer totals row shows per-set Σ (all must read 100%).
- **Live EV/RTP 1/2/3** (spec 2.4): from `previewSets` pcts + `r.market_value` (now price) + `data.pack.price`: `EV_s = Σ round(price×100) × pct_s/100 / 100`, `RTP_s = EV_s / pack.price`. Render as three small stat chips above the table.
- **Published EV header** (spec 2.4.7.5): in `PublishedOddsSection` (lines ~648-767), next to the tier-sum figure, compute PubEV client-side: tier avg over `rows` (`market_value` grouped by `rarity`) × the section's CURRENT tier inputs / 100, summed; label "Published EV: RM …". The `overall` input stays (it is published display data).
- `save()` sends `rowsToSetEntries(rows)`; response patch-back maps the returned set-1 weights as today and re-seeds `pctInput2/3` from the refetch… NO — `useSaveOdds` deliberately does not invalidate; instead patch: keep the user's `pctInput2/3` strings as-is (they are already what was saved; the server materialized Common's weight_2/3 which shows on next load — add a comment).
- Save disabled while `previewSets(rows).error !== null` (replaces `result.error`).

- [ ] **Step 4: Verify** — `yarn test`, `corepack yarn build`, `lint` clean. Dev boot round-trip: edit a set-2 rate on one card → Common's set-2 preview moves; save; reload → explicit value persists, untouched cards still show grayed inherited values; set-1-only pack unaffected.
- [ ] **Step 5: Commit** — `feat(odds): 3-set odds editor with live EV/RTP + Published EV header`

---

### Task 11: Customer groups → odds set (admin page)

**Files:**
- Modify: `backend/apps/admin/src/lib/admin-rest.ts` (append under the Epic 3 marker), `query-keys.ts` (+test), `queries.ts`
- Create: `backend/apps/admin/src/routes/odds-sets/page.tsx`

**Interfaces:**
- Consumes: Medusa NATIVE admin customer-groups API (mounted + typed in `.mercur/index.d.ts` — nothing repo-side calls it yet). The prebuilt `@mercurjs/admin` group pages handle create/edit/membership; this custom page ONLY manages the `odds_set` metadata (the prebuilt form is a compiled bundle and cannot gain a selector — flagged operator decision).
- Produces:

```ts
export interface AdminCustomerGroup { id: string; name: string; metadata: Record<string, unknown> | null }
export const listCustomerGroupsAdmin = () =>
  getJson<{ customer_groups: AdminCustomerGroup[]; count: number }>(`/admin/customer-groups?limit=100`);
export const setGroupOddsSet = (id: string, set: 1 | 2 | 3) =>
  postJson<{ customer_group: AdminCustomerGroup }>(`/admin/customer-groups/${encodeURIComponent(id)}`, { metadata: { odds_set: set } });
// qk.customerGroups = ['admin', 'customer-groups'] as const
// useCustomerGroupsAdmin(), useSetGroupOddsSet() (invalidates qk.customerGroups)
```

- [ ] **Step 1: Implement**

Page config: `{ label: 'Odds Sets', icon: Users, nested: '/customers', rank: 3 }`. Body: table Group name | Odds set (`Select` 1/2/3, value `coerce(metadata?.odds_set)` defaulting 1) | Save button per row (`useSetGroupOddsSet`, toast). Header `Text`: "The default group (customers with no group) plays set 1. Set 2 falls back to set 1, set 3 to set 2, per card." Empty state links the operator to the prebuilt Customer Groups page (`/customer-groups`) to create groups.

- [ ] **Step 2: Verify live** — dev boot: create a group in the prebuilt UI, assign set 2 here, confirm `metadata.odds_set` persisted (network tab / re-fetch shows 2). **Verify Medusa's metadata update semantics live** (whether POST `{ metadata: { odds_set: 2 } }` merges or replaces the metadata object — if it REPLACES and groups carry other metadata keys, switch `setGroupOddsSet` to read-modify-write: spread the current metadata into the POST). Build + lint + test clean.
- [ ] **Step 3: Commit** — `feat(odds): Odds Sets admin page — per-group odds_set selector`

---

### Task 12: Gacha cards list — hide stock, price/created sort, bulk add-to-pack

**Files:**
- Modify: `backend/packages/api/src/modules/packs/admin-card.ts` (DTO gains `created_at`)
- Modify: `backend/apps/admin/src/lib/packs-api.ts` (`AdminCard` + `created_at: string`)
- Modify: `backend/apps/admin/src/routes/cards/page.tsx`
- Modify: `backend/apps/admin/src/routes/packs/[slug]/page.tsx` (pending-add arrival)
- Test: extend `backend/packages/api/src/modules/packs/__tests__/admin-card.unit.spec.ts` (`created_at` passes through)

**Interfaces:**
- Consumes: the Epic-1 bulk-select pattern (copy VERBATIM from the post-merge `routes/deliveries/page.tsx`: `Set<string>` selection, `toggleAll` deciding from `prev` inside the updater, `pageIds` intersection at apply, header/row `Checkbox`); `usePacks` for the picker; react-router `navigate` + `location.state`.
- Produces: cards table without the Stock column; sortable headers name / value / price / created; bulk bar "N selected → Add to gacha pack" → pack picker `FocusModal` → `navigate(`/packs/${slug}`, { state: { addCards: string[] } })`; the odds editor consumes `location.state.addCards`.

- [ ] **Step 1: Backend + failing unit** — `admin-card.ts`: add `created_at: card.created_at` to the DTO (test first: extend the existing unit spec's fixture + assertion). Verify pass, commit-sized-with-the-rest.

- [ ] **Step 2: Cards page**

- Remove the Stock header (lines ~383-389), cell (~431-451), the `'stock'` sort key + its `pick()` branch.
- Sort union → `'name' | 'value' | 'price' | 'created'`; comparators: price = `c.price ?? c.priceBreakdown?.displayPrice ?? 0`; created = `Date.parse(created_at)`. Headers via the existing `sortHeader` helper.
- Selection + bulk bar per the deliveries pattern (unpaged list → `pageIds` = currently FILTERED row ids, keep the intersection defense). Bar: count + `Add to gacha pack` button → `FocusModal` listing `usePacks()` rows (title, category, status badge) → clicking one navigates as above and clears selection.

- [ ] **Step 3: Editor arrival**

In `packs/[slug]/page.tsx`: `const addCards = (useLocation().state as { addCards?: string[] } | null)?.addCards`. On buffer seed, if `addCards?.length`: append pending `EditRow`s for handles not already in the pool (name/image/rarity/market_value from `useCards({ enabled: true })` lookup; `pctInput: '0'`, `pctInput2/3: ''`, a `pending: true` flag rendering a "new — not in pool until saved" badge), and clear the router state (`navigate('.', { replace: true, state: null })`) so refresh doesn't re-append. `save()` when pending rows exist: first `await saveMembers.mutateAsync({ slug, handles: [...existingIds, ...pendingIds] })` (the step balances + persists membership), then the normal odds save with ALL rows (set-equality guard now passes). Comment the two-phase order.

- [ ] **Step 4: Verify** — builds/tests clean; dev boot: sort each column both directions; select 2 cards → add to a pack → editor shows pending rows → save → rows in pool with balanced odds.
- [ ] **Step 5: Commit** — `feat(odds): cards list sort + bulk add-to-pack into the odds editor`

---

### Task 13: Nav cleanup (§2.1)

**Files:**
- Modify: `backend/apps/admin/src/admin-ui.css`
- Modify: `backend/apps/admin/src/routes/products/from-pricecharting/page.tsx:38-42`

- [ ] **Step 1: Implement**

- `from-pricecharting/page.tsx` config: `nested: '/products'` → `nested: '/inventory'` (the `/inventory` core group already exists — houses Reservations).
- `admin-ui.css` — append (this is the file's first non-`.pc-admin`-scoped rule; extend the header comment noting why):

```css
/* POLYCARD-BACK §2.1: hide the core Collections/Categories sidebar entries.
   Nav lives in the prebuilt @mercurjs/admin bundle (useCoreRoutes) — not
   patchable from src/routes. CSS-hide only: the pages stay URL-reachable and
   Medusa data is untouched (spec baked default). */
nav a[href$="/collections"],
nav a[href$="/categories"] {
  display: none;
}
```

- [ ] **Step 2: Verify live** — dev boot: Collections/Categories gone from the sidebar; `/dashboard/collections` still loads by URL; PriceCharting appears under Inventory. If the selector misses (inspect the sidebar DOM — the anchor may carry the `/dashboard` basename or a different structure), adjust to the observed markup (e.g. `[href="/dashboard/collections"]`) and re-verify. Keyboard shortcuts (`G C` / `G A`) still reach the pages — acceptable (URL-reachable is the contract).
- [ ] **Step 3: Commit** — `feat(odds): §2.1 nav cleanup — hide Collections/Categories, PriceCharting under Inventory`

---

### Task 14: Full verification sweep

- [ ] **Step 1: odds-math** — `corepack yarn build` (fresh dist) then `corepack yarn test` (both suites), `check-types`.
- [ ] **Step 2: Backend** — full `corepack yarn test:unit`; `corepack yarn check-types`; `corepack yarn test:integration:smoke`; single-spec runs of `odds-sets.spec.ts` + `packs-list-stats.spec.ts`; re-run `pack-open-charge.spec.ts` and `open-compensation.spec.ts` (draw path + compensation touched).
- [ ] **Step 3: Admin** — `corepack yarn build`, `lint`, `yarn test`.
- [ ] **Step 4: Repo root** — `npm run check`; `npm test` (storefront untouched, but the secret-odds contract file `src/lib/data/packs.ts` must show ZERO diff: `git diff origin/master -- src/ | wc -l` → 0).
- [ ] **Step 5: Grep sweeps** — `grep -rn "computeOdds" backend/packages/api/src backend/apps/admin/src` → only `daily-box.ts` + `daily-rewards/page.tsx` (reward paths, unchanged); `grep -rn "weight_2\|weight_3" src/` (storefront) → zero; `git diff origin/master --stat` formatter-churn review.
- [ ] **Step 6: Manual round-trip** on the live stack: edit set-2 rates in the editor → assign a test group set 2 → open a pack as a grouped customer on the storefront (bronze-pack is the only spinnable pack on a prod-clone DB; on a fresh DB use the seeded fixture) → pull matches the set-2 distribution; packs list shows EV/RTP + GROUP; published odds on the storefront unchanged.
- [ ] **Step 7: PR** — `/code-review`, fix findings, push, PR to `master` titled `feat(odds): win-rate sets 1/2/3, Common balancer, EV/RTP + groups (POLYCARD-BACK epic 3)`.

---

## Coverage check (spec §2 → tasks)

- 2.1 nav cleanup → Task 13.
- 2.2 cards list (hide stock, sort, bulk add-to-pack) → Task 12.
- 2.3 packs list GROUP + Real EV/RTP per set + Published EV/RTP (expander, not 10 columns) → Tasks 8, 9.
- 2.4 editor: price values → Task 4; three win-rate columns + inherited gray → Task 10; balancer replacing the split → Tasks 1, 3, 5; live EV/RTP → Task 10; Published EV header → Task 10; GROUP read-only on edit page → covered by list (Task 9) + the editor pack block already shows title/category — add `group` to the odds GET pack block in Task 4 and render a badge in Task 10.
- 2.5 groups → odds set, server-side at spin → Tasks 2, 6, 11; storefront displayed odds unchanged → Task 7 case 5 + Task 14 Step 4.
- Acceptance: EV RM170 / PubEV RM74 unit-tested → Task 8; balancer property test (Σ=100%, Common ≥ 0 blocks save) → Task 1; two-groups integration draw test → Task 7.

## Open items surfaced to the operator (do not decide silently)

1. **Collections/Categories removal is CSS-hide only** — the prebuilt `@mercurjs/admin` nav can't be edited from repo source; pages stay URL-reachable (matches "data untouched"). Full removal would need `patch-package` on the dist bundle.
2. **Group odds-set selector lives on a NEW "Odds Sets" admin page**, not inside the prebuilt group create/edit form (compiled bundle, not modifiable). Spec's "form exposes the selector" is approximated: create the group in the stock UI, assign the set on the new page.
3. **EV formula carries FX**: spec's `fmv_myr` doesn't exist — FMV is USD; price = `market_value × fx × market_multiplier` (the existing `displayMarketPrice`/economy-route convention). Worked-example tests pin the math with fx = 1.
4. **`locked` semantics under the balancer**: every non-Common rate is now pinned verbatim; `locked` remains meaningful for Common rows (a locked Common stops balancing) and as a UI pin flag. The old "unlocked rows re-split" behavior is gone from pack odds (reward boxes keep it via `computeOdds`).
5. **Multi-group customers**: oldest group (created_at ASC) wins the odds set — deterministic, documented in `resolveOddsSetForCustomer`.
