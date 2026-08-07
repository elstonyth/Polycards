# Plan 084: Stop reading every gateway 400 as "never existed", and stop expiring deposits into a terminal status

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat db2767f5..HEAD -- backend/packages/api/src/jobs backend/packages/api/src/modules/packs/globepay-reconcile.ts backend/packages/api/src/modules/packs/globepay-client.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (coordinate with 083 — same files, disjoint lines)
- **Category**: security
- **Planned at**: commit `db2767f5`, 2026-08-07

## Why this matters

Both reconcile sweeps decide "the gateway has never heard of this transaction"
from `error.httpStatus === 400`. But `GlobePayError` carries the response
status for **every** parsed refusal — a rotated key, a wrong merchant code, an
IP de-whitelisting and a genuine not-found all arrive as the same 400 shape.
So a single credential or configuration breakage turns the safety net into a
loss machine, in both directions:

- **Deposits**: every pending deposit older than the 1-hour stale window is
  marked `failed` on the strength of an error that actually means "our auth is
  broken" — including deposits the customer has already paid.
- **Withdrawals**: the ambiguous-submit population (no gateway id on the row,
  because `SubmitWithdrawal` timed out) is **refunded** while the bank may
  still execute the payout — money out _and_ credited back.

The withdrawal side is already half-guarded: `unknownWithdrawalAction` takes a
`hasGatewayTransactionId` flag and refuses to refund when the payout provably
exists, with a doc comment that reasons about exactly this hazard. The deposit
side has no such parameter, and the withdrawal side's _other_ branch is still
exposed.

