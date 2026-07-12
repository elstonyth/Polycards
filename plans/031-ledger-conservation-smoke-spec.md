# Plan 031: Add a cross-flow ledger-conservation integration spec to the money smoke subset

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat dbce0561..HEAD -- backend/packages/api/integration-tests/http backend/packages/api/package.json backend/packages/api/README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW (pure test addition)
- **Depends on**: none (plays best merged after plan 026 — see Maintenance notes)
- **Category**: tests
- **Planned at**: commit `dbce0561`, 2026-07-13

## Why this matters

PR #138 deleted the virtual-month sim harness (`scripts/sim/`), and with it
`ledger.mjs` — the only cross-cutting check the project ever had that the
credit economy **conserves money** across a live multi-step flow. What
survives is unit-level: `credit-summary.unit.spec.ts` proves the pure
fold conserves over hand-built rows, and each write path has its own
idempotency/locking specs — but nothing asserts that after a real
topup → open → buyback sequence, `Σ(ledger rows) == reported balance` and
the external-funded (deposit) basis adds up. That invariant is exactly what
catches the class of bug a future money-mover (the planned cashout writer —
see round-4 direction notes) could introduce. This plan restores the
assertion as one ordinary HTTP integration spec, added to the plan-025
smoke subset so it runs in CI's integration gate and in the local
`test:integration:smoke` loop. Deliberately NOT resurrected: the sim
harness, personas, or viewer — the maintainer removed those; this is one
invariant, not a simulation.

## Current state

- `backend/packages/api/integration-tests/http/` — 60+ suites using
  `medusaIntegrationTestRunner` (`inApp: true`). Exemplar to model on:
  `pack-open-charge.spec.ts` — seeds a publishable API key via the API-key
  module, creates a pack + single card ("Single-card pool → deterministic
  roll"), pins FX (`MANUAL_RATE`) in `beforeEach` for determinism, registers
  a customer over HTTP, tops up, opens, sells back, asserting exact RM
  amounts (constants at the top: `PACK_PRICE = 10`, `FMV = 50`,
  `MULTIPLIER = 1.2`, `MANUAL_RATE = 4.0`, buyback 96% → `230.4`).
- `backend/packages/api/package.json:29` — the smoke subset:

```json
"test:integration:smoke": "node integration-tests/run-http-shards.mjs economy.spec credit-topup.spec pack-open-charge.spec vault-buyback.spec mature-commissions.spec"
```

(passing filenames to `run-http-shards.mjs` = filtered single run, no
sharding).

- `backend/packages/api/README.md` — the plan-025 runbook; its smoke section
  says the subset is 5 suites.
- Service internals the spec can reach via `getContainer()` →
  `container.resolve<PacksModuleService>(PACKS_MODULE)`:
  - `listCreditTransactions({ customer_id }, ...)` — the raw ledger rows.
  - `creditSummary(customerId)` → `{ balance, topupTotal, spendTotal, externalFundedSpendTotal }`.
  - `walletSummary(customerId)` → `{ balance, available, locked, isFrozen, nextUnlock, withdrawable, playthrough }`.
- Ledger semantics (from `models/credit-transaction.ts`): `amount` is
  decimal RM; `external_funded_cents` is signed integer sen — topup rows
  `+`, pack_open rows `−` (deposit-funded portion only), everything else
  0/NULL.
- `GET /store/credits` returns `{ balance, topup_total, spend_total, transactions, wallet: {...} }`.

## Commands you will need

| Purpose        | Command (working dir)                                                                                | Expected on success |
| -------------- | ---------------------------------------------------------------------------------------------------- | ------------------- |
| Start DB/Redis | `docker start pokenic-postgres pokenic-redis`                                                        | both names printed  |
| Install + deps | `corepack yarn install --immutable && corepack yarn build --filter="@acme/api^..."` (in `backend/`)  | exit 0              |
| New spec only  | `corepack yarn test:integration:http ledger-conservation.spec` (in `backend/packages/api`, Git Bash) | all pass            |
| Smoke subset   | `corepack yarn test:integration:smoke` (in `backend/packages/api`, Git Bash)                         | 6 suites pass       |
| Typecheck      | `corepack yarn check-types` (in `backend/`)                                                          | exit 0              |

## Scope

**In scope** (the only files you should modify/create):

- `backend/packages/api/integration-tests/http/ledger-conservation.spec.ts` (create)
- `backend/packages/api/package.json` (append the spec to `test:integration:smoke`)
- `backend/packages/api/README.md` (smoke-count sentence: 5 → 6)
- `plans/README.md` — status row

**Out of scope** (do NOT touch):

- Any source file under `src/` — if an invariant assertion FAILS, that is a
  real bug you report, not something you fix here (STOP condition).
- The other smoke suites and `run-http-shards.mjs`.
- Re-creating anything under `scripts/sim/`.

## Git workflow

- Branch: `advisor/031-ledger-conservation`
- Conventional commit, e.g. `test(economy): cross-flow ledger-conservation invariant in the smoke subset`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Scaffold the spec from the exemplar

Create `ledger-conservation.spec.ts` by copying
`pack-open-charge.spec.ts`'s harness shape (jest timeout, runner call,
publishable-key setup, pack/card seeding with deterministic constants,
pinned FX, HTTP customer registration + auth headers). Keep the constants
economically simple, e.g. `PACK_PRICE = 10`, topup `100`.

