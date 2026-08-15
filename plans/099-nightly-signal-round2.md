# Plan 099: Nightly signal round 2 — rescope the economy-report locators, name the failing gate, promote the two shipped-invariant QA scripts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 5c74ce17..HEAD -- tests/e2e/admin.spec.ts .github/workflows/e2e.yml package.json`
> On drift, compare "Current state"; mismatch = STOP.

## Status

- **Priority**: P2 (the nightly is red on a stale selector TODAY)
- **Effort**: S
- **Risk**: LOW (test/workflow-only)
- **Depends on**: none
- **Category**: tests / dx
- **Planned at**: commit `5c74ce17`, 2026-08-15

## Why this matters

The nightly E2E has been red since 2026-08-13 for a non-bug: PR #436 CSS-hid
the Mercur seller "Payouts" sidebar entry (`display:none`; the node stays in
the DOM), and `admin.spec.ts`'s economy-report test asserts
`page.getByText(/payouts/i).first()` is visible — `.first()` now latches the
hidden sidebar anchor. Live-run evidence: runs 31830661692 and 31733761607
both fail with `locator resolved to <p …>Payouts</p> — unexpected value
"hidden"`, 33 retries. Every `getByText(...).first()` in the admin spec has the
same fragility against the prebuilt Mercur chrome.

Second signal problem: the nightly's three gates (Playwright E2E, a11y, CSP)
run as three steps of ONE job, so `gh run list` reports a single bit. In the
last two weeks "nightly red" has meant three different single causes
(card-management spec, a11y contrast, this stale locator) — and telling them
apart requires opening step logs. A cheap `$GITHUB_STEP_SUMMARY` line per gate
makes the run page name the failing gate.

