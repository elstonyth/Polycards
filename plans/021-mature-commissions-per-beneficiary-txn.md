# Plan 021: Run the commission-maturity job one transaction per beneficiary

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat e9ce6968..HEAD -- backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/jobs/mature-commissions.ts`
> If either file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (behavior per beneficiary unchanged; the flip is
  cosmetic/audit — the spendable-balance gate is read-time)
- **Depends on**: none (see Coordination note for a merge-order caveat)
- **Category**: bug (availability/contention)
- **Planned at**: commit `e9ce6968`, 2026-07-12

## Why this matters

`matureDueCommissions` is decorated `@InjectTransactionManager()`, so the whole
hourly job body runs in ONE database transaction. Inside it, the method loops
over **every** beneficiary with a due commission and takes
`pg_advisory_xact_lock('credit:<beneficiary>')` per beneficiary. `_xact_`
locks release only at commit — so by the end of the run, one transaction
simultaneously holds a `credit:` lock for every beneficiary it touched, while
also `await`ing one feed-notification write per flipped row inside the same
transaction. The `credit:<id>` keyspace is exactly what the money paths
serialize on (`mutateCreditAtomic`, `settleOpen`, `claimReward`,
`recordRewardWithdrawal`) — any open / top-up / voucher claim / withdrawal for
those customers **blocks behind the hourly job until it commits**. Secondary
issues: thousands of simultaneously-held advisory locks pressure Postgres'
shared lock table, and a `notify` throw rolls back the whole batch's flips
while already-sent notifications stay sent.

Balances stay correct throughout (the flip is cosmetic — `availableBalance`
already treats a pending row as spendable once `matures_at` passes, per the
job's own doc comment). This is an availability/contention fix, not a
money-correctness fix.

## Current state

- `backend/packages/api/src/modules/packs/service.ts:3423-3499` —
  `matureDueCommissions` (verified 2026-07-12). Shape today:

  ```ts
  @InjectTransactionManager()
  async matureDueCommissions(
    notify?: (beneficiaryId, commissionId, frozen) => Promise<void>,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ flipped: number }> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    const CHUNK = 500;
    // 1) SELECT DISTINCT beneficiary ... ORDER BY beneficiary COLLATE "C"
    const due = await em.execute<{ beneficiary: string }[]>(...);
    let flipped = 0;
    for (const { beneficiary } of due) {
      // 2) per-beneficiary advisory lock — TRANSACTION-scoped, so with one
      //    outer txn these ACCUMULATE until the whole job commits
      await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
        [`credit:${beneficiary}`]);
      // 3) const frozen = await this.isFrozen(beneficiary, sharedContext);
      // 4) chunked UPDATE ... FOR UPDATE SKIP LOCKED ... RETURNING id
      for (;;) {
        const rows = await em.execute<{ id: string }[]>(/* UPDATE...LIMIT CHUNK */);
        for (const r of rows) {
          flipped++;
          if (notify) await notify(beneficiary, r.id, frozen); // INSIDE the txn
        }
        if (rows.length < CHUNK) break;
      }
    }
    return { flipped };
  }
  ```

  The long comment above the `due` query explains the `COLLATE "C"` ordering:
  it exists to prevent AB-BA deadlocks **because** the single transaction holds
  many locks at once. With one lock per transaction, that vector disappears
  (keep the ordering anyway for determinism, and keep the comment but update
  it — see Step 3).

- `backend/packages/api/src/jobs/mature-commissions.ts` (verified, whole file
  read) — hourly job (`schedule: '0 * * * *'`), calls
  `packs.matureDueCommissions(async (beneficiaryId, commissionId, frozen) => {
await notifyFeed(container, { receiverId, template: 'commission_matured',
data: {...}, idempotencyKey: \`${commissionId}:matured\` }); })`. The
  notification is already idempotent per commission (`${commissionId}:matured`),
  which is what makes moving it after commit safe: a crash between commit and
  notify means a missed notification (acceptable, feed-only), and a re-run
  cannot double-notify.

- Repo conventions: integer-sen money math, per-customer advisory locks via
  the `credit:` keyspace, raw SQL through `em.execute`. Exemplar for a
  transaction-per-unit-of-work service method: `mutateCreditAtomic`
  (`service.ts:~576`) — decorated `@InjectTransactionManager()`, does one
  customer's work, commits. Match its decorator/`@MedusaContext` signature
  style exactly.

## Commands you will need

| Purpose                                                            | Command                                                                                  | Expected on success |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------- |
| Typecheck (after plan 019: `corepack yarn check-types`; otherwise) | `cd backend/packages/api && npx tsc --noEmit`                                            | exit 0              |
| Single integration suite                                           | `cd backend/packages/api && corepack yarn test:integration:http mature-commissions.spec` | all pass            |
| Neighbor suites (regression)                                       | `cd backend/packages/api && corepack yarn test:integration:http reverse-commission.spec` | all pass            |
| Backend build                                                      | `cd backend && corepack yarn build`                                                      | exit 0              |

Integration suites need the local Postgres/Redis containers
(`pokenic-postgres` / `pokenic-redis`) running — `docker start pokenic-postgres
pokenic-redis`. The Medusa test runner creates and drops its own per-suite DBs.

## Scope

**In scope** (the only files you should modify):

- `backend/packages/api/src/modules/packs/service.ts` — only the
  `matureDueCommissions` method and one new private sibling method next to it.
- `backend/packages/api/src/jobs/mature-commissions.ts` — notify error
  handling.
- `backend/packages/api/integration-tests/http/mature-commissions.spec.ts`
  (create).
- `plans/README.md` (this plan's status row only).

**Out of scope** (do NOT touch, even though they look related):

- `mutateCreditAtomic`, `settleOpen`, `reverseOpen`, `reverseCommission`,
  `commissionsForBeneficiary` — the rest of the commission machinery is
  correct and other plans/worktrees touch nearby code.
- The read-time maturity gate (`availableBalance` / `lockedCommissionCents`)
  — unchanged by design.
- Notification module / `notify-feed.ts` — the idempotency contract stays.

## Git workflow

- Branch: `advisor/021-mature-commissions-per-beneficiary-txn`
- Commit style: conventional commits, e.g.
  `fix(commissions): scope maturity flips to one transaction per beneficiary`.
- Do NOT push or open a PR unless the operator instructed it.
- **Coordination note**: plan 011 (commission-reversal cache invalidation,
  status TODO) also edits commission code in `service.ts`, in different
  methods. If it lands first, rebase and re-run the drift check; the two
  changes are logically independent.

## Steps

### Step 1: Split enumeration from per-beneficiary work

In `service.ts`, refactor `matureDueCommissions` into two methods:

1. A new private method `matureDueCommissionsForBeneficiary(beneficiary:
string, @MedusaContext() sharedContext: Context = {})` decorated
   `@InjectTransactionManager()`, containing steps 2–4 of the current body
   (advisory lock, `isFrozen`, chunked flip loop) for ONE beneficiary. It
   returns `{ flipped: number; flippedIds: string[]; frozen: boolean }` —
   collect the RETURNING ids instead of notifying inline. **No `notify` call
   inside this method.**
2. `matureDueCommissions` itself: REMOVE its `@InjectTransactionManager()`
   decorator (keep `@MedusaContext()` off it too — it must not receive an
   ambient transaction, otherwise the per-beneficiary calls would join one
   outer transaction and reintroduce the bug). It enumerates `due`
   beneficiaries with the same `SELECT DISTINCT ... ORDER BY beneficiary
COLLATE "C"` query — run it via a non-transactional path; the established
   pattern for a plain read in this service is to call `em.execute` from a
   transaction-decorated method, so instead reuse the simplest available
   read mechanism used elsewhere in the file for un-locked reads (e.g. how
   `leaderboardTop` or other read methods obtain a query runner). Then, per
   beneficiary: `await this.matureDueCommissionsForBeneficiary(b)` (its own
   short transaction), and **after it returns** (i.e. after commit), loop the
   returned `flippedIds` calling `notify(beneficiary, id, frozen)`.

Preserve: the exact UPDATE SQL (status-guarded `status='pending'`,
`FOR UPDATE SKIP LOCKED`, `CHUNK = 500`), the `hashtextextended('credit:...')`
lock key format, and the method's public signature
`(notify?, ...) => Promise<{ flipped: number }>` so the job needs no signature
change.

**Verify**: `cd backend/packages/api && npx tsc --noEmit` → exit 0.

### Step 2: Make notify per-beneficiary best-effort in the job

In `src/jobs/mature-commissions.ts` (or in the enumerator, pick ONE place —
prefer the service enumerator so all callers get the behavior): wrap each
`notify` call in `try/catch` that logs and continues. Rationale to preserve in
a comment: the flip is already committed; the notification is feed-only and
idempotent (`${commissionId}:matured`), so a failed notify must not abort the
remaining beneficiaries (and can never roll back flips anymore).

**Verify**: `npx tsc --noEmit` → exit 0.

### Step 3: Update the lock-ordering comment

The block comment above the `due` query (currently justifying `COLLATE "C"` as
an AB-BA deadlock guard) must be updated: with one advisory lock per
transaction, the job can no longer deadlock against `reverseOpen`/
`reverseCommission`; the ordering is retained for deterministic processing
order only. Keep the Postgres `DISTINCT`/`COLLATE` explanation (it documents
why the subquery shape exists).

**Verify**: `grep -n "COLLATE" backend/packages/api/src/modules/packs/service.ts`
→ still present; comment mentions determinism, not deadlock-prevention-via-
single-transaction.

### Step 4: Write the integration spec

Create `integration-tests/http/mature-commissions.spec.ts`, modeled
structurally on `integration-tests/http/reverse-commission.spec.ts` (same
runner/bootstrapping — copy its setup shape).

**Verify**: `corepack yarn test:integration:http mature-commissions.spec` →
all pass.

### Step 5: Regression pass on neighbors

**Verify**:
`corepack yarn test:integration:http reverse-commission.spec` → pass, and
`corepack yarn test:integration:http commission-idempotency.spec` → pass.

## Test plan

New file `integration-tests/http/mature-commissions.spec.ts`, cases:

1. **Happy path**: seed 2 beneficiaries each with pending commissions whose
   `matures_at` is in the past; run `matureDueCommissions` (resolve the packs
   module service from the test container, as sibling specs do); assert all
   rows now `status='available'` and the returned `flipped` count matches.
2. **Notify failure isolates, and flips still commit**: run with a `notify`
   stub that throws for beneficiary B only. Assert: A's rows flipped, **B's
   rows ALSO flipped** (flip committed before notify), and the method did not
   throw. (This pins the new semantics — under the old code a notify throw
   rolled back every flip.)
3. **Idempotent re-run**: run twice; second run returns `flipped: 0` and
   notify stub is not called again for already-flipped ids.
4. **Status guard**: a `reversed` commission with past `matures_at` is not
   flipped.

Pattern anchor: `reverse-commission.spec.ts` for setup/teardown and container
resolution; `commission-idempotency.spec.ts` for idempotency-assertions style.

## Done criteria

- [ ] `npx tsc --noEmit` (in `backend/packages/api`) exits 0
- [ ] `corepack yarn test:integration:http mature-commissions.spec` passes with
      the 4 cases above
- [ ] `reverse-commission.spec` and `commission-idempotency.spec` still pass
- [ ] `grep -n "@InjectTransactionManager" backend/packages/api/src/modules/packs/service.ts`
      shows the decorator on `matureDueCommissionsForBeneficiary` and NOT on
      `matureDueCommissions`
- [ ] No `notify`/`notifyFeed` call inside the transaction-decorated method
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `service.ts:3423` doesn't match the excerpt (drifted).
- You cannot find a non-transactional read path for the enumerator query
  without inventing new infrastructure — report the options you found instead
  of adding a new base-repository accessor.
- Removing `@InjectTransactionManager()` from the public method breaks other
  callers (grep for `matureDueCommissions(` — expected callers: the job and
  possibly tests; anything else is a STOP).
- Test case 2 shows B's rows NOT flipped — that means the per-beneficiary
  transaction boundary didn't take effect (calls are joining an ambient
  transaction); report rather than papering over with retries.
- The integration runner can't reach a database (missing `pokenic-postgres`).

## Maintenance notes

- Future reviewers: the invariant to protect is **at most one `credit:`
  advisory lock held per transaction, ever**. Any future batch job over the
  `credit:` keyspace must copy this per-unit-transaction shape.
- If commission volume grows enough that even per-beneficiary flips are slow,
  the next lever is batching beneficiaries into worker-pool parallelism —
  safe now precisely because locks no longer accumulate in one transaction.
- Deferred deliberately: an application-level advisory-lock timeout/metric.
