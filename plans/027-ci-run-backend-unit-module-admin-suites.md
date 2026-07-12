# Plan 027: Make CI actually execute the backend unit, module, and admin test suites (and cache turbo)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat dbce0561..HEAD -- .github/workflows/ci.yml backend/turbo.json backend/package.json backend/apps/admin/package.json backend/packages/api/package.json backend/packages/api/jest.config.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (the module suites boot a real DB per suite in one process — expect first-run heap/timeout shakeout; everything else is LOW)
- **Depends on**: none
- **Category**: tests / dx
- **Planned at**: commit `dbce0561`, 2026-07-13

## Why this matters

CI currently type-checks the backend and runs the **HTTP** integration
suite — nothing else. The jest config routes suites by `TEST_TYPE`, and the
`test:unit` / `test:integration:modules` scripts are defined but invoked by
no workflow, hook, or turbo task. That leaves ~90 spec files under
`backend/packages/api/src/**/__tests__/` — including the money specs
(`economy.unit.spec.ts`, `credit-balance.unit.spec.ts`, `topup.unit.spec.ts`,
`buyback-rate.unit.spec.ts`, `wallet-summary.spec.ts`,
`withdrawable.unit.spec.ts`) — green-but-never-run on every push/PR. A wrong
money computation that keeps its types passes CI. The admin SPA's vitest
suite (3 files) is likewise never executed by CI. Separately, the
`backend-quality` job rebuilds every package cold each run because the turbo
cache directory is never restored, despite turbo being fully configured for
caching.

After this plan: every backend test tier (unit, modules, http) and the admin
vitest suite gate CI, and backend CI reuses turbo's cache.

## Current state

Files:

- `.github/workflows/ci.yml` — jobs: `changes` (paths filter, output
  `backend`), `quality` (storefront), `backend-quality` (lint + check-types +
  build; yarn-berry cache only), `integration-http` (3-shard matrix with
  postgres/redis service containers), `gitleaks`. All actions pinned to full
  SHAs; least-privilege `permissions`; `concurrency` cancel-in-progress.
- `backend/packages/api/jest.config.js:28-34` — suite routing:

```js
if (process.env.TEST_TYPE === 'integration:http') {
  module.exports.testMatch = ['**/integration-tests/http/*.spec.[jt]s'];
} else if (process.env.TEST_TYPE === 'integration:modules') {
  module.exports.testMatch = ['**/src/modules/*/__tests__/**/*.[jt]s'];
} else if (process.env.TEST_TYPE === 'unit') {
  module.exports.testMatch = ['**/src/**/__tests__/**/*.unit.spec.[jt]s'];
}
```

- `backend/packages/api/package.json` scripts (verbatim):

```json
"test:integration:modules": "TEST_TYPE=integration:modules NODE_OPTIONS=--experimental-vm-modules jest --silent=false --runInBand --forceExit",
"test:unit": "TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules jest --silent --runInBand --forceExit"
```

- `backend/apps/admin/package.json` — has `"test": "vitest run"` (3 suites:
  `src/lib/format.test.ts`, `odds-rows.test.ts`, `query-keys.test.ts`).
  `@acme/api` has **no** plain `test` script (only the `test:*` variants) —
  so a turbo `test` task will pick up only the admin app. `backend/apps/vendor`
  — check it has no `test` script (expected; if it has one, see STOP).
- `backend/turbo.json` — tasks: `build` (with `outputs`), `lint`,
  `check-types`, `dev`. **No `test` task.**
- `backend/package.json` — root scripts map to turbo:
  `"check-types": "turbo run check-types"` etc.
