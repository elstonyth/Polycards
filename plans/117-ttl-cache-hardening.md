# Plan 117: Bound the TTL caches, close the malformed-200 hole, and finish the cache adoption

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 30eded61..HEAD -- src/lib/ttl-cache.ts src/lib/data/packs.ts src/lib/data/leaderboard.ts src/lib/data/avatar-frames.ts src/lib/data/challenge.ts src/app/api/recent-pulls/route.ts backend/packages/api/src/api/store/pulls/recent/route.ts src/lib/__tests__/ttl-cache.test.ts`
> On any in-scope change since `30eded61`, compare the "Current state"
> excerpts before proceeding; on a mismatch, treat as STOP.

## Status

- **Priority**: P2
- **Effort**: M (a bundle of S steps in one file cluster)
- **Risk**: LOW
- **Depends on**: none (plan 116 touches only comments in adjacent files;
  if both run concurrently, 117 owns `ttl-cache.ts`'s code and 116 its
  header comment — coordinate the header edit or run 116 first)
- **Category**: security + perf + bug + tests
- **Planned at**: commit `30eded61`, 2026-08-22

## Why this matters

PR #473 added `src/lib/ttl-cache.ts` (a per-process promise memo) and
adopted it on the public read path. Three gaps, each confirmed by reading:

1. **Unbounded, attacker-keyed growth**: the cache `Map` has no size cap
   and never removes expired entries (the only `delete` is the
   rejected-promise path). `/api/recent-pulls` keys the cache on the raw
   `pack_id` query param — unauthenticated, unvalidated, no rate limit at
   either hop — so every fresh param mints a permanent entry AND pays a
   full backend hop (a guaranteed miss). This adds a slow memory-growth
   vector to the exact storefront box whose OOM incident motivated #473
   (`--max-old-space-size=896` on 1 GiB). The backend's own
   `store/pulls/recent` Map has the same unbounded-key shape (it caches
   the empty 200 for unknown packs).
2. **Malformed-200 cached as empty**: the helper's stated contract is
   "callers must let their loader throw and catch the degradation
   OUTSIDE" — but three of four adopters swallow a _shape_ failure inside
   the loader and resolve an empty value, which then serves for the whole
   window: a 200 with a garbage body (deploy skew, proxy error page,
   schema rename) blanks the catalog / avatar frames / board for a full
   TTL on that instance.
3. **One missed adoption + zero adopter tests**: `getChallenge` still pays
   the backend hop + zod parse per `/leaderboard` request (its two sibling
   calls on the same page are cached), and no test pins any adopter's
   throw-inside/catch-outside contract — the most delicate convention in
   the new layer is enforced by prose only.

## Current state

Files:

- `src/lib/ttl-cache.ts` (63 lines) — the helper. Store and set path:

  ```ts
  const store = new Map<string, Entry>();
  …
  export function cached<T>(key, ttlMs, load): Promise<T> {
    const hit = store.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
    const value = load();
    store.set(key, { expires: Date.now() + ttlMs, value });
    void value.catch(() => {
      if (store.get(key)?.value === value) store.delete(key);
    });
    return value;
  }
  export function clearTtlCache(): void { store.clear(); }
  ```

  The header (lines 32-38) states the contract: "callers must let their
  loader throw and catch the degradation OUTSIDE this call — a loader that
  catches its own failure and returns `[]` resolves successfully, and
  nothing here can tell that empty result from a real one."

- `src/app/api/recent-pulls/route.ts:35-42` — the attacker-keyed adopter:

  ```ts
  const pack = request.nextUrl.searchParams.get('pack_id')?.trim();
  const body = await cached(
    `recent-pulls:${pack || ''}`,
    CACHE_TTL_MS,
    async () =>
      JSON.stringify({ pulls: await getRecentPulls(pack || undefined) }),
  );
  ```

  Its comment block (:22-28) records a DELIBERATE opt-out of the
  throw-contract (`getRecentPulls` returns `[]` on failure because its
  other callers depend on that) and argues the cached-empty blip is inert.
  **Honor that opt-out — do not make this loader throw.**

- `src/lib/data/packs.ts` — `loadPackCategories` (:92-135) parses
  `Array.isArray(packs) ? packs : []` — a malformed body quietly becomes
  an all-empty-category catalog and is cached; the wrapper
  `getPackCategories` (:150+) is the repo's exemplar of the correct
  throw-split otherwise (its doc comment explains the eviction rationale).
- `src/lib/data/leaderboard.ts` — `fetchBoard` (:68-80):
  `if (!Array.isArray(entries) || entries.length === 0) return [];`
  inside the `cached()` loader. Empty-and-valid is legitimate; NOT-an-array
  is malformed and must throw.
- `src/lib/data/avatar-frames.ts` (:28-36): inside the loader,
  `return parsed ? parsed.frames : {};` — `parseOne` returning null
  (schema reject) caches `{}` for 60s; the file's own earlier comment says
  the throw-split exists so "one blip would [not] strip every avatar frame
  for the full 60s window".
- `src/lib/data/challenge.ts` — `getChallenge` (:130-140, catch at
  :326-329): fetch + parse + `if (!data || !data.active || …) return null`
  all inside one try, `catch → null`. No `cached()` anywhere
  (`grep -c "cached(" src/lib/data/challenge.ts` → 0). Note: `null` today
  conflates "challenge off" (legit, cacheable) with "backend failed /
  malformed" (must NOT cache).
- `backend/packages/api/src/api/store/pulls/recent/route.ts:38-48` — the
  backend's `recentCache` Map, keyed on the same untrusted slug, caching
  empty 200s for unknown packs.
- `src/lib/__tests__/ttl-cache.test.ts` — 5 cases on the primitive;
  `src/lib/data/__tests__/packs-price.test.ts:18,45` shows the
  `clearTtlCache()` test seam in use.

Conventions:

- Zod parses via `parseOne`/`parseList` from the repo's schema helpers
  (see their use in the files above); `parseOne` returns `T | null`.
- Storefront tests: vitest, files `src/**/__tests__/*.test.ts`. Backend:
  jest (`--testPathPatterns`, plural).

## Commands you will need

| Purpose                                                         | Command                                              | Expected             |
| --------------------------------------------------------------- | ---------------------------------------------------- | -------------------- |
| Storefront typecheck                                            | `npm run typecheck`                                  | exit 0               |
| Storefront tests                                                | `npm test`                                           | all pass (622 + new) |
| One test file                                                   | `npx vitest run src/lib/__tests__/ttl-cache.test.ts` | pass                 |
| Lint / format                                                   | `npm run lint` / `npm run format:check`              | exit 0               |
| Backend typecheck                                               | from `backend/`: `corepack yarn check-types`         | exit 0               |
| Backend http tier (only if you touch the backend route's tests) | jest `--testPathPatterns "pulls"`                    | pass                 |

## Scope

**In scope**:

- `src/lib/ttl-cache.ts` (size bound)
- `src/lib/__tests__/ttl-cache.test.ts` (new cases)
- `src/app/api/recent-pulls/route.ts` (slug shape gate)
- `src/lib/data/packs.ts`, `src/lib/data/leaderboard.ts`,
  `src/lib/data/avatar-frames.ts` (shape-throw)
- `src/lib/data/challenge.ts` (cache adoption with correct split)
- `src/lib/data/__tests__/` — new adopter contract tests (create files)
- `backend/packages/api/src/api/store/pulls/recent/route.ts` (same
  one-line size bound on `recentCache`)

**Out of scope**:

- `getRecentPulls` in `src/lib/data/packs.ts` — its return-`[]` contract
  is load-bearing for the home/pack-detail renders (documented in the
  route's comment). The route's opt-out from the throw contract stays.
- Rate limiting (either hop) — the size cap + catalog-bounded key gate
  bound the damage; adding a limiter matcher is a separate decision
  recorded in plan README's rejected list.
- `src/app/page.tsx`, `getPackChase` — no changes to route-cache
  semantics.
- Plan 116's comment edits (coordinate if concurrent).

## Git workflow

- Branch: `advisor/117-ttl-cache-hardening`
- Conventional commits per step, e.g. `fix(cache): bound the TTL store and gate recent-pulls keys`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Size-bound the storefront cache

In `src/lib/ttl-cache.ts`, after the `store.set(…)` line in `cached()`:

```ts
// Hard bound: keys can be attacker-influenced (recent-pulls' pack_id),
// and expired entries are otherwise never removed. Map iterates in
// insertion order, so this evicts oldest-inserted first — not LRU, but
// the legit key population is tiny (catalog + a few fixed keys), so
// anything evicted under pressure is an attacker key or long-expired.
if (store.size > MAX_ENTRIES) {
  store.delete(store.keys().next().value as string);
}
```

with `const MAX_ENTRIES = 256;` near the store declaration.

**Verify**: `npx vitest run src/lib/__tests__/ttl-cache.test.ts` → existing
5 pass. Then add (in the same file) a case: insert `MAX_ENTRIES + 10`
distinct keys → `expect` no throw and (export a size probe? NO — assert
behaviorally) the FIRST key inserted is gone: calling `cached(firstKey, …)`
again invokes its loader a second time while the LAST key still serves its
memo without invoking. → pass.

### Step 2: Bound the recent-pulls key to the KNOWN catalog, not just its shape

A shape regex (`^[a-z0-9-]+$`) validates form but NOT cardinality: 256
valid-shaped garbage slugs still fill the Map, and Step 1's
oldest-insertion eviction would then flush the four legitimate hot keys
(`pack-categories`, `avatar-frames`, `leaderboard:*`, `challenge`). Bound
the KEY SPACE instead — resolve `pack_id` against the already-cached
catalog slugs and collapse any miss to the global feed:

```ts
// Cache keys must be bounded to the real catalog, not just kebab-shaped:
// an unbounded valid-shaped namespace still fills the TTL Map and evicts
// the hot keys. getPackCategories is already cached (same 30s window), so
// this adds no backend hop. A slug not in the catalog scopes to the global
// feed — the same rows getRecentPulls returns for an unknown pack anyway,
// now without minting a per-garbage-key cache entry.
const raw = request.nextUrl.searchParams.get('pack_id')?.trim() ?? '';
const cats = await getPackCategories();
const known = new Set(cats.flatMap((c) => c.packs.map((p) => p.slug)));
const pack = raw && known.has(raw) ? raw : '';
```

Read `getPackCategories`' return type first to get the exact slug path
(`PackCategory[]` → each `.packs[].slug`; confirm the field name against
`src/lib/data/packs.ts`'s `toPack`/`Pack` type — adjust `.slug` if the
storefront type names it differently). Confirm the collapse-to-global is
behavior-preserving: `src/lib/use-recent-pulls.ts` only ever passes a real
catalog slug, so no legitimate caller is affected; state what you found.

Note the ordering interaction: `getPackCategories()` throwing (backend
down) would now throw in this route — but it already catches internally
and returns `[]` (Step 4 keeps that outer catch), so `cats` is `[]`,
`known` is empty, and every request collapses to the global feed during an
outage. That is correct (degraded-but-serving), not a new failure mode —
verify `getPackCategories` still has its try/catch after Step 4.

**Verify**: `npm run typecheck` → exit 0. `npm test` → pass. Add a test:
an unknown-but-valid-shaped `pack_id` produces the SAME cache key as no
`pack_id` (both global) — assert two such requests share one memo (loader
invoked once).

### Step 3: Same one-line bound on the backend `recentCache`

In `backend/packages/api/src/api/store/pulls/recent/route.ts`, at the
cache-set site add the identical oldest-insertion eviction with
`MAX_ENTRIES = 256` and a comment mirroring Step 1's (this Map caches
empty 200s for unknown pack ids, so its keys are equally mintable). Match
the file's existing comment style.

**Verify**: from `backend/`: `corepack yarn check-types` → exit 0.

### Step 4: Throw on shape failures inside the three loaders

1. `src/lib/data/packs.ts` `loadPackCategories`: replace
   `Array.isArray(packs) ? packs : []` with
   `if (!Array.isArray(packs)) throw new Error('/store/packs returned a non-array packs field');`
   then parse `packs` directly.
2. `src/lib/data/leaderboard.ts` `fetchBoard`: split the guard —
   `if (!Array.isArray(entries)) throw new Error('/store/leaderboard returned a non-array entries field');
if (entries.length === 0) return [];`
3. `src/lib/data/avatar-frames.ts`: replace
   `return parsed ? parsed.frames : {};` with
   `if (!parsed) throw new Error('/store/avatar-frames body failed schema parse');
return parsed.frames;`

Each file already has the outer catch that degrades (packs → `[]` with
`logger.error`, avatar-frames → `{}` via its catch, leaderboard's caller —
verify where `fetchBoard`'s rejection lands: `getLeaderboard` must catch
it and return `[]`; if it does not currently catch, add the try/catch at
the `getLeaderboard` level, matching `getPackCategories`' shape).

**Verify**: `npm run typecheck` → exit 0. `npm test` → pass (fix any test
that asserted the old swallow — if one did, it was pinning the bug; update
it and say so).

### Step 5: Adopt `cached()` in `getChallenge` with the correct split

Restructure `src/lib/data/challenge.ts` on the `getPackCategories`
pattern:

```ts
const CHALLENGE_TTL_MS = 30_000; // matches the backend's 30s /store/challenge window

/** Throws on fetch/parse failure; null ONLY for "challenge genuinely off"
 *  (inactive or no stages) — that null is a real state and may be cached. */
