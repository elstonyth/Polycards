# Plan 095: Close the three withdrawal-path gaps (zero stop-lever, callback failure reason, storefront Idempotency-Key)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **This is a money path.** Every touched file sits between a ledger debit and
> a real bank payout via the live GlobePay365 gateway. Write each test first
> (RED), then the code. Do not "simplify" ordering comments in the touched
> files — they record bugs that already happened.
>
> **Drift check (run first)**:
> `git diff --stat 5c74ce17..HEAD -- backend/packages/api/src/modules/packs/globepay-withdrawal.ts backend/packages/api/src/api/hooks/globepay/withdrawal/route.ts src/lib/actions/vault.ts src/app/bank-withdrawal/WithdrawForm.tsx`
> If any in-scope file changed since `5c74ce17`, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security / bug (money)
- **Planned at**: commit `5c74ce17`, 2026-08-15

## Why this matters

Three independent small holes on the same live money-out surface:

1. **The incident stop-lever silently fails.** `GLOBEPAY_WD_APPROVAL_ABOVE_RM=0`
   is the operator's "hold every payout for a human" action during an incident.
   The threshold is read via `positiveIntFromEnv`, which **rejects 0** and falls
   back to the RM 1,000 default — so pulling the lever leaves every payout at or
   below RM 1,000 auto-submitting to the live gateway, with only a stdout warn.
   The repo's own `nonNegativeIntFromEnv` doc block documents this exact failure
   class and why money ceilings must accept 0.
2. **Bank-side payout rejections land reasonless.** When the gateway's payout
   callback reports failure, the row is closed `failed` with no
   `failure_reason` — the signed `Remark` field (their own reason text) is
   parsed and discarded. This is the ordinary path for a bank refusing a
   transfer, and it recreates the blank-reason admin queue that PR #433 exists
   to abolish (its motivating incident: failure codes for eight production
   payouts gone from DO logs by morning).
