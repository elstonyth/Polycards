# Plan 094: Hold withdrawals above RM 1,000 for admin approval

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **This is a money path.** Every change here sits between a ledger debit and a
> real bank payout. Write the test first (RED), then the code. Do not
> "simplify" any ordering comment you find in the touched files — they are
> load-bearing and each one records a bug that already happened.
>
> **Drift check (run first)**:
> `git diff --stat 606a28eb..HEAD -- backend/packages/api/src/modules/packs backend/packages/api/src/api/admin/globepay backend/packages/api/src/jobs`
> On any mismatch with the "Current state" notes below, re-read the affected
> file before proceeding.
>
> **Rebased 2026-08-11**: first written against `a919a264`; baseline is now
> `606a28eb`. In between, #423/#425 rewrote the submit error handling in
> `startGlobePayWithdrawal` — both the definite-refusal and the ambiguous
> branches now log inside a `try/catch` ("best-effort logger"), and
> `GlobePayError.definite` separates the two. The approve route (Task 5) must
> mirror **that** shape. Line numbers quoted below are from `a919a264` and may
> be off by a few dozen lines; the anchors are the symbol names.

## Status

- **Priority**: P2 (operator-requested control, not a live defect)
- **Effort**: M (backend ~1 day, admin UI ~3h, plus one CI cycle per merge)
- **Risk**: HIGH — touches the debit→submit ordering and the reconcile sweep
- **Depends on**: none. Builds on plan 082 (withdrawal gate under lock)
- **Category**: payments / operator control
- **Planned at**: commit `a919a264`, rebased to `606a28eb`, 2026-08-11

## The requirement

Operator's words: _"Above 1000, I will only able to redraw, and then below
thousand is auto approve."_

- Withdrawal **> RM 1,000** → do NOT submit to the gateway. Park it for an
  admin to approve or deny by hand.
- Withdrawal **≤ RM 1,000** → unchanged: auto-submit, exactly as today.

The customer's balance is debited in **both** cases, at request time. A held
payout is money already reserved — it must not be spendable while it waits.

**Stated assumption, flagged to the operator 2026-08-11 and not contested:** a customer who
requests RM 2,000 sees the money leave their balance immediately and then
waits — possibly days — with no payout and no refund until someone clicks
Approve or Deny. This is forced by the module's debit-before-submit invariant
(the alternative is a second reservation mechanism that can leak). It makes the
admin queue's response time a customer-support commitment.

## Current state

`startGlobePayWithdrawal` (`modules/packs/globepay-withdrawal.ts`) is one shot,
no human in the loop:

1. write `pending` row
2. `packs.withdrawForCashout` — the authoritative gate + ledger debit, under
   the per-customer `credit:` advisory lock
3. `submitWithdrawal` — money leaves

Existing automatic gates, none of which is an approval queue:

| Gate                                | Value                                      | Where                       |
| ----------------------------------- | ------------------------------------------ | --------------------------- |
| Per-payout band                     | RM 50 – RM 50,000                          | `globepay-withdrawal.ts:38` |
| Freeze / playthrough / withdrawable | refuse                                     | `withdrawable.ts:72`        |
| Rolling-24h total cap               | `GLOBEPAY_WD_DAILY_MAX_RM`, default 50,000 | `service.ts:1301`           |

Other facts this plan depends on, verified at the baseline commit:

- `status` is `model.enum(['pending','settled','failed'])`
  (`models/globepay-withdrawal.ts:33`) **and** a SQL CHECK constraint
  (`migrations/Migration20260722170000.ts:21`). Both must widen.
- The reconcile sweep selects `{ status: 'pending' }`
  (`jobs/globepay-withdrawal-reconcile.ts:47`). A new status is therefore
  excluded **by accident, not by intent** — see "The trap".
- The admin Withdrawals list is read-only **by an explicit decision** recorded
  in its header comment (`api/admin/globepay/withdrawals/route.ts:21`): _"a
  manual 'refund this' button here would be a second, unaudited way to mint
  credit."_ This plan adds exactly such a button, so Task 5 must amend that
  comment — otherwise the next reader deletes the endpoints as a violation.
- The Payout Verification hook
  (`api/hooks/globepay/payout-verify/route.ts:88`) rejects anything whose row
  is not `pending`. Approve must flip the row to `pending` **before**
  submitting, never after.
