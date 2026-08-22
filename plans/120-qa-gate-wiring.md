# Plan 120: Give the orphan QA scripts teeth and a home — without creating the next never-green gate

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 30eded61..HEAD -- scripts/qa-motion13.mjs scripts/qa-reset-countdown.mjs scripts/qa-prod-smoke.mjs scripts/qa-postwipe-spin.mjs .github/workflows/e2e.yml package.json`
> On any in-scope change since `30eded61`, compare the "Current state"
> excerpts before proceeding; on a mismatch, treat as STOP.

## Status

- **Priority**: P3
- **Effort**: S–M
- **Risk**: LOW-MED (MED only for the nightly wiring step — it adds a gate
  that could go red; the vacuity fix and the precondition analysis below
  exist precisely to prevent a false red)
- **Depends on**: plan 113 recommended first (restores a green nightly
  baseline so a new gate's first result is attributable)
- **Category**: tests + dx
- **Planned at**: commit `30eded61`, 2026-08-22

## Why this matters

Four QA scripts landed in the delta, all exit non-zero correctly, and
**none is wired to anything** — the nightly runs exactly four gates
(a11y, CSP, free-pack, catalog-groups). Worse, per script:

- `qa-motion13.mjs` (QA for the motion v12→13 major) is **vacuous twice
  over**: its own comment says "if motion failed to initialise, [the node
  count] collapses to 0 and 'no stuck nodes' would be vacuously true" —
  and then `motionNodes` is printed but never asserted; and when `/slots`
  yields no pack link the SKIP branch pushes nothing to `results`, so a
  backend-down run checks 3 pages and exits 0. Same vacuous-gate class as
  this repo's axe/oklch incident.
- `qa-reset-countdown.mjs` says "Non-zero so this can gate unattended" —
  but it CANNOT be promoted to the nightly: **the CI seed creates no
  challenge** (`grep -c challenge backend/packages/api/src/scripts/seed-e2e-fixtures.ts`
  → 0), so CI's `/leaderboard` renders no `Resets` line and the gate would
  be permanently red — the exact slot-collision failure mode plan 107 just
  fixed. It needs a documented precondition, not a workflow entry.
- `qa-prod-smoke.mjs` (verified read-only: goto + $$eval + screenshots +
  a consent-banner click; asserts home-200, catalog-served, detail-hydrated,
  no console errors) deliberately targets production — it belongs on a
  manual `workflow_dispatch`, and it should also assert #473's headline
  deliverable (home served from the route cache), which currently has a
  **self-documented silent-failure mode and zero verification** — a
  `cookies()` read added anywhere in the home tree reverts the whole win
  with green CI (`src/app/page.tsx:28-30` warns exactly this).
- `qa-postwipe-spin.mjs` claims "The DB is the assertion surface" but
  never opens a DB and only asserts `aria-busy` rose and cleared — a
  spinner, not a settled spin. And `QA_BASE` pointed at prod runs a
  **charged** spin on a real account with no warning.
- Three of the four carry a copy-pasted `mkdirSync` justified by a false
  comment ("the screenshot below would throw") — Playwright's
  `page.screenshot` mkdirs its own path (verified in the installed
  `playwright-core`); the wrong explanation is already propagating.

## Current state

- `.github/workflows/e2e.yml:205-268` — the four gate steps, each
  `if: always()` + `npm run <alias>`, and the Gate summary table writing
  `$GITHUB_STEP_SUMMARY` rows for `e2e/a11y/csp/qafp/qacg`.
- `package.json` scripts: `qa:csp`, `test:a11y`, `qa:free-pack`,
  `qa:catalog-groups` only.
- `scripts/qa-motion13.mjs`:
  - `:49-52`: the motionNodes comment + helper (`document.querySelectorAll('[style*="opacity"]').length`).
  - `visit()` returns `fresh.length === 0 && hidden.length === 0` — `nodes`
    printed only.
  - `:165-169`: `} else { console.log('SKIP pack-detail/card-overlay/spin — no pack link on /slots (backend down?)'); }` — pushes nothing.
  - `:176`: `process.exit(failed ? 1 : 0)`.
- `scripts/qa-reset-countdown.mjs` — 30 lines; asserts the `/^Resets/i`
  line's text changes across a 2.2s wait; `process.exitCode = first && second && first !== second ? 0 : 1;`
  If the line never renders, `textContent` on the unmatched locator throws
  and `first` stays undefined → exit 1 with an opaque error.
- `scripts/qa-prod-smoke.mjs` — full read above confirmed; `BASE`
  defaults `https://polycards.gg`; `mkdirSync(OUT, { recursive: true })`
  at `:10` with no false comment (keep or drop — see Step 6 rule).
