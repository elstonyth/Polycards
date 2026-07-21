# Plan 048: Make the two always-skipping E2E specs actually run in the nightly (card lifecycle + voucher claim)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b5944e26..HEAD -- tests/e2e/card-management.spec.ts tests/e2e/rewards.spec.ts backend/packages/api/src/scripts/seed-e2e-fixtures.ts .github/workflows/e2e.yml`
> On any change, compare the excerpts below; mismatch = STOP.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `b5944e26`, 2026-07-20

## Why this matters

Two E2E specs look like coverage but never run in CI:

1. `card-management.spec.ts` — the admin register→FMV-edit→marketplace→storefront-price-reflection lifecycle — skips unless an eligible product with handle `pw-test-card` exists. Nothing creates it in CI: `seed-e2e-fixtures.ts` doesn't mint it (grep confirms), the skip message points at a hand-run `create-test-product.ts`. The dependent eligibility re-check test then also skips (`lifecycleRan` stays false). The one admin-driven money-adjacent UI flow in the suite is permanently dark in the nightly.
2. `rewards.spec.ts` — the voucher-claim UI path — skips whenever the "coming soon" gate renders, and `e2e.yml` never sets `REWARDS_REDEMPTION_ENABLED`, so the gate always renders in CI. (The backend claim route IS covered by an integration spec with the flag on; this is the missing UI leg.)

Silent always-skip is worse than no test: it reads as coverage in every green run.

## Current state

- `tests/e2e/card-management.spec.ts:26-53`:
  ```ts
  const PRODUCT_TITLE = 'PW Test Eligible Card';
  const CARD_HANDLE = 'pw-test-card';
  const POOL_PACK = 'pokemon-rookie';
  ...
  let lifecycleRan = false;
  test.beforeAll(async () => {
    admin = await adminToken();
    await deleteCardIfExists(admin, CARD_HANDLE);
  });
  test('card lifecycle: ...', async ({ page }) => {
    const elig = await eligibleProducts(admin);
    test.skip(
      !elig.products.some((p) => p.handle === CARD_HANDLE),
      `No eligible product '${CARD_HANDLE}' — run create-test-product.ts first.`,
    );
    lifecycleRan = true;
  ```
- `tests/e2e/rewards.spec.ts:27-36`:
  ```ts
  const gated = await page
    .getByRole('button', { name: /coming soon/i })
    .first()
    .isVisible()
    .catch(() => false);
  test.skip(
    gated,
    'reward redemption disabled (REWARDS_REDEMPTION_ENABLED unset)',
  );
  ```
- `backend/packages/api/src/scripts/seed-e2e-fixtures.ts` — the idempotent nightly seed (`yarn seed:e2e` era, plan 023/039 lineage): creates the active packs (`pokemon-rookie`/`pokemon-elite`), cards, odds, FIRM FX rate. Contains NO `pw-test-card` and NO claimable reward grant. Extend this file — it is the designated home for CI fixtures.
- `backend/packages/api/src/scripts/create-test-product.ts` — the separate hand-run script that mints the eligible product (`HANDLE = "pw-test-card"` at :14, the sole definition of that handle in the repo) — read it and lift its product-minting logic into the seed (idempotently).
- `.github/workflows/e2e.yml` — job-level `env:` at ~line 65 (`DATABASE_URL`, `REDIS_URL`, deliberate no-NODE_ENV comment, mock-gateway opt-in). `grep REWARDS_REDEMPTION_ENABLED e2e.yml` → nothing. The backend start step (~line 151) launches `corepack yarn start` with `NODE_ENV: development`.
- Precedent for flag-on testing: `backend/packages/api/src/subscribers/__tests__/notify-feed-nonfatal.unit.spec.ts:129` drives `POST /store/rewards/claim/:grantId` with `REWARDS_REDEMPTION_ENABLED=true`.
- E2E conventions: specs read seeded slugs and use the seed-presence guard from plan 039 (`tests/e2e/helpers/`); nightly = `e2e.yml` (schedule + dispatch); local runs need the backend on :9000 + storefront standalone on :4000.

## Commands you will need

| Purpose                   | Command                                                                                                                                        | Expected                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Seed locally (idempotent) | `cd backend/packages/api && corepack yarn seed:e2e` (verify exact script name in `package.json` — plan text uses the plan-023 name)            | exit 0, fixtures present                          |
| List specs                | `npx playwright test --list` (repo root)                                                                                                       | includes both specs, no parse errors              |
| Run one spec locally      | `npx playwright test tests/e2e/card-management.spec.ts`                                                                                        | passes with the seeded product (needs live stack) |
| Backend typecheck         | `cd backend/packages/api && corepack yarn check-types`                                                                                         | exit 0                                            |
| Workflow lint             | YAML parses — `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/e2e.yml','utf8'))"` (js-yaml is in backend deps) | no error                                          |

## Scope

**In scope**:

- `backend/packages/api/src/scripts/seed-e2e-fixtures.ts` (add: pw-test-card eligible product; one claimable reward grant for the E2E customer path)
- `.github/workflows/e2e.yml` (add `REWARDS_REDEMPTION_ENABLED: 'true'` to the backend job/step env)
- `tests/e2e/card-management.spec.ts` / `tests/e2e/rewards.spec.ts` — ONLY to adjust skip messages/guards to the new reality (skip stays as a genuine data guard, not the permanent state)

**Out of scope**:

- Product code (routes, rewards gate) — no behavior changes.
- `playwright.config.ts`, other specs, `ci.yml`.
- Making these specs run per-PR — nightly-only cadence is a documented tradeoff.

## Git workflow