- The `integration-http` job's shape to copy for the modules job
  (`ci.yml:149-240`): postgres:16 + redis:7 service containers, env
  `DATABASE_URL: postgres://postgres:postgres@localhost:5432/medusa-test`,
  `NODE_ENV: test`, DB\_\* overrides for `@medusajs/test-utils initDb`,
  corepack + node 22 + yarn cache, `corepack yarn install --immutable`, then
  `corepack yarn build --filter="@acme/api^..."` ("jest resolves
  @acme/odds-math via its dist/ entrypoint"), then the test script.
- The module suites use `moduleIntegrationTestRunner` (real DB, no full
  medusa app boot — lighter than the HTTP suites, which OOM'd at 66 suites
  and needed 3 shards). `jest.setTimeout(300 * 1000)` inside the specs.
- Turbo cache: turbo 2.x writes its local cache to `backend/.turbo/cache`.
  `ci.yml` has `actions/cache` steps only for `~/.yarn/berry/cache` (2×) and
  storefront `.next/cache`.

## Commands you will need

| Purpose                       | Command (working dir)                                                                              | Expected on success        |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------- |
| Start DB/Redis (local verify) | `docker start pokenic-postgres pokenic-redis`                                                      | both names printed         |
| Install                       | `corepack yarn install --immutable` (in `backend/`)                                                | exit 0                     |
| Build workspace deps          | `corepack yarn build --filter="@acme/api^..."` (in `backend/`)                                     | exit 0                     |
| Unit suites                   | `corepack yarn test:unit` (in `backend/packages/api`, Git Bash)                                    | all pass, exit 0           |
| Module suites                 | `corepack yarn test:integration:modules` (in `backend/packages/api`, Git Bash, containers running) | all pass, exit 0           |
| Admin suite                   | `corepack yarn test` (in `backend/apps/admin`)                                                     | 3 files pass               |
| Turbo test task               | `corepack yarn turbo run test` (in `backend/`)                                                     | runs @acme/admin#test only |
| Workflow lint (optional)      | `actionlint .github/workflows/ci.yml` if installed                                                 | no errors                  |

The `test:*` scripts use inline-env (`TEST_TYPE=...`) — Git Bash on Windows,
never PowerShell/cmd.

## Scope

**In scope** (the only files you should modify):

- `.github/workflows/ci.yml`
- `backend/turbo.json` (add `test` task)
- `backend/package.json` (add `"test": "turbo run test"` root script)
- `plans/README.md` — status row

**Out of scope** (do NOT touch):

- `backend/packages/api/jest.config.js` and the `test:*` scripts — they work; CI just never called them.
- `.github/workflows/e2e.yml` — nightly-only by documented design (see plans/README round-4 notes); per-PR E2E is a separate maintainer decision.
- `integration-tests/run-http-shards.mjs` and the HTTP shard matrix.
- Any test file. If a suite fails when first executed in CI, that failure is a _finding_ (report it), not something to patch here — see STOP conditions.
- The 15.5s real-timer sleep in `pack-open-rate-limit.spec.ts` (known backlog item, separate concern).

## Git workflow

- Branch: `advisor/027-ci-test-tiers`
- Conventional commits, e.g. `ci(backend): run unit + module + admin suites; restore turbo cache`
- Do NOT push or open a PR unless the operator instructed it. (Note: full CI proof requires a PR run; local verification below is the gate you can run yourself.)

## Steps

### Step 1: Add the turbo `test` task and root script

`backend/turbo.json` — add to `tasks`:

```json
"test": {
  "dependsOn": ["^build"]
}
```

(`^build` because vitest in the admin app may import workspace packages that
resolve via `dist/`.) `backend/package.json` — add script
`"test": "turbo run test"`.

**Verify**: `corepack yarn turbo run test` (in `backend/`, after install +
deps build) → exactly one package runs (`@acme/admin`), 3 test files pass.
If turbo reports "no tasks found", the task name/manifest is wrong — fix
before proceeding.

### Step 2: Run both new backend tiers locally to establish the baseline

With `pokenic-postgres`/`pokenic-redis` running, from
`backend/packages/api` (Git Bash):

1. `corepack yarn test:unit` → note the suite count and that all pass.
2. `corepack yarn test:integration:modules` → note the suite count, wall
   time, and that all pass.

Record both times in your report. If either tier fails **before any CI
change**, STOP — the plan assumed locally-green suites (they were green when
last run during rounds 2–4 execution).

### Step 3: Add the `backend-unit` job to ci.yml

New job after `backend-quality`, gated the same way
(`needs: changes`, `if: needs.changes.outputs.backend == 'true'`):

- `runs-on: ubuntu-latest`, `timeout-minutes: 15`
- Steps (copy the exact pinned action SHAs from the existing jobs in this
  file — do not unpin): checkout (persist-credentials false) → corepack
  enable → setup-node 22 → yarn berry cache (same key as `backend-quality`)
  → `corepack yarn install --immutable` (workdir `backend`) →
  `corepack yarn build --filter="@acme/api^..."` (workdir `backend`) →
  `corepack yarn test:unit` (workdir `backend/packages/api`) → a final step
  `corepack yarn turbo run test` (workdir `backend`) for the admin vitest
  suite.

No service containers — the unit tier and admin vitest need no DB.

**Verify**: the YAML parses — `node -e "const y=require('yaml'); y.parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8')); console.log('ok')"`
→ `ok` (install `yaml` transiently via `npm i --no-save yaml` at repo root
if absent, or use `actionlint` if available). Also `git diff` shows only the
new job.

### Step 4: Add the `integration-modules` job

Clone the `integration-http` job's structure (service containers, env block,
install, workspace-deps build) with these differences:

