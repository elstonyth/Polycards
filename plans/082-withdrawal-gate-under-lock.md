# Plan 082: Enforce the withdrawal gate under the credit lock, and cap withdrawal value per window

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat db2767f5..HEAD -- backend/packages/api/src/modules/packs/globepay-withdrawal.ts backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/api/store/credits/withdraw`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `db2767f5`, 2026-08-07

## Why this matters

`startGlobePayWithdrawal` checks the customer's `withdrawable` balance and then
debits, with **no lock held across the two**. The check reads
`walletSummary()` (which folds in the freeze flag, locked unmatured
commissions, and the playthrough gate); the debit is a separate transaction
whose only atomic guard is `floor: 0`.

`floor: 0` enforces **raw balance ≥ 0**. It knows nothing about `locked`. So N
concurrent `POST /store/credits/withdraw` requests all read the same
`withdrawable`, all pass the policy check, and all debit — bounded only by the
raw balance. A customer holding unmatured or suspended commission credits can
therefore move up to `locked` more than they are entitled to, out to a bank
account, after which the reversal and auto-freeze machinery has nothing left
to claw back. The rate limiter permits a 5-request burst per 10s, so the
concurrency is reachable.

The existing comment at `globepay-withdrawal.ts:196-199` shows the window was
considered and mis-analysed: it reasons about a _stale, lower_ `withdrawable`
(harmless) rather than two concurrent readers of the _same_ one, and it names
`floor: 0` as the backstop when `floor: 0` cannot see `locked`.

Separately, the only value ceiling on money leaving the system is the
per-transaction band (RM 50 – RM 50,000). Nothing sums prior withdrawals over
any window, so a compromised account's blast radius is "the whole balance, as
fast as the limiter allows" and there is no velocity signal to alert on.

After this plan: the policy check and the debit are one serialized unit, a
rolling-window value cap bounds the blast radius, and a register-phase token
gets a clean 401 instead of a confusing "you can withdraw up to RM 0.00".

## Current state

Files and roles:

- `backend/packages/api/src/modules/packs/globepay-withdrawal.ts` — the payout
  orchestration. The gate is at lines 192-218; the debit at 236-257.
- `backend/packages/api/src/modules/packs/service.ts` — the packs module
  service. `walletSummary` at 2977+, `mutateCreditAtomic` at 852+,
  `withdrawCreditsWithLedger` at 1079+.
- `backend/packages/api/src/api/store/credits/withdraw/route.ts` — the HTTP
  route; `customerId` is read at line 21 with no emptiness guard.

### The gate and the debit today (`globepay-withdrawal.ts:192-257`, verbatim)

```ts
// 0) The withdrawal gate (withdrawable.ts's own invariant: "the cashout
// writer MUST route through this"). walletSummary folds THREE limits into
// one number: the freeze flag (frozen accounts withdraw nothing — it is
// the fraud-response tool), locked unmatured commissions, and the
// playthrough gate (deposits must be spent on packs before they can leave
// to a bank — the anti-laundering rule). floor 0 below still guards raw
// overdraft atomically; this check enforces the policy layer, and the
// small check-then-debit window can only move in the customer's favor.
const wallet = await packs.walletSummary(input.customerId);
if (amount > wallet.withdrawable) {
  // ... three branch-specific error messages, elided ...
}

const merchantTransactionId = newMerchantTransactionId();

// 1) Row first — the callback echoes MerchantTransactionId but not our
// customer id, so this row is the only way back (same shape as deposits).
const [row] = await packs.createGlobePayWithdrawals([
  /* ... */
]);

