# Plan 110: Report the duplicate-phone population that blocks the one-phone-one-account index

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 16cc85d3..HEAD -- backend/packages/api/src/api/utils/phone-claim.ts backend/packages/api/src/api/utils/phone-verification-guard.ts backend/packages/api/src/scripts/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (read-only — this plan writes no data)
- **Depends on**: none
- **Category**: security / tech-debt
- **Planned at**: commit `16cc85d3`, 2026-08-18

## Why this matters

"One phone number = one account" shipped as an application-level check
(PR #456). The code that implements it is explicit that the check is **not
atomic** and names its own backstop — a partial unique index on
`customer(phone) WHERE deleted_at IS NULL` — and names the one thing standing
between the code and that backstop: **live rows already share numbers, so
creating the index would fail until those are reconciled.** Its closing
instruction is "Dedupe, then add it."

Nothing in this repository can find those rows. There is no report, no admin
surface, no script. The stated remediation has no first step, so the documented
race (one handset, two concurrent signups inside the same 10-minute proof
window, both reads seeing zero claimants) stays open indefinitely and the
sentence "dedupe, then add it" quietly becomes a sentence nobody can act on.

The exposure is real but bounded — multi-accounting, which matters here because
this codebase gates a free welcome pack, VIP levels and referral-adjacent
economics on account identity.

This plan delivers **the report only**: a read-only script that names the
duplicate population precisely enough for an operator to act on. The index
itself is deliberately a follow-up, gated on the report coming back clean —
shipping a migration that fails on live data would be worse than the status quo.

## Current state

### The code that names the gap

`backend/packages/api/src/api/utils/phone-claim.ts` — the whole file is the
one-phone-one-account check, and its docblock states the situation:

```ts
/**
 * One phone number = one account.
 * ...
 * Exact string match, because every write path normalizes to E.164 before it
 * gets here (storefront normalizePhone, E164_RE on both OTP routes) — verified
 * against the live customer table: zero rows store anything but `+…`.
 *
 * Soft-deleted customers are excluded (listCustomers' default) and
 * store/customers/me/delete nulls `phone` outright, so deleting an account
 * releases its number. ...
 *
 * NOT atomic — check-then-write, no lock or unique index. State the real
 * exposure rather than the change route's old one: at SIGNUP a proof token is
 * purpose-scoped but not single-use, so one person with one handset can fire
 * two concurrent POST /store/customers inside the proof's 10-minute window and
 * have both reads see zero claimants. The backstop is a partial unique index
 * on customer(phone) WHERE deleted_at IS NULL — core Medusa already ships
 * exactly that shape for email (IDX_customer_email_has_account_unique), and
 * the release-on-delete behaviour above means it carries no soft-delete
 * hazard. It is not here for ONE reason: live rows already share numbers, so
 * creating it would fail until those are reconciled. Dedupe, then add it.
 */
export const assertPhoneUnclaimed = async (
  scope: MedusaContainer,
  phone: string,
  exceptCustomerId?: string,
): Promise<void> => {
  const customers = scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const matches = await customers.listCustomers(
    { phone, has_account: true } as unknown as CustomerFilters,
    { select: ['id'], take: 2 },
  );
  if (matches.some((c) => c.id !== exceptCustomerId))
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, PHONE_IN_USE_MESSAGE);
};
```

Three call sites enforce it, all correct and all out of scope here:

- `backend/packages/api/src/api/utils/phone-verification-guard.ts` — signup
  (`POST /store/customers`), runs regardless of `PHONE_VERIFICATION_REQUIRED`.
- `backend/packages/api/src/api/store/phone-verification/check/route.ts` —
  `purpose === 'signup'`, so the refusal is usable before the auth identity
  exists.
- `backend/packages/api/src/api/store/phone-verification/change/route.ts` —
  phone change, exempting the caller's own row.

Note the two filters the report must reproduce exactly, or its numbers will not
predict whether the index can be created: **`has_account: true`** and
**soft-deleted excluded** (the `listCustomers` default).

Also note the release-on-delete behaviour it depends on —
`backend/packages/api/src/api/store/customers/me/delete/route.ts:225` writes
`phone: null` — so deleted accounts are not part of the duplicate population.

### The prior art for the index shape

Core Medusa already ships the analogous constraint for email
(`IDX_customer_email_has_account_unique`). The follow-up migration, once the
report is clean, mirrors it. **Do not write that migration in this plan.**

### Script conventions in this repo

Scripts live in `backend/packages/api/src/scripts/`, default-export a function
taking `ExecArgs`, and are run through Medusa's exec. Read
`backend/packages/api/src/scripts/check-globepay.ts` as the structural
exemplar — it is the repo's cleanest read-only diagnostic:

```ts
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';

// <a long comment explaining WHY the script exists and what gap it closed>
//
//   medusa exec ./src/scripts/check-globepay.ts
//
// <what it prints, and what it never prints>
export default async function checkGlobePay({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  ...
}
```

Conventions to match:

- `logger` from the container, never bare `console.log`.
- A header comment with the exact run command and a statement of what is and is
  not printed.
- Read-only scripts say so explicitly in the header.
- An optional positional arg is read from `args?.[0]` (see
  `grant-skipped-challenge-cards.ts` for the pattern, including its
  unparseable-input guard).

### PII rule for this script

Phone numbers are customer PII and this output will land in a terminal, a CI
log, or a paste. **Print masked numbers by default** — the repo already has the
idiom, `backend/packages/api/src/api/store/phone-verification/change/route.ts`:

```ts
const mask = (phone: string): string => `••••${phone.slice(-4)}`;
```

Customer **ids** are opaque and safe to print in full — they are what an
operator needs to act. Emails must not be printed. Provide an explicit
`--full` style opt-in for unmasked numbers only if an operator genuinely cannot
act without them; default masked either way.

## Commands you will need

| Purpose               | Command                                                                          | Working directory      | Expected on success      |
| --------------------- | -------------------------------------------------------------------------------- | ---------------------- | ------------------------ |
| Backend typecheck     | `corepack yarn check-types`                                                      | `backend`              | exit 0                   |
| Backend lint (direct) | `./node_modules/.bin/eslint packages/api/src/scripts/report-duplicate-phones.ts` | `backend`              | exit 0                   |
| Backend unit tier     | `corepack yarn test:unit`                                                        | `backend/packages/api` | all pass                 |
| Run the report        | `corepack yarn medusa exec ./src/scripts/report-duplicate-phones.ts`             | `backend/packages/api` | exit 0, prints a summary |

`corepack yarn lint` is known to die on this machine — call eslint directly.
Never pipe test output through `tail`.

Running the script needs a reachable database. Locally the `pokenic-postgres`
container must be up and `backend/packages/api/.env` must exist with
`DATABASE_URL` — a **missing** `.env` presents as a `KnexTimeoutError` that
looks like a full connection pool, so check the file before debugging the pool.

## Scope

**In scope**:

- `backend/packages/api/src/scripts/report-duplicate-phones.ts` (create)
- `backend/packages/api/src/api/utils/phone-claim.ts` — **comment only**: one
  added line pointing at the script as the first step of "dedupe, then add it"
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):

