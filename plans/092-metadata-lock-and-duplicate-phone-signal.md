# Plan 092: Serialize the customer-metadata read-modify-write, and make a duplicate-phone dead end visible

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat db2767f5..HEAD -- backend/packages/api/src/api/store/credits/withdraw/accounts backend/packages/api/src/api/store/profile backend/packages/api/src/api/store/phone-verification/start`
> On any mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `db2767f5`, 2026-08-07

## Why this matters

Two small, independent correctness gaps that share a theme: something can go
wrong silently.

**1. Lost updates on `customer.metadata`.** Saved bank accounts live in
`customer.metadata.bank_accounts` and are written with an unlocked
read-modify-write of the **whole** JSONB blob. The avatar route does the same
spread-merge on the same blob. So an avatar upload landing between a saved-
account read and its write silently drops the just-saved bank account, or vice
versa. The same window also lets concurrent POSTs exceed
`MAX_SAVED_BANK_ACCOUNTS`. No confidentiality or money impact — a lost update
on a convenience store — but the user sees an account they saved simply not be
there.

The repo already solved exactly this shape elsewhere: `setPayoutDetails`
(`service.ts:2289+`) takes a `payout:${customerId}` advisory lock precisely
because "the list-then-create still needs a lock".

**2. A duplicate-phone account cannot use phone recovery, and nobody finds
out.** When `POST /store/phone-verification/start` is called with
`purpose: 'password-reset'` and the phone matches zero or two-plus accounts, it
returns `{ ok: true }` and **sends no SMS**. The user is told "we'll text you a
code" and waits for a message that was never sent. Nothing is logged. If they
persist, `password-reset` 400s permanently on a multi-match.

The identical-200 response is **correct and must stay** — it is the
anti-enumeration property. What is missing is a log line so support can
diagnose the dead end.

Duplicate rows are plausible: the `change` route blocks _creating_ one but its
own comment accepts that duplicates may already exist from legacy data, and
`blockUnverifiedPhoneWrite` only refuses direct `/me` phone writes **while the
flag is on** — so anything written before 2026-08-04, or during the 2026-08-07
window when both flags were `false`, could carry an unproven or duplicated
number.

## Current state

### The unlocked read-modify-write (`store/credits/withdraw/accounts/route.ts`)

- `loadAccounts` at :96 returns `{ accounts, metadata }` — read the whole
  function.
- The cap check at :171-176 uses `MAX_SAVED_BANK_ACCOUNTS` (declared at :26).
- The writes at :182 and :207 spread the previously-read blob:

```ts
    metadata: { ...metadata, bank_accounts: next },
```

### The other writer of the same blob

`backend/packages/api/src/api/store/profile/avatar/route.ts` around :132-140 —
read it; it performs the same spread-merge. Check whether a frame route does
too (`ls backend/packages/api/src/api/store/profile/`).

### The lock idiom to copy (`service.ts:2289-2307`)

Read `setPayoutDetails`. It is `@InjectTransactionManager()` and takes
`pg_advisory_xact_lock(hashtextextended('payout:' || customerId, 0))`. The
generic form appears at `service.ts:867-871`.

**Constraint**: `service.ts:4979-4983` records the invariant "at most one
`credit:` advisory lock held per transaction, ever". A new `metadata:` lock is
a different key namespace and does not violate it — but do **not** take a
`credit:` lock here, and do not nest this inside a transaction that already
holds one.

### The silent branch (`store/phone-verification/start/route.ts:33-49`, verbatim)

```ts
const logger = req.scope.resolve('logger') as { warn: (msg: string) => void };