**Verify**: `corepack yarn test:integration:http ledger-conservation.spec`
→ the copied skeleton runs (even with a trivial first assertion) and
passes.

### Step 2: Drive the flow and assert conservation after every hop

One `it('ledger conserves across topup → open → buyback', ...)` that after
**each** money step runs a shared `assertConserved(customerId)` helper
(defined in the spec file) which:

1. Loads all rows: `listCreditTransactions({ customer_id: customerId }, { take: 1000 })`.
2. Computes `sumRm = Σ Number(row.amount)` (round to 2dp with the same
   cent-math style the exemplar uses — sum in cents:
   `Σ Math.round(Number(row.amount) * 100)` then `/100`).
3. Asserts, with `toBeCloseTo(…, 2)`:
   - `sumRm === creditSummary(customerId).balance`
   - `sumRm === walletSummary(customerId).balance`
   - `GET /store/credits` `.balance` and `.wallet.balance` equal `sumRm`
     (the HTTP view agrees with the ledger).
   - `walletSummary.available === balance − locked` when not frozen, and
     `withdrawable ≤ available`.
4. External-basis conservation: `sumExt = Σ (row.external_funded_cents ?? 0)`
   satisfies `0 ≤ sumExt ≤ Σ external over topup rows`, and
   `creditSummary().externalFundedSpendTotal * 100 === Σ (−external) over pack_open rows`.

The flow: (a) register + assert conserved (empty ledger, balance 0);
(b) topup 100 (the exemplar shows the topup call incl. the mandatory
Idempotency-Key header — copy it) + assert; (c) open one pack + assert;
(d) instant-buyback the pull + assert; (e) final exact-value pin: balance
=== 100 − PACK_PRICE + buybackAmount (compute the constant the way the
exemplar's `INSTANT_AMOUNT` comment does, and assert
`playthrough.deposited === 100`).

Numbers note (for the exact-value pin): with the exemplar's constants, the
buyback credit is `FMV × MANUAL_RATE × MULTIPLIER × 96% = 230.4`; final
balance would be `100 − 10 + 230.4 = 320.4`. Recompute for whatever
constants you seed — show the arithmetic in a comment like the exemplar
does.

**Verify**: spec green. Then run it twice in a row → green both times
(idempotent seeding, no cross-run collisions — use unique customer emails
per run like the exemplar).

### Step 3: Wire into the smoke subset and runbook

1. `package.json:29`: append ` ledger-conservation.spec` to the smoke
   script's filter list.
2. `backend/packages/api/README.md`: update the smoke description (5 → 6
   suites; one line naming the new invariant).

**Verify**: `corepack yarn test:integration:smoke` → 6 suites, all green.
`corepack yarn check-types` → exit 0.

## Test plan

The plan IS a test. Cases covered: conservation on the empty ledger,
after external deposit, after debit (open), after non-deposit credit
(buyback), plus the external-basis inequality and the HTTP-vs-service
agreement. Pattern source: `pack-open-charge.spec.ts` (same file layout,
constants-with-arithmetic-comments style, `unwrapResponse` util).

## Done criteria

Machine-checkable; ALL must hold:

- [ ] `integration-tests/http/ledger-conservation.spec.ts` exists; contains ≥4 `assertConserved` call sites
- [ ] `grep -n "ledger-conservation.spec" backend/packages/api/package.json` → 1 match (smoke script)
- [ ] `corepack yarn test:integration:http ledger-conservation.spec` green twice
- [ ] `corepack yarn test:integration:smoke` → 6 suites green
- [ ] `corepack yarn check-types` exits 0
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any conservation assertion fails against the real flow — that is a live
  money bug; capture the ledger rows and the differing sums in your report
  and change NOTHING under `src/`.
- The topup endpoint's contract differs from the exemplar (e.g. the
  Idempotency-Key requirement changed) — re-read the exemplar's current
  form; if both drifted from this plan, re-baseline against
  `pack-open-charge.spec.ts` as the source of truth.
- The suite is flaky across the two required consecutive runs.

## Maintenance notes

- **Interaction with plan 026** (playthrough basis change): this spec's
  step (e) asserts `playthrough.deposited === 100`; it deliberately does
  NOT pin `playthrough.used` to a value that differs between the two bases
  (the open in this flow is deposit-funded, where both bases agree). It is
  therefore green before AND after 026 — safe to land in either order.
- **When the cashout writer lands** (direction DIR-01), extend
  `assertConserved` with the cashout leg: a `cashout` row must reduce
  balance and never drive `Σ ledger` negative, and
  `withdrawable` must be recomputed under the customer's `credit:` lock.
  This spec is where that assertion belongs.
- The `take: 1000` in the helper is fine for a 5-row test ledger; it is not
  a pattern for production reads.