Second, compounding problem: when the deposit sweep gives up on a still-live
deposit, it writes `status: 'failed'` — the same terminal status a genuine
gateway failure gets. The sweep only scans `{ status: 'pending' }`, so that
row is never requeried again. The `d6bd9732` fix ("credit a paid deposit the
sweep already wrote off") recovers such a row **when a callback arrives** —
but the sweep exists precisely because callbacks get dropped. A dropped
callback plus a bank settlement after the 1-hour window means the customer's
money is credited nowhere and nothing will ever look again.

After this plan: a 400 that is not an explicit not-found leaves the row alone
and LOGS the condition at error level — escalation is manual, because nothing
in this repo pages on a log line (see the Deferred note at the end of this
plan) — and "we stopped waiting" is a distinct, still-recoverable state from
"the gateway said no".

## Current state

### The deposit sweep's not-found test (`jobs/globepay-reconcile.ts:68-77`, verbatim)

```ts
      } catch (error) {
        // A deposit they have never heard of requeries as a 400 "Not found"
        // (observed on staging — NOT the documented PMT10016). That means
        // SubmitDeposit never took, so nobody can ever pay it.
        const notFound =
          error instanceof GlobePayError &&
          (error.httpStatus === 400 || error.has('PMT10016'));
        if (!notFound) throw error;
        action = unknownDepositAction(new Date(deposit.created_at), now);
      }
```

### The withdrawal sweep's version (`jobs/globepay-withdrawal-reconcile.ts:65-80`, verbatim)

```ts
      } catch (error) {
        const notFound =
          error instanceof GlobePayError &&
          (error.httpStatus === 400 || error.has('PMT10016'));
        if (!notFound) throw error;
        if (withdrawal.gateway_transaction_id) {
          // The payout provably exists (their W… id is on our row) — a 400
          // requery is OUR config being broken, never non-existence.
          logger.error(
            `[globepay-wd-reconcile] requery 400 for ${withdrawal.merchant_transaction_id} which HAS gateway id ${withdrawal.gateway_transaction_id} — refusing the unknown-refund path; check merchant credentials`,
          );
        }
        action = unknownWithdrawalAction(
```

### The asymmetry, stated by the repo itself (`modules/packs/globepay-reconcile.ts:120-143`, verbatim)

```ts
/**
 * A withdrawal the gateway CLAIMS not to know (requery 400). Two very
 * different situations produce that answer, and only one may refund:
 *
 * - No gateway id on our row: SubmitWithdrawal never returned, so either it
 *   never took or its outcome is unknown. Once the row is old enough that an
 *   in-flight submit is impossible, the debit goes back — this is the
 *   crash-recovery path the submit ordering relies on.
 * - A gateway id IS recorded: the payout PROVABLY exists on their side, so a
 *   400 requery is our own config being broken (rotated key, wrong merchant
 *   code), never non-existence. ...
 */
export function unknownWithdrawalAction(
  createdAt: Date,
  now: Date,
  hasGatewayTransactionId: boolean,
): WithdrawalReconcileAction {
  if (hasGatewayTransactionId) return { kind: 'wait' };
  return now.getTime() - createdAt.getTime() > GLOBEPAY_STALE_AFTER_MS
    ? { kind: 'refund' }
    : { kind: 'wait' };
}
```

The deposit equivalent has no such parameter (`globepay-reconcile.ts`,
`unknownDepositAction`, verbatim):

```ts
export function unknownDepositAction(
  createdAt: Date,
  now: Date,
): ReconcileAction {
  return now.getTime() - createdAt.getTime() > GLOBEPAY_STALE_AFTER_MS
    ? { kind: 'expire' }
    : { kind: 'wait' };
}
```

The discriminator already exists on the deposit row — `globepay-deposit.ts`
writes `gateway_transaction_id` as soon as `SubmitDeposit` returns (read
around :253 to confirm).

### `expire` and `fail` collapse into one status (`jobs/globepay-reconcile.ts:145-151`, verbatim)

```ts
// 'fail' (the gateway says so) and 'expire' (non-final but too old to keep
// chasing) both close the row without touching the ledger. Conditional on
// status so a callback that settled it mid-sweep is never overwritten.
await packs.updateGlobePayDeposits({
  selector: { id: deposit.id, status: 'pending' },
  data: { status: 'failed' },
});
```

and the scan that will never see them again (`jobs/globepay-reconcile.ts:44-47`):

```ts
const outstanding = await packs.listGlobePayDeposits(
  { status: 'pending' },
  { take: GLOBEPAY_RECONCILE_BATCH, order: { created_at: 'ASC' } },
);
```

### Why expiry must not be a write-off (`modules/packs/globepay-reconcile.ts`, near the top)

Read the `GLOBEPAY_STALE_AFTER_MS` block and the `reconcileAction` doc comment:
they already say expiry "only stops us chasing it. It never contradicts the
gateway." The bug is that the **storage** contradicts that intent.

### Repo conventions to match

- The sweeps log with a bracketed prefix (`[globepay-reconcile]`,
  `[globepay-wd-reconcile]`) and never abort the whole batch on one bad row.
- Decision logic lives in pure functions in `modules/packs/globepay-reconcile.ts`
  and is unit-tested there; the job files do I/O. Keep that split.
- Backend source is Prettier-formatted with single quotes; keep diffs narrow.

## Commands you will need

| Purpose                       | Command                                                                                                                       | Expected on success |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Backend typecheck             | `cd backend/packages/api && corepack yarn check-types`                                                                        | exit 0              |
| Reconcile tests               | `cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest reconcile --runInBand --forceExit` | all pass            |
| Backend unit tier             | `cd backend/packages/api && corepack yarn test:unit`                                                                          | all pass            |
| Backend lint | NONE. `backend/packages/api` has no eslint config and no `lint` script, so `turbo run lint` skips it and CI never lints this package. Do NOT author one — out of scope. | n/a |
| Migration check (Step 3 only) | see Step 3                                                                                                                    | —                   |

## Scope

**In scope**:

- `backend/packages/api/src/jobs/globepay-reconcile.ts`
- `backend/packages/api/src/jobs/globepay-withdrawal-reconcile.ts`
- `backend/packages/api/src/modules/packs/globepay-reconcile.ts`
- `backend/packages/api/src/modules/packs/__tests__/globepay-reconcile.unit.spec.ts` (extend)
- `backend/packages/api/src/modules/packs/models/globepay-deposit.ts` **and** a
  new migration — only if Step 3 goes the new-status route
- `plans/README.md` (status row)

**Out of scope**:

- The signature/decrypt chain and the client's error-parsing shape
  (`globepay-client.ts`) — read it, do not change it.
- The amount ceiling — that is plan 083 (same files, different lines; if both
  are executed, coordinate the order and rebase rather than merging blind).
- The withdrawal `hasGatewayTransactionId` branch that already waits — it is
  correct.
- Any change to `GLOBEPAY_STALE_AFTER_MS`.

## Git workflow

- Branch: `advisor/084-reconcile-notfound-and-expiry`
- Conventional commits, e.g.
  `fix(payments): stop treating every gateway 400 as a missing transaction`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Establish what a not-found actually looks like

Read `backend/packages/api/src/modules/packs/globepay-client.ts` around
:142-159 (`post()` and the `GlobePayError` construction) and record:

- what `error.has(code)` matches against,
- what the client does with a refusal body that carries no code,
- whether any existing test fixture asserts a real 400 body from the gateway.

Then read `backend/packages/api/src/scripts/check-globepay.ts` and any
`docs/` note on GlobePay error codes for evidence of the 400 taxonomy.

**Verify**: you can state, with a file:line citation, exactly which signal
distinguishes not-found from an auth/config refusal — or state plainly that
the repo contains no such evidence. Both are acceptable answers; the design in
Step 2 differs between them.

### Step 2: Make "unknown" conservative on both sweeps

**Deposits.** Give `unknownDepositAction` the same `hasGatewayTransactionId`
parameter its withdrawal sibling has, with the same semantics: a row that
carries a gateway id **never** expires on a 400, however old — it waits and
the job logs loudly (mirror the withdrawal job's log line, adapted). Pass
`Boolean(deposit.gateway_transaction_id)` from the job.

Confirm first that `OutstandingDeposit` (the row shape the job selects) can
carry `gateway_transaction_id`; if the select list omits it, add it.

**Both sweeps.** Narrow the `notFound` test. Two acceptable outcomes,
depending on Step 1:

- If Step 1 found a reliable not-found signal: key `notFound` on that signal
  alone and let every other 400 fall through to the outer `catch` (row stays
  pending, retried next run) with a loud log.
- If Step 1 found no reliable signal: keep the `httpStatus === 400` disjunct
  but make it **non-actionable on its own** — a 400 without an explicit
  not-found code may only produce `wait`, never `expire`/`refund`, and must
  log at error level naming "check merchant credentials". Write a comment
  saying this is a deliberately conservative reading pending the gateway's
  taxonomy, and cite plan 093's operator checklist item.

Either way the invariant to encode is: **an ambiguous refusal never moves
money and never writes a row off.**

**Verify**: `corepack yarn check-types` → exit 0;
`grep -n "unknownDepositAction" backend/packages/api/src/modules/packs/globepay-reconcile.ts backend/packages/api/src/jobs/globepay-reconcile.ts`
shows the new three-argument signature at both sites.

### Step 3: Give expiry its own non-terminal status

Today `expire` and `fail` both write `status: 'failed'`, and the sweep scans
only `pending`, so an expired-but-live deposit is unreachable forever.

Introduce a distinct status — `expired` — that means "we stopped chasing, the
gateway never said no":

1. **A migration IS required — this was verified at plan time, do not
   re-litigate it.** `status` is a text column with a CHECK constraint, from
   `backend/packages/api/src/modules/packs/migrations/Migration20260721140000.ts:28`:

   ```sql
   "status" text check ("status" in ('pending', 'settled', 'failed')) not null default 'pending',
   ```

   So a new value needs the constraint dropped and recreated. Read a
   constraint-altering migration in that directory first and match its shape;
   if none exists, follow the file's own `addSql` style. Note the sibling
   `globepay_withdrawal` table carries the identical constraint
   (`Migration20260722170000.ts:21`) — **leave it alone**, this plan changes
   deposits only.

2. Write `expired` on the `expire` branch, keep `failed` for `fail`.
3. Add a **second, lower-frequency scan tier** to the job that requeries
   `expired` rows within a bounded age window (suggested: up to 7 days old),
   so a late bank settlement is still recoverable. Rows past that window are
   left alone.
4. The recovery branch on the callback route (`hooks/globepay/deposit/route.ts`
   around :149-171, from commit `d6bd9732`) selects on the row's read status
   rather than a literal — confirm it still recovers an `expired` row and, if
   it hardcodes `'failed'` anywhere, extend it. **Read it; do not assume.**
5. Anything that displays or filters deposit status — the admin deposits route
   (`api/admin/globepay/deposits/route.ts`) and the admin SPA — must not break
   on a new value. Grep for `'failed'` across `backend/` and check each hit.

**Verify**: `corepack yarn check-types` → exit 0;
`grep -rn "'expired'" backend/packages/api/src/modules/packs backend/packages/api/src/jobs` returns
matches; `grep -rn "status === 'failed'\|status: 'failed'" backend/packages/api/src backend/apps/admin/src`
has been reviewed hit by hit (list them in your completion note).

### Step 4: Tests

See "Test plan", then run the gates.

## Test plan

Extend
`backend/packages/api/src/modules/packs/__tests__/globepay-reconcile.unit.spec.ts`
(read it first; the pure functions make this easy — match its existing style).

Cases (all required):

1. `unknownDepositAction` with `hasGatewayTransactionId: true` and an
   arbitrarily old row → `wait`, never `expire`. This is the anti-write-off
   guard.
2. `unknownDepositAction` with `hasGatewayTransactionId: false` and an old row
   → `expire` (the crash-recovery path still works).
3. A `GlobePayError` with `httpStatus: 400` and **no** not-found code →
   whatever Step 2 chose: either it propagates (row stays pending) or it can
   only produce `wait`. Assert it can never produce `expire`/`refund`.
4. A `GlobePayError` with the explicit not-found code → the not-found path,
   unchanged.
5. Withdrawal side: same as 3, asserting `refund` is unreachable from an
   ambiguous 400 when there is no gateway id.
6. Job-level: an `expired` row is picked up by the second scan tier within the
   window and not outside it.

Prove case 1 red-green by reverting `unknownDepositAction` to two arguments;
confirm the test fails; restore; confirm it passes. Report both.

Verification:
`cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest reconcile --runInBand --forceExit`
→ all pass including the new cases.

## Done criteria

- [ ] `cd backend/packages/api && corepack yarn check-types` exits 0
- [ ] `cd backend/packages/api && corepack yarn test:unit` exits 0
- [ ] `unknownDepositAction` takes `hasGatewayTransactionId` and the job passes it
- [ ] No code path can reach `expire` or `refund` from an ambiguous 400 (asserted by tests 3 and 5)
- [ ] `expire` writes a status distinct from `failed`, and a second scan tier requeries it
- [ ] Every `'failed'` comparison in `backend/` was reviewed; the list is in the completion note
- [ ] If a migration was needed, it exists and `corepack yarn check-types` still passes
- [ ] The red-green proof for test 1 is reported
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- The CHECK-constraint migration would need a lock this table cannot take
  safely while payouts are live. Report the migration shape you would need and
  stop — a lock on a live money table is an operator decision. (A
  `DROP CONSTRAINT` + `ADD CONSTRAINT ... NOT VALID` pair is usually the way
  out; propose it rather than running it.)
- The `d6bd9732` recovery branch turns out to depend on the row being exactly
  `'failed'` in a way you cannot extend without touching the callback route
  (which plan 083 may also be editing). Report the conflict.
- Existing production rows already carry `status: 'failed'` from expiry and
  cannot be distinguished from genuine failures. **Do not write a backfill.**
  Report it — deciding which historical rows to re-open is an operator call,
  and plan 093 records the query to find them.

## Maintenance notes

- **The invariant to protect**: an ambiguous gateway refusal must never move
  money and never close a row. Both sweeps now encode it; a future
  "simplification" that merges the not-found test back into a bare status
  check will silently undo it.
- **`expired` is not `failed` and never becomes it automatically.** The whole
  point is that a human or a late callback can still settle it. If a future
  cleanup job wants to age `expired` rows out, it must requery them first.
- A reviewer should scrutinize: that the deposit sweep passes the real
  `gateway_transaction_id` (not `undefined` because the select list omitted
  the column), and that the second scan tier is bounded so it cannot grow into
  a full-table scan.
- **Deferred**: alerting. Both loud log lines are still only log lines; nothing
  pages on them. Plan 093 records this as an operator item.
