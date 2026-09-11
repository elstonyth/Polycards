# Plan 134: Harden `/store/pulls/gaps` — a rate limiter, one ledger scan instead of two, a bounded window, and a view schema on the chart

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Do NOT update
> `plans/README.md`; the reviewer maintains it.
>
> **Drift check (run first)**:
> `git diff --stat 1bc30e6b..HEAD -- backend/packages/api/src/api/middlewares.ts backend/packages/api/src/api/store/pulls/gaps/route.ts backend/packages/api/src/modules/packs/service.ts backend/packages/api/integration-tests/http/pulls-gaps.spec.ts src/components/PullGapsChart.tsx src/lib/data/schemas.ts src/lib/data/packs.ts CONTEXT.md`
> Expected on a branch cut from origin/master `51f74bcd`: `middlewares.ts`
> (+52 — four `/admin/players*` / `/admin/customer-groups*` matchers near the
> end of the array; nothing in the `/store` block), `service.ts` (+126,
> partner groups; nothing inside `pullGaps`), `schemas.ts` (+19, account
> policy fields; nothing near `PullGapsSchema`). Anything else → compare
> against "Current state"; on a mismatch, STOP. Locate code by symbol name,
> not line number.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED — Step 4 changes what `current`/`avg` mean for a never-hit tier; it is gated on a decision recorded in CONTEXT.md
- **Depends on**: none
- **Category**: security / perf / bug
- **Planned at**: commit `1bc30e6b` (working tree), 2026-09-10; drift-checked against origin/master `51f74bcd`

## Why this matters

