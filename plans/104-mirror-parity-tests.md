# Plan 104: Parity-lock the free-pack constant mirrors and the withdrawal status set

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 5c74ce17..HEAD -- src/lib/packs-data.ts backend/packages/api/src/modules/packs/free-pack.ts backend/packages/api/src/modules/packs/models/globepay-withdrawal.ts backend/packages/api/src/api/admin/globepay/withdrawals/route.ts backend/apps/admin/src/routes/withdrawals/page.tsx backend/apps/admin/src/routes/packs/page.tsx`
> On drift, compare "Current state"; mismatch = STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (tests + one tuple export; no behavior)
- **Depends on**: none
- **Category**: tech-debt / tests
- **Planned at**: commit `5c74ce17`, 2026-08-15

## Why this matters

This repo has a recorded mirror-drift bug class (plan 005's enum mirrors, plan
041's `usdToMyr` — both drifted before being parity-locked). The delta added
instances 4 and 5:

1. `FREE_WELCOME_CATEGORY` and `FREE_PULL_LOCKED_MESSAGE` are hand-copied
   across **three deploy units** — storefront (`src/lib/packs-data.ts`),
   backend (`modules/packs/free-pack.ts`), and the admin SPA
   (`apps/admin/src/routes/packs/page.tsx` carries its own
   `FREE_WELCOME_CATEGORY`). The storefront copy's comment demands the message
   stay "VERBATIM equal" because the server returns that exact string on a
   refused sell/deliver — and no test asserts it. A drifted message breaks the
   string-match UX; a drifted category silently turns off every free-pack
   branch on the storefront with no error anywhere.
2. The withdrawal status set (`pending/settled/failed/held`) is defined in
   four uncoordinated places inside the backend/admin (model enum, migration
   CHECK, admin route filter list, admin page view list) plus a narrower
   service-side type. The delta widened it from three to four values and every
   copy was edited by hand. The next status (a denied-archived state is the
   obvious candidate) requires four coordinated edits with no compiler or test
   linking them; a stale admin filter list means an operator's filter silently
   returns an empty page.

Plan 041 established the fix pattern: export once, derive or parity-test the
mirrors.

## Current state

### Free-pack mirrors

- `backend/packages/api/src/modules/packs/free-pack.ts:5-8` — the canonical:
  `export const FREE_WELCOME_CATEGORY = 'free_welcome';` and
  `export const FREE_PULL_LOCKED_MESSAGE = ...` (plain TS module, no Medusa
  imports — importable from vitest).
- `src/lib/packs-data.ts:13-24` — the storefront mirror with the VERBATIM
  comment (`:14` names the backend path; `:20-23` the message).
- `backend/apps/admin/src/routes/packs/page.tsx` — the admin mirror of
  `FREE_WELCOME_CATEGORY` (grep it for the exact line).
- Precedent to copy: plan 041's parity test — find it via
  `grep -rn "displayMarketPrice\|parity" src/lib/__tests__/ src/lib/data/__tests__/`
  (the usdToMyr mirror test imports across the repo boundary the same way this
  plan needs).

### Withdrawal status set

- `backend/packages/api/src/modules/packs/models/globepay-withdrawal.ts:41-43`
  — `status: model.enum(['pending', 'settled', 'failed', 'held']).default('pending')`.
- `backend/packages/api/src/modules/packs/migrations/Migration20260811220000.ts:48`
  — the SQL CHECK with the same four literals (FROZEN HISTORY — never edit; it
  gets a pointer comment only).
- `backend/packages/api/src/api/admin/globepay/withdrawals/route.ts:57` —
  `const STATUS_FILTERS = ['pending', 'settled', 'failed', 'held', 'all'] as const;`
- `backend/apps/admin/src/routes/withdrawals/page.tsx:44-49` —
  `const VIEWS: GlobePayWithdrawalView[] = ['held','pending','settled','failed','all'];`
  (deliberate ORDER — held first is what the operator sees by default; a
  parity test must assert set-equality, not order).
- `backend/packages/api/src/modules/packs/service.ts:295-297` — the narrower
  mirror with its own comment:
  `type WithdrawalStatus = 'pending' | 'settled' | 'failed' | 'held';`
  ("mirrored from the model's enum for the raw-SQL claim below").
- Storefront: `src/lib/data/schemas.ts:381-387` `WithdrawStartSchema.status`
  is `z.enum(['pending','held']).optional()` — a DELIBERATE narrowing with a
  deploy-skew rationale comment; do NOT widen it; the parity test for it
  asserts subset-ness only.

## Commands you will need

| Purpose                            | Command (from)                                                                                            | Expected                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------- |
| Storefront tests                   | `npm test` (root)                                                                                         | pass incl. new parity file |
| Backend typecheck                  | `corepack yarn check-types` (`backend/`)                                                                  | exit 0                     |
| Backend unit tier (touched suites) | `TEST_TYPE=unit node node_modules/jest/bin/jest.js --silent globepay-withdrawal` (`backend/packages/api`) | pass                       |
| Admin tests                        | `.\node_modules\.bin\vite.cmd` is for dev; tests run via turbo: `corepack yarn test` (`backend/`)         | admin vitest green         |

## Scope

**In scope**:

- NEW `src/lib/__tests__/free-pack-parity.test.ts` (storefront vitest, imports
  both repo copies by relative path — the plan-041 pattern)
- `backend/packages/api/src/modules/packs/models/globepay-withdrawal.ts` — hoist
  the tuple: `export const WITHDRAWAL_STATUSES = ['pending','settled','failed','held'] as const;`
  and feed `model.enum([...WITHDRAWAL_STATUSES])`
- `backend/packages/api/src/api/admin/globepay/withdrawals/route.ts` — derive
  `STATUS_FILTERS` from the tuple (`[...WITHDRAWAL_STATUSES, 'all'] as const`)
- `backend/packages/api/src/modules/packs/service.ts:297` — derive the type:
  `type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];` (keep the
  comment, updated)
- `backend/apps/admin/src/routes/withdrawals/page.tsx` — one vitest beside the
  page's existing tests asserting VIEWS is a permutation of statuses + 'all'
  (the admin app cannot import the api package at runtime? CHECK: grep
  `from '@acme/api` or relative `../../../packages` imports in apps/admin — if
  cross-package import is not established there, put the assertion in the API
  package's unit tier against a hand-list in the test file ONLY as fallback,
  and say so in the commit)
