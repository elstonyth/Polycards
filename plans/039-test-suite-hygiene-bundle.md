# Plan 039: Test-suite hygiene — real-timer sleep, seed guard, orphan-id assert, a11y gate

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Your reviewer
> maintains `plans/README.md` — do not edit it.
>
> **Drift check (run first)**:
> `git diff --stat 38f7dbdd..HEAD -- backend/packages/api/integration-tests/http/pack-open-rate-limit.spec.ts backend/packages/api/src/modules/packs/__tests__/reward-draw.spec.ts tests/e2e/helpers .github/workflows/e2e.yml`
> On any change, compare "Current state" against live code before proceeding.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests / dx
- **Planned at**: commit `38f7dbdd`, 2026-07-13

## Why this matters

Four independent test-hygiene items, all cheap, that got worse or stayed open
across rounds 3–4:

1. **A 15.5s real sleep runs in CI on every backend PR.** Plan 027 made the
   HTTP integration tier run in CI; `pack-open-rate-limit.spec.ts:140` sleeps
   `15_500` ms of real wall-clock (waiting out a rate-limit window). The cost
   is now paid per PR, per shard drawing that spec.
2. **9 E2E specs hardcode seed pack slugs with no presence guard.** They
   assume `pokemon-rookie`/`pokemon-elite` exist; a local run against a
   drifted shared dev DB fails opaquely mid-spec (documented to have happened
   during plan 023).
