# Plan 124: Operator script to release a duplicated phone number from one account

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Do NOT update
> `plans/README.md`; the reviewer maintains it.
>
> **Drift check (run first)**:
> `git diff --stat dac14a59..HEAD -- backend/packages/api/src/scripts/delete-customer-account.ts backend/packages/api/src/modules/packs/service.ts`

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: MED — writes to a live customer row
- **Depends on**: plan 123 (merged, `dac14a59`) for the script conventions
- **Category**: dx / security
- **Planned at**: commit `dac14a59`, 2026-08-24

## Why this matters

Production has one duplicate phone value shared by two accounts:

- `cus_01KZDBZTJ64VGYAHHNQQZ18JWZ` — 48 pulls, RM 10,477.83, active. Keeps the number.
- `cus_01M07Q2G0A7N9S0X0K2W0SFBSA` — 1 pull, RM 0, dormant since signup. Releases it.

Deleting the dormant account was tried first and the system correctly refused:
`deleteAccountPreflight` returned `CARDS_UNSETTLED` because that account still
holds a card in its vault. Destroying an owned asset to resolve a phone
collision is the wrong trade, so the operator chose to release just the phone.

Releasing the number is what unblocks the follow-up partial unique index on
`customer(phone)`, which is the actual goal.

## Current state

- `customer.phone` is a plain column; uniqueness is not enforced today — that
  index is the pending follow-up this work unblocks.
- Phone **verification** state lives in a different table:
  `customer_account_state.phone_verified_at`. `markPhoneVerified`
  (`modules/packs/service.ts:2827`) stamps it; there is no unmark method.
  `hasVerifiedPhone` reads it (`service.ts:2811-2814`).
- `purgeAccountPacksData` deliberately does **not** clear `phone_verified_at`
  when deleting an account — it writes a `disabled` tombstone instead, so the
  stale stamp is unreachable. **That reasoning does not transfer here**: a
  released account stays active, so leaving `phone_verified_at` set would leave
  the account "phone-verified" with no phone on file, and money gates read that
  flag. This plan must clear it.
- Precedent for the script shape, PII masking, dry-run-first and the
  echo-the-id confirm: `src/scripts/delete-customer-account.ts` (plan 123).
- `admin_action_audit` (`modules/packs/models/admin-action-audit.ts`) is the
  repo's append-only operator-action trail. Its `entity_type` and `action` are
  DB-level enums — use the existing `customer` / `edit` values. Do **not** add
  a new enum value; that needs a migration and is out of scope.

## Commands

| Purpose         | Command                                                                                                                                             | Expected |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Typecheck       | from `backend/`: `corepack yarn check-types`                                                                                                        | exit 0   |
| Script spec     | from `backend/`: `node packages/api/node_modules/jest/bin/jest.js --config packages/api/jest.config.js --testPathPatterns "release-customer-phone"` | all pass |
| Neighbour specs | same runner, `--testPathPatterns "delete-customer-account"`                                                                                         | all pass |

jest 30 uses `--testPathPatterns` (plural). Backend eslint is vacuous for
`packages/api`; typecheck plus jest are the real gates.

## Scope

**In scope**:

- `backend/packages/api/src/scripts/release-customer-phone.ts` (create)
- `backend/packages/api/src/scripts/__tests__/release-customer-phone.unit.spec.ts` (create)

**Out of scope**:

- `api/utils/account-deletion.ts`, the delete script, the store routes — untouched.
- Any migration, including the pending unique index and any audit-enum change.
- `markPhoneVerified` and `deleteAccountPreflight` — read/reuse, never modify.
- Running the script against any database.

## Steps

### Step 1: The script

Create `src/scripts/release-customer-phone.ts`. Model its structure, masking
helpers and NOT_FOUND-versus-outage error handling on
`src/scripts/delete-customer-account.ts` — including its `isNotFound` helper,
which must be reused, not re-derived: an operational failure must never render
as "customer does not resolve".

**Required inputs**

- `RELEASE_CUSTOMER_ID` — the account that gives up the number.
- `RELEASE_REASON` — free text, mandatory, recorded in the audit row. Missing
  either → log an error and return, writing nothing.

