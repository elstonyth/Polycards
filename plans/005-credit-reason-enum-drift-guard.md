# Plan 005: Regression guard — storefront credit-reason enum must cover the backend enum

> **✅ Status: DONE — implemented in PR #59.** The "Current state" / steps below
> describe the pre-implementation baseline at commit `4ca2593`, kept as the
> historical record; the live code already reflects the completed work. See
> [README.md](README.md) for status — do not re-run this as a fresh checklist.

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report. When done, update the status
> row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 4ca2593..HEAD -- src/lib/data/schemas.ts backend/packages/api/src/modules/packs/models/credit-transaction.ts`
> If either file changed, re-read both enums and compare before proceeding.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests / dx
- **Planned at**: commit `4ca2593`, 2026-07-02

## Why this matters

The storefront parses the credit ledger with Zod. `parseList()` **silently drops
any row that fails validation** — so if the backend adds a new
`credit_transaction.reason` value that the storefront's `CREDIT_REASONS` list
doesn't include, those transactions vanish from the customer's Transactions page
with no error. This has bitten the project before (PR #36). **Right now the two
enums are identical** (10 values each), so there is no live data loss — this
plan does not fix a current bug, it installs a test that fails the moment they
drift again, converting a silent production data-loss class into a red build.

## Current state

Both enums, verified identical at `4ca2593`:

- Backend (source of truth) —
  `backend/packages/api/src/modules/packs/models/credit-transaction.ts:14-25`:
  ```ts
  reason: model.enum([
    "buyback", "topup", "pack_open", "adjustment",
    "direct_referral", "team_override", "commission_reversal",
    "cashout", "voucher_claim", "reward_credit",
  ]),
  ```
- Storefront — `src/lib/data/schemas.ts:124-135`:
  ```ts
  export const CREDIT_REASONS = [
    'buyback',
    'topup',
    'pack_open',
    'adjustment',
    'direct_referral',
    'team_override',
    'commission_reversal',
    'cashout',
    'voucher_claim',
    'reward_credit',
  ] as const;
  ```
  Used by `CreditTransactionSchema` (`schemas.ts:139-144`, `reason: z.enum(CREDIT_REASONS)`)
  and consumed by `parseList()` (`schemas.ts:31-39`) which drops non-conforming rows.

There is an existing storefront schema test file (the audit referenced a
`schemas.test.ts` / `schemas.spec.ts` around the CREDIT_REASONS assertions).
**Find it first** — search `src/lib/data` and the repo test dirs for
`CREDIT_REASONS`. Add to it rather than creating a parallel file.

## Commands you will need

| Purpose               | Command                                                                                                             | Expected on success |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Storefront typecheck  | `npm run typecheck`                                                                                                 | exit 0              |
| Storefront unit tests | check `package.json` "scripts" for the test runner (e.g. `npm test` / `vitest`); run it filtered to the schema test | all pass            |
| Lint                  | `npm run lint`                                                                                                      | exit 0              |

> Confirm the storefront test command from `package.json` before running — do
> not assume `vitest` vs `jest`.

## Step 1: Locate the enum test and the runner

- Find the existing schema test file and how storefront unit tests are run
  (`package.json` scripts). Record both.

**Verify**: you can run the existing schema test and it passes.

## Step 2: Add a "storefront enum ⊇ backend enum" assertion

The check must fail if the backend gains a `reason` the storefront lacks. Two
implementation options — pick the one that fits the repo's test setup:

**Option A (preferred if the backend model is importable from the storefront
test):** import the backend enum values and assert every one is in
`CREDIT_REASONS`. Backend and storefront are separate packages, so a direct
import may not resolve — only use this if it does.

**Option B (robust, no cross-package import):** encode the backend list as an
expected constant in the test with a comment pointing at the backend file, and
assert `CREDIT_REASONS` is a superset:

```ts
// Mirror of backend credit_transaction.reason enum
// (backend/packages/api/src/modules/packs/models/credit-transaction.ts).
// If the backend adds a reason, add it here AND to CREDIT_REASONS — this test
// exists to force that same-deploy update (see plans/005). parseList() silently
// drops unknown reasons, so drift = invisible data loss.
const BACKEND_CREDIT_REASONS = [
  'buyback',
  'topup',
  'pack_open',
  'adjustment',
  'direct_referral',
  'team_override',
  'commission_reversal',
  'cashout',
  'voucher_claim',
  'reward_credit',
] as const;

test('storefront CREDIT_REASONS covers every backend credit reason', () => {
  for (const r of BACKEND_CREDIT_REASONS) {
    expect(CREDIT_REASONS).toContain(r);
  }
});
```

Option B still requires a human to update `BACKEND_CREDIT_REASONS` when the
backend changes — but the failing test + comment is the tripwire. If you can
make Option A resolve, prefer it (fully automatic).

**Verify**: run the schema test → the new case passes at current state.

## Step 3: Prove the guard actually catches drift

Temporarily remove one value from `CREDIT_REASONS` (e.g. `'reward_credit'`) and
run the test — it MUST fail. Restore the value and confirm it passes again. This
proves the tripwire works. (Do not commit the temporary removal.)

**Verify**: test fails with the value removed, passes when restored.

## Test plan

- The deliverable IS the test. Cases: (1) every backend reason is present in
  `CREDIT_REASONS`; (2) `parseList` keeps a row for each reason (extend the
  existing fixture test if it enumerates reasons).
- Model after the existing schema test file found in Step 1.
- Verification: storefront test run → all pass, including the new case(s).

## Scope

**In scope:**

- The existing storefront schema test file (found in Step 1).

**Out of scope:**

- `src/lib/data/schemas.ts` — do NOT change the enum or `parseList` (they are
  correct and currently in sync). This plan only adds a test.
- Backend files — read-only reference.

## Git workflow

- Branch: `advisor/005-credit-reason-drift-guard`
- Conventional commits, e.g. `test(schemas): guard storefront credit-reason enum against backend drift`
- Do NOT push or open a PR unless the operator instructed it.

## Done criteria

- [ ] A test asserts `CREDIT_REASONS` covers every backend credit reason.
- [ ] Step 3 proof performed: the test fails when a reason is removed, passes when restored (temporary change NOT committed).
- [ ] Storefront test run passes.
- [ ] `npm run typecheck` exits 0.
- [ ] Only the test file is modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The two enums are NOT identical at execution time (drift already happened) —
  stop and report; that's a live bug to fix separately (widen `CREDIT_REASONS`
  to match backend), not just a test to add.
- No existing storefront test runner/config is found — report before scaffolding
  a new test framework (that's a bigger decision than this plan).

## Maintenance notes

- This is one instance of a broader hand-mirrored-enum class (see plans/README
  "Direction"). If it recurs for other enums (reward kinds, achievement types),
  consider a shared constants module or codegen instead of more mirror tests.
- A reviewer should confirm the test's backend list matches the backend model at
  review time, and that the tripwire comment points at both files.
