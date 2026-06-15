# Architecture Deepening — Design Spec

**Date:** 2026-06-15
**Status:** Approved (brainstorming → writing-plans)
**Source:** `improve-codebase-architecture` review (3 Explore passes; HTML report in OS temp).

## Goal

Turn six shallow / scattered modules into deep ones — concentrate change, bugs, and
knowledge behind small interfaces (locality + leverage), and make the affected code
testable and AI-navigable. **Architecture vocabulary:** module, interface,
implementation, depth, seam, adapter, leverage, locality, deletion test.

## Overriding contract — behavior-preserving

**Every candidate is a refactor. No observable behavior change.** Success = identical
output, proven by the existing test suites:

- **Backend** integration specs (jest) already cover the affected routes/flows:
  `store-packs-price-contract.spec.ts`, `pack-open-charge.spec.ts`,
  `vault-buyback.spec.ts`, `customer-gacha.spec.ts`, `public-profile.spec.ts`,
  `economy.spec.ts`. These are the **characterization net**: green-before, green-after
  each candidate. JSON shape is locked by the price-contract spec.
- **Storefront** `npm test` (vitest 3.2.6) + visual regression (Playwright capture on
  the standalone server at :4000) + the PostToolUse/Stop typecheck hooks.

New **pure** helpers (`toMoney`, `money`, zod schemas) are built **TDD** (RED → GREEN).
Refactors of existing logic lean on the characterization net, not new unit tests.

## Decisions (from brainstorming)

1. **Landing = two waves with a checkpoint.** Wave 1 (backend backbone) lands and the
   user reviews; then Wave 2 (storefront). Hard stop between waves.
2. **Candidate 4 validation = add `zod`** to the storefront (one schema per resource).
3. **Candidate 2 = full fold** — free-function economy logic becomes
   `PacksModuleService` methods; pure math stays as pure functions underneath.

## Isolation & verification

- One worktree `feat/arch-deepening` (consent pre-granted in CLAUDE.md/AGENTS.md).
  `npm install` (root) + `corepack yarn install` (backend) in the fresh worktree.
- Verify on the **standalone** server (`npm run build` →
  `pwsh scripts/serve-standalone.ps1 -Port 4000`), **never** `next dev`.
- Watch for runaway node processes; kill with `Get-Process node | Stop-Process -Force`.
- Backend `medusa develop` watcher patch caveat applies after any reinstall
  (`backend/.claude/lessons.md`).

---

## WAVE 1 — Backend backbone

Build order: **3-backend → 1 → 2** (primitives before the enclosure that absorbs them).

### Candidate 3-backend — Money seam

**New:** `backend/packages/api/src/modules/packs/money.ts`

```ts
// Returns a finite JS number identical to the current Number(x) call sites.
export function toMoney(value: BigNumberValue | number | string | null | undefined): number
```

- Replaces ~15 inline `Number(pack.price)` / `Number(card.market_value)` coercions
  across store + admin routes.
- **Invariant:** output byte-identical to today's `Number(x)` for every existing input.
  Guarded by `store-packs-price-contract.spec.ts`.
- **TDD:** unit-test `toMoney` against BigNumber, string, number, null inputs first.

### Candidate 1 — CardView assembler

**New:** `backend/packages/api/src/modules/packs/card-view.ts`

```ts
export function cardByHandle(cards: Card[]): Map<string, Card>
export function rarityIndex(odds: PackOdds[]): (packId: string, cardId: string) => Rarity | undefined
export function toCardView(card: Card, rarity?: Rarity): CardViewBase
// CardViewBase = { handle, name, set, grader, grade, rarity, market_value, image }
//   market_value via toMoney()
```

- Collapses the load → `Map` → join → drop-orphans → shape → normalize ritual repeated
  across 6 routes (`store/packs/[slug]`, `store/vault`, `store/pulls/recent`,
  `store/profiles/[handle]`, `admin/customers/[id]/gacha`, `admin/packs/[slug]/odds`),
  plus the `rarityByPair` lookup rebuilt 4×.
- **Honest scope:** only the *common* shape + money + join/filter centralize.
  Per-route extras stay route-local spreads on top of `toCardView`:
  - vault → buyback fields
  - admin odds → `stock`, `weight`, `locked`, `pct`
  - pulls/recent → `rolled_at`, `pack_id`
- **Guard:** the six routes' integration specs.

### Candidate 2 — Full PacksModuleService fold

**Edit:** `backend/packages/api/src/modules/packs/service.ts` (today: empty body).

Fold free-function logic into service methods (caller-facing interface):