**Guards, all evaluated before any write**

1. The customer resolves (NOT_FOUND → clean stop; any other error → rethrow).
2. The customer actually has a phone. If it is already null, print that and
   stop — nothing to do, and this must not be reported as a failure.
3. **The phone must genuinely be duplicated.** Count other `has_account: true`
   customers holding the exact same phone string. If that count is zero,
   **REFUSE** — releasing a number no one else holds would lose it outright.
   This is the load-bearing safety property of this script: it can only ever
   release a number that survives on at least one other account, which is also
   what makes the operation reversible without stashing the number anywhere.
   Use exact-string matching, the same basis `report-duplicate-phones.ts` uses,
   so this predicts the same grouping the future index will enforce.

**Dry run is the default.** Print: id, masked phone (last 4), email shape hint,
`has_account`, how many other accounts hold the same number, and whether
`phone_verified_at` is currently set — then stop, having written nothing.

**Apply** only when `CONFIRM_RELEASE` equals the customer id exactly (never
`yes`/`1`). On mismatch, print both values and refuse.

**Writes, in this order**

1. `customers.updateCustomers(customerId, { phone: null })`
2. Clear the verification stamp: read the customer's
   `customer_account_state` row; if one exists with a non-null
   `phone_verified_at`, update it to `phone_verified_at: null`. If no row
   exists, do nothing — absence already means unverified. Do **not** create a
   row. Comment why this is required here even though the delete path skips it
   (the account stays active; money gates read that flag).
3. Append one `admin_action_audit` row: `entity_type: 'customer'`,
   `entity_id: <customerId>`, `action: 'edit'`, the mandatory reason, and an
   `admin_id` identifying this as an operator script run. Match how the
   existing audit writers in `service.ts` populate the row. If a required
   field has no sensible value for a script context, STOP and report rather
   than inventing one.

Then re-read the customer and print the masked phone after, distinguishing a
genuine release (`(none)`) from a failed verification read
(`(unreadable — verify manually)`), exactly as the delete script does.

Never print a full phone number or a whole email address.

### Step 2: Unit-test the guards

Create the spec with a mocked container. Assert on actual mock calls, not
merely that nothing threw. Cases:

1. `RELEASE_CUSTOMER_ID` unset → no service call.
2. `RELEASE_REASON` unset → no write.
3. Target phone already null → clean stop, no write.
4. **Phone not duplicated (no other account holds it) → REFUSES, no write.**
5. Dry run (no `CONFIRM_RELEASE`) → duplicate check runs, no write.
6. `CONFIRM_RELEASE` wrong id → refuses, no write.
7. `CONFIRM_RELEASE` correct → `updateCustomers` called once with
   `{ phone: null }`, the verified stamp cleared, one audit row appended.
8. `phone_verified_at` already null → no account-state write, and no row created.
9. Generic (non-NOT_FOUND) lookup error → surfaces as a failure, no write.

## Done criteria

- [ ] `corepack yarn check-types` exits 0
- [ ] Script spec passes, ≥9 cases
- [ ] `--testPathPatterns "delete-customer-account"` still passes
- [ ] `grep -c "CONFIRM_RELEASE" src/scripts/release-customer-phone.ts` → ≥2
- [ ] The duplicate-count guard exists and refuses on zero (case 4 proves it)
- [ ] No file outside the two in-scope paths is modified (`git status`)
- [ ] The script was NOT executed against any database

## STOP conditions

- The duplicate-count guard cannot be implemented against the customer module's
  read API — report what is available instead of weakening it to a no-op.
- `admin_action_audit` requires a field you cannot populate honestly from a
  script context.
- Clearing `phone_verified_at` would need a new service method on
  `PacksModuleService` — report first; do not add methods to `service.ts`
  (it is ~9,300 lines and under an extraction plan).
- Anything asks you to run the script or write to real data.

## Maintenance notes

- The duplicate-count guard is the reason this script needs no backup of the
  released number: the number provably still exists on another account.
- Once the partial unique index on `customer(phone)` lands, this script is what
  an operator uses to clear a collision before the migration runs.