- Branch: `advisor/048-e2e-unskip`
- Commit: `test(e2e): seed pw-test-card + enable rewards flag so two dark specs run nightly`
- Do NOT push/PR unless instructed.
- NOTE (this machine): global formatter hook may churn backend quote style — check `git diff`.

## Steps

### Step 1: Read the hand-run product script and port it into the seed

Locate `create-test-product.ts` (or the current equivalent) under `backend/packages/api/src/scripts/`; port its "mint an eligible product with handle `pw-test-card`, title `PW Test Eligible Card`" logic into `seed-e2e-fixtures.ts`, idempotently (skip if the handle already exists — match the seed's existing upsert style). The product must satisfy `eligibleProducts()` (read that helper's backend route to confirm the eligibility predicate — typically: product exists, not yet card-registered).

IMPORTANT: `card-management.spec.ts`'s `beforeAll` deletes the CARD (`deleteCardIfExists`) so re-registration is possible — the seed must provide the PRODUCT, not a registered card. If the lifecycle test's cleanup deletes the product itself at the end, the seed re-creates it next run (CI DB is ephemeral anyway; local reruns rely on the seed's idempotency).

**Verify**: run the seed twice locally → exit 0 both times; `eligibleProducts` (via the admin API or the spec's helper) lists `pw-test-card` after a fresh seed.

### Step 2: Seed a claimable reward grant

Concrete recipe (resolved at plan-review time — do not re-derive from the claim-route spec, it exercises the route, not grant creation):

1. The grant-CREATION exemplar is `backend/packages/api/src/scripts/seed-reward-economy-demo.ts` — `rewards.spec.ts`'s own header documents it as the spec's precondition. The needed shape is a VIP **voucher** grant in `granted` status (the kind a level-progression mints).
2. The customer: `rewards.spec.ts` logs in as `test@polycards.app`, which is created by `seed.ts`'s SEED_DEMO path (`seed.ts:646-718`) via `deploy:init` — NOT by `seed-e2e-fixtures.ts`. FIRST verify the nightly actually gets that customer: check whether `e2e.yml`'s `deploy:init` step (~`:131`) runs with SEED_DEMO on (read `seed.ts` for the flag's default). If the customer is NOT seeded in CI, extend `seed-e2e-fixtures.ts` to create it (idempotent, same pattern as its other fixtures) BEFORE minting the grant — do not reach into `seed.ts`.
3. Port the minimal grant-minting call from `seed-reward-economy-demo.ts` into `seed-e2e-fixtures.ts`, targeted at that customer. Idempotent: skip if an unclaimed (`granted`) grant already exists for them.

**Verify**: seed twice → exit 0; exactly one unclaimed grant row exists for the customer (query via the admin API or psql).

### Step 3: Flip the flag in e2e.yml

Add `REWARDS_REDEMPTION_ENABLED: 'true'` to the backend job env (the job-level `env:` block at ~65 is simplest — it only affects this workflow's ephemeral stack). Add a one-line comment in the file's commented style: rewards UI specs need the gate open; prod default stays off.

**Verify**: YAML parse command → no error; `grep -n "REWARDS_REDEMPTION_ENABLED" .github/workflows/e2e.yml` → 1 hit in env.

### Step 4: Retune the skip guards

- `card-management.spec.ts`: change the skip message to name the seed (`seed-e2e-fixtures.ts`) instead of the hand-run script.
- `rewards.spec.ts`: keep the `gated` skip (still correct locally when the flag is off) but update its message to say the nightly sets the flag; keep `!hasClaimable` as a genuine data guard.

**Verify**: `npx playwright test --list` → both specs listed; no syntax errors.

### Step 5: Local end-to-end proof (if a local stack is feasible)

With backend + storefront running and the seed applied, run both specs; both must PASS (not skip). If a full local stack is not feasible in your environment, run what you can, state exactly what was and wasn't exercised, and flag that the first nightly run is the final proof — do not claim it.

**Verify**: spec output shows `passed` (not `skipped`) for the lifecycle test and the rewards claim path — or an explicit report caveat.

## Test plan

The deliverable IS test enablement. Success = the two specs execute and pass. Regression risk: the seed must not break existing specs that count seeded entities — re-run `npx playwright test --list` and, if a local stack exists, the seed-dependent specs (`slot-vault-room`, notifications fixture specs).

## Done criteria

- [ ] Seed is idempotent (two consecutive runs exit 0) and creates `pw-test-card` + one claimable grant
- [ ] `e2e.yml` sets `REWARDS_REDEMPTION_ENABLED: 'true'`; YAML parses
- [ ] Both specs list; skip guards reference the new reality
- [ ] Local pass proof or an explicit "verify on first nightly" caveat in the report
- [ ] `corepack yarn check-types` (api) exits 0
- [ ] No files outside scope modified (`git status`)
- [ ] `plans/README.md` updated

## STOP conditions

- `create-test-product.ts` doesn't exist and no equivalent minting logic is findable — report; do not invent an eligibility shape from guesswork.
- The eligibility predicate requires entities the seed can't create idempotently (e.g. a seller context that collides) — report the actual constraint.
- Turning the flag on makes OTHER e2e specs fail (a spec may assert the "coming soon" gate) — grep `coming soon` across tests/e2e first; if a conflict exists, report rather than half-fixing.
- The rewards spec's fixture customer doesn't exist in the seed — report which customer it expects.

## Maintenance notes

- When the rewards economy launches for real (DIR-C), the flag-on nightly becomes the pre-launch regression net — keep it.
- The first nightly after merge is the real proof — whoever merges should check both specs show `passed`, not `skipped`, in that run's report.
- Deferred: per-PR E2E smoke remains a maintainer call (documented tradeoff, round 4).