if (purpose === 'password-reset') {
  const customerService: ICustomerModuleService = req.scope.resolve(
    Modules.CUSTOMER,
  );
  const matches = await customerService.listCustomers(
    { phone, has_account: true } as unknown as CustomerFilters,
    { select: ['id'], take: 2 },
  );
  if (matches.length !== 1) {
    // Zero matches: don't text strangers. Two+: ambiguous, the check step
    // would refuse anyway. Same 200 either way — no oracle. Timing skew vs
    // the Twilio call exists; accepted (the email flow has the same shape:
    // core 201s unknown emails without sending).
    res.json({ ok: true });
    return;
  }
}
```

A `logger` with a `warn` method is **already resolved** on line 33 — the fix is
one call.

### Repo conventions to match

- Advisory locks are namespaced by a `prefix:${id}` string hashed with
  `hashtextextended`.
- Log lines carry a bracketed prefix and never contain PII. A phone number is
  PII; a match **count** is not.
- Backend source is Prettier-formatted with single quotes.

## Commands you will need

| Purpose                | Command                                                                                                                               | Expected on success |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Backend typecheck      | `cd backend/packages/api && corepack yarn check-types`                                                                                | exit 0              |
| Accounts + phone tests | `cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest "accounts\|phone" --runInBand --forceExit` | all pass            |
| Backend unit tier      | `cd backend/packages/api && corepack yarn test:unit`                                                                                  | all pass            |
| Backend lint | NONE. `backend/packages/api` has no eslint config and no `lint` script, so `turbo run lint` skips it and CI never lints this package. Do NOT author one — out of scope. | n/a |

## Scope

**In scope**:

- `backend/packages/api/src/modules/packs/service.ts` (one small locked helper)
- `backend/packages/api/src/api/store/credits/withdraw/accounts/route.ts`
- `backend/packages/api/src/api/store/profile/avatar/route.ts` (and the frame
  route if it does the same merge)
- `backend/packages/api/src/api/store/phone-verification/start/route.ts` (one
  log line)
- The matching `__tests__` specs
- `plans/README.md` (status row)

**Out of scope**:

- Moving saved accounts out of `customer.metadata` into their own table. That
  is the better long-term fix and is recorded in plan 087's notes; it needs a
  migration and touches the admin surface.
- The anti-enumeration response shape. **Do not** change the 200, add a
  distinct status code, or vary the body.
- Running any query against production to find duplicate rows — write the
  query into your completion note instead (see Step 3).
- Anything about the phone-change or password-reset routes themselves (plan 080).

## Git workflow

- Branch: `advisor/092-metadata-lock-and-dup-phone-signal`
- Conventional commits, e.g.
  `fix(store): serialize customer-metadata writes; log the duplicate-phone dead end`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a locked metadata mutator

Add a service method (e.g. `mutateCustomerMetadata(customerId, mutate)`)
decorated `@InjectTransactionManager()` that:

1. takes `pg_advisory_xact_lock(hashtextextended('metadata:' || customerId, 0))`
   using the idiom at `service.ts:867-871`;
2. reads the customer's current metadata **inside** the lock;
3. applies the caller's pure `mutate(metadata) => metadata` function;
4. writes the result.

The read must happen inside the lock — a mutator that takes the lock and then
uses a blob the caller read earlier fixes nothing.

Write a comment naming the concrete failure it prevents (an avatar upload
dropping a just-saved bank account) and pointing at `setPayoutDetails` as the
precedent.

**Verify**: `corepack yarn check-types` → exit 0.

### Step 2: Route every metadata writer through it

Convert the two writes in `accounts/route.ts` and the avatar route (and the
frame route if applicable). Move the cap check **inside** the mutate callback,
so `MAX_SAVED_BANK_ACCOUNTS` is enforced under the lock rather than against a
stale read.

Then grep for any other writer:

```
grep -rn "metadata: {" backend/packages/api/src/api --include=route.ts
```

Convert every hit that spread-merges customer metadata. List them in your
completion note.

**Verify**: `corepack yarn check-types` → exit 0; the grep above returns only
converted call sites.

### Step 3: Log the duplicate-phone dead end

In the `matches.length !== 1` branch, add a `logger.warn` carrying the **match
count only** — never the phone number. Something like:

```
[phone-otp] password-reset start matched ${matches.length} accounts — no SMS sent
```

Extend the existing comment with one sentence: the identical 200 is the
anti-enumeration property and stays; the log is the diagnosability that was
missing.

Then write the operator query into your completion note (do **not** run it):

```sql
SELECT phone, count(*) FROM customer
WHERE has_account AND phone IS NOT NULL
GROUP BY phone HAVING count(*) > 1;
```

**Verify**: `corepack yarn check-types` → exit 0;
`grep -n "logger.warn" backend/packages/api/src/api/store/phone-verification/start/route.ts`
returns a match.

## Test plan

Cases (all required):

1. **Concurrency**: two metadata mutations interleaved — both survive. If the
   unit harness cannot model true concurrency, assert instead that the mutator
   reads inside the lock (e.g. the read is called _after_ the lock statement,
   asserted on the mock's call order) and say plainly in your completion note
   that the test pins the ordering, not the race. Do not claim a race is
   covered when it is not.
2. The account cap is enforced from the value read **inside** the mutator, not
   from a caller-supplied blob.
3. Adding an account still returns the same response shape as before (no
   contract change).
4. Avatar update preserves an existing `bank_accounts` key (the cross-writer
   case, expressed as a single-threaded assertion on the mutate function).
5. `start` with `purpose: 'password-reset'` and zero matches → `{ ok: true }`,
   `sendPhoneOtp` **not** called, and a warn logged.
6. Same with two matches → identical response, warn logged with count 2.
7. Exactly one match → **no** warn, SMS sent. (Guards against logging on the
   happy path.)
8. No log line anywhere contains the phone number — assert on the logger mock's
   argument.

Prove case 8 red-green by temporarily interpolating the phone into the warn;
confirm the test fails; restore; confirm it passes. Report both.

Verification:
`cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest "accounts\|phone" --runInBand --forceExit`
→ all pass.

## Done criteria

- [ ] `cd backend/packages/api && corepack yarn check-types` exits 0
- [ ] `cd backend/packages/api && corepack yarn test:unit` exits 0
- [ ] Every customer-metadata spread-merge in `src/api` goes through the locked mutator; the converted sites are listed in the completion note
- [ ] The account cap is checked inside the lock (asserted by test 2)
- [ ] No log line contains a phone number (asserted by test 8), with the red-green proof reported
- [ ] The `start` route's response shape is unchanged in all three branches
- [ ] The duplicate-phone operator query is in the completion note and was **not** run
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- A metadata writer turns out to live inside a transaction that already holds a
  `credit:` advisory lock. Report it — nesting locks across namespaces in one
  transaction is how the round-6 `matureDueCommissions` incident happened.
- Converting the avatar route changes its response or its error handling in any
  way. It is in scope only for the metadata write.
- You find that `customer.metadata` is written from the admin side too. Report
  it; an admin writer racing a customer writer is the same bug with a wider
  blast radius, and whether to convert it is a scope decision.

## Maintenance notes

- **Any future feature that stores something in `customer.metadata` must use
  the mutator.** The blob is shared by avatar, frame, and bank accounts today;
  every new key makes an unlocked spread-merge more likely to lose data.
- The real fix is a table per concern; this is the cheap correct-behaviour
  version. Plan 087's notes carry the storage-migration constraints.
- **The identical 200 on the duplicate-phone branch is a security property, not
  an oversight.** Anyone tempted to return a helpful error there is
  reintroducing a phone-enumeration oracle.
- A reviewer should scrutinize: that the metadata read happens inside the lock
  (not before it), that the cap moved inside the mutator, and that no log line
  carries PII.
