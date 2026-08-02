# Plan 066: Stop the inventory loader reading the whole card table; bound the xlsx export

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a993f34a..HEAD -- backend/packages/api/src/modules/packs/inventory-view.ts backend/packages/api/src/api/admin/inventory/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: MED (derived columns must stay correct for every caller)
- **Depends on**: none (coordinate with plan 061 only on the export rate-limit note below)
- **Category**: perf
- **Planned at**: commit `a993f34a`, 2026-08-01

## Why this matters

`loadInventoryRows` reads the ENTIRE card table on every call — including the
single-item detail route, where products and all five aggregates are already
scoped to one handle. The xlsx export reuses the same loader with no row
ceiling. PR #299 (PriceCharting bulk import) exists specifically to push the
catalog toward five figures ("a collection can run to five figures of offers"
— `pricecharting/collection/route.ts:14`), and admin GETs carry no rate
limiter, so an open Inventory tab stacks full-catalog scans against the same
connection pool the money paths use. The unpaged LIST route is a documented
tradeoff and stays; the card-table scan and the unbounded export are not
documented anywhere and are what this plan fixes.

## Current state

- `backend/packages/api/src/modules/packs/inventory-view.ts:94-118`:

  ```ts
  const products = await pageAll((page) =>
    productModule.listProducts(
      opts.handle ? { handle: opts.handle } : opts.q ? { q: opts.q } : {},
      page,
    ),
  );
  const cards = await pageAll((page) => packs.listCards({}, page));   // ← ALWAYS full table
  const fx = await resolveFxRate(packs);
  const listed = products.filter(...);
  const handles = listed.map((p) => p.handle);
  const cardByHandle = new Map(cards.map((c) => [c.handle, c]));
  // five sequential aggregates, each taking `handles` (already scoped):
  const stockByHandle = await getCardStockByHandle(container, handles);
  const skus = await skuByHandle(container, handles);
  const buckets = await packs.inventoryLifecycleBuckets(handles);
  const costByHandle = await packs.weightedAverageCostByHandle(handles);
  const listingCounts = await packs.listingCountByHandle(handles);
  ```

  Note the products read IS scoped when `opts.handle`/`opts.q` is set, and the
  five aggregates key off `handles` — only the `cards` read ignores the scope.
  The sequential-not-parallel comment (pool-exhaustion rule) is deliberate;
  keep it.

- Callers (all three):
  - `backend/packages/api/src/api/admin/inventory/route.ts:27` — list;
    header comment (`route.ts:7-10`): "UNPAGED by design: on_hand/in_vault/…
    are computed AFTER the product page loads, so sorting on them can only
    happen client-side". This tradeoff is SETTLED — do not paginate the list.
  - `backend/packages/api/src/api/admin/inventory/[handle]/route.ts` — single item.
  - `backend/packages/api/src/api/admin/inventory/export.xlsx/route.ts` —
    export; reuses the loader (`route.ts:130` builds the workbook from ALL
    rows), documented as "same rows as the visible list", no ceiling.
- `cardByHandle` consumption: `inventory-view.ts:121` area — card fields
  (`name`/`fmv`/`multiplier`) join into each row. Scoping the card read must
  key off the derived `handles`, not the raw filter, or rows lose those fields.
- Tests: `backend/packages/api/integration-tests/http/inventory-list.spec.ts`,
  `inventory-detail.spec.ts`, `inventory-export.spec.ts`, `inventory-buckets.spec.ts`.

## Commands you will need

| Purpose                                | Command                                                                    | Expected on success |
| -------------------------------------- | -------------------------------------------------------------------------- | ------------------- |
| Backend typecheck                      | `cd backend && corepack yarn check-types`                                  | exit 0              |
| Inventory http specs (needs docker DB) | `cd backend/packages/api && corepack yarn test:integration:http inventory` | all pass            |
| Unit tier                              | `cd backend/packages/api && corepack yarn test:unit`                       | all pass            |

## Scope

**In scope**:

- `backend/packages/api/src/modules/packs/inventory-view.ts`
- `backend/packages/api/src/api/admin/inventory/export.xlsx/route.ts`
- `backend/packages/api/integration-tests/http/inventory-export.spec.ts` (one new case)