3. **`reward-draw.spec.ts` asserts an orphan string id round-trips** — it sets
   `vault_pull_id: 'pull_abc123'` (a fabricated id referencing no real Pull)
   and asserts it comes back equal. It proves a column stores a string, not
   that a real reward-draw association holds; a referential-integrity
   regression passes it. (Flagged by CodeRabbit on PR #143.)
4. **`test:a11y` is the only automated a11y signal and runs in no workflow.**

## Current state

**Item 1** — `backend/packages/api/integration-tests/http/pack-open-rate-limit.spec.ts`:
`await sleep(15_500);` at line 140 (`sleep` helper defined ~line 21;
`jest.setTimeout(240 * 1000)` at line 6). The window it waits out is the pack-
open rate-limit window, configured via env in
`backend/packages/api/src/api/utils/rate-limit.ts` (the `.env.template`
documents `PACK_OPEN_RATE_*` knobs around lines 59-60). Read `rate-limit.ts`
to confirm the window is env-overridable **in test mode** before shrinking it.

**Item 2** — the 9 specs are under `tests/e2e/`:
`odds-reflection`, `delivery-request`, `card-management`, `customer`,
`bulk-sell`, `slot-vault-room`, `rewards`, `ship-orders`, `admin` (`.spec.ts`).
Helpers live in `tests/e2e/helpers/` (`admin.ts`, `api.ts`, `constants.ts`,
`storefront.ts`). The seed slugs are string literals in the specs.

**Item 3** — `backend/packages/api/src/modules/packs/__tests__/reward-draw.spec.ts`:
line 125 `vault_pull_id: 'pull_abc123'`, line 131
`expect(row.vault_pull_id).toBe('pull_abc123')`. The surrounding case creates
a product row directly rather than via a real reward draw.

**Item 4** — `package.json:39` `"test:a11y": "node scripts/qa-a11y.mjs"`;
this string appears in neither `.github/workflows/ci.yml` nor `e2e.yml`.
`scripts/qa-a11y.mjs` likely needs a running server (read it to confirm what
it expects). `e2e.yml` already boots the full stack on a schedule.

## Commands you will need

| Purpose            | Command                                                                                                    | Expected             |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------- |
| Backend install    | `corepack yarn install` (in `backend/`)                                                                    | exit 0               |
| Rate-limit spec    | `corepack yarn test:integration:http --testPathPattern="pack-open-rate-limit"` (in `backend/packages/api`) | passes, and now fast |
| reward-draw spec   | `corepack yarn test:integration:modules --testPathPattern="reward-draw"`                                   | passes               |
| E2E list           | `npx playwright test --list` (repo root)                                                                   | lists specs, exit 0  |
| Storefront install | `npm install` (repo root)                                                                                  | exit 0               |

## Scope

**In scope**:

- `backend/packages/api/src/api/utils/rate-limit.ts` — **only if** the test-
  mode window isn't already env-overridable and Step 1 needs to make it so.
- `backend/packages/api/integration-tests/http/pack-open-rate-limit.spec.ts`
- `tests/e2e/helpers/` — a new preflight/guard helper (+ its wiring into the
  affected specs' setup, minimally).
- `backend/packages/api/src/modules/packs/__tests__/reward-draw.spec.ts`
- `.github/workflows/e2e.yml` — add the a11y step (only if `qa-a11y.mjs` fits
  the booted-stack model).

**Out of scope**:

- The rate-limit _production_ behavior — only the test's ability to use a
  short window in test mode.
- `ci.yml` — the a11y gate belongs in the nightly `e2e.yml` (server already
  up), not per-PR.
- Any non-test source logic.

## Git workflow

- Branch: `advisor/039-test-suite-hygiene-bundle`
- One commit per item is fine, e.g.
  `test(perf): drop the 15.5s real sleep in pack-open-rate-limit`,
  `test(e2e): fail fast when seed packs are missing`,
  `test: assert reward-draw association on a real Pull id`,
  `ci: run the a11y gate in the nightly e2e workflow`.
- Do not push or open a PR.

## Steps

### Step 1: Shrink the rate-limit sleep

Read `src/api/utils/rate-limit.ts`. If the pack-open window is env-configurable
(`PACK_OPEN_RATE_WINDOW_MS` etc.), set a short window (e.g. 1000ms) for this
spec via the test's env setup and reduce `sleep(15_500)` to just over the
short window. If it is NOT test-overridable, add a minimal test-mode override
(guarded by `NODE_ENV==='test'` or the existing test detection) so the window
can be shortened **without changing prod defaults**. The spec must still assert
the same behavior: requests inside the window are limited, a request after it
succeeds.

**Verify**:
`corepack yarn test:integration:http --testPathPattern="pack-open-rate-limit"`
→ passes, and wall-clock is seconds not 15s+ (note the runtime in your report).

### Step 2: Seed-presence preflight for E2E

Add a helper in `tests/e2e/helpers/` (e.g. `seed-guard.ts`) that asserts the
required packs (`pokemon-rookie`, `pokemon-elite`) exist — query the store
API via the existing `api.ts` helper — and throws a clear message naming the
reseed command (`corepack yarn seed` from `backend/packages/api`) if absent.
Wire it into the shared setup the affected specs use (a `beforeAll` in a common
fixture, or Playwright global setup if one exists — check
`playwright.config.ts`). Prefer one central hook over editing 9 specs.

**Verify**: `npx playwright test --list` → exit 0 (specs still collect). Do NOT
run the full E2E suite (needs the booted stack); listing is the gate here.

### Step 3: Assert reward-draw on a real Pull

In `reward-draw.spec.ts`, change the product-link case so it creates a **real**
reward Pull (use the same creation path the other cases in the file use) and
asserts the association against that Pull's generated id, instead of the
fabricated `'pull_abc123'`. If the file has no existing "create a Pull" seam,
model it on the nearest case that creates a real row.

**Verify**:
`corepack yarn test:integration:modules --testPathPattern="reward-draw"` →
passes; `grep -n "pull_abc123" backend/packages/api/src/modules/packs/__tests__/reward-draw.spec.ts`
→ 0 matches.

### Step 4: Wire the a11y gate into nightly E2E

Read `scripts/qa-a11y.mjs` to confirm it targets a running server URL. Add a
step to `.github/workflows/e2e.yml` that runs `npm run test:a11y` after the
stack is up (mirror how the existing E2E step invokes the booted server). If
`qa-a11y.mjs` needs a URL/env the workflow must provide, wire it the same way
the Playwright step gets its base URL.

**Verify**: `.github/workflows/e2e.yml` parses (YAML valid — a quick
`node -e "require('js-yaml')"` isn't available; instead confirm indentation
matches the sibling steps by reading). If you cannot confirm `qa-a11y.mjs`
fits the booted-stack model, STOP and report — do not guess at the wiring;
deleting the two dead scripts (`qa:csp` has separate unit coverage;
`test:a11y`) is the acceptable alternative, note which you chose.

## Test plan

Each step is itself a test change verified by re-running the affected suite
(Steps 1, 3) or the collector (Step 2). No new product-code tests. Item 4 is
CI config, verified by inspection.

## Done criteria

- [ ] pack-open-rate-limit spec passes in seconds (runtime noted in report)
- [ ] E2E seed guard exists and specs still collect (`npx playwright test --list` exit 0)
- [ ] `grep -n "pull_abc123" .../reward-draw.spec.ts` → 0; the spec passes
- [ ] a11y gate added to `e2e.yml` OR the dead scripts removed (report which)
- [ ] `git status` shows no files outside scope

## STOP conditions

- The pack-open rate-limit window is NOT test-overridable and adding an
  override would touch production rate-limit behavior in a non-test path —
  report; do not weaken prod limits.
- `playwright.config.ts` has no shared setup seam and the guard would require
  editing all 9 specs — report; the reviewer may accept the 9-spec edit or a
  global-setup addition.
- `scripts/qa-a11y.mjs` needs infrastructure the nightly workflow can't
  provide — report; default to removing the dead scripts instead.

## Maintenance notes

- Item 1's test-mode window override must never leak into prod defaults — a
  reviewer should confirm the override is test-gated.
- The seed guard is the fail-fast the round-3/4 backlog asked for; if seed
  slugs change, update the guard's expected list.
- `qa:csp` was intentionally left (it has separate unit coverage in
  `src/lib/security/__tests__/csp.test.ts`); only `test:a11y` needed a home.
