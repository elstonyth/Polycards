# Plan 038: Fold the redundant second ledger scan out of /store/credits

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Your reviewer
> maintains `plans/README.md` — do not edit it.
>
> **Drift check (run first)**:
> `git diff --stat 38f7dbdd..HEAD -- backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/api/store/credits/route.ts`
> On any change, compare "Current state" against live code before proceeding.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plan 033 (033 changes the `walletSummary` `deposited_cents`
  filter; this plan threads that same filtered value from a shared scan — land
  033 first so the playthrough basis is settled before it's threaded).
- **Category**: perf
- **Planned at**: commit `38f7dbdd`, 2026-07-13

## Why this matters

`GET /store/credits` runs `creditSummary(customerId)` and
`walletSummary(customerId)` for the same customer in one `Promise.all`. Each
issues a **full scan of that customer's append-only credit ledger**
(`SELECT SUM(...) FROM credit_transaction WHERE customer_id = ? AND deleted_at
IS NULL`). `walletSummary`'s three sums are a **strict subset** of
`creditSummary`'s: `balance == balance`, `deposited == topupTotal` (both
`topup AND amount>0`), and `used == externalFundedSpendTotal` (both
`pack_open, -external_funded_cents`). So every wallet-page load scans the full
ledger twice where once suffices, and the cost scales with per-customer ledger
size (unbounded). Round 4 deferred this "pending MikroORM shared-manager
concurrency verification" — but that concern **does not apply**: the fix
threads three already-computed scalars into `walletSummary`, no shared entity
manager, no concurrent-query question. `walletSummary` has exactly one caller.

## Current state

`creditSummary` (`service.ts` ~550-575) returns
`{ balance, topupTotal, spendTotal, externalFundedSpendTotal }` from one scan:

```ts
'SELECT ' +
  '  COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS balance_cents, ' +
  "  COALESCE(SUM(CASE WHEN reason = 'topup' AND amount > 0 THEN ROUND(amount * 100) ELSE 0 END), 0)::bigint AS topup_cents, " +
  '  COALESCE(SUM(CASE WHEN amount < 0 THEN ROUND(-amount * 100) ELSE 0 END), 0)::bigint AS spend_cents, ' +
  "  COALESCE(SUM(CASE WHEN reason = 'pack_open' THEN -external_funded_cents ELSE 0 END), 0)::bigint AS ext_spend_cents " +
  'FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL',
```

`walletSummary` (`service.ts` ~2222-2260) runs its **own** scan for
`balance_cents` / `deposited_cents` / `used_cents`, then separately queries
`lockedCommissionCents` and `nextUnlock` (these are NOT in `creditSummary` and
must stay). It feeds `deposited`/`used` through `playthroughState`
(`withdrawable.ts`).

**IMPORTANT — post-033 shape**: after plan 033 lands, `walletSummary`'s
`deposited_cents` carries an extra filter
`AND external_funded_cents IS NOT NULL` (grandfathering pre-1b deposits) that
`creditSummary`'s `topup_cents` does **not** have. So the two "deposited"
numbers legitimately differ. This plan must **not** silently unify them — see
Step 1.

`credits/route.ts` (~15-30):

```ts
const [summary, transactions, wallet] = await Promise.all([
  packs.creditSummary(customerId),
  packs.listCreditTransactions(...),
  packs.walletSummary(customerId),
]);
```

Parity spec: `integration-tests/http/store-credits.spec.ts` asserts the lean
balance route matches the full route's `balance` — keep it green.

## Commands you will need

| Purpose            | Command (in `backend/packages/api`)                                         | Expected             |
| ------------------ | --------------------------------------------------------------------------- | -------------------- |
| Install            | `corepack yarn install` (in `backend/`)                                     | exit 0               |
| Typecheck          | `corepack yarn check-types`                                                 | exit 0               |
| Credits HTTP spec  | `corepack yarn test:integration:http --testPathPattern="store-credits"`     | all pass (Docker DB) |
| Wallet module spec | `corepack yarn test:integration:modules --testPathPattern="wallet-summary"` | all pass             |
| Money smoke        | `corepack yarn test:integration:smoke`                                      | all pass             |

## Scope

**In scope**:

- `backend/packages/api/src/modules/packs/service.ts` — give `walletSummary`
  an optional pre-computed-inputs path; keep its lockedCommission/nextUnlock
  queries.
- `backend/packages/api/src/api/store/credits/route.ts` — pass the shared
  scalars.
- `integration-tests/modules/wallet-summary.spec.ts` — keep passing; adjust
  only if the signature change requires it (the direct-call cases must still
  work with no pre-computed inputs).

**Out of scope**:

- `creditSummary` internals — unchanged.
- The lean `GET /store/credits/balance` route — unchanged (already 1 scan).
- The `deposited` grandfather filter's semantics — plan 033 owns that; do not
  alter it, just thread it correctly (see Step 1).

## Git workflow

- Branch: `advisor/038-credits-single-ledger-scan`
- Commit: `perf(credits): compute the ledger scan once per wallet request`
- Do not push or open a PR.

