# Plan 088: Bind a payout to a saved, cooled-off destination instead of the request body

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **This plan changes user-visible behaviour on the first-withdrawal flow.**
> The operator has approved the direction; the specific durations and copy in
> Step 1 are still theirs to confirm. If you reach Step 1 and the decision is
> not recorded anywhere, that is a STOP condition — not a guess.
>
> **Drift check (run first)**:
> `git diff --stat db2767f5..HEAD -- backend/packages/api/src/api/store/credits/withdraw backend/packages/api/src/modules/packs/globepay-withdrawal.ts src/app/bank-withdrawal src/app/\(account\)/bank`
> On any mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M–L
- **Risk**: MED (behavioural change on a live money path)
- **Depends on**: plan 082 (it moves the gate into a locked service method; do
  082 first so this plan's checks land inside that transaction rather than
  creating a second unlocked window)
- **Category**: security
- **Planned at**: commit `db2767f5`, 2026-08-07

## Why this matters

Every payout takes its destination — bank code, account number, account holder
name — **from the request body**, on every call. The values are shape-validated
and sent straight to the gateway. Nothing checks the destination against
anything the customer previously registered or that anyone verified.

So a single stolen or replayed customer bearer token cashes out to an
attacker-controlled bank account in **one request**: no destination
cooling-off, no step-up re-auth, no match against the account holder's own
identity. It also quietly undercuts the playthrough gate, which the code
describes as the anti-laundering control on the assumption that money returns
to the depositor — here it can go to an arbitrary third party.