- name `integration-modules`; no `strategy.matrix` (single job, no shards);
  `timeout-minutes: 30`.
- Test step (workdir `backend/packages/api`):

```yaml
- name: Module integration tests
  run: |
    set -o pipefail
    corepack yarn test:integration:modules 2>&1 | tee modules-tests.log
```

- Keep the upload-log-on-failure step, renamed artifact
  (`modules-integration-log`).

**Verify**: YAML parse check as in Step 3.

### Step 5: Restore the turbo cache in `backend-quality`

In the `backend-quality` job, after the yarn cache step and before
`corepack yarn install`, add:

```yaml
- name: Cache turbo
  uses: actions/cache@<same pinned SHA as the other cache steps in this file>
  with:
    path: backend/.turbo
    key: turbo-${{ runner.os }}-${{ github.sha }}
    restore-keys: |
      turbo-${{ runner.os }}-
```

(`github.sha` in the key makes every run save a fresh entry; `restore-keys`
rehydrates the newest — same pattern the storefront `.next/cache` step in
this file already uses and documents. Turbo's own input hashing decides what
is actually reused, so a stale restore is safe.)

**Verify**: YAML parse check; `git diff .github/workflows/ci.yml` shows the
cache step inside `backend-quality` only.

### Step 6: Local end-to-end re-verification

Re-run the full local battery: Step 1's turbo test, Step 2's two tiers, plus
`corepack yarn check-types` and `corepack yarn build` (in `backend/`) to
prove the turbo.json edit broke nothing.

**Verify**: all exit 0.

## Test plan

This plan adds no test files — it wires existing suites into CI. The
verification is the local runs (Steps 1, 2, 6) plus the first PR run of the
modified workflow. In your completion report, list: unit suite count, module
suite count + wall time, admin vitest count — so the reviewer can sanity-check
the CI job durations against them.

## Done criteria

Machine-checkable; ALL must hold:

- [ ] `grep -n "test:unit\|test:integration:modules\|turbo run test" .github/workflows/ci.yml` → ≥3 matches (the two new jobs' steps)
- [ ] `grep -n '"test"' backend/turbo.json backend/package.json` → 1 match each
- [ ] YAML parse check on `ci.yml` passes
- [ ] `corepack yarn test:unit` (packages/api) exits 0 locally
- [ ] `corepack yarn test:integration:modules` (packages/api) exits 0 locally
- [ ] `corepack yarn turbo run test` (backend/) runs the admin suite, exits 0
- [ ] `corepack yarn check-types && corepack yarn build` (backend/) exit 0
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 2 finds an already-failing suite locally — report which; do not
  patch test files or source under this plan.
- The module tier exceeds ~25 minutes or dies with heap exhaustion
  ("Ineffective mark-compacts") locally. Report the wall time and suite
  count; the fallback design (sharding it like `run-http-shards.mjs`, or
  `NODE_OPTIONS=--max-old-space-size=6144`) is a scope expansion the
  reviewer must approve.
- `backend/apps/vendor/package.json` turns out to define a `test` script
  (turbo would start running an unvetted suite) — report before wiring.
- The pinned action SHAs in ci.yml have drifted from the excerpts (someone
  bumped actions since `dbce0561`) — reuse whatever SHA the file now pins,
  and note it.

## Maintenance notes

- The `changes` path filter gates all backend jobs on `backend/**` +
  `ci.yml` — the two new jobs inherit that; a storefront-only PR stays
  cheap.
- When plan 026 lands, its new `wallet-summary` case is automatically
  enforced by the `integration-modules` job — that pairing is the point of
  doing 026 and 027 in the same round.
- If the module tier grows past heap limits later, shard it the way
  `run-http-shards.mjs` documents (it exists precisely because of this
  failure mode at 66 HTTP suites).
- Reviewer scrutiny: pinned SHAs preserved; no `continue-on-error` anywhere;
  the unit job must NOT get service containers (keeping it fast is what
  makes it cheap to gate every PR).