3. **The storefront never sends the withdrawal Idempotency-Key.** PR #427 added
   optional Idempotency-Key support to `POST /store/credits/withdraw` ("Money-out
   parity with POST /store/credits/topup"), but `startWithdrawal` still sends
   only an Authorization header, under a comment arguing the guard is
   unnecessary. A server action is a network round-trip: it can reject at the
   action boundary (offline, 5xx, deployment-id rotation) **after** the backend
   debited and submitted the payout. The UI then shows "Something went wrong.
   Please try again." with the form still populated — inviting a retry that is a
   second debit and a second bank transfer.

## Current state

### Files

- `backend/packages/api/src/modules/packs/globepay-withdrawal.ts` — the
  store-path withdrawal writer. Threshold read at `:421-427`; the doc comment
  at `:60-67` names `positiveIntFromEnv` as deliberate (it is wrong — update
  it); `GLOBEPAY_WD_APPROVAL_ABOVE_RM_DEFAULT = 1000` at `:67`;
  `formatGatewayFailureReason` at `:179-208` (redacts digit runs);
  the submit-refusal `failure_reason` writer at `:575-585`.
- `backend/packages/api/src/api/utils/rate-limit.ts` — both env parsers.
  `nonNegativeIntFromEnv` at `:393-413` (accepts 0, with the money-ceiling
  rationale in its doc block at `:382-392`); `positiveIntFromEnv` at `:415-429`.
- `backend/packages/api/src/api/hooks/globepay/withdrawal/route.ts` — the
  payout callback. `Remark?: string` parsed at `:40`; the failed branch's
  terminal update at `:203-211` writes `status/gateway_status/gateway_transaction_id`
  and **no** `failure_reason`.
- `src/lib/actions/vault.ts` — `startWithdrawal` at `:483+`; the stale
  no-Idempotency-Key comment at `:475-476`; the fetch with only an
  `Authorization` header at `:504-515`. The correct pattern is in the SAME
  file: `topUpCredits` at `:549-580` (caller-minted key, header
  `'Idempotency-Key': idempotencyKey ?? crypto.randomUUID()`).
- `src/app/bank-withdrawal/WithdrawForm.tsx` — the submit handler (`try` block
  starting ~`:131`, `startWithdrawal({ amount, accountId })` call, `catch`
  rendering "Something went wrong. Please try again.").

### Excerpts (as of `5c74ce17`)

`globepay-withdrawal.ts:418-427`:

```ts
// Approval-threshold check, read PER CALL — never latched at module load
// (the plan-066 convention). Strictly greater-than, integer cents: RM
// 1,000.00 exactly still auto-submits (Global Constraint 1).
const held =
  Math.round(amount * 100) >
  positiveIntFromEnv(
    'GLOBEPAY_WD_APPROVAL_ABOVE_RM',
    GLOBEPAY_WD_APPROVAL_ABOVE_RM_DEFAULT,
  ) *
    100;
```

`rate-limit.ts:382-392` (the rule this violates — quote it in your commit body):

```
 * For a rate limiter, 0 is meaningless (...), which is why the sibling rejects
 * it. For a money CEILING it is the opposite: 0 is the most important value an
 * operator can set, because it is the stop lever during an incident. Routing
 * it to the fallback meant reaching for that lever silently produced the
 * DEFAULT cap — wide open — with only a log line saying the value was ignored.
```

`hooks/globepay/withdrawal/route.ts:203-211` (failed branch — no failure_reason):

```ts
await packs.updateGlobePayWithdrawals({
  selector: { id: withdrawal.id, status: 'pending' },
  data: {
    status: 'failed',
    gateway_status: data.Status,
    gateway_transaction_id:
      gatewayTransactionId || withdrawal.gateway_transaction_id,
  },
});
```

`src/lib/actions/vault.ts:475-476` (the stale comment):

```
 * ... No Idempotency-Key: the backend
 * mints a fresh reference per attempt, and each attempt debits atomically.
```

Backend header parse (already shipped, `api/store/credits/withdraw/route.ts:44-55`):
optional, trimmed, 200-char bound, forwarded as `idempotencyKey` — clients that
send no header "simply get no replay protection".

### Conventions to honor

- Backend money code: integer-cent comparisons, per-call env reads (plan-066
  convention — never latch at module load), `formatGatewayFailureReason` for any
  gateway-authored text that lands in `failure_reason` (it redacts digit runs;
  the raw `Remark` could echo an account number).
- Storefront: caller-minted idempotency keys, minted once per ATTEMPT and reused
  across retries of that attempt (see the `topUpCredits` doc block at
  `vault.ts:549-556` — a key minted per call would rotate on every retry and
  bypass the replay guard).

## Commands you will need

| Purpose                         | Command (run from)                                                                                                       | Expected on success |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Backend typecheck               | `corepack yarn check-types` (from `backend/`)                                                                            | exit 0              |
| Backend unit tier               | `TEST_TYPE=unit node node_modules/jest/bin/jest.js --silent globepay-withdrawal` (from `backend/packages/api`, Git Bash) | suites pass         |
| Callback unit spec              | `TEST_TYPE=unit node node_modules/jest/bin/jest.js --silent hooks` (from `backend/packages/api`)                         | suites pass         |
| Storefront typecheck+lint+build | `npm run check` (repo root)                                                                                              | exit 0              |
| Storefront tests                | `npm test` (repo root)                                                                                                   | all pass            |

Do NOT pipe jest through `head`/`tail` (recorded CI-gap trap: output truncation
has hidden red suites before). Run suites individually if output is long.

## Scope

**In scope** (the only files you should modify):

- `backend/packages/api/src/modules/packs/globepay-withdrawal.ts`
- `backend/packages/api/src/api/hooks/globepay/withdrawal/route.ts`
- The existing unit specs for both (`globepay-withdrawal.unit.spec.ts` and the
  withdrawal-hook spec — locate with `grep -rl "GLOBEPAY_WD_APPROVAL_ABOVE_RM\|hooks/globepay/withdrawal" backend/packages/api/src --include=*.spec.ts` and the
  integration-tests tree)
- `src/lib/actions/vault.ts`
- `src/app/bank-withdrawal/WithdrawForm.tsx`
- A storefront test file for the action header (see Test plan)

**Out of scope** (do NOT touch):

- `backend/packages/api/src/api/store/credits/withdraw/route.ts` — the header
  parse already works; nothing to change.
- `rate-limit.ts` — both parsers are correct as-is; you are only switching which
  one a call site uses.
- The deny/approve admin routes, `refundGlobePayWithdrawal`, the reconcile
  sweep — their failure_reason writing already works.
- The top-up path (`topUpCredits`, `TopUpSheet`) — it is your exemplar, not your
  target.

## Git workflow

- Branch: `advisor/095-withdrawal-path-trio`
- Conventional commits, one per step, e.g.
  `fix(payouts): accept 0 as the approval-threshold stop lever`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (RED): threshold zero test

In the unit spec that already covers the approval threshold (grep
`GLOBEPAY_WD_APPROVAL_ABOVE_RM` under `backend/packages/api/src/modules/packs/__tests__/`),
add a case: with `process.env.GLOBEPAY_WD_APPROVAL_ABOVE_RM = '0'`, ANY
positive amount (use RM 1) is held. Follow the env set/restore pattern of the
neighboring threshold cases.

**Verify**: run that suite → the new case FAILS (currently 0 falls back to
1000, so RM 1 auto-submits).

### Step 2 (GREEN): switch the parser

In `globepay-withdrawal.ts:421-427`, replace `positiveIntFromEnv` with
`nonNegativeIntFromEnv` (same module import from `../../api/utils/rate-limit`
— check the existing import line and extend it). Update the doc comment at
`:60-67`: it currently says "via positiveIntFromEnv"; state that
`nonNegativeIntFromEnv` is used precisely so `=0` works as the hold-everything
stop lever, referencing the parser's own doc block.

**Verify**: Step 1's case passes; the full `globepay-withdrawal` unit suite
passes; `corepack yarn check-types` exits 0.

### Step 3 (RED): callback failure_reason test

In the callback's spec, add a case: a signed failed callback carrying
`Remark: 'insufficient balance at bank 1234567890123'` results in the row
updated with a non-empty `failure_reason` that contains `insufficient balance`
and does NOT contain `1234567890123` (digit-run redaction). Model on the
existing failed-callback case.

**Verify**: the new case FAILS (no failure_reason is written today).

### Step 4 (GREEN): write the reason in the failed branch

In `hooks/globepay/withdrawal/route.ts`, in the `failed` terminal update
(`:203-211`), add:

```ts
failure_reason: formatGatewayFailureReason({
  prefix: 'callback failed',
  codes: [],
  httpStatus: 0,
  bankCode: withdrawal.bank_code,
  message: data.Remark ?? '',
  accountNumber: withdrawal.account_number,
  accountHolderName: withdrawal.account_holder_name,
}),
```

Import `formatGatewayFailureReason` from `modules/packs/globepay-withdrawal`.
Check the actual field names on the loaded `withdrawal` row before writing
(`bank_code` / `account_number` / `account_holder_name` — confirm against the
model `modules/packs/models/globepay-withdrawal.ts`); if the row is loaded with
a field subset that omits them, extend the load, do not pass empty strings.

**Verify**: Step 3's case passes; the whole callback suite passes.

### Step 5 (RED): storefront header test

Storefront: find the existing tests for `vault.ts` actions (grep
`startWithdrawal` under `src/lib/actions/__tests__/`). Add a case asserting the
`sdk.client.fetch('/store/credits/withdraw', ...)` call carries an
`Idempotency-Key` header equal to the key passed into `startWithdrawal`. If no
action-level test harness exists for this action, model on how
`account-lifecycle.test.ts` mocks `sdk.client.fetch`.

**Verify**: new case FAILS (no header today).

### Step 6 (GREEN): thread the key

1. `src/lib/actions/vault.ts`: add an optional `idempotencyKey?: string` to
   `startWithdrawal`'s input; set the header exactly as `topUpCredits` does
   (`'Idempotency-Key': input.idempotencyKey ?? crypto.randomUUID()`). Rewrite
   the `:475-476` comment: the backend replay guard (PR #427) is now used; the
   key is minted per ATTEMPT by the caller and reused across retries of that
   attempt.
2. `src/app/bank-withdrawal/WithdrawForm.tsx`: mint the key once per attempt —
   a `useRef<string | null>(null)`; on submit, `ref.current ??= crypto.randomUUID()`;
   pass it to `startWithdrawal`; clear the ref (`ref.current = null`) ONLY on
   success (`res.ok`) — a failed/thrown attempt keeps the key so the retry
   replays instead of double-debiting. This mirrors `TopUpSheet` — open it and
   match its shape.

**Verify**: Step 5's case passes; `npm test` all green; `npm run check` exit 0.

## Test plan

- Backend: 2 new unit cases (threshold `=0` holds; callback failed writes
  redacted `failure_reason`). Pattern: the suites they extend.
- Storefront: 1 new case (header present + stable across a retry of the same
  attempt if the harness makes that cheap; header presence is the minimum).
- Full gates: backend unit tier for the two touched suites, `npm test`,
  `npm run check`, `corepack yarn check-types`.

## Done criteria

- [ ] `grep -n "positiveIntFromEnv" backend/packages/api/src/modules/packs/globepay-withdrawal.ts` → no match on the approval-threshold read
- [ ] `grep -n "failure_reason" backend/packages/api/src/api/hooks/globepay/withdrawal/route.ts` → ≥1 match inside the failed branch
- [ ] `grep -n "Idempotency-Key" src/lib/actions/vault.ts` → match inside `startWithdrawal`
- [ ] All commands in the table exit green
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The threshold read at `globepay-withdrawal.ts:421-427` no longer matches the
  excerpt (drifted).
- The callback route's failed branch has gained a `failure_reason` writer
  already (someone fixed it independently) — report, skip steps 3–4.
- The `withdrawal` row loaded in the callback lacks the account fields and
  extending the load pulls in decrypt/PII machinery — STOP and report rather
  than logging or storing decrypted values (plan 087 removed exactly that).
- `WithdrawForm` submit shape differs materially from the excerpt (e.g. someone
  already added key minting).

## Maintenance notes

- The `held` insert path writes rows with their final status; if a future
  status is added ahead of `held`, re-check the threshold comparison still runs
  before the row insert.
- Reviewer: scrutinize Step 6's key lifecycle — the key must NOT rotate between
  a failure and its retry (that is the entire guard), and MUST rotate between
  two distinct successful withdrawals.
- Deferred: surfacing `replayed` in the WithdrawForm success copy ("already
  sent") — the backend may return it; nice-to-have, not required here.
