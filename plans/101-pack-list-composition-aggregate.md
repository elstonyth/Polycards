# Plan 101: Stop materializing every odds row and every card to compute two booleans per pack

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 5c74ce17..HEAD -- backend/packages/api/src/api/store/packs/route.ts backend/packages/api/src/api/admin/packs/route.ts backend/packages/api/src/modules/packs/card-view.ts backend/packages/api/src/api/utils/page-all.ts`
> On drift, compare "Current state"; mismatch = STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED — `poolComposition` carries reward-row and orphaned-odds
  skip-set semantics a SQL rewrite must reproduce exactly; the
  characterization suites are the net
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `5c74ce17`, 2026-08-15

## Why this matters

Both pack-list routes now read **every `pack_odds` row and every `card` in the
database into Node** (`pageAll`, 1000-row pages, no ceiling) to compute
per-pack composition (`group` + `psa10`, i.e. two booleans) and admin EV/RTP
stats. Cost scales with total catalog size, not pack count. The public route
(`/store/packs` — behind `/slots`, home tiles, and the free-pack state's
sibling reads) at least has a 30s cache + single-flight; the admin route has
**no cache at all** and fans out on every admin pack-page load. PR #299's bulk
import pushes the catalog toward five figures; at 50k cards / 200k odds rows
this is hundreds of MB of heap churn to answer per-pack counts a single grouped
SQL aggregate can return.

## Current state

- `backend/packages/api/src/api/store/packs/route.ts:88-99`:

```ts
    pageAll((opts) => packsModuleService.listPackOdds({}, opts)),
    pageAll((opts) => packsModuleService.listCards({}, opts)),
  ]);
  const comp = poolComposition(allOdds, allCards);
  const groupOf = (slug) => compositionGroup(t?.graded ?? 0, t?.total ?? 0);
  const psa10Of = (slug) => t !== undefined && t.total > 0 && t.psa10 === t.total;
```

Cache machinery in the same file: `CACHE_TTL_MS = 30_000` (`:24`),
`listCache` map (`:26`), clear seam (`:36`), get/set (`:44`, `:53`).

- `backend/packages/api/src/api/admin/packs/route.ts:47-60` — same double
  `pageAll` fan-out, self-documented ("Stats fan-out — every odds row and every
  card ONCE... this list renders on every admin pack-page load"), plus FX and
  price math per pack. NO cache.
- `backend/packages/api/src/modules/packs/card-view.ts:58-76` —
  `poolComposition(odds, cards)`: skips `card_id == null` (reward rows) and
  odds rows whose card no longer exists (orphans, via the `byHandle` miss);
  counts `total`/`graded` (`isGraded`)/`psa10` (`isPsa10`) per `pack_id`.
  The comment: "the two routes must always agree on that skip-set, so it lives
  here." `compositionGroup` at `:45-52` (GRADED iff all, RAW iff none, MIX
  otherwise, null for empty).
- `backend/packages/api/src/api/utils/page-all.ts` — the exhaustive pager
  (PAGE=1000, id-tiebreaker ordering).
- Characterization nets: `modules/packs/__tests__/card-view.unit.spec.ts`,
  `integration-tests/http/packs-list-stats.spec.ts` (+117 lines in the delta),
  plus the storefront `catalog-group.test.ts` degraded shapes.
- `isGraded` / `isPsa10` — read their definitions in `card-view.ts` (they
  encode grader/grade string semantics the SQL must mirror EXACTLY — e.g.
  case-insensitivity; read before writing SQL).

### Target design

One SQL aggregate replacing both `pageAll` calls, exposed as a service method
(the raw-SQL idiom used elsewhere in `service.ts`, e.g. the profile-stats CTE
from plan 022):

```sql
SELECT o.pack_id,
       COUNT(*)                                   AS total,
       COUNT(*) FILTER (WHERE <isGraded(c)>)      AS graded,
       COUNT(*) FILTER (WHERE <isPsa10(c)>)       AS psa10
FROM pack_odds o
JOIN card c ON c.handle = o.card_id            -- inner join = orphan skip
WHERE o.card_id IS NOT NULL                    -- reward-row skip
  AND o.deleted_at IS NULL AND c.deleted_at IS NULL   -- match list* soft-delete scope