async function loadChallenge(): Promise<Challenge | null> {
  const raw = await sdk.client.fetch<unknown>('/store/challenge');
  const data = parseOne(ChallengeSchema, raw);
  if (!data) throw new Error('/store/challenge body failed schema parse');
  if (!data.active || data.stages.length === 0) return null;
  … // existing mapping body, unchanged
}

export async function getChallenge(): Promise<Challenge | null> {
  try {
    return await cached('challenge', CHALLENGE_TTL_MS, loadChallenge);
  } catch (error) {
    logger.error('[challenge] failed to load:', error);
    return null;
  }
}
```

The mapping body moves verbatim into the loader. The distinction this
step MUST preserve (it is the whole point): backend-says-off caches a
null 30s (correct — it IS the state); backend-broken throws, evicts, and
degrades to null for that request only.

**Verify**: `npm run typecheck` → exit 0.
`npx vitest run src/lib/data/__tests__/challenge.test.ts` → pass (update
mocks if the fetch call count changes — the existing tests may call
`getChallenge` twice; use `clearTtlCache()` in `beforeEach`, seam as in
`packs-price.test.ts:45`).

### Step 6: Adopter contract tests

New file `src/lib/data/__tests__/cache-contract.test.ts` (vitest, mock
`sdk.client.fetch`, `clearTtlCache()` in `beforeEach` — model the mock
wiring on `packs-price.test.ts`):

1. `getPackCategories`: fetch rejects → returns `[]` AND a second call
   re-invokes fetch (rejection was NOT cached).
2. `getPackCategories`: fetch resolves `{ packs: "garbage" }` → returns
   `[]` AND a second call re-invokes fetch (malformed-200 not cached).
   _(This case FAILS before Step 4 — write it first if you want red/green.)_
3. `getAvatarFrames`: fetch resolves a schema-invalid body → degraded
   value AND second call re-invokes fetch.
4. `getLeaderboard` (or `fetchBoard` via its public wrapper): non-array
   `entries` → degraded AND re-invoked; empty array `entries: []` →
   `[]` AND second call does NOT re-invoke (legit empty IS cached).
5. `getChallenge`: schema-invalid body → null AND re-invoked;
   `active: false` body → null AND second call does NOT re-invoke.

**Verify**: `npx vitest run src/lib/data/__tests__/cache-contract.test.ts`
→ ≥6 assertions pass. `npm test` → full suite green.

## Test plan

Covered by Steps 1 (bound case), 5 (challenge tests updated), 6 (contract
file). Pattern exemplars: `src/lib/__tests__/ttl-cache.test.ts` for the
primitive, `src/lib/data/__tests__/packs-price.test.ts` for mocking
`sdk.client.fetch` + the `clearTtlCache` seam.

## Done criteria

- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check` exit 0
- [ ] `npm test` → all pass, including ≥7 new cases (1 bound + ~6 contract)
- [ ] Backend `corepack yarn check-types` exits 0
- [ ] `grep -n "Array.isArray(packs) ? packs : \[\]" src/lib/data/packs.ts` → 0 matches
- [ ] `grep -n "parsed ? parsed.frames : {}" src/lib/data/avatar-frames.ts` → 0 matches
- [ ] `grep -c "cached(" src/lib/data/challenge.ts` → ≥1
- [ ] `grep -c "MAX_ENTRIES" src/lib/ttl-cache.ts` → ≥2; same grep on the backend recent route → ≥2
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Excerpt mismatch (drift).
- `getLeaderboard` turns out to have no place to catch `fetchBoard`'s new
  rejection without changing its public return type — report the actual
  call graph instead of changing the type.
- Step 5's mapping body extraction forces signature changes visible to
  `WeeklyChallenge.tsx` / `page.tsx` callers — the public
  `getChallenge(): Promise<Challenge | null>` must not change; report if
  it would.
- You are tempted to make `getRecentPulls` throw — its `[]` contract is
  load-bearing (documented in the route's comment block).

## Maintenance notes

- Anyone adding a `cached()` adopter must add a contract case to
  `cache-contract.test.ts` — the file's header should say so.
- The 256-entry bound assumes a small legit key population (fixed keys +
  one per catalog slug). If keys ever become per-user, this cache is the
  wrong tool entirely — see the "no auth state" invariant in the header.
- Backend `store/packs/[slug]`'s `packCache` deliberately caches only 200
  bodies, so unknown slugs don't mint entries there — that is why it
  needed no bound.
- Deferred, recorded: a rate-limit matcher for `/store/pulls/recent` (the
  only unauthenticated param-keyed store route with no limiter). Not done
  here because the caps make the attack pointless; revisit if backend CPU
  from feed queries ever shows up in metrics.
