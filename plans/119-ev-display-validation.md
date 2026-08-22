# Plan 119: Only render "Expected value" when the published odds actually support the claim

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 30eded61..HEAD -- src/lib/packs-format.ts src/lib/__tests__/pool-value-range.test.ts src/app/slots/[slug]/OddsSheet.tsx backend/apps/admin/src/routes/packs/[slug]/page.tsx`
> On any in-scope change since `30eded61`, compare the "Current state"
> excerpts before proceeding; on a mismatch, treat as STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW-MED (MED only as product behavior: a misconfigured pack's
  EV row disappears in favor of the range row — that is the intended
  fail-safe, but flag it in the PR description for the operator)
- **Depends on**: none
- **Category**: bug (player-facing money figure)
- **Planned at**: commit `30eded61`, 2026-08-22

## Why this matters

PR #462 added an "Expected value" row to the pack odds panel:
`poolExpectedValue` sums (average priced card per tier) × (published
percent / 100). Two unvalidated assumptions make the figure wrong exactly
when an admin misconfigures a pack:

1. **Nothing checks that the published percentages sum to 100.** Each pct
   is individually validated to `[0,100]` (`okPct`), but Σ can be 40 (only
   rare tiers published → EV massively understated) or 130 (typo → EV
   overstated). The row renders either way (`any` flips true on the first
   contributing tier).
2. **A published tier with no priced card silently drops its probability
   mass** (`if (!t …) continue`) instead of disqualifying the figure —
   e.g. a 60%-weight tier whose cards all lack prices simply vanishes from
   the sum.

This is a player-facing money claim on a gambling-adjacent product. The
admin's own API distinguishes "what the player is promised" (`pub_ev`)
from what the secret weights pay; the storefront must not render the
promised figure when the promise is arithmetically incoherent. The
fail-safe already exists: return `null` and the panel falls back to the
"Card value range" row.

## Current state

- `src/lib/packs-format.ts` — `poolExpectedValue` (:119-144):

  ```ts
  export function poolExpectedValue(
    pool: readonly { rarity: string; value: string }[],
    tiers: Partial<Record<Rarity, number>>,
  ): string | null {
    const sums = new Map<Rarity, { sum: number; n: number }>();
    for (const card of pool) {
      if (!isRarity(card.rarity)) continue;
      const v = priceNumber(card.value);
      if (v <= 0) continue;
      const t = sums.get(card.rarity) ?? { sum: 0, n: 0 };
      t.sum += v;
      t.n += 1;
      sums.set(card.rarity, t);
    }
    let ev = 0;
    let any = false;
    for (const rarity of RARITIES) {
      const pct = tiers[rarity];
      const t = sums.get(rarity);
      if (!t || typeof pct !== 'number' || !Number.isFinite(pct)) continue;
      any = true;
      ev += (t.sum / t.n) * (pct / 100);
    }
    return any ? formatValue(Math.round(ev * 100) / 100) : null;
  }
  ```

  Its doc comment (:107-117) records a DELIBERATE tradeoff you must not
  "fix": the storefront folds DISPLAY prices (FX × markup) so it reads
  higher than the admin's raw-market `pub_ev` — "one panel, one price
  basis". Keep that.

- `src/app/slots/[slug]/OddsSheet.tsx:63` — the row label ternary:
  `{expectedValue ? 'Expected value' : 'Card value range'}` — the
  null-fallback wiring already exists; no UI change needed for the guard.
- `src/app/slots/[slug]/PackDetailClient.tsx:321` — the call site:
  `publishedOdds ? poolExpectedValue(pool, publishedOdds.tiers) : null`.
- `src/lib/data/packs.ts:278-288` — `parsePublishedOdds` + `okPct`
  (per-value validation only; no sum check — leave it, the sum check
  belongs in the EV fold, where partial tier data also matters).
- `src/lib/__tests__/pool-value-range.test.ts` — existing tests for this
  module; extend here (vitest).
- `backend/apps/admin/src/routes/packs/[slug]/page.tsx` — the admin pack
  editor (contains the published-odds inputs; located by
  `grep -l published_odds backend/apps/admin/src/routes/packs`).

## Commands you will need

| Purpose              | Command                                                                     | Expected                                                                                                      |
| -------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Storefront typecheck | `npm run typecheck`                                                         | exit 0                                                                                                        |
| Storefront tests     | `npm test` (or `npx vitest run src/lib/__tests__/pool-value-range.test.ts`) | all pass                                                                                                      |
| Lint / format        | `npm run lint` / `npm run format:check`                                     | exit 0                                                                                                        |
| Admin typecheck      | from `backend/`: `./node_modules/.bin/tsc -b apps/admin/tsconfig.json`      | exit 0 — **`corepack yarn check-types` does NOT cover apps/admin** (turbo silently skips it; known repo trap) |

## Suggested executor toolkit

- If the `dashboard-form-ui` / `medusa-ui-conformance` skills are
  available in your environment (they live in `backend/.claude/skills/`),
  load them before Step 3's admin edit.

## Scope

**In scope**:

- `src/lib/packs-format.ts` (the guard)
- `src/lib/__tests__/pool-value-range.test.ts` (new cases)
- `backend/apps/admin/src/routes/packs/[slug]/page.tsx` (non-blocking sum
  warning) and, if the odds inputs live in a child component it imports,
  that component; plus `backend/apps/admin/src/i18n/en.json` if the page's
  strings are i18n-keyed (follow the file's existing pattern)

**Out of scope**:

- `parsePublishedOdds` / `okPct` — per-value validation is correct as is.
- Any server-side write validation or migration of existing
  `published_odds` rows. **Do not block saves on Σ=100**: live packs may
  already violate it, and this repo has been bitten before by client
  bounds that contradicted seeded data (the voucher-cap incident) — the
  admin change is a WARNING only.
- The backend's `pub_ev` computation.
- Label wording ("Expected value") — with the guard in place the label is
  honest when shown; renaming is a product call not taken here.

## Git workflow

- Branch: `advisor/119-ev-display-validation`
- Conventional commit, e.g. `fix(packs): suppress the EV row when published odds don't cover the pool`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Guard the fold

