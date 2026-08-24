# Plan 123: Give operators an audited account-deletion path, and use it to clear the duplicate phone

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Do NOT update
> `plans/README.md`; the reviewer maintains it.
>
> **Drift check (run first)**:
> `git diff --stat d724f1e3..HEAD -- backend/packages/api/src/api/store/customers/me/delete/route.ts backend/packages/api/src/modules/packs/service.ts`
> On any change, re-read the route before proceeding.

## Status

- **Priority**: P1 (operator is blocked on a live prod data question)
- **Effort**: M
- **Risk**: MED — touches the shipped account-deletion PII path
- **Depends on**: none
- **Category**: dx / security
- **Planned at**: commit `d724f1e3`, 2026-08-23

## Why this matters

Production has exactly one duplicate phone value, shared by two accounts
(found by `report-duplicate-phones.ts`, inspected with
`inspect-duplicate-phone-pair.ts`):

- `cus_01KZDBZTJ64VGYAHHNQQZ18JWZ` — 48 pulls, RM 10,477.83 balance, active
  today. The real account.
- `cus_01M07Q2G0A7N9S0X0K2W0SFBSA` — 1 pull, RM 0, 0 deposits, never touched
  after signup. The duplicate.

The operator has decided to delete the duplicate. There is no way to do that
today:

- `POST /store/customers/me/delete` is self-service and authenticates with the
  customer's own password (`route.ts:125`). An operator does not have it.
- Medusa's stock admin customer delete is explicitly rejected by
  `docs/adr/0006-account-deletion-destroys-pii-retains-anonymous-books.md`: it
  leaves the `provider_identity` row (and the email) in the database forever
  and permanently blocks re-registration.
- `rejectAdminPhoneWrite` (plan 112) deliberately closed the admin phone route,
  and its own note records that a purpose-built audited path is the intended
  replacement. This is that path.

Deleting the duplicate also resolves the duplicate phone by design: the
deletion sequence sets `phone: null` (`route.ts:221`), which is the
precondition the follow-up unique-index migration is waiting on.

## Current state

`backend/packages/api/src/api/store/customers/me/delete/route.ts` (296 lines).
After the password check it runs this sequence, in this order — the order is
load-bearing and the ADR explains why:

1. `packs.deleteAccountPreflight(customerId)` — refuse if not `ok`
2. `packs.purgeAccountPacksData(customerId)`
3. delete notifications addressed to the email or the customer id, in
   1,000-row batches
4. `customers.deleteCustomerAddresses(...)`
5. `packs.mutateCustomerMetadata` — captures `avatar_file_id`, clears metadata
6. `customers.updateCustomers(id, { email: deleted_<id>@removed.invalid,
first_name: null, last_name: null, phone: null, company_name: null })`
7. `auth.deleteAuthIdentities(...)` — **HARD** delete, never soft (ADR: a soft
   delete keeps the email slot occupied and blocks re-registration forever)
8. `customers.softDeleteCustomers([customerId])` — **last**
9. `deleteFilesWorkflow` for the captured avatar; failure is logged, not thrown

`deleteAccountPreflight` (in `modules/packs/service.ts`) already refuses on:
account frozen, non-zero raw ledger balance (either direction), pending or held
withdrawal, pending or expired deposit, **a vaulted or delivering pull**, and a
non-terminal delivery order.

Existing coverage that must stay green:
`integration-tests/http/account-self-service.spec.ts`,
`integration-tests/http/delete-guard.spec.ts`,
`src/api/store/customers/me/__tests__/self-service.unit.spec.ts`,
`src/modules/packs/__tests__/account-lifecycle.unit.spec.ts`.

## Commands

| Purpose     | Command                                                                                                                                  | Expected            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------- |
| Typecheck   | from `backend/`: `corepack yarn check-types`                                                                                             | exit 0              |
| Unit tier   | from `backend/`: `node node_modules/jest/bin/jest.js --config packages/api/jest.config.js --testPathPatterns "self-service               | account-lifecycle"` | all pass |
| Integration | from `backend/packages/api`: the http integration script (see its `package.json`), filtered to `account-self-service` and `delete-guard` | all pass            |

jest 30 uses `--testPathPatterns` (plural). Docker `pokenic-postgres` and
`pokenic-redis` must be up for the integration tier. Backend eslint is vacuous
for `packages/api`; typecheck plus jest are the real gates.

