# Design — Admin shared formatters, mapper dedup, and Vitest runner (Candidate D)

**Date:** 2026-06-16
**Repo:** `Pokenic_Game` — `backend/apps/admin` (Mercur standalone Vite admin app)
**Author:** brainstorming session (follows Candidate B, PR #6 / `c61f2a8`)
**Scope label:** Core-D-only (no money-formatting sweep across cards/packs/RegisterCardModal)

## Problem

Three classes of duplication in `backend/apps/admin/src`, plus no way to unit-test
the pure logic that the Candidate B review flagged:

1. **`usd` formatter — 3 byte-identical copies** (one one-line variant, two
   three-line variants, all identical output):
   - `routes/pulls/page.tsx:13`
   - `routes/economy/page.tsx:12`
   - `routes/support/page.tsx:27`
2. **`timeAgo` formatter** — `routes/pulls/page.tsx:16` (single copy, but belongs
   with the shared formatters and is currently untestable because it reads
   `Date.now()` internally).
3. **`fmtPct` formatter** — `routes/packs/[slug]/page.tsx:61`.
4. **`EditRow → OddsInput` mapper — built identically twice** inside
   `routes/packs/[slug]/page.tsx`: the live-preview `useMemo` (`:129`) and the
   `save()` handler (`:166`). Both produce
   `{ card_id, locked, pct: Number(pctInput), rarity }`.
5. **No test runner.** `apps/admin` `package.json` has only `dev`/`build`/`lint`/
   `preview`. The Candidate B reviewer recommended unit tests for `qk`,
   `mapOddsToRows`, and the formatters; there is nowhere to put them.

## Goals

- One home for the shared formatters; delete the local copies.
- One `EditRow → OddsInput` mapper; both callsites use it.
- A test runner wired up, with thin pure-function tests for the genuine logic.
- **Zero behavior change** — outputs identical to today, byte-for-byte.

## Non-goals (explicitly out of scope)

- The money-formatting sweep — routing the scattered inline
  `toLocaleString('en-US', { minimumFractionDigits: 2 })` calls in
  `cards/page.tsx` (×3), `packs/page.tsx`, `RegisterCardModal.tsx`, and
  `[slug]/page.tsx` (×2) through `usd`. Deferred by decision (bigger, more files).
- Candidate A (transport-seam unification) and any housekeeping — separate tasks.
- Component-render / DOM tests. Repo policy is visual-first (Playwright covers
  presentational behavior); this task adds **pure-function** tests only.

## Approach (chosen)

**Extract the pure logic into dedicated zero-runtime-dependency modules**, then
test only those modules. The two test targets that today live inside React files
(`qk` in `queries.ts`, the mappers in `page.tsx`) are moved into pure modules so
the tests import them without dragging in React, `@medusajs/ui`, or
`@mercurjs/client`. That keeps the test environment `node` (no jsdom, no mocking)
and gives clean, independently-understandable units.

Rejected alternatives:
- *Minimal — `format.ts` only, test `qk`/mappers via the existing files.* Tests
  would import `queries.ts`/`page.tsx`, pulling React + `@mercurjs/client` into a
  node test → likely needs jsdom + mocks; fragile; contradicts "pure-fn only."
- *`format.ts` only, skip the `qk`/mapper tests.* Under-delivers; the reviewer
  asked for these tests and D exists to stand up the runner.

## New modules (all pure, zero runtime deps → node-testable)

| File | Exports |
|---|---|
| `src/lib/format.ts` | `usd(n: number \| null): string`, `timeAgo(iso: string, now?: number): string`, `fmtPct(n: number): string` |
| `src/lib/query-keys.ts` | `qk` (the query-key factory, moved verbatim out of `queries.ts`) |
| `src/lib/odds-rows.ts` | `EditRow` (type), `mapOddsToRows(odds: OddsRow[]): EditRow[]`, `rowsToOddsInputs(rows: EditRow[]): OddsInput[]` |

Notes:
- **`usd`** — single canonical body; signature stays `number | null` (matches all
  callsites). Null → `"—"`; otherwise `"$" + toLocaleString('en-US', { min/max
  FractionDigits: 2 })`.
- **`timeAgo(iso, now = Date.now())`** — the only behavior-adjacent change: a
  default `now` parameter so the function is pure and testable with a fixed clock.
  Existing callsite (`timeAgo(p.rolled_at)`) is unchanged because the param
  defaults. Invalid ISO → `"—"`; `<60s` → `"just now"`; then `Nm/Nh/Nd ago`.
- **`fmtPct`** — integer → `"N%"`; otherwise `n.toFixed(2) + "%"`.
- **`qk`** — has **no external consumers** (every route imports hooks like
  `usePulls`, never `qk`), so it moves cleanly; `queries.ts` adds
  `import { qk } from './query-keys'`. No re-export needed.
- **`odds-rows.ts`** — imports are **type-only** (`import type { OddsRow } from
  './packs-api'`, `import type { OddsInput } from '@acme/odds-math'`), which are
  erased at runtime, so the module loads with no runtime dependencies. `EditRow`,
  `mapOddsToRows` move verbatim from `page.tsx`; `rowsToOddsInputs` is the new
  single mapper replacing the two inline builds.

## Edited files (the 4 named files + `queries.ts`)

- `routes/pulls/page.tsx` — remove local `usd` + `timeAgo`; `import { usd, timeAgo } from '../../lib/format'`.
- `routes/economy/page.tsx` — remove local `usd`; `import { usd } from '../../lib/format'`.
- `routes/support/page.tsx` — remove local `usd`; `import { usd } from '../../lib/format'`.
- `routes/packs/[slug]/page.tsx` — remove local `fmtPct`, `EditRow`, `mapOddsToRows`;
  import `fmtPct` from `../../../lib/format` and `EditRow` (type), `mapOddsToRows`,
  `rowsToOddsInputs` from `../../../lib/odds-rows`. Replace **both** inline
  `EditRow → OddsInput` builds (the preview `useMemo` and `save()`) with
  `rowsToOddsInputs(...)`.
- `lib/queries.ts` — `import { qk } from './query-keys'` (delete the inline `qk`).

## Test runner

- Add `vitest@3.2.6` as an admin devDependency (3.2.6 is already hoisted at the
  workspace root; yarn dedupes). Use **vitest**, not jest — even though
  `@acme/odds-math` uses jest, the admin app is Vite + ESM (`"type": "module"`),
  for which Vitest is the native fit (shared transform, no babel/swc-jest setup).
- Add `"test": "vitest run"` to `apps/admin` `package.json` scripts.
- Add `apps/admin/vitest.config.ts`: `test.environment = 'node'`,
  `test.include = ['src/**/*.test.ts']`. (Fresh config — no existing vitest config
  in the monorepo to mirror.)

## Tests (colocated `*.test.ts`, pure-function only)

- `src/lib/format.test.ts`
  - `usd`: a number with cents, a whole number (forces `.00`), `null → "—"`.
  - `timeAgo`: with a fixed `now`, assert `just now` (<60s), `Nm ago`, `Nh ago`,
    `Nd ago`, and invalid ISO `→ "—"`.
  - `fmtPct`: integer `→ "N%"`, fractional `→ "N.NN%"`.
- `src/lib/query-keys.test.ts`
  - Static keys (`packs`, `cards`, `pulls`, `economy`, `eligibleProducts`).
  - Factory fns (`pack`, `packOdds`, `customerGacha`) return the expected tuple
    shape for a given id/slug.
- `src/lib/odds-rows.test.ts`
  - `mapOddsToRows`: field-by-field mapping, including `currentPct = o.pct` and
    `pctInput = String(o.pct)`.
  - `rowsToOddsInputs`: shape `{ card_id, locked, pct, rarity }` with
    `pct = Number(pctInput)`.

## Verification

- Admin build: `cd backend && corepack yarn build` (turbo; builds
  `@acme/odds-math` dist first) — green.
- Tests: `corepack yarn workspace @acme/admin test` — all green.
- Typecheck: enforced by the repo PostToolUse + Stop hooks (the real gate).
- Lint baseline unchanged: the 5 pre-existing `react-refresh/only-export-components`
  errors on route `config` exports are not regressions and are not touched here.

## Risks / watch-items

- **No behavior drift.** The whole point is byte-identical output; the only
  signature change is `timeAgo`'s default param, which leaves the callsite
  identical. Diff each moved helper against its original before deleting.
- **`react-refresh` lint.** New `lib/*.ts` modules export only non-component
  values, so they will not add `only-export-components` violations.
- **Bracketed route dir.** New modules live in `src/lib/`, not next to
  `[slug]/page.tsx`, so file-based routing (which only treats `page.tsx` as a
  route) is untouched and the `apps/admin/src/*` starter contract surface is
  respected.
- **Prettier hook.** The global PostToolUse prettier hook reformats after each
  edit; if a follow-up edit's `old_string` fails, re-Read first.
