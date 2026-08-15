# Plan 098: Bound the aggregate admin credit-mint rate (RM 1M/call × 200/min has no ceiling)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **This is a money path** (operator credit minting). Tests first.
>
> **Drift check (run first)**:
> `git diff --stat 5c74ce17..HEAD -- backend/packages/api/src/modules/packs/credit-adjust.ts backend/packages/api/src/workflows/adjust-credits.ts backend/packages/api/src/modules/packs/service.ts`
> On drift in the adjust path, compare "Current state" first; mismatch = STOP.

## Status

- **Priority**: P2 (P1 the day an admin token leaks)
- **Effort**: M
- **Risk**: MED (a too-low global ceiling blocks legitimate support work — the
  bound is env-tunable for exactly that reason)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `5c74ce17`, 2026-08-15

## Why this matters

PR #435 raised the per-call manual credit-adjustment ceiling from RM 10,000 to
RM 1,000,000. The constant's own comment concedes the control that was lost:
_"This is NOT a typo guard any more — at this size a slipped digit mints real
money, so the confirm Prompt in the admin UI is the only thing between an
operator and a six-figure grant."_ A UI confirm is not a control against a
compromised or rogue admin token. The only automated bound left is the shared
admin-action rate limiter (30/10s burst, 200/60s sustained, per actor) — which
now allows **~RM 200,000,000 per minute** of minted credit. Minted credit is
stamped `external_funded_cents = 0`, banks zero playthrough, and on an account
with no unplayed deposits it is immediately withdrawable through the live
GlobePay payout path. The asymmetry is stark: #426 parks a RM 1,001 _payout_
for a human approver, while minting RM 1,000,000 requires no second party. The
`admin_action_audit` row is written after the fact — forensics, not a control.

The fix: a rolling-24h **global** (all-admins, all-customers) positive-mint
ceiling, checked inside the workflow before the ledger write, env-tunable with
`0` as a valid hold-everything stop lever (the plan-095 parser rule).

## Current state

### Files

- `backend/packages/api/src/modules/packs/credit-adjust.ts` — pure rules.
  `ADJUST_MAX_RM = 1_000_000` at `:11` with the quoted comment (`:6-10`);
  `adjustAmountError` at `:15-33` (finite, non-zero, |x| ≤ max, cent
  precision).
- `backend/packages/api/src/workflows/adjust-credits.ts` — the workflow the
  admin route runs; its step calls the service mutation. (Read it fully before
  editing — the amount/note validation lives "in the workflow step" per the
  route comment.)
- `backend/packages/api/src/api/admin/customers/[id]/credits/route.ts` — POST
  handler; derives `admin_id` from `auth_context.actor_id`; runs
  `adjustCreditsWorkflow`. Auto-protected admin route; on the shared
  `adminActionRateLimit`.
- `backend/packages/api/src/modules/packs/service.ts` — the adjust mutation
  writes `reason: 'adjustment', reference: input.note, floor: 0` at
  `:5437-5445` (inside the advisory-locked `mutateCreditAtomic` family).
  The rolling-24h WITHDRAWAL cap exemplar you will mirror:
  `:1412-1420` — a SQL sum over the last 24h scoped `customer_id`, compared
  against `nonNegativeIntFromEnv('GLOBEPAY_WD_DAILY_MAX_RM', …)`, with its
  binding pinned by a test.
- `backend/packages/api/src/api/utils/rate-limit.ts` —
  `nonNegativeIntFromEnv` (`:393-413`): the parser for money ceilings (accepts
  0 as the stop lever).
- `backend/packages/api/.env.template` — where the new env var gets documented
  (plan 103 documents the OTHER payout knobs; add yours here regardless of
  ordering — the two plans touch different lines).

### Semantics to implement

- Ceiling: `ADJUST_DAILY_MINT_MAX_RM`, default **1_000_000** (one max-size
  grant per day passes; a second same-day max grant trips the ceiling —
  conservative default, operator can raise).
- Scope: sum of **positive** `amount` over `credit_transaction` rows with
  `reason = 'adjustment'` in the trailing 24h, across ALL customers and ALL
  admins (a global bound — per-admin would just mean N tokens). Negative
  adjustments (clawbacks) do not count against it and are never blocked by it.
- `0` = hold everything (every positive adjustment refused) — must work, per
  the `nonNegativeIntFromEnv` doc block.
- Refusal: a clear error naming the env var and the current 24h total, so the
  operator understands it's the aggregate ceiling, not the per-call one. Do NOT
  include customer ids in the message.