## Steps

### Step 1: Decide the threading shape (read before coding)

`walletSummary` needs `balance`, `deposited` (playthrough-filtered), and
`used`. `creditSummary` gives `balance`, `topupTotal` (NOT
playthrough-filtered post-033), and `externalFundedSpendTotal` (== used).

So `balance` and `used` are directly reusable; **`deposited` is NOT** — the
grandfather filter makes `walletSummary.deposited ≠ creditSummary.topupTotal`.
Two correct options — **choose (A)**:

- **(A) Add a fourth scalar to `creditSummary`'s scan**: a
  `deposited_playthrough_cents` column with the same
  `FILTER (WHERE reason='topup' AND amount>0 AND external_funded_cents IS NOT
NULL)` that 033 put on `walletSummary`. Then `creditSummary` computes all
  four in its single scan and `walletSummary` reuses them. This keeps the
  playthrough basis defined in exactly one SQL place going forward.
- (B) Thread only `balance` + `used` and let `walletSummary` run a _narrow_
  query for just `deposited_playthrough_cents` — still 2 scans. Rejected: it
  doesn't remove the second scan.

Go with **(A)**. If (A) turns out to require exposing the new scalar on
`creditSummary`'s public return type in a way that ripples to other callers,
STOP and report (the reviewer may prefer B).

### Step 2: Extend creditSummary's scan + return

Add `deposited_playthrough_cents` to `creditSummary`'s SELECT (the filtered
topup sum), and add `depositedPlaythroughTotal` (in MYR/number, matching the
others) to its return object and type. Existing callers ignore the new field
(additive).

**Verify**: `corepack yarn check-types` → exit 0.

### Step 3: Give walletSummary a pre-computed-inputs path

Change `walletSummary(customerId)` to
`walletSummary(customerId, precomputed?: { balance; depositedCents; usedCents })`.
When `precomputed` is supplied, **skip** the balance/deposited/used scan and
use those values; always still run the lockedCommission/nextUnlock queries.
When omitted, behave exactly as today (direct callers and the module spec keep
working). Convert MYR↔cents consistently with the existing code (the existing
scan yields `*_cents` bigints → `/100`; match whatever unit `precomputed`
carries and document it).

**Verify**: `corepack yarn check-types` → exit 0;
`corepack yarn test:integration:modules --testPathPattern="wallet-summary"`
→ all pass (the no-arg path is unchanged).

### Step 4: Pass the shared scalars from the route

In `credits/route.ts`, compute `creditSummary` first (or restructure the
`Promise.all` so `walletSummary` receives the scalars). Pass
`{ balance: summary.balance, depositedCents: Math.round(summary.depositedPlaythroughTotal*100), usedCents: Math.round(summary.externalFundedSpendTotal*100) }`
(match the exact unit `walletSummary` expects). The route's response shape must
not change.

**Verify**:
`corepack yarn test:integration:http --testPathPattern="store-credits"` →
all pass (parity + response-shape unchanged);
`corepack yarn test:integration:smoke` → all pass.

## Test plan

- The existing `store-credits` HTTP spec (response shape + lean/full balance
  parity) and `wallet-summary` module spec are the regression net — both must
  stay green with no assertion changes (proving the refactor is behavior-
  preserving). Add one module-spec case asserting `walletSummary` with
  `precomputed` inputs returns the same object as the no-arg call for the same
  seeded ledger (proves the two paths agree).
- Verification: the commands in Steps 3-4.

## Done criteria

- [ ] `corepack yarn check-types` exits 0
- [ ] `store-credits` HTTP spec passes unchanged (response shape identical)
- [ ] `wallet-summary` module spec passes, incl. the new both-paths-agree case
- [ ] `corepack yarn test:integration:smoke` passes
- [ ] The `/store/credits` route issues the ledger scan **once**
      (`creditSummary`), not twice — confirm by reading that `walletSummary`
      no longer runs its own balance/deposited/used SELECT when called from the
      route
- [ ] `git status` shows no files outside scope

## STOP conditions

- Plan 033 has NOT landed (the `walletSummary.deposited` filter isn't present)
  — this plan threads a value 033 defines; report and let the reviewer
  sequence 033 first.
- `walletSummary` turns out to have more than one caller (grep
  `walletSummary` across `backend/`) whose contract the signature change
  breaks.
- Option (A) ripples `creditSummary`'s return type into callers that would
  break — fall back to reporting, not to option (B) unilaterally.

## Maintenance notes

- After this lands, the playthrough-`deposited` filter lives in exactly one
  SQL query (`creditSummary`), and `walletSummary` reuses it — a reviewer
  should confirm no third place recomputes it.
- If a future caller needs `walletSummary` standalone at high frequency, the
  no-arg scan path still exists — fine, it's the same query as before.
- The deferred "overlapping-scan merge" backlog item from round 4 is resolved
  by this plan; the "MikroORM shared-manager concurrency" concern was moot
  (no shared manager involved).