GROUP BY o.pack_id
```

`<isGraded(c)>` / `<isPsa10(c)>` translated from `card-view.ts`'s TS
predicates — column names verified against the model
(`modules/packs/models/card.ts`), soft-delete scoping verified against what
`listPackOdds({}, …)` / `listCards({}, …)` actually filter (MikroORM default
filters exclude `deleted_at` rows — confirm by reading an existing raw-SQL
method's WHERE in `service.ts`, e.g. the challenge aggregates, and mirror it).

The admin route keeps its EV/RTP math BUT that math needs per-pack odds rows
with weights, not just counts — read `admin/packs/route.ts` fully: if the EV
math consumes `allOdds` beyond composition, the aggregate only replaces the
`allCards` scan for composition and the admin route ALSO gets the 30s
cache + single-flight the store route has (lifting the exact pattern from
`store/packs/route.ts:24-53`, including a clear seam for tests). That split
outcome is acceptable: store route = aggregate (its only use of the scans IS
composition — verify by reading the rest of the route), admin route = cache.

## Commands you will need

| Purpose                      | Command (from)                                                                                                                                                     | Expected              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| Typecheck                    | `corepack yarn check-types` (`backend/`)                                                                                                                           | exit 0                |
| Composition characterization | `TEST_TYPE=unit node node_modules/jest/bin/jest.js --silent card-view` (`backend/packages/api`)                                                                    | pass                  |
| Pack-list HTTP suites        | `NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http node node_modules/jest/bin/jest.js --silent packs-list-stats` (`backend/packages/api`, live DB) | pass — the parity net |
| Storefront catalog tests     | `npm test` (root)                                                                                                                                                  | pass                  |

## Scope

**In scope**:

- `backend/packages/api/src/modules/packs/service.ts` — ONE new read method
  (`poolCompositionAggregate` or similar) and nothing else
- `backend/packages/api/src/api/store/packs/route.ts`
- `backend/packages/api/src/api/admin/packs/route.ts`
- `integration-tests/http/packs-list-stats.spec.ts` — ADD a SQL-vs-TS parity
  case (below); existing cases unchanged
- `modules/packs/__tests__/` — a module-tier spec for the new method if the
  HTTP suite doesn't already exercise every skip-set branch

**Out of scope**:

- `card-view.ts` — `poolComposition` STAYS (the parity test needs it, and the
  odds editor may use it); do not delete or edit.
- `page-all.ts` — other call sites depend on it.
- Admin EV/RTP math semantics — same numbers out, only sourcing/caching change.
- The admin pool-picker client fetch (`apps/admin` `useCards`) — recorded
  follow-up, not this plan.

## Git workflow

- Branch: `advisor/101-pack-list-aggregate`
- Conventional commits, e.g. `perf(packs): SQL composition aggregate replaces the full-table scans`.
- No push/PR without operator instruction.

## Steps

### Step 1: read + decide the admin split

Read both routes end-to-end. Determine: does the store route use
`allOdds`/`allCards` for ANYTHING besides `poolComposition`? Does the admin
route's EV math need row-level odds? Record the answers in the commit message
— they decide whether admin gets aggregate+cache or cache-only (see Target
design).

**Verify**: answers written down; no edits yet.

### Step 2 (RED): the parity test

In `packs-list-stats.spec.ts`, add a case that seeds one pack with the full
skip-set zoo — a normal graded PSA 10 card, a graded PSA 9, a raw card, a
reward row (`card_id: null`), and an orphaned odds row (odds row whose card is
then deleted) — and asserts the ROUTE's `group`/`psa10` output equals what
`poolComposition` computes over the same seeded rows (import it directly in
the spec). This is the SQL-vs-TS parity pin.

**Verify**: passes against CURRENT code (both paths are the TS fold today) —
this is a characterization test; it must be green before AND after.

### Step 3 (GREEN): the aggregate + rewire the store route

Implement the service method; rewire `store/packs/route.ts` to consume it
(delete the two `pageAll` calls there). Keep the 30s cache exactly as-is.

**Verify**: `packs-list-stats` suite green (incl. Step 2); `card-view` unit
suite green (untouched); typecheck green.

### Step 4: admin route

Per Step 1's answer: either consume the same aggregate (if EV math permits) or
add the 30s cache + single-flight + clear seam lifted from the store route.
Either way the admin route must stop double-scanning on EVERY load.

**Verify**: admin pack-list HTTP suite (grep the http tests for the admin
packs route suite name) green; typecheck green.

### Step 5: EXPLAIN sanity (live DB available only)

Against `pokenic-postgres`, `EXPLAIN` the new aggregate. Expect index/seq
choices proportional to odds rows ONCE — no per-pack loops. If it seq-scans
`card` and that table is large in prod, note it in the README row (an index on
the join key is a separate operator decision).

**Verify**: EXPLAIN output pasted into the README row or commit body.

## Test plan

- Step 2's parity case (the load-bearing one — it pins the skip-set).
- Existing `packs-list-stats`, `card-view.unit`, storefront `catalog-group`
  suites green throughout.
- If Step 4 chose the cache path: a cache-hit case modeled on the store
  route's existing cache tests (grep `listCache` in the http suites).

## Done criteria

- [ ] `grep -n "pageAll" backend/packages/api/src/api/store/packs/route.ts` → 0 matches
- [ ] Admin route: either 0 `pageAll` composition scans or a 30s cache wrapping them
- [ ] Parity case green; all suites in the commands table green
- [ ] `poolComposition` in `card-view.ts` unedited
- [ ] `git status` clean outside scope; `plans/README.md` row updated

## STOP conditions

- `isGraded`/`isPsa10` turn out to encode logic not expressible in one SQL
  predicate (e.g. a TS-side normalization table) — STOP; the cache-only
  fallback for BOTH routes is the reduced scope, report it.
- The soft-delete scoping of `listPackOdds({})` cannot be confirmed from an
  existing raw-SQL exemplar — STOP rather than guess (a scope mismatch would
  silently change composition for archived cards).
- Step 2's parity case fails BEFORE your changes (pre-existing route/TS
  divergence) — that is a new finding; report it.

## Maintenance notes

- The parity test is the contract: any future change to `isGraded`/`isPsa10`
  must update the SQL predicate AND will be caught by it.
- The admin pool-picker still transfers the whole catalog client-side
  (`apps/admin/src/lib/queries.ts useCards`) — recorded follow-up; pair with a
  server-paged picker when the catalog actually hurts.
- Reviewer: check the aggregate's join key (`c.handle = o.card_id`) against the
  model — `card_id` on odds rows stores the card HANDLE in this schema (that is
  what `byHandle.get(o.card_id)` implies); if that reading is wrong, the parity
  test will catch it.