- Check runs inside the workflow, before the credit write, reading the sum
  under the same transaction/context the write uses (mirror how the withdrawal
  cap reads within `startGlobePayWithdrawal`'s locked flow). A racing pair of
  adjustments that together exceed the cap: acceptable if one slips through on
  read-skew ONLY if the reads are not serialized — prefer running the sum
  inside the per-customer `credit:` lock like the withdrawal cap does; note in
  a comment that cross-customer concurrent mints are serialized only by the
  admin limiter, and the ceiling is enforcement-at-margin, not to-the-cent
  (same posture as the withdrawal cap's own comment if it has one — read it).

## Commands you will need

| Purpose                   | Command (from)                                                                                                                                                                                                                                   | Expected |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Typecheck                 | `corepack yarn check-types` (`backend/`)                                                                                                                                                                                                         | exit 0   |
| Adjust unit/module suites | `TEST_TYPE=unit node node_modules/jest/bin/jest.js --silent credit-adjust` then `TEST_TYPE=integration:modules node node_modules/jest/bin/jest.js --silent adjust` (`backend/packages/api`; modules tier needs `pokenic-postgres` + `.env.test`) | pass     |
| Admin route HTTP suite    | `NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http node node_modules/jest/bin/jest.js --silent credits` (`backend/packages/api`)                                                                                                 | pass     |

## Scope

**In scope**:

- `backend/packages/api/src/workflows/adjust-credits.ts` (the check site)
- `backend/packages/api/src/modules/packs/service.ts` — ONE new read method
  (`rollingAdjustmentMintSen` or similar) beside the withdrawal-cap read; and
  nothing else in the file
- `backend/packages/api/src/modules/packs/credit-adjust.ts` — constants/doc
  only if the error-message helper belongs there
- The suites covering the adjust path (extend)
- `backend/packages/api/.env.template` — one documented entry

**Out of scope**:

- `ADJUST_MAX_RM` itself — the operator chose RM 1M per call; keep it.
- The admin UI confirm flow (`backend/apps/admin`) — server-side bound only.
- The admin rate limiter numbers.
- Any second-approver flow (recorded as the alternative; not chosen — cheaper
  control first).

## Git workflow

- Branch: `advisor/098-adjust-mint-ceiling`
- Conventional commits, e.g. `feat(money): rolling-24h global ceiling on positive credit adjustments`.
- No push/PR without operator instruction.

## Steps

### Step 1: read the two exemplars

Read `service.ts:1400-1430` (withdrawal daily cap: SQL shape, env read, error
shape, the `merchant_transaction_id <> ?` self-exclusion trick and its pinning
test in `globepay-withdrawal.unit.spec.ts`) and `workflows/adjust-credits.ts`
end-to-end. No edits.

**Verify**: you can name where the workflow validates `amount` today and where
the new check slots in (before the mutation step). Write both into your first
commit message.

### Step 2 (RED): the ceiling tests

Extend the adjust-path module/HTTP suite with, minimum:

1. Sum below ceiling → adjustment succeeds (existing happy path still green).
2. A prior same-window positive adjustment such that the new one crosses the
   ceiling → refused with the env-var-naming error; ledger has NO new row.
3. `ADJUST_DAILY_MINT_MAX_RM=0` → ANY positive adjustment refused; a NEGATIVE
   adjustment still succeeds.
4. Rows older than 24h do not count (seed one with a backdated `created_at`).

**Verify**: cases 2–4 fail against current code.

### Step 3 (GREEN): implement

Service read method beside the withdrawal cap (same SQL idiom, `reason =
'adjustment' AND amount > 0 AND created_at >= now() - interval '24 hours'`,
sum in sen, no customer scope), workflow check before the mutation using
`nonNegativeIntFromEnv('ADJUST_DAILY_MINT_MAX_RM', 1_000_000)`, refusal error
consistent with the workflow's existing error style. Log one structured line on
refusal (admin actor id + attempted amount + window total) — that is the
alert hook.

**Verify**: all Step 2 cases pass; full adjust suites pass; typecheck green.

### Step 4: document the knob

`.env.template`: add `ADJUST_DAILY_MINT_MAX_RM` (commented) with: default,
what counts (positive adjustments only, global, 24h rolling), and that `0`
holds all minting during an incident.

**Verify**: `grep -n "ADJUST_DAILY_MINT_MAX_RM" backend/packages/api/.env.template` → 1.

## Test plan

The four cases in Step 2, in the existing adjust suites (module tier for the
sum semantics, HTTP tier if the refusal shape is easiest to assert there).
Pattern: the withdrawal daily-cap tests.

## Done criteria

- [ ] `grep -rn "ADJUST_DAILY_MINT_MAX_RM" backend/packages/api/src` → the workflow check + nothing unexpected
- [ ] Step 2's four cases green; pre-existing adjust cases green
- [ ] `corepack yarn check-types` exit 0
- [ ] `.env.template` entry present
- [ ] `git status` clean outside scope; `plans/README.md` row updated

## STOP conditions

- `adjust-credits.ts` workflow shape differs materially from the route
  comment's description (validation not in the step).
- The ledger table/columns backing the sum differ from the withdrawal-cap
  exemplar's assumptions (e.g. `created_at` not indexed for a 24h scan on a
  table this hot — if EXPLAIN on the dev DB shows a seq scan over
  `credit_transaction`, STOP and report; an index addition is a migration
  decision the operator should see).
- Anything requires touching `mutateCreditAtomic` itself.

## Maintenance notes

- The refusal log line is the alerting seam — when observability lands, alert
  on it (plan 093's checklist owns operator alerting).
- If a second-approver flow is ever built (the #426 held-queue shape), this
  ceiling stays as the backstop beneath it, not replaced by it.
- Reviewer: check the 24h sum excludes negative rows and is NOT customer-scoped
  — both are the point; a copy-paste of the withdrawal cap would get both wrong.
