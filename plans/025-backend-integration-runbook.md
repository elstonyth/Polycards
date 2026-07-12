# Plan 025: One-command local runbook + smoke subset for the backend integration suites

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat e9ce6968..HEAD -- backend/packages/api/README.md backend/packages/api/package.json backend/packages/api/integration-tests/run-http-shards.mjs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S–M
- **Risk**: LOW — docs plus one additive npm script; no test or product code
  changes.
- **Depends on**: none (pairs well with plan 020's README work)
- **Category**: dx / tests
- **Planned at**: commit `e9ce6968`, 2026-07-12

## Why this matters

The backend's money-path guarantees live almost entirely in the HTTP
integration layer (66 suites), and CI runs them (3-shard job with service
containers). **Locally**, though, there is no documented path from "fresh
clone" to "integration tests pass": the suites need a live Postgres + Redis
and specific env, none of which `backend/packages/api/README.md` explains.
An agent or contributor making a risky backend change today can run
build + unit tests, but the layer that actually guards the money loop is
effectively CI-only for them — slow feedback and blind local iteration. A
documented prerequisites section plus a named "smoke" subset (the 3–4 suites
that exercise the credit/open/buyback core) gives executors a fast local
"does the money loop still work?" command.

## Current state

All verified 2026-07-12.

- `backend/packages/api/package.json` scripts:
  `test:integration:http` → `node integration-tests/run-http-shards.mjs`;
  `test:integration:modules`; `test:unit`. No smoke subset.
- `backend/packages/api/integration-tests/run-http-shards.mjs` (header
  verified): 66 suites each boot a full Medusa app via
  `medusaIntegrationTestRunner`; a single `--runInBand` process OOMs node's
  ~4GB heap, so the runner splits into `SHARDS = 3` sequential shards.
  **Filtered runs bypass sharding**: `corepack yarn test:integration:http
economy.spec …` → "filtered single run (no sharding)". This is the
  mechanism the smoke script will use.
- The suites' infra: the Medusa test runner creates/drops per-suite databases
  on a local Postgres; at least one suite (`rate-limit-redis-store.spec.ts`)
  requires a real Redis; helper `integration-tests/http/utils.ts` mints a
  super-admin. Local convention containers: `pokenic-postgres` /
  `pokenic-redis` (started via `docker start …`; created per the root README
  after plan 020, or `scripts/sim/provision.mjs`).
- `backend/packages/api/README.md` exists but does not document any of the
  above (confirm on read; if it now does, STOP — drifted).
- CI reference: `.github/workflows/ci.yml` `integration-http` job (3-shard
  matrix, service containers) — the CI-side truth for required services/env;
  read it to extract the exact env vars/DB URL shape CI passes, and mirror
  those in the docs.

## Commands you will need

| Purpose            | Command                                                                       | Expected on success       |
| ------------------ | ----------------------------------------------------------------------------- | ------------------------- |
| Start infra        | `docker start pokenic-postgres pokenic-redis`                                 | both containers running   |
| Filtered suite run | `cd backend/packages/api && corepack yarn test:integration:http economy.spec` | suite passes, no sharding |
| New smoke script   | `cd backend/packages/api && corepack yarn test:integration:smoke`             | the named suites pass     |

## Scope

**In scope** (the only files you should modify):

- `backend/packages/api/README.md` — new "Running the integration tests
  locally" section.
- `backend/packages/api/package.json` — one additive script:
  `test:integration:smoke`.
- Root `README.md` — ONE pointer line in the backend section linking to the
  new docs (only if plan 020 has landed; otherwise skip and note it).

**Out of scope** (do NOT touch, even though they look related):

- `run-http-shards.mjs`, `jest.config.js`, any spec file — no behavior
  changes.
- `.github/workflows/ci.yml` — CI already covers the full matrix.
- docker-compose files — container creation is documented, not automated,
  here (see Maintenance notes for the deferred compose profile).

## Git workflow

- Branch: `advisor/025-backend-integration-runbook`
- Commit style: conventional commits, e.g. `docs(api): local integration-test runbook + smoke subset script`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract the real prerequisites

Read (read-only): `.github/workflows/ci.yml` `integration-http` job (services,
env vars), `backend/packages/api/jest.config.js`, and
`integration-tests/http/utils.ts` — list exactly which env vars and services a
local run needs (DB URL/credentials shape, Redis URL, any seeded admin
credentials the utils mint themselves).

**Verify**: you can state, in the docs you're about to write, every env var by
NAME (never paste values from any local `.env`; a guard-secrets hook blocks
shell reads of `.env*` files — use Read if you must inspect a template, and
reference variable names only).

### Step 2: Prove the happy path once

With `pokenic-postgres`/`pokenic-redis` running, execute ONE filtered suite:
`corepack yarn test:integration:http economy.spec`.

**Verify**: exit 0. If it fails on infra, fix your env per Step 1 findings —
if it fails on a test assertion, STOP (report; the baseline is broken).

### Step 3: Pick and wire the smoke subset

Add to `backend/packages/api/package.json`:

```json
"test:integration:smoke": "node integration-tests/run-http-shards.mjs economy.spec credit-topup.spec pack-open-charge.spec buyback"
```

Before committing the exact list: `ls integration-tests/http/` and choose the
3–4 suites that cover (a) credit ledger/economy invariants, (b) top-up,
(c) pack-open charge, (d) buyback. Use the real filenames (the names above are
the expected ones — confirm; substitute the closest match if a name differs,
and say so in your report). The filtered-run mode of the shard runner accepts
multiple patterns (verify by reading its argv handling; if it accepts only
one pattern, chain via `&&` jest filters instead — read before wiring).

**Verify**: `corepack yarn test:integration:smoke` → all selected suites run
and pass, in a single non-sharded process, in a few minutes.

### Step 4: Write the runbook section

In `backend/packages/api/README.md`, add "## Running the integration tests
locally": prerequisites (containers + start command + creation pointer), env
var names and where they come from, the three commands (full sharded run,
filtered single suite, smoke), the OOM/shard explanation in one sentence
(link `run-http-shards.mjs`), and the note that the Medusa runner
creates/drops its own per-suite DBs (so the dev DB is safe).

**Verify**: another agent following ONLY the new section (fresh shell) can run
the smoke command successfully — re-run `corepack yarn test:integration:smoke`
from a clean shell using only documented steps → exit 0.

## Test plan

The smoke script's green run IS the test. No new specs.

## Done criteria

- [ ] `backend/packages/api/README.md` has the runbook section with named
      env vars and all three commands
- [ ] `corepack yarn test:integration:smoke` exits 0 locally
- [ ] The smoke list covers economy/topup/open/buyback (4 suites max)
- [ ] No spec/runner/CI files modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The filtered single-suite run in Step 2 fails on ASSERTIONS with correct
  infra (baseline broken — report which suite).
- The shard runner's filtered mode can't express a multi-suite subset and the
  jest-level alternative requires config changes (out of scope).
- Local Postgres/Redis containers don't exist and `scripts/sim/provision.mjs`
  doesn't create them as documented (report what it actually does).
- The README already documents this (drift — someone got there first).

## Maintenance notes

- Deferred deliberately: a `docker compose` test profile that creates
  postgres+redis from zero (nice-to-have; the named-container convention is
  entrenched in `preview.ps1`/provision scripts — changing it is a separate
  decision).
- When new money-path suites land (e.g. plan 021's
  `mature-commissions.spec.ts`), consider adding them to the smoke list —
  keep it under ~5 suites or it stops being smoke.
- This runbook is what makes plans 021/022 (and future backend plans) locally
  verifiable by executor agents — keep it accurate when the runner changes.