The saved-accounts store exists but is explicitly documented as _not_ the
enforcement point (`accounts/route.ts:15-19`: "This is a CONVENIENCE store,
not the enforcement point"). Separately, `player_payout_details` — the repo's
only operator-verified destination record, written by
`service.ts:2289+` under a `payout:${customerId}` advisory lock — is read by
an admin route and by **nothing on the money path**. The system has a notion
of a verified destination and does not use it.

After this plan: a payout resolves its destination server-side from a saved
account the session owns, a newly-added destination cannot receive money
immediately, and adding one notifies the account.

## Current state

### The route passes the body straight through (`store/credits/withdraw/route.ts:47-57`, verbatim)

```ts
  const result = await startGlobePayWithdrawal(
    req.scope,
    {
      customerId,
      amount: body.amount,
      bankCode: body.bank_code,
      accountNumber: body.account_number,
      accountHolderName: body.account_holder_name,
      ipAddress,
    },
    notifyUrl,
```

and `body` is typed at :22-27 as four `unknown` fields read from the request.

### Validation is shape-only (`modules/packs/globepay-withdrawal.ts:181-187`)

`withdrawalDetailsError(input)` checks the bank code against
`/^[A-Z0-9]{2,20}$/`, the account number against `/^[0-9]{6,34}$/`, and the
holder name's length. Read it. There is no ownership or history check.

### The saved-accounts store

`backend/packages/api/src/api/store/credits/withdraw/accounts/route.ts`:

- header comment at :9-23 (quoted in "Why this matters") — read it in full;
- `MAX_SAVED_BANK_ACCOUNTS = 5` at :26;
- storage is `customer.metadata.bank_accounts`, read-modify-written at
  :163-183 and :207;
- a deterministic id derived from bank + account number (see the doc comment
  at :36-40), so re-adding an existing account is idempotent;
- all three handlers key strictly on `req.auth_context.actor_id`, with an
  empty-`actor_id` guard at :85-92.

### The unused verified-destination record

`backend/packages/api/src/api/admin/customers/[id]/payout-details/route.ts`
and `service.ts:2289+` (`setPayoutDetails`, locked on `payout:${customerId}`).
Read both before Step 1 — whether this becomes the destination of record is
part of the decision.

### Repo conventions to match

- Money-path validation lives in `globepay-withdrawal.ts`; the route is thin.
- Customer identity comes only from `req.auth_context.actor_id`, never the body.
- Storefront money forms duplicate server checks for UX only; the server is
  always authoritative (see `src/app/bank-withdrawal/WithdrawForm.tsx:87-110`).
- Backend: Prettier, single quotes. Storefront: `npm run format:check` gates CI
  and `npm run check` does **not** run it.

## Commands you will need

| Purpose           | Command                                                                                                                      | Expected on success |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Backend typecheck | `cd backend/packages/api && corepack yarn check-types`                                                                       | exit 0              |
| Withdrawal tests  | `cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest withdraw --runInBand --forceExit` | all pass            |
| Backend unit tier | `cd backend/packages/api && corepack yarn test:unit`                                                                         | all pass            |
| Backend lint | NONE. `backend/packages/api` has no eslint config and no `lint` script, so `turbo run lint` skips it and CI never lints this package. Do NOT author one — out of scope. | n/a |
| Storefront gates  | `npm run typecheck && npm test && npm run format:check`                                                                      | all exit 0          |

## Scope

**In scope**:

- `backend/packages/api/src/api/store/credits/withdraw/route.ts`
- `backend/packages/api/src/api/store/credits/withdraw/accounts/route.ts`
- `backend/packages/api/src/modules/packs/globepay-withdrawal.ts`
- `backend/packages/api/src/modules/packs/service.ts` (only if the cooling-off
  timestamp needs a service-side read)
- The matching `__tests__` specs
- `src/app/bank-withdrawal/WithdrawForm.tsx`, `src/app/(account)/bank/BankAccountsClient.tsx`
- `plans/README.md` (status row)

**Out of scope**:

- Encrypting stored account numbers (deferred by plan 087).
- Moving saved accounts out of `customer.metadata` — plan 092 fixes the
  concurrency hazard in place; the storage migration is separate work.
- `player_payout_details` becoming the single destination of record — see
  Step 1; if the operator picks that direction, **stop and re-plan**, because
  it changes the admin surface too.
- The gate/lock/cap work in plan 082.

## Git workflow

- Branch: `advisor/088-bind-payout-destination`
- Conventional commits, e.g.
  `feat(payments): pay out only to a saved, cooled-off destination`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: The policy — DECIDED 2026-08-07, do not re-ask

The operator answered all three. **These are the parameters; build to them.**

1. **Cooling-off duration: 24 hours.** A newly saved destination cannot receive
   a payout until 24h after it was saved. Make it an env-tunable constant
   (`PAYOUT_DESTINATION_COOLDOWN_HOURS`, default 24), read **per call** per the
   plan-066 convention, so support can shorten it without a redeploy of code.
2. **Grandfathering: backfill.** Any bank destination already used by a
   **settled** withdrawal is backfilled as saved-and-already-cooled, so
   existing customers are not delayed on their next payout. Ship the backfill
   as a `medusa exec` script under `backend/packages/api/src/scripts/` — that
   directory has several precedents; read one and match its shape. **Do NOT run
   it** against any database; it ships with the change and the operator runs
   it. It must be idempotent: reuse the existing deterministic saved-account id
   derivation (bank code + account number, see `accounts/route.ts:36-40`) and
   re-running it will then be a no-op rather than creating duplicates.
3. **`player_payout_details` stays admin-only.** It does **not** become the
   destination of record in this plan. Leave it untouched.

**Verify**: the cooldown constant exists, is env-tunable and is read per call;
the backfill script exists, is idempotent, and was NOT executed.

### Step 2: Add `saved_at` / `usable_from` to the saved-account shape

`SavedBankAccount` (`accounts/route.ts:28-34`) has no timestamp. Add one when
an account is created, and derive usability from it rather than storing a
second flag (a stored flag needs a job to flip it; a derived one does not).

Existing saved accounts have no timestamp — decide per Step 1's answer 2 and
comment the choice. Whatever you choose, an account with a **missing**
timestamp must resolve deterministically; do not let `undefined` mean "usable"
by accident.

**Verify**: `corepack yarn check-types` → exit 0; the parse helper
(`parseSavedBankAccounts`) tolerates rows without the new field.

### Step 3: Make the withdrawal route resolve the destination server-side

Change the request contract: the body carries an **account id**, not bank
details. Then:

1. Load the caller's saved accounts by `req.auth_context.actor_id` — reuse the
   `loadAccounts` choke point in `accounts/route.ts` rather than re-reading
   metadata (export it if it is currently module-private).
2. Find the account by id. Not found → `MedusaError.Types.INVALID_DATA`,
   `'Select a saved bank account.'`
3. Cooling-off not elapsed → `MedusaError.Types.NOT_ALLOWED` with a message
   naming when it becomes usable.
4. Pass the **resolved** bank code / number / holder name into
   `startGlobePayWithdrawal`. The existing `withdrawalDetailsError` shape
   validation stays as a belt-and-braces check on the stored values.

Keep the resolution **inside** the transaction plan 082 introduces, so the
destination cannot change between check and debit. If 082 has not landed,
STOP — this plan depends on it.

**Verify**: `corepack yarn check-types` → exit 0;
`grep -n "body.account_number\|body.bank_code" backend/packages/api/src/api/store/credits/withdraw/route.ts`
returns **no** matches.

### Step 4: Notify on a new saved destination

When `POST .../accounts` adds an account, notify the account by **email**
(plus a feed row), the same way plan 080 notifies on a phone change. Read
`backend/packages/api/src/subscribers/` for the pattern and follow it: emit
after the write commits, never throw, never include the full account number
(last 4 only).

If plan 080 has landed, reuse whatever helper it introduced rather than
duplicating.

**Verify**: `corepack yarn check-types` → exit 0.

### Step 5: Update the storefront

- `src/app/bank-withdrawal/WithdrawForm.tsx`: submit an account id; render the
  cooling-off state (a saved-but-not-yet-usable account should be visible and
  disabled, with the time it becomes usable — not hidden, which reads as a
  bug).
- `src/app/(account)/bank/BankAccountsClient.tsx`: show the same state on the
  bank-accounts management screen.
- Match the existing components' conventions; do not restyle.

**Verify**: `npm run typecheck && npm test && npm run format:check` → all exit 0.

## Test plan

Backend cases (all required):

1. Withdrawal with an account id the session owns, past cooling-off → succeeds
   and the gateway receives the **stored** bank details.
2. Withdrawal with an account id belonging to **another** customer → rejected,
   no debit. This is the IDOR guard and must fail if Step 3 is reverted.
3. Withdrawal with an account id inside the cooling-off window → rejected with
   the timing message, no debit.
4. Withdrawal with bank details in the body and **no** id → rejected (the old
   contract must be gone, not merely unused).
5. A saved account with a missing timestamp resolves per Step 2's documented
   rule — assert the rule explicitly, whichever way it went.
6. Adding an account emits the notification; a notification failure does not
   fail the add.

Storefront: assert the form submits an id, and that a cooling-off account
renders disabled with its usable-from time.

Prove case 2 red-green. Report both directions.

## Done criteria

- [ ] `cd backend/packages/api && corepack yarn check-types` exits 0
- [ ] `cd backend/packages/api && corepack yarn test:unit` exits 0
- [ ] `npm run typecheck && npm test && npm run format:check` all exit 0
- [ ] The withdrawal route reads no bank details from the body (grep from Step 3)
- [ ] Cross-customer account id is rejected (test 2), with the red-green proof reported
- [ ] The cooldown is env-tunable and read per call; the backfill script exists, is idempotent, and was NOT executed
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The backfill turns out to need production data you cannot see to be written
  correctly. Ship the script, report what it assumes, and let the operator run
  it — **never run it yourself**.
- Plan 082 has not landed (this plan's resolution must live inside its
  transaction).
- The operator's answer to Step 1.3 is that `player_payout_details` becomes the
  destination of record — the plan needs rewriting, not adapting.
- A backfill turns out to be required and would touch production data. Write
  the query, report it, and stop; do not run it.
- You find an existing withdrawal path that does not route through
  `startGlobePayWithdrawal`.

## Maintenance notes

- **The convenience-store comment at `accounts/route.ts:15-19` becomes wrong
  the moment this lands.** Rewrite it in the same commit; leaving it is worse
  than never having had it, because the next reader will trust it.
- The cooling-off window is the whole point: it converts "steal a token, cash
  out" into "steal a token, wait a day, and hope the owner ignored the email".
  A future "skip cooling-off for trusted customers" feature would remove that
  property — if it is ever proposed, it needs its own threat model.
- A reviewer should scrutinize: that the account is resolved inside plan 082's
  locked transaction, that the cross-customer case is genuinely tested (not
  vacuously passing because the fixture has one customer), and that a missing
  timestamp cannot mean "usable".
- **Deferred**: step-up re-auth (password or OTP) at payout time, on top of the
  destination binding. That is a stronger control and a bigger UX change;
  cooling-off plus notification buys most of the protection for far less
  friction.