- `GLOBEPAY_WD_DAILY_MAX_RM` is **not** this feature. It _refuses_ above the
  threshold. The operator wants queue-then-pay. Do not "implement" this plan by
  setting that env var to 1000.

## The trap (read before writing any code)

A held row is a row that was **debited but never submitted**. If it ever
reaches the reconcile sweep, the sweep requeries the gateway, gets "not found",
and — once `GLOBEPAY_WD_SLOW_AFTER_MS` has passed — **refunds it and closes it
as `failed`**. Every pending approval would silently self-cancel hours later,
and no existing test would notice.

Today's `{ status: 'pending' }` filter already excludes a new status. That is
luck, not a control. Task 4 pins it with a regression test whose failure
message says why.

## Global Constraints

Binding on every task; reviewers check against these.

1. **Threshold semantics are exact.** Hold when
   `Math.round(amount * 100) > thresholdRM * 100` — strictly greater, integer
   cents. RM 1,000.00 exactly **auto-submits**. Default `1000`, env override
   `GLOBEPAY_WD_APPROVAL_ABOVE_RM`.
2. **Env is read per call**, never latched at module load — the plan-066
   convention, via `positiveIntFromEnv`, same as `GLOBEPAY_WD_DAILY_MAX_RM` in
   `service.ts` and the cooldown in `saved-accounts.ts:97`.
3. **A `held` row is never submitted to the gateway and never swept.** It has
   no `gateway_transaction_id`. It leaves only via admin approve (→ `pending`)
   or admin deny (→ `failed`, refunded).
4. **One refund anchor.** Every refund on this path uses
   `withdrawalRefundReference(customerId, merchantTransactionId)`. Do not mint
   a second anchor family.
5. **Money-ordering comments are load-bearing.** Do not delete, shorten, or
   "clean up" the existing ordering comments in `globepay-withdrawal.ts`,
   `service.ts#withdrawForCashout`, or the reconcile job. Extend them when the
   behaviour they describe changes.
6. **TDD.** Test first (RED), then implement. Backend tests live beside the
   code in `__tests__/`. No test that asserts nothing.
7. **Code style**: TypeScript strict, no `any`, named exports, 2-space indent,
   single quotes (backend prettier). After editing, check `git diff` for
   whole-file reformat churn from an editor hook and revert anything unrelated
   to the change.
8. **Do not touch** the deposit path, the storefront outside the one file named
   in Task 7, or any unrelated route.

---

## Task 1: Widen the withdrawal status to include `held`

**Files**: `backend/packages/api/src/modules/packs/models/globepay-withdrawal.ts`,
new migration under `backend/packages/api/src/modules/packs/migrations/`.

1. Model: `status: model.enum(['pending', 'settled', 'failed', 'held']).default('pending')`.
2. Add this to the model comment beside the existing `'pending'` / `'failed'`
   notes, verbatim in substance:

   > `'held'` — debited, awaiting admin approval, **never submitted to the
   > gateway**. It has no `gateway_transaction_id` and the reconcile sweep must
   > never select it. It leaves only via the admin approve route (→ `pending`)
   > or the admin deny route (→ `failed`, refunded).

3. New migration, forward-only and additive, that **replaces the CHECK
   constraint in place** — drop the existing `status` check and add one
   allowing `('pending', 'settled', 'failed', 'held')`. Do not drop/recreate
   the table: it holds real payout history. Find the constraint's actual name
   from the database rather than assuming it (Postgres auto-names it); a
   `DO $$ … $$` block that looks it up in `information_schema` is acceptable.
   `down()` restores the three-value check.
4. Generate/verify against a **real** database, not a mock. This table's
   `bigNumber` history (`raw_amount`, see the comment in
   `Migration20260722170000.ts`) is the standing reminder that a mocked insert
   proves nothing.

**Verify**: run the migration against the local `pokenic-postgres` container,
then insert and select a row with `status = 'held'`. Existing packs unit tests
still pass.

---

## Task 2: Hold withdrawals above the threshold

**File**: `backend/packages/api/src/modules/packs/globepay-withdrawal.ts` (plus
its `__tests__/globepay-withdrawal.unit.spec.ts`).

1. Add beside `GLOBEPAY_WD_MIN_RM` / `GLOBEPAY_WD_MAX_RM`:

   ```ts
   export const GLOBEPAY_WD_APPROVAL_ABOVE_RM_DEFAULT = 1000;
   ```

   Comment it with the boundary rule from Global Constraint 1 — that RM 1,000.00
   exactly auto-submits — because that is the cheapest thing here to get wrong.