`GET /store/pulls/gaps` (#538, the pull-history stats chart) is the most
expensive public read the storefront has, and the only new public route in
the delta with **no rate-limit matcher**. Its two sibling public routes from
the same weeks got one (`/store/payments/config` → `storeReadRateLimit`,
`/store/referral/codes/*` → `profile-read`). The route is reachable with the
publishable key, which ships in the browser bundle.

Per cache miss it runs the same CTE **twice** — a `ROW_NUMBER()` window over
every `source='pack'` pull in scope (the whole ledger on the global feed),
with a correlated `EXISTS` against `pack_odds` per row — once for four
scalars and once for 20 hit rows. Six tiers × a 5-second TTL lets one
anonymous caller force ~72 double scans a minute, each holding a pooled
Postgres connection (the pool is five). The author's own cost note
(`service.ts` above `pullGaps`) relies on "the chart only being fetched while
its tab is open" — a client-behaviour assumption a direct caller does not
honour, and one the chart itself no longer keeps: it refetches on every
`refreshKey` change, and the panel keys that on the drought counters, which
move on every new pull the 10-second feed poll observes.

On the storefront, `PullGapsChart` is the one same-origin poller that parses
its response with a bare cast instead of a schema. The three sibling pollers
validate through `parseOne(...PollResponseSchema)` because, as
`schemas.ts:1121-1124` says, "rolling deploys can answer with the older view
shape". A 200 with no `hits` array throws inside render and takes the whole
pull-history panel down through the error boundary, where the component's
own `unavailable` branch was meant to catch it.

After this plan: the route carries the store read budget; one scan per miss;
the scan is bounded to the newest N pulls with the bound recorded in the
domain glossary; the chart rejects an incompatible payload and shows its
unavailable state instead of crashing.

## Current state

### Files

- `backend/packages/api/src/api/middlewares.ts` — the matcher array; `storeReadRateLimit = rateLimit('store-read')` at line 79; the `/store/payments/config` entry at 846-855 is the template.
- `backend/packages/api/src/api/store/pulls/gaps/route.ts` (129 lines) — the route: 5 s / 256-entry cache, slug gate, `packs.pullGaps`, puller enrichment.
- `backend/packages/api/src/modules/packs/service.ts` — `pullGaps` (~line 5946-6012), `PULL_TIER_SQL` (line 302), the capped exemplar `profileStatsForCustomer` (~6016-6040, "capped to the NEWEST 20k pulls … the LIMIT in the `capped` CTE").
- `backend/packages/api/integration-tests/http/pulls-gaps.spec.ts` — one HTTP case (`'numbers the ledger, gaps each hit from the previous one, and reads the published rate'`, line 99).
- `src/components/PullGapsChart.tsx` (~200 lines) — the client; fetch at 53-73.
- `src/lib/data/schemas.ts` — `PullGapsSchema` (backend shape, line 247) and the "same-origin polling responses" block (line 1119) with `CardPollResponseSchema`, `PackPollResponseSchema`, `RecentPollResponseSchema`.
- `src/lib/data/packs.ts` — `PullGaps` / `PullGapHit` view types (lines ~560-590) and `getPullGaps` (595).
- `src/app/api/pull-gaps/route.ts` — the same-origin proxy (`force-dynamic`, 5 s memo). Unchanged by this plan.
- `CONTEXT.md` — §"Opening a pack" glossary entries **Drought** (line 69) and **Gap** (line 76).

### Excerpts

The limiter and the template entry:

```ts
// middlewares.ts:79
const storeReadRateLimit = rateLimit('store-read');
// middlewares.ts:847-855
    {
      // The active gateway's money bands (GET /store/payments/config), read by
      // the top-up sheet and the withdrawal form on open. Public — nothing
      // secret, and the sheet must know the floor before the customer types —
      // but every endpoint is throttled, so it shares the store read budget.
      matcher: '/store/payments/config',
      method: 'GET',
      middlewares: [storeReadRateLimit],
    },
```

`rate-limit.ts:875-878`: `'store-read': { message: 'Too many requests.', defaults: STORE_READ_DEFAULTS }`
(120 / 10 s burst, 480 / 60 s sustained per IP, per the CONTEXT/plan-081 notes).
There is no `/store/pulls/gaps` matcher anywhere in the file; the only
`/store/pulls` entries are the two POSTs (`*/reveal`, `close-instant`).

The query (abridged; read the whole method):

```ts
// service.ts ~5944-5945 (docblock tail)
// Two full scans of the scope's ledger per call — bounded by the route's
// 5s cache and by the chart only being fetched while its tab is open.
// service.ts ~5967-5981
const ctes =
  'WITH seq AS (' +
  '  SELECT p.id, p.customer_id, p.rolled_at, ' +
  '         ROW_NUMBER() OVER (ORDER BY p.rolled_at ASC, p.id ASC) AS n, ' +
  '         ' +
  PULL_TIER_SQL +
  ' AS hit ' +
  '    FROM pull p ' +
  "   WHERE p.deleted_at IS NULL AND p.source = 'pack'" +
  packSql +
  '), hits AS (' +
  '  SELECT id, customer_id, rolled_at, n, ' +
  '         (n - COALESCE(LAG(n) OVER (ORDER BY n), 0))::int AS gap ' +
  '    FROM seq WHERE hit ' +
  ') ';
const [scalars] = await em.execute(
  ctes +
    'SELECT (SELECT COUNT(*) FROM seq)::int AS total, (SELECT MAX(n) FROM hits)::int AS last_n, (SELECT AVG(gap) FROM hits)::float AS avg_gap, (SELECT AVG(gap) FROM (SELECT gap FROM hits ORDER BY n DESC LIMIT 20) t)::float AS last20_gap',
  scopeParams,
);
const hits = await em.execute(
  ctes +
    'SELECT id, customer_id, rolled_at, gap FROM hits ORDER BY n DESC LIMIT ?',
  [...scopeParams, opts.limit],
);
```

```ts
// service.ts:302-306
const PULL_TIER_SQL =
  'EXISTS (SELECT 1 FROM pack_odds o WHERE o.pack_id = p.pack_id ' +
  '  AND o.card_id = p.card_id AND o.deleted_at IS NULL AND o.rarity = ?)';
```

The capped exemplar (comment only — read the SQL under it for the CTE shape):

```ts
// service.ts ~6021-6025
//  - capped to the NEWEST 20k pulls (the route's documented MAX_PULLS
//    aggregation cap — now the LIMIT in the `capped` CTE),
```

The glossary this plan must keep true:

```md
<!-- CONTEXT.md:69-73 -->

**Drought** (pull history):
For one chase tier in one scope (a pack, or the whole ledger), how many
pack-source Pulls have been rolled since that tier last hit — "303 packs
without Immortal". Counted in (rolled_at, id) order; a tier never hit counts
every pull on record. Public display, unfiltered by the feed's tier tab.
```

The chart's fetch:

```tsx
// src/components/PullGapsChart.tsx:53-66
  useEffect(() => {
    let active = true;
    const q = new URLSearchParams({ rarity: tier });
    if (packSlug) q.set('pack_id', packSlug);
    fetch(`/api/pull-gaps?${q.toString()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<PullGaps | null>) : null))
      .then((body) => {
        if (!active) return;
        if (body) {
          setData(body);
          setLoadedScope(scope);
        }
        setFailed(!body);
      })