**Out of scope**:

- Pagination of the list route (documented decision — stays unpaged).
- The five aggregate methods and their sequential ordering.
- `admin/cards/route.ts` (same client-sort rule, different surface).
- Rate-limiting the export GET — noted for the operator: `adminActionRateLimit`
  is POST-scoped today; if they want the export throttled, that is a plan-061
  follow-up decision, not this plan.

## Git workflow

- Branch: `advisor/066-inventory-read-diet`
- Conventional commit, e.g. `perf(inventory): scope the card read to listed handles; cap the xlsx export`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Scope the card read

In `inventory-view.ts`, move the `cards` read AFTER `handles` is derived and
filter it: `packs.listCards({ handle: handles }, page)` inside the same
`pageAll` (MedusaService list filters accept arrays — `listCards({ handle: [...] })`
is the same idiom the aggregates use; verify by reading one aggregate's
implementation, e.g. `weightedAverageCostByHandle` at `service.ts:~6827`,
before assuming). Handle the `handles.length === 0` case by skipping the read
entirely (`const cards = handles.length ? await pageAll(...) : []`) — an empty
`IN ()` is the classic footgun.

**Verify**: `cd backend && corepack yarn check-types` → exit 0;
`corepack yarn test:integration:http inventory` → all four suites pass
(detail spec proves `name`/`fmv` still populate).

### Step 2: Cap the export

In `export.xlsx/route.ts`, add an explicit `EXPORT_MAX_ROWS` (10,000 — an
xlsx of 10k rows is ~1–2 MB and generous against today's catalog) checked
AFTER `loadInventoryRows` returns: over the cap → 400 with a message telling
the operator to narrow `?q=` ("error rather than truncate" — this repo's
documented posture from the round-1 delivery-batch work). Keep the cap a
named constant with a comment stating why erroring beats truncating (a
truncated sheet reads as complete).

**Verify**: typecheck → exit 0.

### Step 3: Export cap spec

Extend `inventory-export.spec.ts`: monkey-patch is not available through the
booted app, so make the cap env-overridable
(`INVENTORY_EXPORT_MAX_ROWS`, default 10000, parsed once at module top) and
have the spec boot-set it to a number below the seeded row count → expect 400;
default path → 200 with the xlsx content-type (existing case).

**Verify**: `corepack yarn test:integration:http inventory-export.spec` → all pass including the new case.

## Test plan

Existing four inventory suites are the regression net for Step 1; Step 3 adds
the cap case. No unit-tier additions (the loader is container-bound).

## Done criteria

- [ ] `grep -n "listCards({}" backend/packages/api/src/modules/packs/inventory-view.ts` → no matches
- [ ] `grep -n "EXPORT_MAX_ROWS" backend/packages/api/src/api/admin/inventory/export.xlsx/route.ts` → match
- [ ] All inventory http specs pass, incl. the new cap case
- [ ] `cd backend && corepack yarn check-types` exit 0; `corepack yarn test:unit` passes
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `listCards` does not accept an array `handle` filter (check the aggregate
  exemplar first) — report the actual filter shape rather than falling back to
  a raw SQL rewrite.
- The detail spec fails after Step 1 with missing card fields — the
  `cardByHandle` join keys on something other than `p.handle`; report the
  actual key.
- Seeding enough rows to exceed a test cap is impractical in the http harness
  — lower the env override further rather than skipping the case; if the env
  can't reach the booted app, report how the harness passes env today
  (`integration-tests/http/*.spec.ts` set up shows it).

## Maintenance notes

- If the catalog outgrows the client-sort UX, the next step is server-side
  pagination + allowlisted sort (the pattern already exists at
  `purchase-invoices/route.ts:71`) — that supersedes the list route's
  "UNPAGED by design" comment and should update it.
- The export cap is a backstop, not a product limit — raising it is one env
  var; removing it should require the streaming-writer discussion the audit
  deferred.
- Reviewer scrutiny: Step 1 must not change row CONTENT for any caller —
  the diff should be pure read-scoping.