Third: PR descriptions in the delta cite `scripts/qa-free-pack.mjs` (#441/#442)
and `scripts/qa-catalog-groups.mjs` (#443) as verification, but they run only
when a human types them. The nightly already boots the full stack those
scripts need — append them so the shipped invariants they encode stay checked.

## Current state

- `tests/e2e/admin.spec.ts:165-173` — the failing test:

```ts
test('economy report renders lifetime stats and RTP', async ({ page }) => {
  await page.goto(`${ADMIN}/economy`, { waitUntil: 'domcontentloaded' });
  for (const stat of [/revenue/i, /payouts/i, /vault liability/i]) {
    await expect(page.getByText(stat).first()).toBeVisible({
      timeout: 15_000,
    });
  }
  expect(await page.locator('table tbody tr').count()).toBeGreaterThan(0);
});
```

- Cause: `backend/apps/admin/src/admin-ui.css` (#436, commit `5f98c287`) hides
  the seller Payouts sidebar anchor with CSS; the anchor's
  `<p class="font-medium font-sans txt-compact-small">Payouts</p>` still
  matches `getByText(/payouts/i)` and sorts first in DOM order.
- Other `getByText(...).first()` sites in `admin.spec.ts`: sweep the file
  (`grep -n "getByText" tests/e2e/admin.spec.ts`) — any that can match
  sidebar/chrome text needs the same scoping.
- `.github/workflows/e2e.yml` — one `e2e` job; steps `Run E2E` (`:198-199`),
  `Run a11y gate` (`:206-208`, `if: always()`), `Run CSP gate` (`:217-219`,
  `if: always()`), then artifact upload. The `always()` comments explain the
  masking concern this plan's summary lines complete.
- `package.json:38-39` — only `qa:csp` and `test:a11y` are exposed as scripts;
  `qa-free-pack.mjs` / `qa-catalog-groups.mjs` are unwired.
- Both scripts default their base URL to :4000 (verify each script's header
  before wiring — read the first ~30 lines).

## Commands you will need

| Purpose                                                                                 | Command                                                                                                                   | Expected                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| List the suite                                                                          | `npx playwright test --list` (root)                                                                                       | exits 0, spec count unchanged |
| Storefront check                                                                        | `npm run check`                                                                                                           | exit 0                        |
| Workflow parse                                                                          | `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/e2e.yml','utf8'))"` (js-yaml is a devDep) | no throw                      |
| Live admin spec (only if a full stack is running; else skip — the nightly is the proof) | `npx playwright test admin.spec.ts`                                                                                       | economy test passes           |

## Scope

**In scope**:

- `tests/e2e/admin.spec.ts`
- `.github/workflows/e2e.yml`
- `package.json` (two new script entries)

**Out of scope**:

- `backend/apps/admin/src/admin-ui.css` — #436's hide is deliberate; the TEST
  adapts.
- `scripts/qa-free-pack.mjs` / `qa-catalog-groups.mjs` bodies — wire them, do
  not edit them (if one fails when finally run in CI, that is a finding, not
  something to silence — see STOP).
- Splitting the workflow into multiple jobs (considered; rejected as heavier
  than the summary-line fix — the stack boot is 15–25 min and would have to be
  duplicated or shared).
- `scripts/qa-raw-frame.mjs`, `capture-*.mjs` — visual-capture tools, stay
  manual.

## Git workflow

- Branch: `advisor/099-nightly-signal-2`
- Conventional commits, e.g. `test(e2e): scope economy-report locators to the content region`.
- No push/PR without operator instruction.

## Steps

### Step 1: rescope the economy-report locators

In the economy test, scope every text assertion to the page content region so
sidebar chrome can never match. Preferred: `page.getByRole('main')` if the
admin layout exposes a `main` landmark (check the DOM via the run-log HTML or a
live stack; Mercur's layout does render `<main>` — verify with
`grep -rn "<main" backend/apps/admin/src` and the Mercur layout if needed).
Fallback: scope to a stable container testid on the economy page (read
`backend/apps/admin/src/routes/economy/page.tsx` for an existing testid or
heading to anchor on — do NOT add testids to the admin app in this plan).
Apply the same scoping to every other `getByText(...).first()` in
`admin.spec.ts` that could match chrome text (sweep from Current state).

**Verify**: `npx playwright test --list` exits 0; the file's test count is
unchanged.

### Step 2: per-gate step summaries

In `e2e.yml`, after each of the three gate steps, append a summary line so the
run page names what failed without a log dive. Cheapest shape — give each gate
step an `id:` and add one `if: always()` step at the end:

```yaml
- name: Gate summary
  if: always()
  run: |
    {
      echo "| gate | outcome |"
      echo "|------|---------|"
      echo "| e2e | ${{ steps.e2e.outcome }} |"
      echo "| a11y | ${{ steps.a11y.outcome }} |"
      echo "| csp | ${{ steps.csp.outcome }} |"
      echo "| qa-free-pack | ${{ steps.qafp.outcome }} |"
      echo "| qa-catalog-groups | ${{ steps.qacg.outcome }} |"
    } >> "$GITHUB_STEP_SUMMARY"
```

(Match the workflow's existing indentation; ids `e2e`/`a11y`/`csp`/`qafp`/`qacg`
added to the corresponding steps.)

**Verify**: the yaml-parse command → no throw.

### Step 3: promote the two QA scripts

1. `package.json`: add `"qa:free-pack": "node scripts/qa-free-pack.mjs"` and
   `"qa:catalog-groups": "node scripts/qa-catalog-groups.mjs"`.
2. `e2e.yml`: after the CSP gate, two steps (ids `qafp`, `qacg`,
   `if: always()`) running those npm scripts, mirroring the a11y/CSP step
   shape and comments (why nightly is the home: the stack is booted).
3. Read both scripts' headers first: confirm they exit non-zero on failure and
   target :4000 by default. If either always exits 0 (the vacuous-gate class
   this repo has hit twice), STOP — wiring a vacuous gate is worse than none.

**Verify**: yaml parses; `npm run qa:free-pack --help 2>&1 || true` runs the
file (it will fail to connect without a stack — that failure IS the non-vacuous
proof; note the exit code is non-zero).

## Test plan

Workflow-file changes are proven by the first nightly after merge (record that
in the README row as a WATCH). Local proof: Step 1 via `--list` + (if a stack
is available) a live run of `admin.spec.ts`; Steps 2–3 via YAML parse + the
non-zero connect-failure probe.

## Done criteria

- [ ] `grep -n "getByText" tests/e2e/admin.spec.ts` → every `.first()` scoped to a content region (none can match sidebar chrome)
- [ ] `e2e.yml` has step ids + the gate-summary step + the two new gate steps
- [ ] `package.json` carries `qa:free-pack` and `qa:catalog-groups`
- [ ] YAML parses; `npx playwright test --list` green; `npm run check` green
- [ ] `git status` clean outside scope; `plans/README.md` row updated (with the first-nightly WATCH note)

## STOP conditions

- Either QA script proves vacuous (exits 0 with no stack) — report; do not
  wire it.
- The admin layout has no scoping anchor (`main` landmark absent and no stable
  container) — report the DOM shape you found instead of inventing a selector
  from chrome classes.
- `e2e.yml` drifted (steps renamed/moved) — re-anchor by step names, and STOP
  if the three gates are no longer in one job (someone may have split it).

## Maintenance notes

- The stale-locator class: any admin-spec assertion using bare
  `getByText(...).first()` breaks when Mercur chrome gains matching text.
  Reviewers of future admin-spec changes should require scoped locators.
- When a gate is red, the step summary now names it — the on-call reflex should
  be "read the summary table", not "open logs".
- Deferred: chronic-failure diffing against the previous run (round-9 idea) —
  still deferred until the gate holds green for a stretch.
