# Plan 070: Make the nightly E2E green again — triage the two chronic red specs and the a11y gate

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f14da91..HEAD -- tests/e2e/admin.spec.ts tests/e2e/odds-reflection.spec.ts scripts/qa-a11y.mjs src/app/leaderboard`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW to investigate; MED only if a fix touches product code (each such fix carries its own verification below)
- **Depends on**: none (coordinate with plan 069 — different files, same suite)
- **Category**: tests / dx
- **Planned at**: commit `0f14da91`, 2026-08-02

## Why this matters

The nightly E2E workflow has failed **14 of the last 15 runs** (only
2026-07-21 was green). A gate that is always red carries no signal: PR #311's
signup regression (plan 069) landed into an already-red nightly and was
indistinguishable from baseline noise. Two spec failures recur in every
inspected run (30574695622, 30658846032, 30714035144), and the a11y gate now
fails with real violations plus a probable animation-timing false positive.
This plan diagnoses and fixes each so that "nightly red" again means
"something new broke".

## Current state

Evidence from nightly run 30714035144
(https://github.com/elstonyth/Polycards/actions/runs/30714035144):

1. **`tests/e2e/admin.spec.ts:94`** — "pulls ledger lists opened packs with
   status": `locator('table tbody tr').first()` never becomes visible on the
   admin `/pulls` page (20s timeout, both attempts). The spec opens a pack
   up front via API (`:95-100`: `createCustomer(100)` then
   `openPack(cust.token, 'pokemon-rookie')`), so either the seeded pull isn't
   landing, the admin page errors, or the table markup moved off
   `<table>`-based rendering.
2. **`tests/e2e/odds-reflection.spec.ts:80`** — "pack A (pokemon-rookie):
   100% via admin UI": `getByRole('button', { name: 'Save win rates' })`
   resolves but stays `disabled` for the full 20s. The admin odds form
   plausibly no longer marks itself dirty from the input path the spec uses.
3. **a11y gate** (`e2e.yml:206-208` → `scripts/qa-a11y.mjs`, exit 1):
   - `/leaderboard` — 1 serious `color-contrast` at **4.17:1** (AA needs 4.5:1). Likely real.
   - `/about` — 3 serious contrast hits (1.63:1, 1.07:1 on the `<h1>`,
     1.02:1) where axe logged `transition-delay` / `transition-[opacity,...]`
     on the offending nodes — plausibly measured **mid fade-in**, i.e. the
     `Reveal` entrance animation, not a real defect. The repo's animation
     engine honors `prefers-reduced-motion` (`src/lib/use-reveal.ts`,
     `src/components/Reveal.tsx` — reduced motion renders content visible
     immediately), which is the clean lever for a deterministic scan.

Repo context you need:

- The e2e stack: storefront prod standalone on :4000, admin vite on :7000,
  backend on :9000 (`tests/e2e/README.md`; never `next dev`).
- Historical rule (PR #244, recorded in plans/README round-8): a gate must
  not be able to pass vacuously — when quarantining, use `test.fixme()` with
  a linked issue, never `.skip()` without one.

## Commands you will need

| Purpose                 | Command                                        | Expected on success               |
| ----------------------- | ---------------------------------------------- | --------------------------------- |
| Download failure traces | `gh run download 30714035144 -D <scratch-dir>` | artifacts incl. Playwright traces |
| Run one spec live       | `npx playwright test tests/e2e/admin.spec.ts`  | pass after fix                    |
| Run a11y gate locally   | `npm run test:a11y` (stack on :4000)           | exit 0 after fix                  |
| Storefront check        | `npm run check`                                | exit 0                            |

## Scope

**In scope**:

- `tests/e2e/admin.spec.ts`, `tests/e2e/odds-reflection.spec.ts` (selector/flow fixes)
- `scripts/qa-a11y.mjs` (deterministic scan: settle/disable entrance animations)
- The specific storefront class carrying `/leaderboard`'s failing contrast
  (identify precisely; likely one text-color utility in `src/app/leaderboard/`)
- Admin odds editor dirty-state wiring — **only if Step 2's diagnosis lands
  there**, smallest possible diff (`backend/apps/admin/src/routes/...` odds
  editor)

**Out of scope**:

- `tests/e2e/helpers/storefront.ts`, `tests/e2e/card-management.spec.ts` (plan 069's files)
- `e2e.yml` gate ordering (`if: always()` on both gates is correct — leave it)
- Any palette/redesign work beyond the single failing contrast token
- Loosening any assertion to make a spec pass

## Git workflow

- Branch: `advisor/070-nightly-triage`
- Conventional commits, e.g. `fix(e2e): re-anchor the admin pulls-ledger spec to the current table markup`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Diagnose the `/pulls` ledger failure with the trace, then fix

Download run 30714035144's artifacts and open the trace for
`admin.spec.ts:94`. Determine which of the three hypotheses holds:
(a) the API-opened pull never appears in the admin list (backend/data issue),
(b) the page shows an error state, (c) the table markup changed (e.g. to a
div-grid) so `table tbody tr` matches nothing. For (c), re-anchor the
locator to the current markup (prefer `getByRole('row')` or a data-testid
already present). For (a) or (b): **STOP and report** — that is a product
bug, not a spec fix.

**Verify**: with the stack up, `npx playwright test tests/e2e/admin.spec.ts`
→ the pulls-ledger test passes.

### Step 2: Diagnose the odds-reflection "Save win rates" disabled state, then fix

Reproduce: launch the stack, follow the spec's UI path
(`odds-reflection.spec.ts:80` onward) manually or via the trace. Determine
why the save button never enables — most likely the form's dirty tracking no
longer registers the input method the spec uses (e.g. `fill()` not firing the
event the form listens to). If the spec's input path is the problem, drive
the input the way a user does (`pressSequentially`, or blur after fill). If
the _product_ form genuinely never enables the button after a real user edit,
that is a live admin bug: fix the dirty-state wiring in the odds editor with
the smallest diff and note it prominently in your report.

**Verify**: `npx playwright test tests/e2e/odds-reflection.spec.ts` → passes.

### Step 3: Make the a11y scan deterministic (reduced motion), re-measure

In `scripts/qa-a11y.mjs`, before scanning each route, emulate reduced motion
so `Reveal` renders content immediately instead of mid-fade:

```js
await page.emulateMedia({ reducedMotion: 'reduce' });
```

(plus a `page.waitForLoadState('networkidle')` or equivalent settle if the
script lacks one). Re-run the gate. Expected: the three `/about` hits
disappear (they were mid-transition measurements); `/leaderboard`'s 4.17:1
persists.

**Verify**: `npm run test:a11y` output no longer reports `/about` violations.

### Step 4: Fix the real `/leaderboard` contrast

Locate the node axe flags (4.17:1) and raise its text color one step within
the existing neutral palette (e.g. `text-neutral-500` → `text-neutral-400`
on the dark background — pick the smallest step that clears 4.5:1; PR #244's
work recorded this palette's contrast floors, check its notes in git history
if unsure). Do not restyle anything else.

**Verify**: `npm run test:a11y` → exit 0 across all routes; `npm run check` → exit 0.

## Test plan

The specs themselves are the tests. Additionally: after Steps 1–2, run each
fixed spec **twice** to guard against flake reintroduction. After Step 4,
run the full a11y gate once more from a cold server start.

## Done criteria

- [ ] `npx playwright test tests/e2e/admin.spec.ts tests/e2e/odds-reflection.spec.ts` → both pass, twice
- [ ] `npm run test:a11y` → exit 0
- [ ] `npm run check` → exit 0 (if storefront files were touched)
- [ ] If admin product code was touched: `backend` admin build green (use the pinned tsc — global TS7 shadows the repo's 5.9.3; invoke `node node_modules/typescript/bin/tsc` if `tsc` misbehaves)
- [ ] No `.skip()` added anywhere; any quarantine uses `test.fixme()` + a filed issue
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Step 1 diagnosis is (a) or (b) — the pull genuinely doesn't reach the admin
  ledger, or the page errors. That's a product defect needing its own plan.
- Step 2 shows the odds form never enables Save for a _real user_ edit and the
  fix is larger than a one-file dirty-state correction.
- Step 3's reduced-motion emulation does NOT clear the `/about` hits — then
  they may be real contrast defects; report the post-settle numbers instead of
  guessing at fixes.
- The stack cannot be brought up locally (see `tests/e2e/README.md`; the
  storefront must be the standalone build, not `next dev`).

## Maintenance notes

- Consider (deferred, operator call): a job-summary step in `e2e.yml` diffing
  the failing-spec set against the previous run, so a _new_ red stands out.
- Reviewer: scrutinize any product-code diff from Steps 2/4 hardest — this
  plan is meant to be test-side; product edits must be minimal and justified
  by the trace evidence.
- Plan 069 restores the customer money-path spec; both plans must land before
  the nightly can be fully green.
