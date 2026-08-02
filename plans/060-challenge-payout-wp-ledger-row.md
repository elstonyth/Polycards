# Plan 060: Write the WP transaction-ledger row when a challenge winner is settled

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a993f34a..HEAD -- backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/modules/packs/ledger.ts backend/packages/api/src/api/admin/ledger/route.ts backend/packages/api/src/modules/packs/__tests__/challenge-settle.integration.spec.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (coordinate with plan 059 only if run concurrently — 059 step 6 touches `settle-challenge-week.ts`, a different file)
- **Category**: bug (money-record integrity)
- **Planned at**: commit `a993f34a`, 2026-08-01

## Why this matters

The admin Transactions ledger (POLYCARD-BACK §5, the operator's money-movement
record of truth) defines a `WP` (weekly-challenge payout) entry type end to end
— type union, model enum, DB CHECK, admin filter — but **nothing writes it**.
PR #296's settlement job mints winner credits via `mutateCreditAtomic` directly,
so every challenge payout moves real balance while the ledger the operator
reconciles against shows nothing. The gap is invisible: `WP` is an offered
filter that returns an empty list. The route's own comment still claims "no
challenge-settlement job exists" — false since #296 shipped in the same delta.

## Current state

- `backend/packages/api/src/modules/packs/ledger.ts:15` — `export type LedgerType = 'TP' | 'SP' | 'SE' | 'OD' | 'RF' | 'AD' | 'WP';`
- `backend/packages/api/src/modules/packs/ledger.ts:24` — the WP payload variant:
  `| { type: 'WP'; period: string; stage: number; rank: number; sku: string | null; value: number };`
- `backend/packages/api/src/modules/packs/service.ts` — `settleChallengeWinner`
  (`@InjectTransactionManager`, one winner per short transaction; the region
  starts near line 6069). It takes the per-customer advisory lock
  (`credit:<customerId>`, same keyspace as `mutateCreditAtomic`), re-checks
  `challenge_payout` under the lock, then:
  - **3a) credits** (~line 6161): `await this.mutateCreditAtomic({ customerId, amount: payout.credits, reason: 'reward_credit', idempotencyReference: \`challenge:${weekStartIso}:${customerId}\` }, sharedContext)`
  - **3b) cards**: dedupes `payout.cardIds` into `(id, qty)`, stock-gates, and
    mints pulls via `this.createPulls(..., sharedContext)` with
    `pack_id: \`challenge-${weekStartIso.slice(0, 10)}\``, `source: 'reward'`.
- `recordLedgerEntry` is defined at `service.ts:4176` (`@InjectTransactionManager`),
  idempotent on `(type, ref_id)`, and its header (`service.ts:4135-4174`)
  requires the caller to already hold the customer's `credit:` advisory lock in
  the same transaction ("path 1") — which `settleChallengeWinner` does.
  Existing writers for the other types: `service.ts:1025` (TP), `1782`, `2719`
  (OD), `3999`, `4065` (SP/AD area), `4115` (SE). Read one (e.g. the SE call at
  `4115`) as the shape exemplar before writing the WP call.
- `backend/packages/api/src/api/admin/ledger/route.ts:72-75` — stale comment:
  "RF and WP are offered as filters but no writer produces them yet (no
  referral-payout or challenge-settlement job exists, and Epic 6 is
  cancelled), so those two return zero rows."
- Existing settlement coverage to extend:
  `backend/packages/api/src/modules/packs/__tests__/challenge-settle.integration.spec.ts`
  (522 lines; runs in the `integration:modules` tier per
  `backend/packages/api/jest.config.js`).
- Vocabulary (CONTEXT.md / plan 058 §5): ledger entries are "go-forward only
  (D4, no backfill)" — do NOT backfill WP rows for weeks settled before this
  change.

## Commands you will need

| Purpose                                                              | Command                                                                                 | Expected on success |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------- |
| Backend typecheck                                                    | `cd backend && corepack yarn check-types`                                               | exit 0              |
| Settlement spec (needs `pokenic-postgres`/`pokenic-redis` docker up) | `cd backend/packages/api && corepack yarn test:integration:modules -- challenge-settle` | all pass            |
| Ledger service spec                                                  | `cd backend/packages/api && corepack yarn test:integration:modules -- ledger-service`   | all pass            |
| Unit tier                                                            | `cd backend/packages/api && corepack yarn test:unit`                                    | all pass            |

## Scope

**In scope**:

- `backend/packages/api/src/modules/packs/service.ts` (ONLY inside `settleChallengeWinner`)
- `backend/packages/api/src/api/admin/ledger/route.ts` (comment only)
- `backend/packages/api/src/modules/packs/__tests__/challenge-settle.integration.spec.ts` (add cases)