- Migration `Migration20260811220000.ts` — a pointer COMMENT above the CHECK
  line only ("domain also exported as WITHDRAWAL_STATUSES; this CHECK is
  frozen history — a new status needs a new migration")
- The admin packs-page mirror of `FREE_WELCOME_CATEGORY` — leave the constant,
  cover it in the parity test if the admin test harness can import both sides;
  otherwise cover storefront↔backend only and note the admin copy in the test's
  comment.

**Out of scope**:

- `src/lib/data/schemas.ts` — the narrowed storefront enum is deliberate
  (subset assertion only, and only if cheap).
- Widening or reordering any live list; behavior must be byte-identical
  (`VIEWS` order preserved).
- The free-pack constants' VALUES.

## Git workflow

- Branch: `advisor/104-mirror-parity`
- Conventional commits, e.g. `test(free-pack): parity-lock the cross-deploy constant mirrors`.
- No push/PR without operator instruction.

## Steps

### Step 1: free-pack parity test

NEW `src/lib/__tests__/free-pack-parity.test.ts`: import
`FREE_WELCOME_CATEGORY`/`FREE_PULL_LOCKED_MESSAGE` from `@/lib/packs-data` and
from the backend module by relative path
(`../../../backend/packages/api/src/modules/packs/free-pack`), assert strict
equality of both. Include the admin copy if importable (see Scope). Model the
cross-boundary import on plan 041's test — find and read it first; if vitest
path-resolution balks at the backend import, mirror however 041 solved it
(it did — the pattern exists).

**Verify**: `npm test` → new file runs and passes. Mutation-prove it: edit one
character of the backend message, run the file, see RED, revert.

**Record the mutation proof (RED output line) in your commit body.**

### Step 2: hoist + derive the status tuple

Make the model file export `WITHDRAWAL_STATUSES`; derive the route's
`STATUS_FILTERS` and the service's `WithdrawalStatus` type from it. Behavior
must not change: the enum's value order, the route's accepted filters, and
`VIEWS`'s display order are all preserved.

**Verify**: `corepack yarn check-types` exit 0; `globepay-withdrawal` unit
suite green; `git diff` shows derivations, no value changes.

### Step 3: the views permutation test

Per Scope's harness check: one test asserting
`new Set(VIEWS)` equals `new Set([...WITHDRAWAL_STATUSES, 'all'])`. Place it
where the import graph allows; fallback shape acceptable with the caveat
recorded.

**Verify**: the owning test command green (admin vitest via
`corepack yarn test` from `backend/`, or the api unit tier).

### Step 4: the migration pointer comment

One comment line above the CHECK in `Migration20260811220000.ts`. No SQL
change.

**Verify**: `corepack yarn check-types` exit 0 (comments only).

## Test plan

Steps 1 and 3 ARE the tests; Step 1 requires the mutation proof. Existing
suites green throughout.

## Done criteria

- [ ] Parity test exists, passes, and its RED mutation proof is in the commit body
- [ ] `grep -n "WITHDRAWAL_STATUSES" backend/packages/api/src` → model export + route + service derivations
- [ ] `VIEWS` order unchanged (`git diff backend/apps/admin/src/routes/withdrawals/page.tsx` shows no reorder)
- [ ] All table commands green
- [ ] `git status` clean outside scope; `plans/README.md` row updated

## STOP conditions

- Vitest cannot import the backend module and plan 041's pattern doesn't
  transfer (its test may live differently than described) — report what 041
  actually did before inventing a new mechanism.
- Deriving `STATUS_FILTERS` changes its inferred type in a way that ripples
  into route validation types beyond a line or two — report; the tuple hoist
  must stay a pure refactor.
- The global prettier hook rewrites whole backend files (quote churn) on your
  edits — restage only your hunks; if impossible, note the churn explicitly in
  the commit body so the reviewer sees it was mechanical.

## Maintenance notes

- Adding a withdrawal status now: extend `WITHDRAWAL_STATUSES`, write the new
  migration, update `VIEWS` (the permutation test will remind you), and check
  the storefront's deliberate `['pending','held']` narrowing still holds.
- The free-pack parity test fails on EITHER side's edit — that is the point;
  the fix is updating both copies in one PR, never loosening the test.