```

The sibling pattern:

```ts
// src/lib/use-recent-pulls.ts:27
const body = parseOne(RecentPollResponseSchema, next);
// src/lib/data/schemas.ts:1119-1124
// --- same-origin polling responses ------------------------------------------
/** Browser JSON is version-sensitive even on the same origin: rolling deploys
 * can answer with the older view shape. Reject incompatible data before it
 * replaces the seed/last-good view; routes separately retain old-tab aliases.
 * These schemas validate the current VIEW, not the backend Store envelope. */
```

The view shape the proxy returns is exactly `getPullGaps`'s return
(`src/lib/data/packs.ts` ~603-627): `{ rarity, pct, expected, avg, last20,
current, hits: [{ id, gap, rolledAt, who, avatar, frame }] }` with `who`
defaulting to `'Anonymous'`, `avatar`/`frame` nullable strings.

### Conventions

- Middleware entries carry a comment explaining _why_ that tier; match the
  register of the `/store/payments/config` entry.
- Raw SQL in the service is built as concatenated string literals with `?`
  bindings; integer cents; `::int` / `::float` casts on aggregates.
- Storefront view schemas live in the "same-origin polling responses" block
  and are `z.object` (strict) — not `looseObject` — because they validate a
  view this repo owns.
- Vitest specs sit in `__tests__/` beside the code; `src/lib/__tests__/pull-gaps.test.ts` and `src/app/api/pull-gaps/__tests__/route.test.ts` already exist — read both for the fixture shape.

## Commands you will need

| Purpose                     | Command                                                                                             | Expected on success                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Backend typecheck           | `cd backend && corepack yarn check-types`                                                           | exit 0                                                      |
| Backend lint                | `cd backend && corepack yarn lint`                                                                  | exit 0                                                      |
| Gaps HTTP spec (real DB)    | `cd backend/packages/api && node integration-tests/run-http-shards.mjs pulls-gaps pulls-recent`     | all pass (local `pokenic-postgres` up; no `DB_*` overrides) |
| Storefront typecheck        | `npm run typecheck`                                                                                 | exit 0                                                      |
| Storefront tests (filtered) | `npx vitest run src/lib/__tests__/pull-gaps.test.ts src/app/api/pull-gaps src/components/__tests__` | all pass                                                    |
| Storefront lint + format    | `npm run lint && npx prettier --check src/components/PullGapsChart.tsx src/lib/data/schemas.ts`     | exit 0                                                      |

## Scope

**In scope** (the only files you should modify):

- `backend/packages/api/src/api/middlewares.ts` — one new entry in the `/store` block
- `backend/packages/api/src/modules/packs/service.ts` — `pullGaps` only
- `backend/packages/api/src/api/store/pulls/gaps/route.ts` — comment only (if the cost note changes)
- `backend/packages/api/integration-tests/http/pulls-gaps.spec.ts`
- `CONTEXT.md` — the **Drought** and **Gap** entries only (Step 4)
- `src/components/PullGapsChart.tsx` — the fetch `.then` only
- `src/lib/data/schemas.ts` — one new schema in the polling block
- `src/components/__tests__/pull-gaps-chart.test.tsx` (create)

**Out of scope** (do NOT touch, even though they look related):

- `src/app/api/pull-gaps/route.ts` — the proxy's 5 s memo and 503-on-null are correct.
- `/store/pulls/recent` and `pullDrought` — `LIMIT 1` + bounded `COUNT`; not the outlier.
- The route's FIFO cache (`remember`) — `ponytail:`-marked ceiling.
- `src/components/PullHistory.tsx` — the `refreshKey` wiring is a product choice (drought moves → chart refreshes); the fix is server-side cost, not client behaviour.
- A store-wide rate-limit coverage probe — plan 136.

## Git workflow

- Branch: `advisor/134-pull-gaps-hardening`
- Conventional commits per step, e.g. `fix(pulls): rate-limit the gaps chart route on the store read budget`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: The limiter

`middlewares.ts`: add, immediately after the `/store/payments/config` entry:

```ts
    {
      // The pull-history stats chart (GET /store/pulls/gaps). Public and
      // publishable-key scoped like /store/pulls/recent, but a cache miss
      // costs a window-function pass over the scope's whole pack ledger —
      // the most expensive public read there is — so it takes the store read
      // budget rather than trusting the client to fetch only while its tab
      // is open (plan 134).
      matcher: '/store/pulls/gaps',
      method: 'GET',
      middlewares: [storeReadRateLimit],
    },