In `poolExpectedValue`, track two totals through the RARITIES loop:
`publishedPct` (Σ of every finite `tiers[rarity]`, whether or not it
contributed) and `contributingPct` (Σ of those that had a priced tier and
entered `ev`). After the loop, render only when the distribution is
coherent:

```ts
// The figure is only the promised EV when (a) the published tiers form a
// full distribution and (b) every published tier contributed priced
// cards — a tier skipped for having no prices silently deletes its
// probability mass. Tolerance covers admin rounding (33.3+33.3+33.4).
const SUM_TOLERANCE = 0.5;
if (
  !any ||
  Math.abs(publishedPct - 100) > SUM_TOLERANCE ||
  publishedPct - contributingPct > SUM_TOLERANCE
) {
  return null;
}
return formatValue(Math.round(ev * 100) / 100);
```

Also count a published-but-unpriced tier correctly: in the loop, add
`pct` to `publishedPct` whenever `typeof pct === 'number' &&
Number.isFinite(pct)` (BEFORE the `!t` continue), and to
`contributingPct` only on the contributing path. A published tier with
pct 0 contributes nothing either way — 0 entries are harmless under both
sums (0 adds 0).

Update the function's doc comment: null now also means "published odds
don't sum to ~100, or a published tier has no priced card — the caller's
range fallback is the honest display for those".

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Tests

Extend `src/lib/__tests__/pool-value-range.test.ts` (match its existing
fixture style):

1. Happy path (unchanged semantics): tiers summing to exactly 100 over
   priced tiers → same formatted value as before this plan (pick a
   fixture with hand-computable EV and assert the exact string).
2. Rounding tolerance: 33.3 + 33.3 + 33.4 → non-null.
3. Σ < 100 (e.g. one tier at 40, nothing else) → null.
4. Σ > 100 (60 + 60) → null.
5. Published tier with NO priced card (pct 50 on a tier absent from the
   pool, plus 50 on a priced tier) → null (mass would have been dropped).
6. Published tier at pct 0 with no priced cards + priced tiers summing
   100 → non-null (zero-weight tiers can't disqualify).

Case 3 (or 5) FAILS against the pre-plan code — if you want the red/green
proof, write the tests first.

**Verify**: `npx vitest run src/lib/__tests__/pool-value-range.test.ts` →
all pass, ≥6 new. `npm test` → full suite green.

### Step 3: Non-blocking sum warning in the admin editor

In `backend/apps/admin/src/routes/packs/[slug]/page.tsx`, find the
published-odds tier inputs (grep `published_odds`/`publishedOdds` within
the file and its imported components). Beneath the tier-percentage inputs,
render a warning (match the page's existing hint/error text component and
i18n pattern) when the entered values are all valid numbers and their sum
differs from 100 by more than 0.5:

> "Published odds sum to {sum}% — the storefront will hide the Expected
> value row until they sum to 100."

WARNING ONLY — do not disable the save button, do not add validation that
rejects the submit (existing rows may be non-compliant; blocking would
strand them, the voucher-cap lesson).

**Verify**: from `backend/`:
`./node_modules/.bin/tsc -b apps/admin/tsconfig.json` → exit 0. If the
admin dev server is easy to run in your environment
(`backend/apps/admin` via `node_modules/.bin/vite`), screenshot the
warning; otherwise state that visual verification is deferred to review.

## Test plan

Step 2's six cases; pattern exemplar `pool-value-range.test.ts`'s existing
blocks. Admin side: typecheck + (best-effort) screenshot — the admin app
has no unit-test rig for route pages (repo precedent).

## Done criteria

- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check` exit 0
- [ ] `npm test` all pass; ≥6 new EV cases
- [ ] `./node_modules/.bin/tsc -b apps/admin/tsconfig.json` (from `backend/`) exits 0
- [ ] `grep -n "SUM_TOLERANCE" src/lib/packs-format.ts` → ≥1
- [ ] The admin warning is render-only (no `disabled`, no validation reject in the diff)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Excerpt mismatch (drift).
- The admin odds inputs turn out to live behind a generated/Mercur
  component you'd have to fork — report the component path instead.
- Any existing test asserts a non-null EV for a fixture whose tiers do
  NOT sum to ~100 — that test was pinning the bug; report it with the
  fixture before changing it.
- You are tempted to normalize by the contributing mass instead of
  returning null — that renders a DIFFERENT number under the same label;
  the decision here is suppress, not reinterpret.

## Maintenance notes

- If the operator later wants "normalize instead of suppress", the two
  sums are already computed — it is a one-line change at the guard, plus
  a label decision ("Expected value (of priced tiers)").
- The backend's `pub_ev` has no such guard either (admin-facing, so lower
  stakes) — noted, deliberately not touched.
- Reviewer: confirm case 1 pins the exact pre-plan value so the guard
  provably changed nothing for well-formed packs.
