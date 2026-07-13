# Plan 033: Grandfather pre-1b deposits in the playthrough withdrawal gate

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md` — do
> not edit it.
>
> **Drift check (run first)**:
> `git diff --stat 38f7dbdd..HEAD -- backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/modules/packs/withdrawable.ts backend/packages/api/integration-tests/modules/wallet-summary.spec.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (money)
- **Planned at**: commit `38f7dbdd`, 2026-07-13

## Why this matters

The playthrough withdrawal gate (PR #140, basis fixed by plan 026) computes
`deposited` and `used` from **asymmetric columns**. `deposited` sums the
always-present `amount` column over every `topup` row in history; `used` sums
`-external_funded_cents` over `pack_open` rows — a column added 2026-06-21
with **no backfill** (NULL on older rows, which SQL `SUM` ignores). A customer
who deposited _and_ fully played through before 2026-06-21 therefore shows
`deposited > 0, used = 0` → `withdrawable = false` **forever**, even though
they satisfied the gate. Today this only mis-renders the wallet page; the day
the cash-out writer ships (direction item DIR-01), it becomes a permanent
cash-out lockout for grandfathered customers. This plan closes the asymmetry
by grandfathering pre-1b deposits: a `topup` row with a NULL
`external_funded_cents` (pre-1b era) no longer counts toward the playthrough
requirement.

Why grandfather instead of backfill: a correct backfill must replay each
customer's ledger chronologically to compute the running external balance
(the basis of each open's snapshot), and it must backfill topups and opens
_consistently_ or the running external balance
(`Σ external_funded_cents`) goes negative and corrupts _future_ opens'
playthrough banking. That is M–L effort with real risk on the money table.
Grandfathering is a one-filter change on the read side, touches no stored
data, and is the customer-favorable interpretation (pre-1b deposits are all
mock-gateway credits — no real PSP existed then).

## Current state

Files:

- `backend/packages/api/src/modules/packs/service.ts` — `walletSummary`
  (~line 2210–2260) computes the gate inputs in SQL.
- `backend/packages/api/src/modules/packs/withdrawable.ts` — the pure gate
  (`playthroughState`), fully unit-tested; documents the convention this plan
  extends.
- `backend/packages/api/src/modules/packs/migrations/Migration20260621120000.ts`
  — the 1b migration; its comment establishes the column semantics.
- `backend/packages/api/integration-tests/modules/wallet-summary.spec.ts` —
  module-tier spec for `walletSummary` (4 cases as of plan 026).

The `walletSummary` SQL as it exists today (`service.ts` ~2228-2234):

```ts
'SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS balance_cents, ' +
  "COALESCE(SUM(ROUND(amount * 100)) FILTER (WHERE reason = 'topup' AND amount > 0), 0)::bigint AS deposited_cents, " +
  "COALESCE(SUM(-external_funded_cents) FILTER (WHERE reason = 'pack_open'), 0)::bigint AS used_cents " +
  'FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL',
```

The migration's column semantics (`Migration20260621120000.ts:3-7`):

```
// Phase 1b — external-funded spend basis. Adds a signed integer-sen column to
// the credit ledger: top-up rows store +external_in, pack_open rows store the
// −external_consumed snapshot, buyback/adjustment store 0. NULL on existing
// rows (forward-only; read as 0).
```

Key consequence: **every post-1b `topup` row carries a non-NULL
`external_funded_cents`** (`+external_in`); only pre-1b rows are NULL. So
`external_funded_cents IS NOT NULL` is a precise "post-1b era" discriminator
on topup rows.

The gate contract (`withdrawable.ts:32-35`):

```ts
export function playthroughState(t: PlaythroughInput): PlaythroughState {
  const remainingCents = Math.max(0, t.depositedCents - t.usedCents);
  return { withdrawable: remainingCents === 0, remainingCents };
}
```

Repo conventions: integer sen (cents) SQL with `ROUND(amount * 100)`,
`FILTER (WHERE ...)` aggregate style as above; money specs live in
`integration-tests/modules/` and follow the arrange-act-assert style of
`wallet-summary.spec.ts` itself.

## Commands you will need

| Purpose                                     | Command (run in `backend/packages/api`)                                     | Expected on success                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Install (fresh worktree, run in `backend/`) | `corepack yarn install`                                                     | exit 0                                                                                   |
| Typecheck                                   | `corepack yarn check-types`                                                 | exit 0 (script pins `node node_modules/typescript/bin/tsc` — do not invoke bare `tsc`)   |
| Gate unit tests                             | `corepack yarn test:unit --testPathPattern="withdrawable"`                  | all pass                                                                                 |
| Wallet module spec                          | `corepack yarn test:integration:modules --testPathPattern="wallet-summary"` | all pass (needs Docker `pokenic-postgres`; see `backend/packages/api/README.md` runbook) |
| Money smoke subset                          | `corepack yarn test:integration:smoke`                                      | all suites pass                                                                          |

Fresh-worktree note: `corepack yarn install` from `backend/` first. The
integration tiers need the `pokenic-postgres` / `pokenic-redis` containers
(normally already running). If a DB-backed suite fails to connect, read the
runbook in `backend/packages/api/README.md` before anything else.

## Scope

**In scope** (the only files you should modify):

- `backend/packages/api/src/modules/packs/service.ts` — the `walletSummary`
  SQL and its adjacent comment only.
- `backend/packages/api/src/modules/packs/withdrawable.ts` — header docs only.
- `backend/packages/api/integration-tests/modules/wallet-summary.spec.ts` —
  new cases.

**Out of scope** (do NOT touch):

- `creditSummary` (`service.ts` ~550-575) — its `topup_cents` keeps the
  unfiltered definition; other consumers rely on it. Plan 038 builds on this
  distinction.
- Any migration or write path (`mutateCreditAtomic`, `settleOpen`, topup
  workflows) — this is a read-side change only.
- `integration-tests/modules/ledger-conservation.spec.ts` — it deliberately
  never pins `playthrough.used`/`deposited`; it must stay green **unmodified**.
- The storefront wallet page/schema.

## Git workflow

- Branch: `advisor/033-playthrough-pre1b-grandfather`
- Conventional commits, e.g.
  `fix(wallet): grandfather pre-1b deposits in the playthrough gate`
- Commit in the worktree. Do not push or open a PR — the reviewer integrates.

## Steps

### Step 1: Add the era filter to `deposited_cents`

In `service.ts` `walletSummary`, change the `deposited_cents` aggregate to:

```sql
COALESCE(SUM(ROUND(amount * 100)) FILTER (WHERE reason = 'topup' AND amount > 0 AND external_funded_cents IS NOT NULL), 0)::bigint AS deposited_cents,
```

Update the comment block directly above the query (it currently explains the
mirror-row convention) to add one sentence: pre-1b `topup` rows
(`external_funded_cents IS NULL`) are grandfathered — they predate the basis
column and never require playthrough.

**Verify**: `corepack yarn check-types` → exit 0.

### Step 2: Document the grandfather rule in `withdrawable.ts`

Extend the `PlaythroughInput.depositedCents` doc comment (currently
"Σ positive `topup` rows, in cents (lifetime deposits).") to:
"Σ positive `topup` rows **with a non-NULL external basis** (post-1b era),
in cents. Pre-1b deposits are grandfathered: they predate
`external_funded_cents` and never require playthrough (their opens' basis is
equally invisible to `usedCents`, so counting them would lock them forever)."

**Verify**: `corepack yarn test:unit --testPathPattern="withdrawable"` → all
pass (no behavior change in the pure gate).

### Step 3: Add the discriminating module-spec cases

In `wallet-summary.spec.ts`, add two cases (follow the existing cases'
fixture style — they create ledger rows and assert `walletSummary` output):

1. **"pre-1b topup does not count toward deposited"** — insert a `topup` row
   with `external_funded_cents` explicitly NULL/undefined (create the row via
   the module's row-creation seam used by the existing fixtures; if that seam
   always sets the basis, insert via a raw
   `em.execute('UPDATE credit_transaction SET external_funded_cents = NULL WHERE id = ?')`
   after creation) plus a normal post-1b topup + full playthrough of the
   post-1b amount. Assert: `deposited` equals only the post-1b amount,
   `withdrawable === true`.
2. **"legacy customer: pre-1b deposit alone is withdrawable-eligible"** — a
   customer with ONLY a NULL-basis topup row and no opens. Assert:
   `playthrough.deposited === 0`, `remaining === 0`, `withdrawable === true`.

**Verify**:
`corepack yarn test:integration:modules --testPathPattern="wallet-summary"`
→ all pass, including the 2 new cases (6 total expected).

### Step 4: Full money gate

**Verify**: `corepack yarn test:integration:smoke` → all suites pass
(the conservation spec must be green unmodified).

## Test plan

Covered by Step 3 (two discriminating cases in
`wallet-summary.spec.ts`, modeled on its existing four). No unit-tier change:
the pure gate math is untouched.

## Done criteria

- [ ] `corepack yarn check-types` exits 0
- [ ] `corepack yarn test:integration:modules --testPathPattern="wallet-summary"` passes with 2 new cases
- [ ] `corepack yarn test:integration:smoke` passes with `ledger-conservation.spec.ts` unmodified
- [ ] `grep -n "IS NOT NULL" backend/packages/api/src/modules/packs/service.ts` shows the new filter inside `walletSummary`'s `deposited_cents` aggregate
- [ ] `git status` shows no files outside the in-scope list

## STOP conditions

Stop and report back (do not improvise) if:

- The `walletSummary` SQL at `service.ts` ~2228 does not match the excerpt
  (drift — plan 038 may have landed first; report and let the reviewer
  re-sequence).
- You find any **post-1b** code path that writes a `topup` row with NULL
  `external_funded_cents` (that would make `IS NOT NULL` an incorrect era
  discriminator — the whole approach needs rethinking).
- You find a consumer of `walletSummary().deposited` other than the
  `/store/credits` route and its specs (the display-number change would leak
  somewhere unreviewed).
- `ledger-conservation.spec.ts` fails and the fix would require editing it.

## Maintenance notes

- **The future cash-out writer (DIR-01) inherits this rule**: recomputing the
  gate under the `credit:` lock must use the same filtered `deposited`.
- The wallet page's displayed "deposited" figure drops pre-1b deposits for
  grandfathered customers — intentional (those deposits carry no playthrough
  obligation), but a reviewer should sanity-check the wallet page copy still
  reads correctly.
- Plan 038 (single-scan fold) adds a playthrough-filtered column to
  `creditSummary`'s scan and threads it into `walletSummary`; it is written
  against the post-033 shape. Land 033 first.
- Deferred alternative (recorded, not chosen): chronological-replay backfill
  of `external_funded_cents` for pre-1b rows — only worth revisiting if
  product wants pre-1b deposits to _require_ playthrough after all.