```

**Verify**: `grep -n "'/store/pulls/gaps'" backend/packages/api/src/api/middlewares.ts` → exactly one match; `cd backend && corepack yarn check-types` → exit 0. Then in `pulls-gaps.spec.ts` add a case that fires `STORE_READ_DEFAULTS.burstLimit + 1` requests (import the constant from `src/api/utils/rate-limit`) and asserts the last answers `429` — model after any existing 429 case (`grep -rn "toBe(429)" backend/packages/api/integration-tests/http | head`).

### Step 2: One scan

In `pullGaps`, fold the scalars into the hits query so the CTE executes once.
Target shape (keep the CTEs as they are; replace the two `execute` calls with
one):

```sql
<ctes>
SELECT h.id, h.customer_id, h.rolled_at, h.gap,
       (SELECT COUNT(*) FROM seq)::int                      AS total,
       (SELECT MAX(n) FROM hits)::int                       AS last_n,
       (SELECT AVG(gap) FROM hits)::float                   AS avg_gap,
       (SELECT AVG(gap) FROM (SELECT gap FROM hits ORDER BY n DESC LIMIT 20) t)::float AS last20_gap
  FROM hits h
 ORDER BY h.n DESC
 LIMIT ?
```

Read the scalars from the first row (all rows carry identical scalar
columns). When there are **zero hits** the query returns no rows, so run the
scalar-only statement as the fallback in that case — it is the existing
scalars query minus nothing; keep it under a `if (rows.length === 0)` branch.
That is still one scan on the common path and two only for an empty tier.
Postgres materialises `seq` once per statement, so the four scalar
subqueries do not re-scan the ledger.

Update the docblock: "One scan of the scope's ledger per call (two only when
the tier has never hit)".

**Verify**: `cd backend/packages/api && node integration-tests/run-http-shards.mjs pulls-gaps` → the existing case (line 99) passes unchanged — it pins `current`, `avg`, `last20`, the hit order and every gap value.

### Step 3: Chart view schema

`schemas.ts`, in the "same-origin polling responses" block after
`RecentPollResponseSchema`:

```ts
export const PullGapsPollResponseSchema = z.object({
  rarity,
  pct: finite.nullable(),
  expected: finite.nullable(),
  avg: finite.nullable(),
  last20: finite.nullable(),
  current: finite.refine((n) => n >= 0),
  hits: z.array(
    z.object({
      id: z.string(),
      gap: finite.refine((n) => n >= 0),
      rolledAt: z.string(),
      who: z.string(),
      avatar: z.string().nullable(),
      frame: z.string().nullable(),
    }),
  ),
});
```

(`rarity` and `finite` are the file's existing helpers; `count` is defined
later in the file near `PullGapsSchema` — reuse it if it is in scope at this
point, otherwise inline the refine as above.)

`PullGapsChart.tsx`: replace the cast with the parse —

```ts
      .then((r) => (r.ok ? r.json() : null))
      .then((raw: unknown) => {
        if (!active) return;
        const body = raw == null ? null : parseOne(PullGapsPollResponseSchema, raw);
```

and keep the rest of the `.then` unchanged (`body` null → `setFailed(true)`,
which is the `unavailable` branch). Import `parseOne` and the schema from
`@/lib/data/schemas`. The `PullGaps` type stays the state type; `parseOne`'s
return is structurally identical — if TypeScript disagrees, `satisfies` /
a `PullGaps` annotation on the parsed value is acceptable, a cast is not.

**Verify**: `npm run typecheck` → exit 0; `npx vitest run src/components/__tests__/pull-gaps-chart.test.tsx` → the new cases in Test plan pass.

### Step 4: Bound the window (decision gate)

The window scan is unbounded because CONTEXT.md defines a never-hit tier's
drought as "every pull on record". A cap changes that number. The advisor's
recommended answer, to be recorded rather than re-derived:

> **Cap at the newest 20,000 pack-source pulls per scope** — the same
> `MAX_PULLS` bound `profileStatsForCustomer` already uses — and let the
> glossary say so: a drought or a first-hit gap is counted within the newest
> 20,000 pulls in scope; the chart shows "20,000+" when the bound is reached.

Do this step **only if** the operator has confirmed the cap in the plan's
README row or in the dispatch message. If neither says so, skip Step 4,
leave the scan unbounded, and note it in your report — Steps 1–3 already
remove the limiter gap, halve the cost, and fix the crash.

If confirmed:

- Add `WITH capped AS (SELECT ... FROM pull p WHERE ... ORDER BY p.rolled_at DESC, p.id DESC LIMIT 20000), seq AS (SELECT ..., ROW_NUMBER() OVER (ORDER BY rolled_at ASC, id ASC) AS n ... FROM capped)` — copy the exact shape from `profileStatsForCustomer`'s `capped` CTE.
- Return a new boolean `bounded` (true when `total === 20000`); the route passes it through as `bounded`; the storefront view/schema gain `bounded: z.boolean().optional()` (optional so an older backend still parses); the chart renders `current` as `"20,000+"` when `bounded && current >= 20000`.
- `CONTEXT.md` **Drought** and **Gap** entries: replace "a tier never hit counts every pull on record" with "a tier never hit counts every pull in the newest 20,000 in scope (the pull-history window); the chart says '20,000+' at the bound".
- HTTP spec: seed 20,001 pulls is too slow — instead make the cap injectable (`opts.window ?? PULL_GAPS_WINDOW`) and test with `window: 3` that the 4th-oldest pull is excluded from `current` and `bounded` is true.

**Verify**: the HTTP spec's new bounded case passes; `grep -n "20,000" CONTEXT.md` → 2 matches (Drought, Gap).

### Step 5: Full verification

Run every command in the Commands table.

## Test plan

- `pulls-gaps.spec.ts` (HTTP, real DB): (a) 429 after the burst limit (Step 1);
  (b) the existing arithmetic case unchanged (Step 2); (c) a tier with zero
  hits answers `hits: []`, `current: <total pulls>`, `avg: null` — this is
  the fallback branch Step 2 introduces; (d) if Step 4 ran, the `window: 3`
  bounded case.
- `src/components/__tests__/pull-gaps-chart.test.tsx` (vitest + jsdom; model
  after an existing component test such as
  `src/components/__tests__/*.test.tsx` — pick one that stubs `fetch`):
  (a) a 200 whose body is `{}` renders the unavailable state and does **not**
  throw; (b) a 200 with a valid body renders one bar per hit; (c) a 503
  renders unavailable (existing behaviour, now pinned).
- Mutation check for (a): temporarily revert the `parseOne` to the cast and
  confirm test (a) fails with a `TypeError`; restore.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -c "'/store/pulls/gaps'" backend/packages/api/src/api/middlewares.ts` → `1`
- [ ] `grep -c "em.execute" <(sed -n '/async pullGaps(/,/^  }/p' backend/packages/api/src/modules/packs/service.ts)` → `2` (the main statement plus the zero-hit fallback), down from 2 statements that both scan on every call — confirm by reading that the fallback is inside `if (rows.length === 0)`
- [ ] `cd backend/packages/api && node integration-tests/run-http-shards.mjs pulls-gaps` exits 0 with ≥ 2 new cases
- [ ] `grep -c "PullGapsPollResponseSchema" src/components/PullGapsChart.tsx src/lib/data/schemas.ts` → each `1`
- [ ] `grep -c "as Promise<PullGaps" src/components/PullGapsChart.tsx` → `0`
- [ ] `npm run typecheck` and `npx vitest run src/components/__tests__/pull-gaps-chart.test.tsx` exit 0
- [ ] `cd backend && corepack yarn check-types` exits 0
- [ ] Step 4 either done with the CONTEXT.md edit present, or explicitly reported as skipped for lack of the operator's confirmation
- [ ] `git status --porcelain` lists only in-scope files

## STOP conditions

Stop and report back (do not improvise) if:

- `pullGaps` no longer builds `ctes` as one string reused by two `execute`
  calls (the shape Step 2 rewrites).
- `STORE_READ_DEFAULTS` is not exported from `rate-limit.ts` (find the
  store-read numbers another way and report — do not hard-code 120).
- The existing HTTP case at `pulls-gaps.spec.ts:99` fails **before** your
  change (run it once untouched first).
- `PullGapsChart` no longer fetches through `/api/pull-gaps` (someone moved
  it onto `use-live-poll` — then the schema belongs in that adopter's
  `accept`, and the plan needs re-scoping).
- You reach Step 4 without the operator's confirmation — skip it, do not
  guess.

## Maintenance notes

- Reviewers: the one thing to read closely is the zero-hit fallback in
  Step 2 — `current` for a never-hit tier must still equal the scope's total
  pull count (the HTTP case (c) pins it).
- If Step 4 lands, `profileStatsForCustomer` and `pullGaps` share the 20,000
  bound conceptually but not as one constant; a follow-up may hoist
  `MAX_PULLS` into a shared export. Not required here.
- The chart's `refreshKey` = drought JSON (`PullHistory.tsx:315`) means the
  proxy's 5 s memo is what actually bounds backend calls on a busy feed. If
  the feed poll ever drops below 5 s, revisit.
- Plan 136's store coverage probe will list `/store/pulls/recent`,
  `/store/leaderboard`, `/store/packs`, `/store/packs/*`, `/store/cards/*`,
  `/store/challenge`, `/store/pricing/fx`, `/store/avatar-frames` as
  unlimited public GETs — all cached, all pre-delta; that plan decides their
  EXEMPT entries, not this one.