- **Any migration, and any unique index.** The index is the follow-up, gated on
  a clean report. A migration that fails on live data is a deploy outage.
- **Any write to customer rows.** This script does not merge, delete, null out,
  or renumber anything. Deciding which of two accounts keeps a number is a
  business decision with money attached (balances, vault contents, VIP level,
  free-pack claim) and belongs to the operator, not to a script.
- `assertPhoneUnclaimed`'s logic and its three call sites — correct as shipped.
- `store/customers/me/delete/route.ts` — the release-on-delete behaviour this
  depends on is already right.
- The storefront.

## Git workflow

- Branch: `advisor/110-duplicate-phone-report`
- Conventional commit, e.g.
  `feat(scripts): report the duplicate-phone population blocking the uniqueness index`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the report script

Create `backend/packages/api/src/scripts/report-duplicate-phones.ts`.

**Method**: page `listCustomers` through the customer module and group in
memory. Do **not** reach for raw SQL against the `customer` table — it is a
core-Medusa table owned by another module, and this repo's raw-SQL aggregates
live inside the packs module's own service for exactly that reason. Paging a
customer table of this size is cheap and keeps the module boundary intact.

Required behaviour:

1. Page every customer with `has_account: true`, selecting `id`, `phone`,
   `created_at`. Soft-deleted rows are excluded by `listCustomers`' default —
   state that in a comment so nobody "fixes" it later.
2. Skip rows with a null/empty phone.
3. Group by the **exact** phone string. Exact match, not normalized: this must
   reproduce what `assertPhoneUnclaimed` compares and what a unique index would
   enforce. If you normalize here, the report will predict a different outcome
   from the index and be worse than useless. Add a comment saying so.
4. Report, in this order:
   - a headline: total accounts scanned, distinct phones, **number of phone
     values held by more than one account**, and total accounts involved;
   - one line per duplicate group: the masked phone, the group size, and every
     customer id with its `created_at`, oldest first (the oldest is the likely
     keeper, but the script must not say so — it reports, it does not decide);
   - a closing line stating plainly whether the unique index can be created:
     zero groups → "clean: the partial unique index on customer(phone) can be
     created"; otherwise → "N phone value(s) must be reconciled first".
5. Optional first arg: a limit on how many groups to print in full (default
   printing all, since the expected N is small). Guard an unparseable arg the
   way `grant-skipped-challenge-cards.ts` does.
6. Header comment in the repo's voice: why this exists (quote the
   "Dedupe, then add it." instruction and where it lives), the exact run
   command, that it is **read-only and writes nothing**, and that numbers are
   masked.

**Verify**: from `backend`, `corepack yarn check-types` → exit 0.

### Step 2: Lint it

**Verify**: from `backend`,
`./node_modules/.bin/eslint packages/api/src/scripts/report-duplicate-phones.ts`
→ exit 0.

Then check the global prettier hook did not churn unrelated backend files:
`git status --short` must list only your new file (plus the two files from
Steps 3–4). If it lists unrelated backend files with only quote-style changes,
revert those — a known hazard on this machine.

