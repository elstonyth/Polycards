# Plan 017: Extract and test the voucher-ladder fold logic

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat e9ce6968..HEAD -- backend/apps/admin/src/routes/daily-rewards/page.tsx`
> If the file changed, re-read the fold functions and compare against the
> "Current state" excerpt before editing; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P3
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `e9ce6968`, 2026-07-12

## Why this matters

`foldRangesLocal` (and its companion `summarizeLevels`) validate an operator's
per-level voucher RM configuration over 100 VIP levels — detecting out-of-bounds
ranges, overlaps, and gaps before the ladder can be saved. It's the one
nontrivial pure module on a money-configuration admin screen with **zero tests**:
every other pure admin helper (odds-rows, box-snapshot, query-keys, format) has a
`*.test.ts`; this one, which gates whether an operator can persist voucher
amounts, does not. And it's currently trapped inline in `page.tsx`, so it can't
be imported by a test. A regression could silently block valid ladders or let an
operator believe an invalid one is savable (the backend re-validates, so it's not
data corruption — but the operator-facing correctness is unverified). This plan
extracts the two functions to a lib module and table-tests them.

## Current state

- `backend/apps/admin/src/routes/daily-rewards/page.tsx:180-247` —
  `foldRangesLocal` and `summarizeLevels` are defined inline and **not exported**:

  ```ts
  // foldRangesLocal returns machine-usable levels OR human-readable problems …
  function foldRangesLocal(
    ranges: { from: number; to: number; amountInput: string }[],
  ): { levels: number[] } | { errors: string[] } {
    const errors: string[] = [];
    const out = new Array<number>(LEVELS).fill(-1);
    const overlapLevels = new Set<number>();
    for (const r of ranges) {
      if (!Number.isInteger(r.from) || !Number.isInteger(r.to) ||
          r.from < 1 || r.to > LEVELS || r.from > r.to) {
        errors.push(`Range ${r.from}–${r.to} is invalid: …`);
        continue;
      }
      const amt = Number(r.amountInput);
      … (overlap + gap detection follows) …
  ```

  `LEVELS` is a module constant in the same file — read it and decide whether to
  pass it as an argument or re-export it from the new module.

- **Exemplar to match** — the existing extracted-and-tested pure helpers:
  `backend/apps/admin/src/lib/odds-rows.ts` + `odds-rows.test.ts`, and
  `backend/apps/admin/src/routes/daily-rewards/box-snapshot.ts` +
  `box-snapshot.test.ts`. Follow their structure: a small pure `.ts` module with
  named exports and a co-located `.test.ts` using `vitest` (`describe`/`it`/
  `expect`). `npm test` currently runs 25 tests across format/query-keys/
  box-snapshot/odds-rows — your new file adds to that count.

## Commands you will need

| Purpose               | Command                                              | Expected                  |
| --------------------- | ---------------------------------------------------- | ------------------------- |
| Admin tests           | from `backend/apps/admin`: `npm test` (`vitest run`) | all pass, incl. new tests |
| Admin build/typecheck | from `backend/apps/admin`: `npm run build`           | exit 0                    |

## Scope

**In scope:**

- `backend/apps/admin/src/routes/daily-rewards/voucher-ranges.ts` (create — the
  extracted `foldRangesLocal` + `summarizeLevels`, plus `LEVELS` if it belongs
  with them)
- `backend/apps/admin/src/routes/daily-rewards/voucher-ranges.test.ts` (create)
- `backend/apps/admin/src/routes/daily-rewards/page.tsx` (import from the new
  module instead of the inline defs — behavior-preserving)

**Out of scope:**

- Any change to the fold **behavior** — this is a pure extraction + tests. If a
  test reveals a real bug in the logic, STOP and report it (don't silently
  "fix" it as part of the extraction).
- `box-snapshot.ts` and other daily-rewards logic — leave as-is.

## Git workflow

- Branch: `advisor/017-voucher-ladder-tests`
- Conventional commits, e.g. `test(admin): extract + table-test voucher-ladder fold logic`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract the two functions verbatim

Create `voucher-ranges.ts` and move `foldRangesLocal` + `summarizeLevels` there
**unchanged**, exporting them (named exports). Move or re-export `LEVELS` as
needed so both the module and `page.tsx` share one source of truth (don't
duplicate the constant). Follow the shape of `odds-rows.ts`.

**Verify**: file compiles in isolation once step 2 wires it — proceed.

### Step 2: Import from the new module in `page.tsx`

Replace the inline definitions in `page.tsx` with an import from
`./voucher-ranges`. No call-site logic changes.

**Verify**: `npm run build` → exit 0 (behavior unchanged, types intact).

### Step 3: Table-test the fold logic

Create `voucher-ranges.test.ts` (model after `odds-rows.test.ts`) covering:

- **happy path**: contiguous ranges covering 1..LEVELS return `{ levels }` with
  the right amount per level.
- **out of bounds**: `from < 1`, `to > LEVELS`, `from > to`, non-integer → each
  yields an `errors` entry.
- **overlap**: two ranges covering the same level → an overlap error.
- **gap**: ranges leaving a level uncovered → a gap error (assert which levels).
- **amount parsing**: a non-numeric/blank `amountInput` is handled as the code
  intends (read the code to see whether it errors or defaults).
- `summarizeLevels`: at least one assertion on its output shape.

**Verify**: `npm test` → all pass; the new file's tests are counted.

## Test plan

- New `voucher-ranges.test.ts` with the cases above (happy/bounds/overlap/gap/
  amount), following `odds-rows.test.ts` structure.
- Verification: `npm test` all pass (25 + new); `npm run build` exit 0.

## Done criteria

- [ ] `foldRangesLocal` + `summarizeLevels` live in `voucher-ranges.ts` (exported).
- [ ] `page.tsx` imports them; no behavior change.
- [ ] `voucher-ranges.test.ts` covers happy/bounds/overlap/gap/amount + summarize.
- [ ] `npm test` passes with the new tests; `npm run build` exits 0.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- A test exposes a real behavioral bug (e.g. a gap not detected) — STOP and
  report it. Do not fix it inside this extraction; it needs its own decision.
- `LEVELS` is used by many other functions in `page.tsx` such that moving it is
  invasive — then keep `LEVELS` in `page.tsx` and pass it into the extracted
  functions as a parameter instead.

## Maintenance notes

- The extracted module is now the single home for voucher-range validation; the
  backend still re-validates on save (source of truth). If the VIP level count
  changes, `LEVELS` and the tests move together.
- A reviewer should confirm the extraction is byte-for-byte behavior-preserving
  (diff the moved code) and that the tests actually exercise overlap AND gap, not
  just the happy path.