2. In `startGlobePayWithdrawal`, compute
   `const held = Math.round(amount * 100) > positiveIntFromEnv('GLOBEPAY_WD_APPROVAL_ABOVE_RM', GLOBEPAY_WD_APPROVAL_ABOVE_RM_DEFAULT) * 100;`
   — read per call, at the point of use.
3. Write the row (step 1 of the existing flow) with
   `status: held ? 'held' : 'pending'`. **Insert the final status; do not
   insert `pending` and flip.** An insert-then-flip leaves a window where a
   crash strands a `pending` row with no gateway submission — the exact state
   the sweep refunds.
4. Keep the debit (step 2) unchanged for both branches. Then, when `held`,
   **return before `submitWithdrawal`**:
   `{ merchantTransactionId, transactionId: null, amount, balance: debit.balance, status: 'held' }`.
5. `StartWithdrawalResult` gains `status: 'pending' | 'held'`. Set it on every
   return path in this function (there are several — the ambiguous-submit
   early return included).
6. `positiveIntFromEnv` is already used in `service.ts`; import or re-use it
   from wherever it currently lives rather than writing a second copy. Confirm
   it accepts a value as low as `60` without a floor (the manual test in
   Verification depends on it).

**Tests** (RED first):

- RM 1,000.00 → submits; `submitWithdrawal` called once; result
  `status: 'pending'`.
- RM 1,000.01 → row written `held`, `submitWithdrawal` **never called**, result
  `status: 'held'`, and the ledger debit still happened.
- `GLOBEPAY_WD_APPROVAL_ABOVE_RM=2000` set after module load changes the
  branch — proves the per-call read.
- A held withdrawal still refuses on the existing gate errors (frozen,
  playthrough) before anything is written.

---

## Task 3: Count `held` rows against the rolling-24h cap

**File**: `backend/packages/api/src/modules/packs/service.ts` (the cap query
inside `withdrawForCashout`, ~line 1301), plus its unit spec.

1. The SQL currently reads `AND status IN ('pending', 'settled')`. Add
   `'held'`.
2. Extend the comment above it. It already explains why `failed` is excluded;
   add why `held` is included: the money has left the balance, and only a
   refund puts it back, so a held payout consumes the customer's daily blast
   radius exactly like a submitted one.

**Why this matters** (state it in the test name): without it a customer parks
an unbounded queue of held payouts and blows straight past the 24h ceiling the
moment an operator approves them in a batch.

**Tests** (RED first): with `GLOBEPAY_WD_DAILY_MAX_RM` set low, an existing
`held` row for the same customer inside the window consumes cap; a `failed` one
does not.

---

## Task 4: Extract the shared refund sequence; prove the sweep ignores `held`

**Files**: `backend/packages/api/src/modules/packs/globepay-withdrawal.ts`,
`backend/packages/api/src/jobs/globepay-withdrawal-reconcile.ts`, and
`backend/packages/api/src/jobs/__tests__/globepay-withdrawal-reconcile.unit.spec.ts`.

### 4a — extract the helper

The sweep's refund branch (`globepay-withdrawal-reconcile.ts`, the section
after `// refund: gateway says failed, or it never heard of a stale row.`) runs
a four-step money ordering:

1. refund via `withdrawCreditsWithLedger` anchored on
   `withdrawalRefundReference`
2. `sendWithdrawalReceipt(..., outcome: 'refunded')`
3. terminal row update → `failed`
4. `notifyFeed('withdrawal_refunded')`, guarded by `!refund.replayed`, in a
   `try/catch` that never fails a committed refund

Task 5's deny route needs the identical sequence. **Extract it into one
exported helper** in `modules/packs/globepay-withdrawal.ts` — the module that
already owns both idempotency anchors — and call it from the sweep. Signature
takes the container/scope, the withdrawal row, and whatever the sweep passes
for `gateway_status`; it returns the refund result so the caller can count.
Move the ordering comments with it, unedited in substance.

**Do not leave the sweep on its own copy.** A second verbatim copy of a money
ordering in a second file is the outcome this task exists to prevent.

The sweep's existing unit tests are the regression net: they must pass
**untouched**. If a test needs editing to accommodate the refactor, that is a
signal the behaviour changed — stop and report rather than editing the test.

