# Plan 087: Shrink the plaintext bank-account footprint — mask the admin list, stop logging decrypted bank details

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat db2767f5..HEAD -- backend/packages/api/src/api/admin/globepay backend/packages/api/src/api/hooks/globepay/deposit backend/packages/api/src/api/middlewares.ts backend/apps/admin/src`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none (touches the same deposit hook file as plans 083/084 —
  coordinate the order if several are executed)
- **Category**: security
- **Planned at**: commit `db2767f5`, 2026-08-07

## Why this matters

Customer bank account numbers are stored and served in the clear in more
places than they need to be, and one of them is a log.

The repo already knows the right posture and applies it in the highest-risk
place: the withdrawal ledger deliberately stores `account_last4` only, with a
comment saying the full number stays off customer- and operator-visible
surfaces. But:

1. **The admin withdrawals list returns every listed customer's full account
   number**, up to 100 rows per request. One admin session, or one exported
   response, yields bank details in bulk rather than last-4s. The route
   already sets `no-store` and cites CWE-524 — it took the caching half of the
   problem seriously and not the minimization half.
2. **The deposit callback decrypts the receiving bank details and writes them
   whole to the logger.** The route's own comment identifies the contents. Logs
   have a wider access population and a longer retention than the database, so
   this defeats the minimization applied elsewhere. The field is also
   _unsigned_ — the route's own SIGNED-vs-UNSIGNED analysis establishes that
   only `Data` is covered by the signature — so the logged content is not even
   authenticated.

Deliberately **not** inflated: these are Malaysian bank account numbers, not
card PANs; there is no PCI mandate here. The full-encryption-at-rest work is
scoped out of this plan (see "Out of scope") because it needs a decrypt seam
the admin dispute view depends on. This plan takes the two cheap, high-value
reductions.

## Current state

### The admin list response (`api/admin/globepay/withdrawals/route.ts:103-127`, verbatim)

```ts
const withdrawals = rows.map((r) => ({
  id: r.id,
  merchant_transaction_id: r.merchant_transaction_id,
  gateway_transaction_id: r.gateway_transaction_id,
  customer_id: r.customer_id,
  customer_email: emailById.get(r.customer_id) ?? null,
  // bigNumber columns come back as strings/BigNumber — normalize for display.
  amount: Number(r.amount),
  bank_code: r.bank_code,
  account_number: r.account_number,
  account_holder_name: r.account_holder_name,
  status: r.status,
  gateway_status: r.gateway_status,
  created_at: r.created_at,
  settled_at: r.settled_at,
  stale:
    r.status === 'pending' &&
    now - new Date(r.created_at).getTime() > GLOBEPAY_STALE_AFTER_MS,
}));