**Out of scope**:

- `mutateCreditAtomic` itself — do not add ledger writes inside it; the
  `*WithLedger` wrapper pattern deliberately keeps the primitives separate.
- The `RF` (referral payout) type — Epic 6 is cancelled; RF stays writerless.
- Backfilling WP rows for already-settled weeks (D4: go-forward only).
- `jobs/settle-challenge-week.ts` (plan 059 step 6 may touch it).
- Any admin-UI change (the Transactions page already renders by type).

## Git workflow

- Branch: `advisor/060-wp-ledger-row`
- Conventional commits, e.g. `fix(ledger): record WP entries when challenge winners settle`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the WP row inside the winner transaction

In `settleChallengeWinner`, after the credits mutation (3a) and the card
minting (3b) have both resolved but BEFORE `createChallengePayouts` writes the
payout rows, add one `recordLedgerEntry` call in the same `sharedContext`:

- `type: 'WP'`
- `ref_id`: `challenge:<weekStartIso>:<customerId>` — the same reference the
  credits mutation uses, so retries/replays dedupe on the existing
  `(type, ref_id)` idempotency.
- `customer_id: customerId`
- wallet delta: `payout.credits` (0 when the rank pays cards only — still
  write the row; the ledger records the settlement event, and the payload
  carries the card value).
- payload (the `WP` variant from `ledger.ts:24`): `period` = the ISO week-start
  (`weekStartIso`), `stage`/`rank` from the winner input, `sku` = the first
  granted card handle or `null`, `value` = summed granted-card FMV if the
  snapshot carries it, else `0`. Match the exact field mapping conventions of
  the SE writer at `service.ts:4115` (read it first; field names on
  `recordLedgerEntry`'s input are authoritative over this plan's prose).

Decision recorded here so you don't have to make it: **one WP row per settled
winner** (not per card) — rank rewards are one settlement event; the payout
detail lives in `challenge_payout` rows.

**Verify**: `cd backend && corepack yarn check-types` → exit 0.

### Step 2: Correct the stale route comment

In `backend/packages/api/src/api/admin/ledger/route.ts:72-75`, rewrite the
comment: WP is written by `settleChallengeWinner` since this change; only RF
remains writerless (Epic 6 cancelled).

**Verify**: `grep -n "challenge-settlement job exists" backend/packages/api/src/api/admin/ledger/route.ts` → no matches.

### Step 3: Extend the settlement spec

In `challenge-settle.integration.spec.ts`, add:

1. Settling a winner with credits writes exactly one `WP` ledger row with
   `ref_id = challenge:<week>:<customer>` and the credited amount.
2. Re-running settlement for the same week (idempotent replay) does NOT write
   a second WP row.
3. A card-only rank (credits = 0) still writes its WP row.

Model the assertions on the existing WP fixture usage in
`__tests__/ledger-service.integration.spec.ts:81-83` (it already constructs
WP payloads — reuse its field shape).

**Verify**: `cd backend/packages/api && corepack yarn test:integration:modules -- challenge-settle` → all pass, including 3 new cases. Then the full `test:unit` tier → passes.

## Test plan

Covered by Step 3 (three new integration cases: written-once, replay-deduped,
card-only). Pattern file: `challenge-settle.integration.spec.ts` itself (its
existing "frozen-snapshot replay after an injected mid-batch crash" case shows
how to drive `settleChallengeWeek` twice).

## Done criteria

- [ ] `grep -n "type: 'WP'" backend/packages/api/src/modules/packs/service.ts` → at least one match inside `settleChallengeWinner`
- [ ] `cd backend && corepack yarn check-types` exit 0
- [ ] `corepack yarn test:integration:modules -- challenge-settle` all pass (3 new cases present)
- [ ] `corepack yarn test:integration:modules -- ledger-service` still passes
- [ ] Stale comment gone (Step 2 grep)
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `recordLedgerEntry`'s input shape has no field for one of the WP payload
  values this plan names — report the actual signature instead of inventing a
  mapping.
- The settlement spec cannot construct a card-value for `value` without new
  plumbing — write `value: 0` and note it, do NOT thread new data through the
  job input.
- Adding the call makes the winner transaction fail the existing crash-replay
  spec case — the idempotency interaction is then subtler than planned.

## Maintenance notes

- If a cash-out writer lands (direction item DIR-A), it must use the same
  pattern: ledger row inside the same locked transaction as the credit
  mutation, shared idempotency reference.
- Card grants minted by settlement still have no `vault_delta`-style ledger
  representation beyond the WP payload's `value` field — deliberate for now;
  revisit if the operator reconciles vault value against the ledger.
- Reviewer scrutiny: the WP write must be INSIDE the per-winner transaction
  (before `createChallengePayouts`), never after commit.
