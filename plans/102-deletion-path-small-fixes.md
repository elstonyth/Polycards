# Plan 102: Account-deletion path small fixes — index-shaped audit read, chunked notification delete

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 5c74ce17..HEAD -- backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/api/store/customers/me/delete/route.ts`
> On drift, compare "Current state"; mismatch = STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (touches the same route family as 096 — merge either
  order; hunks are far apart)
- **Category**: perf / bug (latent)
- **Planned at**: commit `5c74ce17`, 2026-08-15

## Why this matters

Two latent defects on the irreversible account-deletion path (#434):

1. **A full table scan while holding the money lock.** The purge's
   audit-idempotency read filters `admin_action_audit` by
   `{ entity_id, action }` — but the table's only usable index is the
   composite `('entity_type','entity_id')`. Omitting the leading column drops
   the seek for a sequential scan of an append-only table that "grows with
   every admin money mutation forever" — executed INSIDE the purge transaction
   while holding that customer's `credit:` advisory lock, the same lock every
   open/buyback/top-up/withdrawal serializes on. The sibling method four
   screens up (`deletedCustomerIds`) passes `entity_type: 'customer'` and its
   comment spells out exactly this trap; the purge call site didn't get the
   memo.
2. **An unbounded single-statement delete.** The route deletes all
   notifications addressed to the customer as ONE `deleteNotifications(ids)`
   call. The generated `DELETE ... WHERE id IN (...)` binds one parameter per
   id against Postgres's 65,535-parameter ceiling. Feed rows accrue per money
   event; a long-lived heavy account eventually cannot delete itself at all —
   the request throws at step 4 and every retry throws identically, on a path
   whose whole contract is "this always completes".

## Current state

- `backend/packages/api/src/modules/packs/service.ts:4198-4206` — the purge
  read (inside `purgeAccountPacksData`, which takes
  `pg_advisory_xact_lock('credit:<id>')` at `:4104-4106`):

```ts
// Idempotent: a half-finished purge gets finished by hand, and an audit
// trail that grows a row per attempt reports one deletion as several.
const [existingAudit] = await this.listAdminActionAudits(
  { entity_id: customerId, action: 'delete_account' },
  { take: 1 },
  sharedContext,
);
```

- The exemplar + rationale: `service.ts:4061-4082` — `deletedCustomerIds`
  passes `entity_type: 'customer'`, with the comment "omitting the leading
  column drops the seek for a full scan."
- Index truth: `modules/packs/models/admin-action-audit.ts:69-73`
  (`IDX_admin_action_audit_entity` on `('entity_type','entity_id')`);
  created in `migrations/Migration20260623000000.ts:12`. No index on
  `entity_id` or `action` alone.
- `backend/packages/api/src/api/store/customers/me/delete/route.ts:169-178`:

```ts
const { email } = await customers.retrieveCustomer(customerId);
const addressed = await notifications.listNotifications({
  to: [email, customerId],
});
if (addressed.length > 0) {
  await notifications.deleteNotifications(addressed.map((n) => n.id));
}
```

(The unbounded LIST is fine — `buildQuery` applies no default limit, so
nothing is silently truncated; the single DELETE statement is the bound.)

- Only the purge writes `action: 'delete_account'`, always with
  `entity_type: 'customer'` — so adding the filter cannot change the result
  set.
- Suites: `integration-tests/http/account-self-service.spec.ts` (586 lines)
  covers the whole flow.

## Commands you will need

| Purpose             | Command (from)                                                                                                                                                         | Expected |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Typecheck           | `corepack yarn check-types` (`backend/`)                                                                                                                               | exit 0   |
| Deletion HTTP suite | `NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http node node_modules/jest/bin/jest.js --silent account-self-service` (`backend/packages/api`, live DB) | all pass |

## Scope

**In scope**:

- `backend/packages/api/src/modules/packs/service.ts` — the ONE filter object
  at `:4202`
- `backend/packages/api/src/api/store/customers/me/delete/route.ts` — the
  delete call at `:173-175`
- `integration-tests/http/account-self-service.spec.ts` — one extended case

**Out of scope**:

- Everything else in both files. The deletion flow's ordering comments are
  load-bearing (each records a bug); change nothing else.
- The notification module.

## Git workflow

- Branch: `advisor/102-deletion-small-fixes`
- Two conventional commits (one per fix).
- No push/PR without operator instruction.

## Steps

### Step 1: add the leading index column

At `service.ts:4202`, change the filter to
`{ entity_type: 'customer', entity_id: customerId, action: 'delete_account' }`.
Add half a line to the existing "Idempotent:" comment noting the
`entity_type` is for the composite-index seek (pointing at the
`deletedCustomerIds` comment above it).

**Verify**: `corepack yarn check-types` exit 0; `account-self-service` suite
green (the double-delete idempotency case in it exercises this read).

### Step 2: chunk the notification delete

In the route, before changing anything, check whether MikroORM/the
notification module already chunks `$in` internally: read
`deleteNotifications`'s implementation path (it is Medusa's notification
module service — check `node_modules/@medusajs/notification/dist` briefly). If
it demonstrably chunks, write that as a comment at the call site, make no code
change, and record "no change needed" in the README row for this half.
Otherwise: chunk `addressed` into batches of 1,000 around the call:

```ts
for (let i = 0; i < addressed.length; i += 1_000) {
  await notifications.deleteNotifications(
    addressed.slice(i, i + 1_000).map((n) => n.id),
  );
}
```

Keep the existing count log line after the loop.

**Verify**: typecheck green; `account-self-service` green.

### Step 3: pin it

Extend the deletion suite's notification case (grep `notification` in
`account-self-service.spec.ts`): seed >1,000 notifications for the customer
(bulk-create in one call if the harness allows; 1,001 is enough) and assert
deletion completes and leaves zero addressed rows. If seeding 1,001 rows is
prohibitively slow in the harness, seed 3 and instead unit-pin the chunk
helper by exporting a `chunk` util ONLY if one doesn't already exist in the
api utils (grep first) — prefer the integration pin.

**Verify**: suite green, new case listed in the output.

## Test plan

Step 3's case plus the untouched 586-line suite as the regression net.

## Done criteria

- [ ] `grep -n "entity_type: 'customer'" backend/packages/api/src/modules/packs/service.ts` → includes the `:4202` site (now shifted)
- [ ] The route's delete is chunked OR carries the verified no-chunk-needed comment
- [ ] `account-self-service` suite green incl. the new case
- [ ] `git status` clean outside scope; `plans/README.md` row updated

## STOP conditions

- The purge read site doesn't match the excerpt (096 or drift moved it) —
  re-locate by grepping `delete_account` in service.ts; if the filter already
  carries `entity_type`, this half is done independently — record and skip.
- `deleteNotifications` turns out to soft-delete with a required cascade you'd
  bypass by chunking oddly — report what you found.

## Maintenance notes

- Any future `listAdminActionAudits` call MUST lead with `entity_type` — the
  two comments now both say so; a third violation suggests a wrapper method is
  warranted.
- Reviewer: confirm Step 2 kept the delete inside the same failure-ordering
  position (step 4 of the route's numbered sequence) — the surrounding
  comments explain why the order matters.