```ts
creditBalance(customerId): Promise<number>          // from credit-balance.ts
quoteBuyback(...): ...                               // from buyback-rate.ts
canAfford(customerId, amount): Promise<boolean>     // from pack-open-charge.ts
cardStock(handles): Promise<Map<string, number>>    // from card-stock.ts
// + economy reads from economy.ts
```

- **Pure math stays pure** (`odds-math.computeOdds`, `economy` formulas, buyback-rate
  math): service methods do the DB reads and call the pure functions. Preserves
  unit-testability; gives a real domain enclosure.
- Workflow steps (`charge-pack-open`, `roll-pack`, `record-pull`, `decrement-stock`,
  `buyback-pull`) and routes call the service instead of importing scattered helpers.
- **Plan task #1:** read each free function's signature (how it gets container / query
  / manager) — that determines how cleanly it folds into a method using `this`.
- **Guard:** `pack-open-charge.spec.ts`, `vault-buyback.spec.ts`, `economy.spec.ts`,
  `customer-gacha.spec.ts`; module unit tests under `modules/packs/__tests__`.

### Wave 1 exit

Backend `corepack yarn build` clean, all backend jest specs green, JSON byte-identical.
**Checkpoint — user reviews before Wave 2.**

---

## WAVE 2 — Storefront

Build order: **4 → 3-storefront → 5 → 6**.

### Candidate 4 — Validated fetch seam (zod)

- Add `zod` to storefront deps.
- **New:** `src/lib/data/schemas.ts` — one schema per resource (VaultItem, WonCard,
  Pack, PackCard, LeaderboardRow, Profile).
- **New:** `src/lib/data/fetch.ts`:
  ```ts
  fetchValidated<T>(path: string, schema: ZodSchema<T>, opts?): Promise<T>
  // sdk.client.fetch → schema.parse → normalized DTO
  ```
- Getters in `data/*.ts` + `actions/*.ts` become `fetch → parse → return`; delete the
  ad-hoc `.filter()` guards and the private `interface BackendXxx` type-assertions.
- **New:** `src/lib/errors.ts` — one `friendlyError` policy table replacing the 4×
  copies (auth/customer/vault/packs).
- **Guard:** `npm test` (add schema unit tests TDD) + typecheck.

### Candidate 3-storefront — Money formatter

- Collapse `format.ts` (`usd`, `usd0`), `packs-format.ts` (`formatValue`),
  `leaderboard.ts` (`fmtUsd`), `data/packs.ts` (`formatPrice`),
  `MarketplaceClient.tsx` (local `fmt`) → one `money(amount, opts)` in `format.ts`.
- Other formatters delegate to `money`; delete dead exports (verify unused first).
- **TDD:** unit-test `money` against the formats the five callers currently emit.

### Candidate 5 — CardTile base

- **New:** `src/components/CardTile.tsx` — presentational frame (rounded-2xl,
  border-white/10, bg-white/[0.03], 3/4 aspect, hover scale/shadow, rarity ring) with
  slots (image, badges, footer).
- Refactor `PackCard`/`PackRow` (ClawClient), `MarketCard` (MarketplaceClient),
  `PullCard` (RecentPullsSection) to compose it; bodies stay bespoke.
- **Visual-regression gated:** Playwright capture on :4000 must match the pre-refactor
  baseline pixel-for-pixel.

### Candidate 6 — Reveal stagger seam

- Add a `stagger` / `index` prop to `Reveal` (or a sibling `<RevealList>`).
- `HowItWorksSteps` + `LeaderboardSection` use it instead of re-deriving index×delay.
- **Preserve** the CLAUDE.md rule: these sections stay **not** wrapped in `<Reveal>` at
  the section level (they own their internal scroll animation); the stagger helper is
  internal. Reduced-motion behaviour preserved.

### Wave 2 exit

`npm run check` (lint + typecheck + build) clean, `npm test` green, visual baseline
matches, Stop hook green both repos.

---

## Out of scope (YAGNI)

- No new features, no copy/visual changes, no dependency bumps beyond `zod`.
- No unrelated refactors of routes/components not listed above.
- Admin-route DTO duplication beyond what the CardView assembler naturally covers is a
  follow-up, not this spec.

## Risks

1. **Service fold (Cand 2)** is the riskiest — free-function data access may not map
   1:1 to `this`. Mitigation: read signatures first; fall back to facade-delegation for
   any function that can't fold cleanly, rather than rewriting its data access.
2. **Backend jest can wedge** pre-output (memory note). Mitigation: `--forceExit`,
   kill node, rerun.
3. **Visual drift (Cand 5)** — capture baseline screenshots *before* touching the card
   components.