- `scripts/qa-postwipe-spin.mjs:1-19` — header claim + `QA_BASE` /
  positional-arg / `127.0.0.1:4000` precedence + the false mkdir comment
  (`:16-18`); `:59-71` the aria-busy watch (`sawBusy`).
- `src/app/page.tsx:28-31` — the fetchCache warning + `revalidate = 15`.
- Repo memory that applies: the balance meter on the spin page is exposed
  via an `sr-only` element (the reliable probe; never assert on the
  animated odometer).

## Commands you will need

| Purpose                   | Command                                                                                                                                                                          | Expected                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Syntax per script         | `node --check scripts/qa-<name>.mjs`                                                                                                                                             | exit 0                                    |
| Lint/format               | `npm run lint` / `npm run format:check`                                                                                                                                          | exit 0 (scripts/ is in prettier scope)    |
| Storefront tests          | `npm test`                                                                                                                                                                       | all pass (nothing here should touch them) |
| Local stack for live runs | build + `pwsh scripts/serve-standalone.ps1 -Port 4000`, backend `corepack yarn dev` from `backend/packages/api`                                                                  | :4000 + :9000 up                          |
| Workflow lint             | `node -e "const y=require('js-yaml')"` is NOT available — validate YAML by pushing? NO: use `npx --yes yaml-lint .github/workflows/e2e.yml` if allowed, else careful diff review | parse ok                                  |

## Scope

**In scope**:

- `scripts/qa-motion13.mjs`, `scripts/qa-reset-countdown.mjs`,
  `scripts/qa-prod-smoke.mjs`, `scripts/qa-postwipe-spin.mjs`
- `package.json` (script aliases only)
- `.github/workflows/e2e.yml` (one new gate step + one summary row)
- `.github/workflows/prod-smoke.yml` (create, `workflow_dispatch` only)

**Out of scope**:

- `backend/packages/api/src/scripts/seed-e2e-fixtures.ts` — seeding a CI
  challenge is a real follow-up but a separate decision (it changes what
  every e2e spec sees); recorded in the README, not done here.
- `scripts/qa-free-pack.mjs` (plan 113), `qa-catalog-groups.mjs`,
  `qa-a11y.mjs`, `qa-csp.mjs` — already wired and owned.
- `src/app/page.tsx` and any source file — this plan is scripts + CI only.

## Git workflow

- Branch: `advisor/120-qa-gate-wiring`
- Conventional commits per step, e.g. `test(qa): make qa-motion13 fail when it proves nothing`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: De-vacuate `qa-motion13.mjs`

1. In `visit()`, fold the node count into the verdict:
   `const pass = fresh.length === 0 && hidden.length === 0 && nodes > 0;`
   and extend the FAIL log line with `motionNodes=${nodes}` context it
   already prints; when `nodes === 0`, append
   `(zero motion-driven nodes — did motion initialise at all?)`.
2. In the no-pack-link `else` branch, make the skip a hard failure:
   `results.push(false, false, false);` after the existing SKIP log, and
   change the log text to
   `FAIL pack-detail/card-overlay/spin — no pack link on /slots (backend down?)`.

**Verify**: `node --check scripts/qa-motion13.mjs` → exit 0.
Live run against the local stack: `node scripts/qa-motion13.mjs` → exits
0 with `PASS` on all surfaces and every line showing `motionNodes=<n>0>`.
Mutation proof: run with the backend stopped → exits 1 (the pushed
falses); restart backend.

### Step 2: Alias the scripts in `package.json`

Add to `scripts`: `"qa:motion13": "node scripts/qa-motion13.mjs"`,
`"qa:reset-countdown": "node scripts/qa-reset-countdown.mjs"`,
`"qa:prod-smoke": "node scripts/qa-prod-smoke.mjs"`,
`"qa:postwipe-spin": "node scripts/qa-postwipe-spin.mjs"`.

**Verify**: `npm run qa:motion13 --silent -- --help 2>&1 | head -1` is not
meaningful for these; instead `node -e "const p=require('./package.json'); ['qa:motion13','qa:reset-countdown','qa:prod-smoke','qa:postwipe-spin'].forEach(k=>{if(!p.scripts[k])throw new Error(k)})"` → exit 0.