### Step 3: Point the code at the script

In `backend/packages/api/src/api/utils/phone-claim.ts`, extend the docblock's
final sentence so "Dedupe, then add it." names its first step:

> ... It is not here for ONE reason: live rows already share numbers, so
> creating it would fail until those are reconciled. Dedupe, then add it —
> `src/scripts/report-duplicate-phones.ts` names the rows that have to go
> first.

Comment only. Do not touch `assertPhoneUnclaimed`'s body.

**Verify**: `git diff --stat backend/packages/api/src/api/utils/phone-claim.ts`
→ comment-only change; `corepack yarn check-types` from `backend` → exit 0.

### Step 4: Run it against a real database and record the answer

**Verify**: from `backend/packages/api`,
`corepack yarn medusa exec ./src/scripts/report-duplicate-phones.ts`
→ exit 0, and a summary is printed.

**Put the headline numbers in your report** — accounts scanned, duplicate phone
values, accounts involved — because those numbers are the whole point of the
plan: they tell the operator whether the follow-up index is a one-line migration
or a reconciliation project. Mask numbers in anything you paste back.

If no database is reachable, say so explicitly and mark this step not-run. Do
not claim the report is clean without having run it.

### Step 5: Backend unit tier still green

**Verify**: from `backend/packages/api`, `corepack yarn test:unit` → all pass.

## Test plan

No unit test. This is a read-only diagnostic script with no branching business
logic; the repo's other `medusa exec` diagnostics
(`check-globepay.ts`, `print-publishable-key.ts`) carry none either, and a test
that mocks `listCustomers` to prove that grouping a map groups a map would be
theatre.

The verification is Step 4: running it against a real database and reporting the
numbers.

If you do add branching worth pinning (e.g. an arg parser with a guard),
co-locate a small spec under
`backend/packages/api/src/scripts/__tests__/` — that directory already exists
and is the right home.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `backend/packages/api/src/scripts/report-duplicate-phones.ts` exists
- [ ] `corepack yarn check-types` from `backend` exits 0
- [ ] `./node_modules/.bin/eslint packages/api/src/scripts/report-duplicate-phones.ts` from `backend` exits 0
- [ ] `corepack yarn test:unit` from `backend/packages/api` exits 0
- [ ] `grep -c "has_account" backend/packages/api/src/scripts/report-duplicate-phones.ts` ≥ 1
- [ ] `grep -nE "\.(update|delete|create|upsert)[A-Za-z]*\(" backend/packages/api/src/scripts/report-duplicate-phones.ts`
      → **no matches** (this targets the module-service call surface, so prose
      in comments cannot satisfy or break it). Also read the file and state in
      the report that it performs no writes.
- [ ] `grep -n "report-duplicate-phones" backend/packages/api/src/api/utils/phone-claim.ts` → 1 match
- [ ] The script was run against a real database and its headline numbers are in
      the report (or the step is explicitly marked not-run, with the reason)
- [ ] `git status --short` lists only the three in-scope files
- [ ] `plans/README.md` status row for 110 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `phone-claim.ts` changed since `16cc85d3` — in
  particular if a unique index or lock has since been added, which would make
  this plan's premise obsolete.
- `listCustomers` does not accept `has_account` as a filter, or paging it does
  not terminate. Report it; **do not** substitute raw SQL against the `customer`
  table without saying so first.
- The report comes back with a **large** duplicate population (say, more than a
  couple of dozen phone values). That changes the follow-up from a migration
  into a reconciliation project with money attached, and the operator needs to
  hear the number before anyone writes an index.
- You find yourself about to write, merge, or null out a customer row. Stop —
  that decision is not yours and not this plan's.
- You discover the assumption **"every stored phone is E.164, so exact-string
  grouping is the same grouping a unique index would enforce"** is false — i.e.
  the report finds rows not starting with `+`. Report the count; it means the
  claim in `phone-claim.ts`'s docblock has drifted and the normalization
  question has to be settled before any index.

## Maintenance notes

- **The follow-up this unblocks**: once the report is clean, add a partial
  unique index on `customer(phone) WHERE deleted_at IS NULL AND phone IS NOT NULL`,
  mirroring core Medusa's `IDX_customer_email_has_account_unique`. That closes
  the documented signup race for good and makes `assertPhoneUnclaimed` a
  friendly-error path rather than the only defence. It is a separate plan on
  purpose.
- **The dependency to protect**: the index is only safe because account deletion
  **nulls** `phone` (`store/customers/me/delete/route.ts:225`) rather than
  relying on soft-delete. If deletion ever stops doing that, the index becomes
  the "soft-delete blocks re-signup" trap this codebase has already hit once on
  the auth identity. Anyone editing the delete path should be pointed here.
- **A reviewer should scrutinize**: that the script writes nothing, that phone
  output is masked by default, and that the grouping is exact-string (not
  normalized) so its verdict actually predicts the index's.
- **Recurrence**: re-run the report before creating the index, not just once —
  the population can grow between the report and the migration while the
  non-atomic check is the only guard.
