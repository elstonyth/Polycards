# Plan 071: Stable pagination and honest `?q=` filtering on the admin list routes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f14da91..HEAD -- backend/packages/api/src/api/admin/pulls/route.ts "backend/packages/api/src/api/admin/customers/[id]/pulls/route.ts" "backend/packages/api/src/api/admin/customers/[id]/transactions/route.ts" backend/packages/api/src/api/admin/delivery-orders/route.ts backend/packages/api/src/api/admin/ledger/route.ts backend/packages/api/src/api/admin/players/route.ts backend/packages/api/src/api/admin/purchase-invoices/route.ts backend/packages/api/src/modules/packs/service.ts`
> On a mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW (adding a secondary sort key can't change which rows match; escaping narrows matches to the literal string typed)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `0f14da91`, 2026-08-02

## Why this matters

Two convention drifts on operator-facing money-adjacent lists:

1. **Missing unique tiebreakers on offset pagination.** Postgres gives no
   stable order among equal sort keys, so with `skip`/`take` a row can appear
   on two pages or on neither. The Pull Ledger is the worst case: batch opens
   stamp every pull of a 10-card batch with the same millisecond, so ties are
   the norm. Five sibling routes already carry the `id` tiebreaker; four don't.
2. **`?q=` handling drift.** The Transactions (`/admin/ledger`) search feeds an
   ILIKE without escaping LIKE metacharacters — `?q=%` returns _every_ row
   while the operator believes the filter applied. And two routes still
   silently drop an array `?q=a&q=b` (widening results) where the ledger route
   was already fixed to 400.

## Current state

**Tiebreaker gaps** (the four sites to fix):

- `backend/packages/api/src/api/admin/pulls/route.ts:74-77`:

  ```ts
  const [ledger, total] = await packs.listAndCountPulls(ledgerFilter, {
    order: { rolled_at: 'DESC' },
    skip: offset,
    take: limit,
  });
  ```

- `backend/packages/api/src/api/admin/customers/[id]/pulls/route.ts:77-81` —
  same shape: `order: { rolled_at: 'DESC' }, skip: offset, take: limit`.
- `backend/packages/api/src/api/admin/customers/[id]/transactions/route.ts:~20`
  and `backend/packages/api/src/api/admin/delivery-orders/route.ts:~38` —
  order on bare `created_at` (lower urgency: no same-instant batch writer was
  proven for these tables, but the omission is the same).

**Tie mechanism proof** — `backend/packages/api/src/workflows/steps/record-pulls-batch.ts:56-64`:

```ts
pulls: input.cards.map((c) => ({
  ...
  rolled_at: new Date(),
  ...
})),
```

**The repo's own convention** (exemplars):
`api/admin/inventory/[handle]/route.ts:82` → `{ created_at: 'DESC', id: 'DESC' }`;
also `api/admin/players/route.ts:35`, `api/admin/purchase-invoices/route.ts:163`,
`api/store/credits/route.ts:39`, `api/store/notifications/route.ts:53`. The
rule is stated in `api/utils/page-all.ts`'s docstring.

**`?q=` escape gap** — `api/admin/ledger/route.ts:63-68`:

```ts
function coerceQ(raw: unknown): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') bad(`Invalid \`q\` filter '${String(raw)}'.`);
  const trimmed = (raw as string).trim();
  return trimmed === '' ? undefined : trimmed.slice(0, 100);
}
```

feeds `modules/packs/service.ts:4318`:

```ts
clauses.push(`(display_id ILIKE ?${idClause})`);
```

The value is parameter-bound (no SQL injection), but `%`/`_`/`\` are not
escaped. The escaping exemplar with the exact rationale lives at
`api/admin/delivery-orders/validate.ts` (`coerceIdSearch`):

```ts
return (raw as string).replace(/[\\%_]/g, (c) => `\\${c}`);
```

and `api/admin/purchase-invoices/route.ts:128-136` repeats it inline with the
ordering rule: _"Truncated FIRST, escaped SECOND: escaping before the cut
could sever an escape pair."_

**Array-drop drift** — `api/admin/purchase-invoices/route.ts:127-136` and
`api/admin/players/route.ts:21-25` both use `typeof rawQ === 'string'`, which
silently ignores a repeated param (filter disabled, full list returned). The
ledger route's `coerceQ` 400s the same input, with a comment explaining why
silent dropping is wrong.

## Commands you will need

| Purpose                                        | Command (from `backend/packages/api`)                                                                                                                   | Expected |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Typecheck                                      | `corepack yarn check-types` (falls back: `node ../../node_modules/typescript/bin/tsc --noEmit` — the api-local `.bin/tsc` shim mis-resolves under yarn) | exit 0   |
| Unit tier                                      | `corepack yarn test:unit`                                                                                                                               | all pass |
| HTTP suite (needs pokenic-postgres + redis up) | `NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http npx jest integration-tests/http/admin-pulls.spec.ts`                                 | all pass |

## Scope

**In scope**:

- The four route files listed under "Tiebreaker gaps"
- `backend/packages/api/src/api/admin/ledger/route.ts` (`coerceQ` escape)
- `backend/packages/api/src/api/admin/purchase-invoices/route.ts` and
  `backend/packages/api/src/api/admin/players/route.ts` (array → 400)
- `backend/packages/api/integration-tests/http/admin-pulls.spec.ts` (new paging case)
- The ledger route's existing spec file if one exists (add `?q=%` case)

**Out of scope**:

- `modules/packs/service.ts` beyond reading it — the ILIKE builder is fine
  once its input is escaped; do not refactor it.
- `api/utils/page-all.ts`, the escaping in delivery-orders/purchase-invoices
  (already correct).
- Any storefront `/store/*` route (all verified to carry tiebreakers).
- Players-route LIKE escaping — its `q` feeds Medusa's customer search, not
  the repo's own ILIKE builder; only the array handling is in scope there.

## Git workflow

- Branch: `advisor/071-admin-list-hardening`
- Conventional commits, e.g. `fix(admin): stable id tiebreaker on offset-paginated pull/ledger lists`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `id` tiebreakers

At each of the four sites, append the unique key at the same direction, e.g.
`order: { rolled_at: 'DESC', id: 'DESC' }` (pulls ×2) and
`order: { created_at: 'DESC', id: 'DESC' }` (transactions, delivery-orders).

**Verify**: typecheck exits 0;
`grep -n "rolled_at: .DESC. }" backend/packages/api/src/api/admin/pulls/route.ts "backend/packages/api/src/api/admin/customers/[id]/pulls/route.ts"`
→ no matches (both now carry the tiebreaker).

### Step 2: Escape LIKE metacharacters in the ledger `coerceQ`

Truncate first, escape second (per the purchase-invoices comment):

```ts
return trimmed === ''
  ? undefined
  : trimmed.slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`);
```

Add one comment line citing the reason (an unescaped `%` silently widens the
search to the whole table).

**Verify**: typecheck exits 0.

### Step 3: Reject array `?q=` on purchase-invoices and players

Match the ledger route's behavior: if `rawQ` is defined and not a string,
respond 400 with the same message shape (`Invalid \`q\` filter ...`) instead
of silently treating it as absent. Reuse each file's existing error helper.

**Verify**: typecheck exits 0.

### Step 4: Tests

- In `integration-tests/http/admin-pulls.spec.ts` (exists — plan 012 created
  it; follow its setup): mint one batch of ≥3 pulls sharing `rolled_at` (open
  via the batch path, or insert rows with an identical timestamp using the
  spec's existing seeding utilities), then page through `/admin/pulls` with
  `limit=1` and assert the union of pages has no duplicates and no gaps.
- Add `?q=%` and repeated-`?q=` cases to the ledger route's spec (locate via
  `grep -rl "admin/ledger" backend/packages/api/integration-tests/http/`):
  `?q=%` must NOT return unfiltered results (assert it matches only rows
  whose display_id literally contains `%`, i.e. typically zero); `?q=a&q=b`
  → 400.

**Verify**: the two HTTP suites pass (command table above; DB required).

## Test plan

Covered in Step 4. Pattern: `integration-tests/http/admin-pulls.spec.ts` for
route setup/auth. Also run the unit tier once (`corepack yarn test:unit`) to
prove no collateral.

## Done criteria

- [ ] All four order clauses carry a unique tiebreaker (greps in Step 1)
- [ ] `coerceQ` escapes `[\\%_]` after truncation
- [ ] purchase-invoices + players 400 on array `?q=`
- [ ] New paging + q-escape spec cases pass on a live DB
- [ ] Backend typecheck + unit tier green
- [ ] No files outside scope modified; `plans/README.md` row updated

## STOP conditions

- The excerpts don't match (drift).
- `listAndCountPulls` rejects a two-key `order` object (framework constraint)
  — report; do not hand-write SQL.
- The admin-pulls spec's seeding utilities can't produce same-timestamp rows —
  report the closest achievable test instead of skipping the case silently.

## Maintenance notes

- The repo now enforces two adjacent conventions by test (rate-limit coverage
  guard) and by comment (tiebreakers, q-escaping). If a _fifth_ site drifts,
  consider a text-scan guard over `skip: offset` queries in the spirit of
  `api/__tests__/admin-rate-limit-coverage.unit.spec.ts` — deliberately
  deferred here (S, speculative until it recurs).
- Reviewer: confirm no `order` direction was flipped while adding tiebreakers.