### Step 3: Wire `qa:motion13` into the nightly

In `.github/workflows/e2e.yml`, after the catalog-groups gate step, add
(matching the existing gate-step shape exactly — `if: always()`, an `id`,
a comment explaining WHY the nightly is the home):

```yaml
# Motion-13 QA gate: the motion v12→13 major drives 8 storefront
# surfaces (reveal stages, overlays, the reels). Asserts real motion
# nodes mounted and none stuck at opacity 0, against the running
# storefront (:4000) + backend (:9000). `always()` for the same
# reason as the gates above.
- name: Run motion QA gate
  id: qamotion
  if: always()
  run: npm run qa:motion13
```

Check the script's BASE/env expectations first (read its top: which env
var sets the base URL — if it defaults to :4100 like qa-free-pack did,
set the same `PW_BASE: http://localhost:4000` env the free-pack step
uses; if it defaults to :4000, no env needed). Add a summary row:
`echo "| Motion QA | ${{ steps.qamotion.outcome }} |"` in the Gate
summary block.

**Verify**: YAML parses (careful review or yaml-lint); the step's alias
exists (Step 2); grep the workflow:
`grep -c "qamotion" .github/workflows/e2e.yml` → 2 (step id + summary).

### Step 4: Precondition-proof `qa-reset-countdown.mjs` and document why it is NOT wired

1. Make the absence case speak: before reading `textContent`, check
   `await line.count()` — if 0, print
   `FAIL no "Resets…" line on /leaderboard — no active challenge here; this script needs a seeded, active challenge`
   and exit 1 (replacing the opaque locator timeout).
2. Extend the header comment:
   `// NOT wired to the nightly: seed-e2e-fixtures.ts seeds no challenge, so CI's /leaderboard has no Resets line and this gate would be red every night (plan 120). Wire it only after the CI seed creates an active challenge.`

**Verify**: `node --check` → exit 0. Live run against the local stack
(local DB has an active challenge per the running product): exits 0 and
prints `ticking: true`. If YOUR local DB happens to have no active
challenge, the new absence branch fires — that is the correct behavior;
note it and verify branch 1's message instead.

### Step 5: Prod-smoke — cache assertion + manual workflow

1. In `scripts/qa-prod-smoke.mjs`, after the existing home check, add a
   route-cache probe using the request API (no browser needed):

```js
// #473's headline: "/" renders once per 15s window (route cache). The
// regression mode is silent (page.tsx's fetchCache warning), so probe it:
// two requests inside one window must show a cache HIT on the second.
// Behind a CDN/edge that strips x-nextjs-cache we can't observe it —
// SKIP LOUDLY rather than pass silently.
const p1 = await ctx.request.get(BASE + '/');
const p2 = await ctx.request.get(BASE + '/');
const cacheHeader = p2.headers()['x-nextjs-cache'];
if (cacheHeader === undefined) {
  console.log(
    'SKIP home route-cache probe — x-nextjs-cache not observable through this edge',
  );
} else {
  check(
    /HIT|STALE/i.test(cacheHeader),
    'home served from the route cache',
    `x-nextjs-cache=${cacheHeader}`,
  );
}
```

(A SKIP here does not increment `failed` — it is deliberately visible
but non-gating, because the CDN may legitimately strip the header. When
run against a direct standalone origin — e.g. `QA_BASE=http://127.0.0.1:4000`
— the header IS present and the check gates hard.)

2. Create `.github/workflows/prod-smoke.yml`:

```yaml
name: prod-smoke
on:
  workflow_dispatch:
    inputs:
      base:
        description: Target origin
        default: https://polycards.gg
        required: true
permissions:
  contents: read
jobs:
  smoke:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run qa:prod-smoke
        env:
          QA_BASE: ${{ inputs.base }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: prod-smoke-shots
          path: docs/research/prod-smoke/
```

Pin the four action SHAs to match how `.github/workflows/e2e.yml` pins
its actions (read it and copy the exact pin style — this repo pins by
SHA with a version comment).

**Verify**: `node --check scripts/qa-prod-smoke.mjs` → exit 0. Run it
against the LOCAL standalone (`QA_BASE=http://127.0.0.1:4000 npm run qa:prod-smoke`)
→ exits 0 and the new probe line appears as either `PASS home served from
the route cache — x-nextjs-cache=HIT` (expected on a direct origin) or a
loud SKIP. Do NOT run it against production during this plan.

### Step 6: Postwipe truth + prod-spend warning