// Identity-varying response carrying emails and full bank accounts
// (CWE-524): a cached copy could outlive the admin session in a shared
// browser profile. Same rule as the store saved-accounts route.
res.setHeader('Cache-Control', 'no-store');
res.json({ total, offset, limit, status, withdrawals });
```

### The log line (`api/hooks/globepay/deposit/route.ts:316-328`, verbatim)

```ts
// AdditionalInformationData is decrypted for logging only — it carries the
// receiving bank details (§1.2.4), never anything the credit depends on.
if (body.AdditionalInformationData) {
  try {
    req.scope
      .resolve('logger')
      .info(
        `[globepay] ${merchantTransactionId} extra: ${aesDecrypt(body.AdditionalInformationData, config.aesKey)}`,
      );
  } catch {
    // Non-fatal: the credit is committed; bad extra data must not undo it.
  }
}
```

Nothing downstream consumes this block — it is `info`-level logging only.

### The posture to match (`modules/packs/service.ts:1104-1108`)

Read it. The withdrawal ledger records `account_last4` with a comment
explaining why the full number does not belong on operator-visible surfaces.
Your masking helper should produce the same shape so the two agree.

### Repo conventions to match

- `/hooks/*` routes answer a gateway and never throw `MedusaError`.
- Admin list routes cap pagination and set `no-store`; both already hold here.
- Backend source is Prettier-formatted with single quotes; the admin SPA
  (`backend/apps/admin/src`) is a separate vite/React workspace with its own
  lint. Its check-types runs inside its build — see the commands table.

## Commands you will need

| Purpose                                                                                       | Command                                                                                                                               | Expected on success |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Backend typecheck                                                                             | `cd backend/packages/api && corepack yarn check-types`                                                                                | exit 0              |
| Admin typecheck (pinned tsc — a global TypeScript 7 shadows the repo's 5.9.3 on this machine) | `cd backend/apps/admin && ./node_modules/.bin/tsc --noEmit` (if that path does not exist, use `../../node_modules/.bin/tsc --noEmit`) | exit 0              |
| Admin unit tests                                                                              | `cd backend/apps/admin && npx vitest run`                                                                                             | all pass            |
| Backend unit tier                                                                             | `cd backend/packages/api && corepack yarn test:unit`                                                                                  | all pass            |
| Backend lint | NONE. `backend/packages/api` has no eslint config and no `lint` script, so `turbo run lint` skips it and CI never lints this package. Do NOT author one — out of scope. | n/a |

## Scope

**In scope**:

- `backend/packages/api/src/api/admin/globepay/withdrawals/route.ts`
- `backend/packages/api/src/api/admin/globepay/withdrawals/__tests__/list.unit.spec.ts` (extend)
- `backend/packages/api/src/api/hooks/globepay/deposit/route.ts` (the logging block only)
- `backend/packages/api/src/api/hooks/globepay/deposit/__tests__/route.unit.spec.ts` (extend)
- `backend/packages/api/src/api/middlewares.ts` — **one new matcher only**, for
  the Step-3 reveal route (registering it on the admin action limiter). Do not
  touch any existing matcher.
- The admin SPA page that renders the withdrawals list — find it with
  `grep -rn "account_number" backend/apps/admin/src`
- `plans/README.md` (status row)

**Out of scope** (do NOT attempt here):

- **Encrypting `globepay_withdrawal.account_number` at rest.** It needs a
  decrypt seam that the admin dispute view and the sweep's ledger payload both
  depend on, plus a migration and a backfill. That is its own plan; this one
  deliberately takes only the reductions that need no schema change.
- **Moving saved accounts out of `customer.metadata`.** Same reason — plan 092
  takes the concurrency half of that problem, and the storage move is a
  separate piece of work.
- The deposits admin route unless it also returns a full account number — check
  it (`grep -n "account" backend/packages/api/src/api/admin/globepay/deposits/route.ts`)
  and include it only if it does.
- The store-side `accounts` GET, which returns full numbers to **the owner**.
  That is correct: a customer picking their own saved account needs to
  recognise it.

## Git workflow

- Branch: `advisor/087-bank-pii-footprint`
- Conventional commits, e.g.
  `fix(payments): mask bank numbers in the admin list and stop logging bank details`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Drop the decrypted-bank-details log block

Delete the block quoted above, or replace it with a redacted projection —
prefer **deletion**, since nothing consumes it and the safest log line is the
one that does not exist.

If you keep a line, it may contain only: the `merchantTransactionId`, whether
the field was present, and at most the last 4 digits of any account number in
it. Parsing an unsigned blob to extract a substring is more code and more risk
than deleting it; justify in the commit message if you go that way.

Leave a short comment where the block was, recording that
`AdditionalInformationData` is unsigned and carries bank details, so a future
reader does not re-add the log.

**Verify**: `grep -n "AdditionalInformationData" backend/packages/api/src/api/hooks/globepay/deposit/route.ts`
shows no `aesDecrypt(...)` inside a logger call.

### Step 2: Mask the account number in the admin list

Add a masking helper (last 4 digits, e.g. `••••1234`) and use it for
`account_number` in the mapped response. Keep the field name so the SPA does
not break on a rename; add a sibling boolean or a separate `account_last4`
field only if the SPA needs to distinguish.

Match the last-4 derivation the ledger already uses
(`service.ts:1104-1108`) so the two surfaces agree on what "last 4" means for
a short account number — read it and copy the edge-case handling rather than
writing your own `slice(-4)`.

**Verify**: `corepack yarn check-types` → exit 0.

### Step 3: Add an explicit per-row reveal

Operators genuinely need the full number to chase a disputed payout, so
masking without a reveal path just moves the work to the database console.

Add a dedicated endpoint that returns the full number for **one** row —
`GET /admin/globepay/withdrawals/:id/account` or similar. Requirements:

- one row per request (no bulk),
- `no-store`, matching the list route,
- registered on the admin action rate limiter in
  `backend/packages/api/src/api/middlewares.ts` alongside its siblings — read
  the existing admin matchers around the money-mutation limiter first and
  match their shape,
- a log line recording that an operator revealed a number (row id + admin
  actor id, **never** the number itself), so the access is auditable.

Then wire a "Reveal" control into the admin SPA row. Match the existing table's
component conventions — read a neighbouring admin page before writing any
markup, and do not restyle anything.

**Verify**: `corepack yarn check-types` → exit 0; the admin typecheck and
vitest commands both pass; `grep -n "globepay/withdrawals" backend/packages/api/src/api/middlewares.ts`
shows the new matcher.

### Step 4: Tests

See "Test plan", then run the gates.

## Test plan

Extend the existing specs; read each first.

Backend cases (all required):

1. The admin list response's `account_number` is masked — assert it does
   **not** equal the seeded full number and does contain its last 4. This must
   fail if Step 2 is reverted.
2. `account_holder_name` is unchanged (masking must not over-reach; operators
   match by name).
3. The reveal endpoint returns the full number for a single id.
4. The reveal endpoint is rejected without admin auth. If the spec harness
   cannot exercise auth, assert instead that the matcher is registered and say
   plainly that auth is covered by the framework's `/admin` guard, not by this
   test.
5. Deposit hook: a callback carrying `AdditionalInformationData` produces **no**
   log line containing the decrypted content. Assert on the logger mock's
   calls; this is the regression guard for Step 1.

Admin SPA: add or extend a test asserting the masked value renders and the
reveal control exists. If the SPA has no test for this table, say so rather
than building a harness — note it as a gap in your completion note.

Prove case 1 red-green. Report both directions.

Verification:
`cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest globepay --runInBand --forceExit`
→ all pass; plus the admin commands from the table.

## Done criteria

- [ ] `cd backend/packages/api && corepack yarn check-types` exits 0
- [ ] `cd backend/packages/api && corepack yarn test:unit` exits 0
- [ ] Admin typecheck and `npx vitest run` both pass
- [ ] No logger call in `hooks/globepay/deposit/route.ts` contains an `aesDecrypt` result
- [ ] The admin list's `account_number` is masked (asserted by test 1)
- [ ] The reveal endpoint exists, is single-row, is rate-limited, and logs the access without the number
- [ ] The red-green proof for test 1 is reported
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- The admin SPA turns out to _depend_ on the full `account_number` for
  something other than display (a copy-to-clipboard used in an operator
  workflow, a CSV export). Report what it is — masking a value an operator
  workflow needs would push them to the database, which is worse.
- The deposits admin route also returns full account numbers **and** the SPA
  reads them — report before widening scope.
- Adding the reveal endpoint would require a new admin permission concept.
  This repo has no per-admin roles; if you find yourself inventing one, stop.

## Maintenance notes

- **Masking without a reveal path is worse than no masking** — it moves
  operators to the DB console, where nothing is audited. The reveal endpoint
  is not optional polish; it is what makes the masking survivable.
- The remaining plaintext stores (`globepay_withdrawal.account_number` and
  `customer.metadata.bank_accounts`) are **known and deliberately deferred**.
  Anyone doing the encryption-at-rest work should start from this plan's
  "Out of scope" section for the constraints.
- A reviewer should scrutinize: that the reveal log line carries no account
  number, that the mask helper agrees with the ledger's `account_last4`, and
  that `no-store` is still set on both routes.