// 2) Debit. floor 0 makes "insufficient balance" atomic with the balance
// read — no separate check-then-debit race.
let debit;
try {
  debit = await packs.withdrawCreditsWithLedger({
    customerId: input.customerId,
    amount: -amount,
    reason: 'cashout',
    reference: merchantTransactionId,
    idempotencyReference: withdrawalIdempotencyReference(
      input.customerId,
      merchantTransactionId,
    ),
    floor: 0,
    ledger: {
      /* ... */
    },
  });
} catch (error) {
  await packs.updateGlobePayWithdrawals({ id: row.id, status: 'failed' });
  throw error;
}
```

### Why `floor: 0` is not the backstop (`service.ts:969-981`, verbatim)

```ts
    // 3) Floor check — covers both "enough credit to open" and "no overdraft".
    if (deltaCents < 0 && beforeCents + deltaCents < floorCents) {
```

`beforeCents` is the **raw** balance. Compare `service.ts:3077-3082`:

```ts
const frozen = await this.isFrozen(customerId, sharedContext);
const available = frozen ? 0 : balance - locked;

// Playthrough gate: all-or-nothing on the available balance. ...
const gate = playthroughState({ depositedCents, usedCents });
const withdrawable = gate.withdrawable ? Math.max(0, available) : 0;
```

`withdrawable` subtracts `locked`; the floor does not.

### The lock idiom you will reuse (`service.ts:867-871`, verbatim)

```ts
// 1) Serialize all credit mutations for THIS customer on the locked txn.
await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
  `credit:${input.customerId}`,
]);
```

### `walletSummary` accepts a shared context (`service.ts:2977-2991`)

```ts
  @InjectManager()
  async walletSummary(
    customerId: string,
    precomputed?: {
      balance: number;
      depositedCents: number;
      usedCents: number;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ /* ... */ }>
```

Because it is `@InjectManager()` with a `@MedusaContext()` parameter, passing a
caller's transaction context makes it read **inside** that transaction.

### The invariant you must not break (`service.ts:4979-4983`, verbatim)

```ts
// Invariant to
// protect: at most one credit: advisory lock held per transaction, ever —
// never forward this method's sharedContext into the per-beneficiary calls,
// or they would join one outer transaction and re-accumulate locks across
// beneficiaries (blocking every money path behind the batch until commit).
```

Re-acquiring the **same** `credit:${customerId}` key inside one transaction is
a no-op (Postgres advisory locks are re-entrant per session), so an outer lock
plus `mutateCreditAtomic`'s own acquisition of the same key is fine. Acquiring
a **different** customer's credit lock in the same transaction is not.

### Value limits today (`globepay-withdrawal.ts:36-37, 174-179`)

```ts
export const GLOBEPAY_WD_MIN_RM = 50;
export const GLOBEPAY_WD_MAX_RM = 50000;
```

```ts
  if (amount < GLOBEPAY_WD_MIN_RM || amount > GLOBEPAY_WD_MAX_RM) {
```

Nothing sums prior withdrawals. The row table already carries the indexes a
window query needs — `backend/packages/api/src/modules/packs/migrations/Migration20260722170000.ts`
(read it; confirm the `status`/`created_at` and `customer_id` indexes before
relying on them).

### The missing guard (`withdraw/route.ts:21`)

```ts
const customerId = req.auth_context.actor_id;
```

Its sibling documents the trap and rejects it —
`backend/packages/api/src/api/store/credits/withdraw/accounts/route.ts:85-92`.
Read that block and copy its shape and its comment's reasoning.

### Repo conventions to match

- Money-mutating service methods are `@InjectTransactionManager()`; read-only
  ones are `@InjectManager()`. Follow the existing decorators.
- Amounts are MYR decimals in the ledger; the service converts to integer
  cents internally. Do not introduce a new unit.
- Comments state the **why**, name rejected alternatives, and cite the spec or
  incident that motivated them. Match that density.
- Backend source is Prettier-formatted with single quotes; keep diffs narrow.

## Commands you will need

| Purpose               | Command                                                                                                                                 | Expected on success |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Backend typecheck     | `cd backend/packages/api && corepack yarn check-types`                                                                                  | exit 0              |
| Withdrawal unit tests | `cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest globepay-withdrawal --runInBand --forceExit` | all pass            |
| Backend unit tier     | `cd backend/packages/api && corepack yarn test:unit`                                                                                    | all pass            |
| Backend lint | NONE. `backend/packages/api` has no eslint config and no `lint` script, so `turbo run lint` skips it and CI never lints this package. Do NOT author one — out of scope. | n/a |

Integration-HTTP tests need a live Postgres (`pokenic-postgres` container). If
it is not running, say so and rely on the unit tier — do not start production
services to satisfy a test.

## Scope

**In scope**:

- `backend/packages/api/src/modules/packs/globepay-withdrawal.ts`
- `backend/packages/api/src/modules/packs/service.ts` (add one method; do not
  restructure existing ones)
- `backend/packages/api/src/api/store/credits/withdraw/route.ts`
- `backend/packages/api/src/modules/packs/__tests__/globepay-withdrawal.unit.spec.ts` (extend)
- `plans/README.md` (status row)

**Out of scope**:

- `mutateCreditAtomic` itself and its floor semantics. Other money paths
  (`pack_open`, buyback) depend on the current behaviour; changing the floor to
  mean `balance − locked` globally would change what a customer can spend on
  packs, which is deliberately unrestricted (see the `walletSummary` comment:
  "Spending on packs stays unrestricted either way — the gate only limits
  cashout").
- The deposit path and both reconcile jobs (plans 083, 084).
- The saved-accounts store (plans 087, 088).
- The rate limiter (plan 081).

## Git workflow

- Branch: `advisor/082-withdrawal-gate-under-lock`
- Conventional commits, e.g.
  `fix(payments): take the withdrawal gate under the credit lock`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the empty-`actor_id` guard to the route

In `withdraw/route.ts`, immediately after reading `actor_id`, throw
`MedusaError.Types.UNAUTHORIZED` when it is falsy. Copy the shape and the
explanatory comment from `withdraw/accounts/route.ts:85-92`, adapting the
wording — the point is that a register-phase JWT passes
`authenticate('customer')` with `actor_id: ''`.

**Verify**: `corepack yarn check-types` → exit 0, and
`grep -n "UNAUTHORIZED" backend/packages/api/src/api/store/credits/withdraw/route.ts`
returns a match.

### Step 2: Add a service method that gates and debits in one transaction

Add to `service.ts`, decorated `@InjectTransactionManager()`, something with
this contract (name it to match the file's conventions, e.g.
`withdrawForCashout`):

1. Take `pg_advisory_xact_lock(hashtextextended('credit:' || customerId, 0))`
   using the exact idiom quoted above.
2. Call `this.walletSummary(customerId, undefined, sharedContext)` — threading
   the context is what makes the read see the locked transaction.
3. Apply the policy check (`amount > withdrawable`) **inside** the transaction,
   throwing the same three branch-specific errors the caller throws today.
   Move those message branches here verbatim; do not reword them (the
   storefront and its tests match on them).
4. Apply the rolling-window cap from Step 3.
5. Call the existing `withdrawCreditsWithLedger` path on the same
   `sharedContext`, so the debit joins the locked transaction.

Write the "why" comment above the lock: state that `floor: 0` guards raw
overdraft only and cannot see `locked`, so the policy check must be serialized
with the debit rather than merely preceding it. Name the concurrency the
limiter allows.

Then change `globepay-withdrawal.ts` to call this method instead of the
separate `walletSummary` read + `withdrawCreditsWithLedger` call. **Delete the
now-wrong comment at `:196-199`** and replace it with one that says where the
gate now lives.

**Verify**: `corepack yarn check-types` → exit 0;
`grep -n "walletSummary" backend/packages/api/src/modules/packs/globepay-withdrawal.ts`
returns **no** matches (the read has moved into the service).

### Step 3: Add a rolling-window value cap

Inside the same locked transaction, sum this customer's withdrawal `amount`
over a rolling 24 hours across statuses `pending` and `settled` (a `failed` or
refunded payout did not move money and must not count against the cap), and
refuse when `sum + amount` exceeds the cap.

- Cap constant: `GLOBEPAY_WD_DAILY_MAX_RM`, default **RM 50,000**, read from
  env per the repo's `positiveIntFromEnv` helper (`rate-limit.ts` has it;
  check whether a money-side equivalent already exists and prefer that).
  Read it **per call**, not at module top — plan 066 established that
  convention so a spec can drive both cap states through one booted app.
- Error: `MedusaError.Types.NOT_ALLOWED`, message
  `` `Daily withdrawal limit reached. You can withdraw RM ${remaining.toFixed(2)} more today.` ``
- **The indexes you need already exist — verified at plan time**, in
  `backend/packages/api/src/modules/packs/migrations/Migration20260722170000.ts:36-41`:
  `IDX_globepay_withdrawal_status_created_at` on `("status", "created_at")` and
  `IDX_globepay_withdrawal_customer_id` on `("customer_id")`, both partial on
  `deleted_at is null`. No migration is needed for this plan. If the live
  schema disagrees with that file, **STOP and report**.
- Note from the same file: `status` is a text column with a CHECK constraint
  limiting it to `('pending','settled','failed')`. Your window query must use
  those exact values.

**Verify**: `corepack yarn check-types` → exit 0; the constant appears in
`grep -rn "GLOBEPAY_WD_DAILY_MAX_RM" backend/packages/api/src`.

### Step 4: Tests

See "Test plan", then run the full gates.

**Verify**: `cd backend/packages/api && corepack yarn test:unit` → all pass.

## Test plan

Extend
`backend/packages/api/src/modules/packs/__tests__/globepay-withdrawal.unit.spec.ts`.
Read it first and match its mocking style.

Cases (all required):

1. **The race, as a regression guard.** Two withdrawals of exactly
   `withdrawable` against a customer with `locked > 0`, issued without waiting
   for the first to resolve: exactly one succeeds, the other throws the
   "You can withdraw up to RM …" error. If the unit-test harness cannot model
   true concurrency, assert the _structure_ instead — that the gate read and
   the debit receive the **same** `sharedContext` object — and say plainly in
   your completion note that the test pins the wiring, not the race. Do not
   claim a race is covered when it is not.
2. Frozen account → the freeze message, no debit.
3. Playthrough remaining > 0 → the playthrough message, no debit.
4. `amount ≤ withdrawable` and under the daily cap → succeeds.
5. Daily cap: a customer whose prior 24h `pending` + `settled` sum plus the
   new amount exceeds the cap → `NOT_ALLOWED` with the remaining figure, no
   debit.
6. Daily cap ignores `failed` rows (seed one; it must not count).
7. Empty `actor_id` at the route → `UNAUTHORIZED`, and
   `startGlobePayWithdrawal` is never called.

Prove case 5 red-green by temporarily raising the cap to `Infinity` and
confirming the test fails; restore and confirm it passes. Report both.

Verification:
`cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest globepay-withdrawal --runInBand --forceExit`
→ all pass including the new cases.

## Done criteria

- [ ] `cd backend/packages/api && corepack yarn check-types` exits 0
- [ ] `cd backend/packages/api && corepack yarn test:unit` exits 0
- [ ] `grep -c "walletSummary" backend/packages/api/src/modules/packs/globepay-withdrawal.ts` = 0
- [ ] `grep -n "pg_advisory_xact_lock" backend/packages/api/src/modules/packs/service.ts` shows the new method's acquisition
- [ ] `grep -rn "GLOBEPAY_WD_DAILY_MAX_RM" backend/packages/api/src` returns matches in both the implementation and the spec
- [ ] The stale comment at the old `globepay-withdrawal.ts:196-199` ("can only move in the customer's favor") is gone: `grep -c "only move in the customer" backend/packages/api/src/modules/packs/globepay-withdrawal.ts` = 0
- [ ] The red-green proof for test case 5 is reported
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- Threading `sharedContext` into `walletSummary` causes a deadlock or a
  "cannot acquire lock" error in tests — that would mean the re-entrancy
  assumption is wrong, and the design needs rethinking before any code lands.
- The live schema disagrees with `Migration20260722170000.ts` about the two
  indexes Step 3 needs (they are present in that file as of `db2767f5`).
- Any existing spec asserts that `walletSummary` is called from
  `globepay-withdrawal.ts` (i.e. the move breaks a test that pins the old
  structure). Report which spec.
- You find a **second** writer of `reason: 'cashout'` that does not go through
  the new method. The gate is only as good as its coverage — report the call
  site rather than patching it blind.

## Maintenance notes

- **`floor` and `withdrawable` mean different things and always will.** Packs
  are spendable from the raw balance by design; only cashout is limited to
  `balance − locked`. Anyone tempted to "simplify" by making the floor
  locked-aware will change what players can spend on packs. That is why this
  plan fixes the gate rather than the floor.
- **The one-credit-lock-per-transaction invariant** (`service.ts:4979-4983`)
  is now load-bearing for this path too. A future refactor that batches
  withdrawals for several customers in one transaction would violate it.
- A reviewer should scrutinize: that the three error messages are byte-identical
  to the old ones, that the cap query excludes refunded/failed rows, and that
  the cap is read per-call rather than at module load.
- **Deferred out of this plan**: an operator override for a legitimately large
  cashout above the daily cap. Today the only lever is the env var, which is a
  redeploy. If support hits this, a per-customer override belongs on the admin
  side, not here.