In `scripts/qa-postwipe-spin.mjs`:

1. Header: replace line 3's "The DB is the assertion surface; the browser
   just drives a real open." with
   `// Asserts a real CHARGED spin runs and settles from the browser's view: the sr-only balance meter must DROP by the pack price across the spin. (No DB access — for ledger-level verification query ledger_entry directly.)`
2. Add the warning right below the BASE line:
   `// A non-local QA_BASE runs a CHARGED spin on the named account and spends real credit. There is no dry-run mode.`
3. Add the balance assertion: before pressing spin, read the sr-only
   balance meter's text (locate it first:
   `grep -rn "sr-only" src/app/slots/[slug]/SlotMachineClient.tsx src/components/ | grep -in "balance\|credit"` — the spin page exposes a
   screen-reader balance meter; if the grep is ambiguous, run the local
   stack, open a spin page, and inspect). Parse the number; after the
   aria-busy fall + the existing 3s settle wait, read it again and:
   `after < before ? ok('balance dropped ' + (before-after)) : fail('balance did not drop — spin did not settle')`.
   Keep the aria-busy check as-is (it proves the animation phase; the
   balance delta proves the charge + settle).
4. Delete the false mkdir comment (`:16-18`'s "would throw at the very
   end") and the `mkdirSync` call — Playwright's `screenshot()` creates
   its directory. Apply the same deletion in `qa-motion13.mjs` (`:14`
   area) and `qa-prod-smoke.mjs` (`:10`) **iff** the script writes only
   screenshots to that directory (all three do — verify with a read
   before deleting; `qa-prod-smoke.yml`'s artifact upload needs the dir
   to EXIST only when screenshots were taken, which screenshot() ensures).

**Verify**: `node --check` on all three → exit 0. Live run against the
LOCAL stack with a funded local customer
(`CUST_EMAIL=… CUST_PW=… npm run qa:postwipe-spin`) → exits 0 with the
new `OK balance dropped …` line. If no funded local customer exists,
STOP condition below applies.

### Step 7: Full gates

**Verify**: `npm run lint`, `npm run format:check`, `npm test` → green.
`git diff --stat` → only in-scope files.

## Test plan

Live-run proofs are embedded per step (motion13 backend-down mutation,
reset-countdown absence branch, prod-smoke local cache probe, postwipe
balance delta). No vitest changes.

## Done criteria

- [ ] `node --check` exits 0 on all four scripts
- [ ] `npm run lint` / `npm run format:check` / `npm test` exit 0
- [ ] motion13: live PASS run + backend-down exit-1 proof recorded
- [ ] e2e.yml has the motion gate + summary row (`grep -c qamotion` → 2); no other workflow lines changed
- [ ] reset-countdown: header carries the NOT-wired rationale; absence branch prints the new message; **no entry for it in e2e.yml**
- [ ] prod-smoke: cache probe present; `.github/workflows/prod-smoke.yml` exists, `workflow_dispatch` only, actions pinned in the repo's style
- [ ] postwipe: balance assertion live-proven; header + spend warning updated
- [ ] `grep -rn "would throw at the very end" scripts/` → 0 matches
- [ ] `plans/README.md` status row updated (including the recorded follow-up: "seed an active challenge in seed-e2e-fixtures, then wire qa:reset-countdown")

## STOP conditions

- Excerpt mismatch (drift).
- The sr-only balance meter cannot be located from grep + one inspection
  session — report what the spin page actually exposes; do not assert on
  the animated odometer (known trap).
- No funded local customer exists and creating one is outside your
  session's reach — deliver Steps 1–5 + 6.1/6.2/6.4 and report 6.3 as
  unproven.
- The e2e.yml action-pin style cannot be matched for the new workflow
  (e.g. an action this repo has never pinned) — ask rather than pinning
  to a tag.
- Any temptation to seed a challenge into CI fixtures "while you're
  here".

## Maintenance notes

- When the CI seed gains an active challenge (recorded follow-up), wire
  `qa:reset-countdown` exactly like the motion gate (step + summary row)
  — its script is already gate-shaped.
- The prod-smoke cache probe's SKIP path is deliberate observability
  honesty: if DO's edge ever starts passing `x-nextjs-cache` through, the
  probe silently upgrades from SKIP to a hard gate.
- Reviewer: check Step 1.2 pushes exactly three `false`s (three skipped
  surfaces) so the summary line's `x/y surfaces clean` arithmetic stays
  truthful.
