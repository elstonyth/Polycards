# Plan 041: Dedupe the rarity arrays + lock the money-display mirror with a parity test

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Your reviewer
> maintains `plans/README.md` — do not edit it.
>
> **Drift check (run first)**:
> `git diff --stat 38f7dbdd..HEAD -- src/lib/rarity.ts src/lib/packs-format.ts backend/apps/admin/src/lib/format.ts backend/packages/api/src/modules/packs/pricing.ts`
> On any change, compare "Current state" against live code before proceeding.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `38f7dbdd`, 2026-07-13

## Why this matters

The "mirror-drift" class — the same constant/logic hand-copied across places
that silently desync — was flagged as a class in round 2 and its "build a
shared module when a third instance appears" trigger was declared met in round 3. The full cross-runtime shared package is a deliberately-scheduled item
(three runtimes: storefront npm, admin yarn, backend yarn — M–L, real risk),
**not** a drive-by. This plan takes the two **safe, bounded, single-concern**
slices that don't need the package:

1. **Two "canonical" rarity arrays.** `src/lib/rarity.ts:19` `RARITY_ORDER`
   and `src/lib/packs-format.ts:13` `RARITIES` are byte-identical six-element
   arrays, each documented as THE single source. Same runtime (storefront) —
   collapsing to one export is a clean, zero-risk dedup.
2. **An untested money-display mirror.** `backend/apps/admin/src/lib/format.ts`
   `usdToMyr` is a hand-mirror of backend `displayMarketPrice`
   (`pricing.ts`, at multiplier 1) — the comment says so verbatim. If the
   backend's rounding basis changes, admin RM figures silently diverge from
   what customers see, with no test to catch it. A parity test locks the
   invariant without restructuring anything.

Explicitly **out of scope / deferred** (documented, not built here): the
cross-runtime shared constants/format package; the `RARITY_RGB` vs
`TIER_COLOR` color drift and decision #10's reveal color-axis unification —
round 3 deferred those to the mobile-first redesign (which reworks the reveal)
and that disposition stands.

## Current state

**Rarity arrays** (both storefront, `src/lib/`):

`rarity.ts:18-25`:

```ts
/** Rarities high→low — drives filter-chip order. */
export const RARITY_ORDER: readonly Rarity[] = [
  'Immortal',
  'Legendary',
  'Mythical',
  'Rare',
  'Uncommon',
  'Common',
];
```

`packs-format.ts:12-20`:

```ts
/** Canonical rarity tiers, rarest-first (display + iteration order). */
export const RARITIES: Rarity[] = [
  'Immortal',
  'Legendary',
  'Mythical',
  'Rare',
  'Uncommon',
  'Common',
];
```

Both import `Rarity` from `@/lib/packs-data`. They are identical order. Find
every importer of each before changing:
`grep -rn "RARITY_ORDER\|RARITIES" src/`.

**Money-display mirror**:

`backend/apps/admin/src/lib/format.ts` `usdToMyr`:

```ts
// USD → MYR at the given rate (2dp), mirroring the backend displayMarketPrice
// at multiplier 1. ...
export const usdToMyr = (usd: number, fx: number): number =>
  Number.isFinite(usd) && Number.isFinite(fx) && fx > 0
    ? Math.round(usd * fx * 100) / 100
    : 0;
```

`backend/packages/api/src/modules/packs/pricing.ts` `displayMarketPrice(marketValueUsd, fxUsdMyr, multiplier)`
computes `Math.round(raw * fx * mult * 100) / 100` (with finite/positive
guards). At `multiplier === 1` the two must agree for all valid inputs.

Admin format tests already exist: `backend/apps/admin/src/lib/format.test.ts`
(run under the admin vitest, which plan 027 wired into CI). That is where the
parity test goes.

**Cross-runtime note**: the admin app (`apps/admin`) and backend
(`packages/api`) are separate workspace packages. Before writing the parity
test, check whether `apps/admin` can import `displayMarketPrice` from
`packages/api` (workspace dep / path). If it **can't** cleanly, do NOT create
a new cross-package dependency just for a test — instead pin the parity by
asserting `usdToMyr` against a small table of hand-computed expected values
**and** add a comment in BOTH files pointing at each other, so a future editor
sees the coupling. See Step 2's two options.

## Commands you will need

| Purpose            | Command                                                                                             | Expected |
| ------------------ | --------------------------------------------------------------------------------------------------- | -------- |
| Storefront install | `npm install` (repo root)                                                                           | exit 0   |
| Storefront check   | `npm run check`                                                                                     | exit 0   |
| Storefront tests   | `npm test`                                                                                          | all pass |
| Admin install      | `corepack yarn install` (in `backend/`)                                                             | exit 0   |
| Admin tests        | `corepack yarn workspace @acme/admin test` (or `turbo run test --filter=@acme/admin` in `backend/`) | all pass |

## Scope

**In scope**:

- `src/lib/rarity.ts` and `src/lib/packs-format.ts` — collapse to one canonical
  array; update the other to re-export it (keeping both names importable) OR
  update all importers to the single name. Prefer the re-export to keep the
  diff small and import sites stable.
- Importers of `RARITIES`/`RARITY_ORDER` under `src/` — only if you choose to
  update names rather than re-export.
- `backend/apps/admin/src/lib/format.test.ts` — add the parity test.
- A one-line cross-reference comment in `usdToMyr` and (if you can't import)
  `displayMarketPrice`.

**Out of scope**:

- `RARITY_RGB` / `TIER_COLOR` color values and `PokemonToken.tsx`'s color axis
  (decision #10) — deferred to the redesign; do NOT touch.
- The full shared cross-runtime package — deferred; do NOT create it.
- `rm`/`relativeTime`/`timeAgo` formatter dedup — deferred with the package;
  do NOT touch (this plan only adds the `usdToMyr` parity _test_, not a
  formatter merge).
- Backend `pricing.ts` logic — read-only except the optional cross-ref comment.

## Git workflow

- Branch: `advisor/041-rarity-dedup-and-parity-lock`
- Commits: `refactor(rarity): single canonical rarity-order export`,
  `test(admin): lock usdToMyr parity with backend displayMarketPrice`.
- Do not push or open a PR.

## Steps

### Step 1: Collapse the rarity arrays

Pick `RARITY_ORDER` in `rarity.ts` as the canonical source (it's the
`readonly` one). In `packs-format.ts`, replace the `RARITIES` literal with
`export const RARITIES = RARITY_ORDER as Rarity[];` (import it from
`@/lib/rarity`) — or, if a circular import results (`rarity.ts` importing from
`packs-format.ts` or vice versa; check), move the array to whichever module is
the leaf and re-export from the other. Keep both export names so importers
don't change. Update the comments so only one says "canonical" and the other
says "re-exported from rarity.ts".

**Verify**: `npm run check` → exit 0; `npm test` → all pass;
`grep -rn "'Immortal', 'Legendary'" src/lib/rarity.ts src/lib/packs-format.ts`
→ the literal appears **once**.

### Step 2: Lock the money-display parity

**Option A (preferred, if the import is clean):** in `format.test.ts`, import
`displayMarketPrice` from the backend package and assert
`usdToMyr(usd, fx) === displayMarketPrice(usd, fx, 1)` across a table of inputs
(incl. edge cases: `fx` non-integer, small/large `usd`, the finite/positive
guards → both return 0).

**Option B (if apps/admin cannot import packages/api):** assert `usdToMyr`
against a hand-computed expected table that encodes the same
`Math.round(usd*fx*100)/100` rule, and add a comment in both `usdToMyr` and
`displayMarketPrice` naming the other as the coupled mirror ("keep in sync;
parity asserted in admin format.test.ts"). Do NOT introduce a new cross-package
dependency solely for the test.

Report which option you used and why.

**Verify**: `corepack yarn workspace @acme/admin test` (or the turbo filter) →
all pass including the new parity cases.

## Test plan

- Rarity dedup: covered by existing `npm test` (any test importing the arrays
  still passes) — no new test needed, the dedup is behavior-preserving.
- Money parity: the new `format.test.ts` cases (Step 2) are the deliverable —
  a table asserting `usdToMyr` matches `displayMarketPrice(...,1)` (or the
  hand-computed rule), including the zero-on-bad-input guards.

## Done criteria

- [ ] The rarity literal exists once across `rarity.ts`/`packs-format.ts`
- [ ] `npm run check` exits 0; `npm test` passes
- [ ] Admin `format.test.ts` has the parity cases and the admin test suite passes
- [ ] Both `RARITIES` and `RARITY_ORDER` remain importable (no broken importers)
- [ ] `git status` shows no files outside scope (notably NOT `PokemonToken.tsx`,
      `price-tier.ts`, or any formatter file)

## STOP conditions

- Collapsing the arrays creates a circular import that can't be resolved by
  moving the leaf — report; the reviewer may accept updating importers instead.
- The two rarity arrays turn out NOT to be identical at HEAD (drift check
  showed a change) — report the actual contents; do not force a merge that
  changes order.
- `usdToMyr` and `displayMarketPrice(...,1)` do **not** actually agree on some
  input (a latent real bug) — STOP and report; that's a finding, not a test to
  paper over.

## Maintenance notes

- The full cross-runtime shared package (constants + formatters + validation
  mirrors — the `CREDIT_REASONS`, client-`max`, and formatter instances) is
  the real fix for this class and remains **deliberately deferred**; this plan
  buys the two cheapest safe slices. Schedule the package when a fourth
  instance appears or the mobile-first redesign opens the storefront anyway.
- Decision #10 (reveal uses rarity colors, not price-tier colors) is unfinished
  in `PokemonToken.tsx` — fold it into the redesign's reveal rework, not here.
- If the parity test used Option B, a reviewer should note the coupling is now
  documented-but-not-compile-enforced; the real enforcement comes with the
  shared package.