### 4b — two sweep regression tests

- Seed a **stale `held` row**, run the job, assert the row is untouched and no
  refund was written. Name it so its failure explains itself, e.g.
  `does not sweep held rows — an approval queue would self-cancel`.
- Seed the state **Task 5's approve route produces on an ambiguous submit**: a
  stale `pending` row with `gateway_transaction_id` NULL. Run the job, assert
  it refunds exactly once and closes `failed`. The first test alone asserts the
  safe state and leaves the reachable one uncovered.

---

## Task 5: Admin approve and deny endpoints

**Files**: new
`backend/packages/api/src/api/admin/globepay/withdrawals/[id]/approve/route.ts`
and `…/[id]/deny/route.ts`, a new method in
`backend/packages/api/src/modules/packs/service.ts`,
`backend/packages/api/src/api/middlewares.ts`,
`backend/packages/api/src/api/admin/globepay/withdrawals/route.ts` (comment
only), plus `__tests__` for both routes.

Both routes: `/admin/*` auth applies automatically; register them on the
**shared admin-action rate limiter** in `middlewares.ts` (the same budget the
account-reveal GET uses), and log `req.auth_context.actor_id` with the row id,
mirroring `[id]/account/route.ts`. Never log the account number.

### The atomic claim (both routes)

Add one module-service method built on `em.execute`, the same escape hatch the
rolling-24h cap query already uses:

```sql
UPDATE globepay_withdrawal SET status = ?, updated_at = now()
WHERE id = ? AND status IN (…) AND deleted_at IS NULL
```

Return whether it affected a row. Approve claims `held → pending`. Deny claims
`held → failed` **and also accepts a row already in `failed`** (see the
recovery path below).

**Do NOT use `updateGlobePayWithdrawals({ selector, data })` for this.** It
type-checks and returns `Entity[]`, so `length === 0` _looks_ like a usable
guard, but the generated service resolves the selector with a find-then-write
and takes no row lock. Two concurrent approves — a double-clicked button is the
realistic trigger — both read `held`, both see one row, and both submit: a
duplicate payout to a real bank. Postgres' row lock inside a single conditional
`UPDATE` is what makes the claim a mutex; nothing at the service layer provides
one.

### `approve`

1. Claim `held → pending`. A `false` return means someone else already claimed
   it: return without submitting (idempotent, not an error).
2. `submitWithdrawal(...)` using the row's stored `bank_code` /
   `account_number` / `account_holder_name`. That is **not** the forbidden
   precheck copy: those fields were written from the LOCKED resolution inside
   `withdrawForCashout` at debit time, so the row _is_ the authoritative
   destination. Say so in the route comment — it otherwise reads as
   re-introducing exactly what the "only to the destination the LOCKED
   resolution returned" comment in `globepay-withdrawal.ts` forbids, and a
   reviewer will flag it.
3. Error handling mirrors `startGlobePayWithdrawal`'s post-#425 shape:
   - `GlobePayError` with `definite === true` → refund via the Task 4 helper,
     row `failed`, and the same best-effort `try/catch` warn line carrying
     `codes`, `httpStatus`, `definite`, `bankCode`, `amount`, `ref`, `msg`.
   - anything else (ambiguous) → leave the row `pending` for the sweep, with
     the best-effort `error` log. Do not invent a third path.

   The ambiguous branch deliberately produces a `pending` row with **no**
   `gateway_transaction_id`; Task 4b covers what the sweep does with it.

### `deny`

1. Claim first: `held → failed` (or `failed → failed`, the recovery re-run).
   A `false` return means the row is in a state deny must not touch (`pending`,
   `settled`) → refuse with a clear error.
2. Then run the Task 4 refund helper.

**The claim runs before the refund, inverting the sweep's ordering. Write the
reason into the route comment:**

- Refund-first loses the approve/deny race. Approve claims `held → pending` and
  submits while deny is still refunding; deny's conditional flip then matches
  nothing, and the payout goes out **and** the credit comes back. Real money,
  unrecoverable.
- Claim-first's cost is the opposite window: a crash between the claim and the
  refund leaves a `failed` row whose debit was never returned, and the sweep
  (pending-only) will never retry it.
- That window is closed by making deny **re-runnable**: the claim accepts
  `failed` as well as `held`, and the refund is anchored on
  `withdrawalRefundReference`, which guarantees exactly one credit however many
  times it runs. An operator who sees a `failed` row with no refund clicks Deny
  again and it settles.