## Scope

**In scope**:

- `backend/packages/api/src/api/utils/account-deletion.ts` (create)
- `backend/packages/api/src/api/store/customers/me/delete/route.ts` (call the
  extracted function)
- `backend/packages/api/src/scripts/delete-customer-account.ts` (create)
- A unit spec for the new script's guards

**Out of scope**:

- `deleteAccountPreflight` and `purgeAccountPacksData` — reuse, never modify,
  never bypass.
- Any change to what deletion destroys or retains (ADR 0006 governs it).
- The admin phone guard and the unique-index migration.
- Running the script. Do not execute it against any database in this session.

## Steps

### Step 1: Extract the post-auth sequence into a shared function

Create `src/api/utils/account-deletion.ts` exporting:

```ts
export type AccountDeletionResult =
  | { ok: true }
  | { ok: false; reason: string; detail: string };

export async function purgeAndDeleteAccount(
  scope: MedusaContainer,
  customerId: string,
): Promise<AccountDeletionResult>;
```

Move steps 1 to 9 above into it **verbatim** — same order, same batch size,
same hard-versus-soft delete choices, same log lines. It runs the preflight
itself and returns `{ ok: false, reason, detail }` when refused, having written
nothing.

This is code motion. Do not improve anything while moving it.

### Step 2: Make the route call it

Keep the auth/password check and the response shape exactly as they are.
Replace the moved body with a call to `purgeAndDeleteAccount`; on `!ok`, throw
the same `MedusaError(MedusaError.Types.NOT_ALLOWED, reason)` and log the same
refusal line the route logs today. The route's observable behaviour — status
codes, error codes, response JSON — must not change.

**Verify**: all four existing test files pass **unmodified**. If any needs an
edit to pass, STOP and report: that means behaviour changed.

### Step 3: The operator script

Create `src/scripts/delete-customer-account.ts`:

- Reads `DELETE_CUSTOMER_ID`. Missing → log an error and return.
- **Dry run is the default.** It resolves the customer and prints: id, masked
  phone (last 4 only), email shape hint, `has_account`, pull count, and the
  `deleteAccountPreflight` verdict — then stops, having written nothing.
- It performs the deletion only when `CONFIRM_DELETE` is set to **the customer
  id itself** (not `yes` or `1`). A mismatch prints both values and refuses.
  This is the guard against deleting the wrong account after an env-var slip.
- On confirm: call `purgeAndDeleteAccount`. If it returns `!ok`, print reason
  and detail and exit non-zero — never bypass the preflight.
- Print the masked phone before and after, so the operator can see the number
  was released.
- Never print a full phone number or a whole email address.

Model the PII masking helpers on `src/scripts/inspect-duplicate-phone-pair.ts`.

### Step 4: Unit-test the script's guards

New spec, mocked container, covering:

1. `DELETE_CUSTOMER_ID` unset → no service call at all.
2. Dry run (no `CONFIRM_DELETE`) → preflight may run, but the write path does
   NOT.
3. `CONFIRM_DELETE` set to the wrong id → refuses, no writes.
4. `CONFIRM_DELETE` matching → the deletion path is invoked exactly once.
5. Preflight refuses → no purge, non-zero exit.

Assert on actual mock calls, not merely that nothing threw.

## Done criteria

- [ ] `corepack yarn check-types` exits 0
- [ ] All four pre-existing test files pass **unmodified**
- [ ] New script spec passes, at least 5 cases
- [ ] `grep -n "softDeleteAuthIdentities" src/api/utils/account-deletion.ts` → no match (must stay the HARD delete)
- [ ] `grep -c "phone: null" src/api/utils/account-deletion.ts` → at least 1
- [ ] The route diff shows no change to status codes, error codes, or response JSON
- [ ] The script was NOT executed against any database

## STOP conditions

- Any of the four existing tests needs modification to pass.
- The extraction would reorder steps 1 to 9, or turn the hard auth-identity
  delete into a soft one.
- You are tempted to bypass or weaken `deleteAccountPreflight`.
- Anything asks you to run the script or delete real data.

## Maintenance notes

- `purgeAndDeleteAccount` is now the single definition of "delete an account".
  Future changes to deletion semantics go there, governed by ADR 0006.
- The operator script is deliberately dry-run-first with an echo-the-id
  confirm. Keep both properties if it is ever extended.