### Amend the list route's header comment

`api/admin/globepay/withdrawals/route.ts` currently states the page is
read-only because "a manual 'refund this' button here would be a second,
unaudited way to mint credit." Record why these two endpoints are the
exception: they act only on `held` rows, which the gateway has never seen; they
reuse the sweep's own idempotency anchor rather than minting credit by a second
route; and every call is attributed to an admin actor id in the logs.

**Tests** (RED first): double-approve submits once; approve on a `pending` row
is a no-op; approve on a definite refusal refunds and closes `failed`; approve
on an ambiguous error leaves `pending`; deny refunds exactly once on replay;
**deny re-run on its own `failed` row is safe** (the recovery path); deny on a
`settled` row is refused.

---

## Task 6: Admin dashboard — surface and work the queue

**File**: `backend/apps/admin/src/routes/withdrawals/page.tsx` (290 lines at
baseline: list + status filter), plus the API client in
`backend/apps/admin/src/lib/`.

1. Add `held` to the status filter, and make it the **default** view: a held
   row is a customer waiting on a human, which outranks `pending` for
   attention. (`parseStatusFilter` in the backend list route defaults to
   `pending`; change the default there too, or pass the filter explicitly —
   pick one and say which in the report.)
2. Approve / Deny buttons on `held` rows **only**, each behind a confirm step
   showing the amount and the masked destination.
3. Follow the `medusa-ui-conformance` and `dashboard-page-ui` skills; use
   `@medusajs/ui` primitives and the local wrappers. Do not hand-roll dialogs.
4. CI fails on synchronous `setState` in `useEffect` (React Compiler lint) —
   check before finishing. `yarn lint` is broken locally; call
   `backend/node_modules/.bin/eslint` directly.

---

## Task 7: Storefront — tell the customer their payout is under review

**File**: `src/app/bank-withdrawal/` (the withdrawal form's result handling).

When the API answers `status: 'held'`, say plainly that the amount has already
left the balance and a person will review it before the bank transfer. Do not
render it as a completed payout, and do not imply the balance is still
spendable. Match the existing copy tone and the surrounding components; no new
design system pieces.

---

## Verification

```
cd backend/packages/api && corepack yarn jest src/modules/packs/__tests__/globepay-withdrawal.unit.spec.ts
cd backend/packages/api && corepack yarn jest src/jobs/__tests__/globepay-withdrawal-reconcile.unit.spec.ts
cd backend/packages/api && NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http corepack yarn test:integration:http -- globepay-withdrawal
```

Plus the Stop hook's storefront + backend typecheck, and
`backend/node_modules/.bin/eslint` directly (`yarn lint` is broken locally —
see the "Run backend lint locally" note).

Manual, on a local stack with `GLOBEPAY_WD_APPROVAL_ABOVE_RM=60` so the band's
RM 50 floor still leaves a testable window: withdraw RM 55 (auto), withdraw
RM 70 (held), approve it, deny another.

## STOP conditions

- The migration cannot widen the CHECK constraint in place → stop. Do not drop
  and recreate the table; it holds real payout history.
- Any existing sweep test needs editing to pass after Task 4's refactor → stop
  and report. It means behaviour changed, not just structure.
- `submitWithdrawal` needs a signature change to be callable from the approve
  route → stop. That means the destination is not fully recoverable from the
  row, which changes the design.

## Considered and rejected

- **`GLOBEPAY_WD_DAILY_MAX_RM=1000`.** Refuses above RM 1,000; the operator
  wants queue-then-pay. Wrong tool.
- **GlobePay's Payout Verification hook as the approval gate**
  (`api/hooks/globepay/payout-verify/route.ts`). It is a synchronous
  request/response — the provider asks and needs an answer in that HTTP call.
  It cannot park a payout for hours waiting on a human. It stays what it is: a
  second factor that checks the payout matches a row we recorded.
- **Holding the money in a separate "reserved" ledger bucket** instead of
  debiting. The debit-before-anything ordering is the security property this
  whole module is built on; a second reservation mechanism would be a second
  thing that can leak. The debit already reserves.
- **A cron that auto-approves held rows after N hours.** An approval queue
  nobody works is a business problem, not a code problem, and auto-approval
  deletes the control the operator asked for.
