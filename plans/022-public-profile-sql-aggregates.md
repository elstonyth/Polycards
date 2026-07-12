# Plan 022: Aggregate the public profile route in SQL and cache it

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat e9ce6968..HEAD -- "backend/packages/api/src/api/store/profiles/[handle]/route.ts" backend/packages/api/src/modules/packs/service.ts backend/packages/api/integration-tests/http/public-profile.spec.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED — stat definitions must stay exactly parity with today's
  values (the route's own comments define the tolerances); mitigated by the
  existing `public-profile.spec.ts` plus new parity assertions.
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `e9ce6968`, 2026-07-12

## Why this matters

Every public `/store/profiles/:handle` view loads up to **20,000 pull rows**
into Node (`MAX_PULLS`), then fetches their cards and a pack-odds set whose
`take` ceiling is `packIds.length * cardIds.length` (~100k rows for a heavy
collector), and folds them in JavaScript — all to produce a 12-item recent
feed, a showcased list, and two scalar stats (`volume`, `by_rarity`). The
route has **no cache**, unlike its siblings (`/store/leaderboard`,
`/store/pulls/recent`, `/store/packs` all have per-process TTL caches), so
bots, link unfurls, and repeat views re-pay the full cost every hit. The
backend already computes the same per-customer aggregates in SQL for the
leaderboard (`leaderboardTop`'s windowed `GROUP BY` CTEs;
`packOpenSpendCents` is already the single-customer spend aggregate this
route uses for `points`). The profile route is the straggler that never
adopted the aggregate pattern.

## Current state

All excerpts verified 2026-07-12.

- `backend/packages/api/src/api/store/profiles/[handle]/route.ts` — the
  route. Key parts:
  - `:26-27` — `const RECENT_N = 12;` and
    `const MAX_PULLS = 20_000; // same aggregation cap as the leaderboard`
  - `:18-25` — PII whitelist comment: PUBLIC route, payload is display name /
    avatar seed / join date / pull stats / recent pulls' card display fields.
    **NEVER email, customer id, addresses, credit balance, or vault/buyback
    state.** Any new SQL must not widen this.
  - `:50-58` — C1 comment + the over-fetch:
    ```ts
    // C1: exclude reward Pulls from the public profile ... Filter IN the
    // query (source='pack' ...). A post-`.filter()` would run AFTER the
    // MAX_PULLS cap ...
    const pulls = await packs.listPulls(
      { customer_id: customer.id, source: 'pack' },
      { take: MAX_PULLS, order: { rolled_at: 'DESC' } },
    );
    ```
  - `:62-73` — lookup tables: `listCards({ handle: cardIds })` and
    `listPackOdds({ pack_id: packIds, card_id: cardIds }, { take:
packIds.length * cardIds.length })`.
  - `:85-107` — the JS fold: `volume += card ? cardMyr(card) : 0;` and
    `byRarity[rarityOf(p.pack_id, p.card_id)] += 1;` per pull row;
    `points = await packs.packOpenSpendCents(customer.id)` (already an SQL
    aggregate); the comment records accepted drift: _"volume ... can drift
    from the board by cents (per-card rounding here vs one sum-level round
    there) and is computed over the MAX_PULLS-capped list (pre-existing
    cap)."_
  - Below that: `recent` = newest-12 with card display fields (skip pulls of
    deleted cards, filter BEFORE slicing), and a showcased `collection`.
- `backend/packages/api/src/modules/packs/service.ts:2257+` —
  `leaderboardTop(opts, ctx)`: the template. Two windowed SQL aggregates
  joined by customer (spend from the credit ledger, pulls + winnings from the
  Pull ledger), executed via
  `const em = (sharedContext.transactionManager ?? sharedContext.manager) as
unknown as LedgerSqlManager; await em.execute<...>(...)`. Its comment notes
  the indexes the scans ride (`IDX_pull_rolled_at`, partial
  `IDX_credit_transaction_pack_open_created_at`).
  `service.ts:2331` — `packOpenSpendCents(customerId)`.
- `backend/packages/api/src/api/store/leaderboard/route.ts:23-44` — the cache
  pattern to copy (verified):
  ```ts
  const CACHE_TTL_MS = 30_000;
  const boardCache = new Map<string, { expires: number; body: unknown }>();
  export function clearLeaderboardCache(): void { boardCache.clear(); }
  ...
  const cached = boardCache.get(period);
  if (cached && cached.expires > Date.now()) { ... }
  ```
  Note the exported `clear...Cache()` test seam and its comment about test
  isolation — replicate both.
- Existing spec: `backend/packages/api/integration-tests/http/public-profile.spec.ts`
  — extend it; do not break its existing assertions.

## Commands you will need

| Purpose                          | Command                                                                              | Expected on success                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------- |
| Typecheck                        | `cd backend/packages/api && npx tsc --noEmit`                                        | exit 0                                                                       |
| Profile suite                    | `cd backend/packages/api && corepack yarn test:integration:http public-profile.spec` | all pass                                                                     |
| Leaderboard suite (parity guard) | `cd backend/packages/api && corepack yarn test:integration:http leaderboard`         | all pass (skip if no such spec file exists; check `ls integration-tests/http | grep -i leaderboard`) |
| Backend build                    | `cd backend && corepack yarn build`                                                  | exit 0                                                                       |

Integration suites need `pokenic-postgres` / `pokenic-redis` running
(`docker start pokenic-postgres pokenic-redis`).

## Scope

**In scope** (the only files you should modify):

- `backend/packages/api/src/api/store/profiles/[handle]/route.ts`
- `backend/packages/api/src/modules/packs/service.ts` — ONE new read method
  (e.g. `profileStatsForCustomer`), placed near `leaderboardTop`.
- `backend/packages/api/integration-tests/http/public-profile.spec.ts`
- `plans/README.md` (this plan's status row only).

**Out of scope** (do NOT touch, even though they look related):

- `leaderboardTop`, `packOpenSpendCents` — read them, copy their patterns,
  change nothing.
- The response JSON shape of the profile route — the storefront
  (`src/app/profile/...`) depends on it byte-for-byte.
- `MAX_PULLS`-style caps on OTHER routes (recent-pulls, vault) — covered by
  earlier plans/decisions.
- Any migration/index change. If you believe an index is missing, record it
  in your report; do not add one.

## Git workflow

- Branch: `advisor/022-public-profile-sql-aggregates`
- Commit style: conventional commits, e.g.
  `perf(profiles): compute public-profile stats in SQL + 30s cache`.
- Do NOT push or open a PR unless the operator instructed it.
- **Coordination note**: `service.ts` is also touched by plan 021 (different
  method) and plan 011 (different methods). Rebase + drift-check on conflict.

## Steps

### Step 1: Add `profileStatsForCustomer` to the service

New method near `leaderboardTop`, same signature conventions
(`@MedusaContext() sharedContext`, `em.execute`). Input: `customerId`.
Output: `{ pulls: number; volume: number; by_rarity: Record<string, number> }`
computed in SQL over `pull` rows where `customer_id = ?`, `source = 'pack'`,
`deleted_at IS NULL`, capped to the newest `MAX_PULLS` rows
(`ORDER BY rolled_at DESC LIMIT 20000` in a subquery/CTE — the cap is part of
today's documented semantics; preserve it):

- `pulls` = COUNT of those rows.
- `volume` = SUM of per-card display MYR **rounded per card** exactly like the
  route's `cardMyr` (`displayMarketPrice(toMoney(card.market_value), fxRate,
Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER))` → per-card
  `ROUND(x, 2)` semantics). The FX rate is a JS-side input: resolve it once
  with `resolveFxRate(this)` (exactly what `leaderboardTop` does) and pass it
  into the SQL as a parameter. Preserve the documented cents-level drift
  tolerance vs the leaderboard (per-card rounding, not sum-level).
- `by_rarity` = COUNT grouped by the rarity resolved from the pack-odds row
  `(pack_id, card_id)`, defaulting to `'Common'` when no odds row matches —
  mirror `makeRarityOf`/`card-view.ts` semantics (open
  `backend/packages/api/src/modules/packs/card-view.ts` and replicate its
  fallback exactly; state the fallback in a comment).

**Verify**: `npx tsc --noEmit` → exit 0.

### Step 2: Rewire the route

In the route:

1. Replace the `MAX_PULLS` fetch + JS fold for `volume`/`byRarity`/pull-count
   with one call to `packs.profileStatsForCustomer(customer.id)`. Keep
   `points = await packs.packOpenSpendCents(customer.id)` as-is.
2. Fetch `recent`: `listPulls({ customer_id, source: 'pack' }, { take: <small
multiple of RECENT_N, e.g. 3*RECENT_N to survive deleted-card skips>,
order: { rolled_at: 'DESC' } })`, then the existing card-join/skip/slice
   logic. Preserve the "filter BEFORE slicing" comment semantics. If after
   filtering you have fewer than RECENT_N and got a full page, fetch one more
   page (bounded loop, max 3 pages) — do not regress the under-fill guard.
3. Fetch the showcased `collection` the way the current code derives it, but
   from a bounded query rather than the 20k list (read the current collection
   derivation in the route first; if it needs a flag/filter not expressible in
   `listPulls` filters, keep its current source but bound the take and note it).
4. Response JSON shape: byte-identical keys and value semantics.

**Verify**: `npx tsc --noEmit` → exit 0.

### Step 3: Add the per-process TTL cache

Copy the leaderboard pattern verbatim, adapted:
`profileCache = Map<handle, { expires, body }>`, `CACHE_TTL_MS = 30_000`,
exported `clearProfileCache()` with the same test-isolation comment. Cache
only the final response body, keyed by handle, AFTER the 404 checks (do not
cache 404s).

**Verify**: `grep -n "clearProfileCache" backend/packages/api/src/api/store/profiles/[handle]/route.ts` → present.

### Step 4: Extend the spec and run the gates

**Verify**: `corepack yarn test:integration:http public-profile.spec` →
all pass, including new cases below.

## Test plan

Extend `integration-tests/http/public-profile.spec.ts` (model new cases on its
existing ones):

1. **Parity pin (the core regression case)**: seed a customer with pulls
   across ≥2 rarities and ≥2 packs (reuse the spec's existing seeding
   helpers); capture the route response and assert `pulls`, `volume`,
   `by_rarity`, `points` equal the values computed the old way (compute
   expected values in the test from the seeded data, not by calling the old
   code). Include a reward-source pull in the seed and assert it is EXCLUDED
   (C1 semantics).
2. **Recent feed**: newest-first, 12 max, deleted-card pulls skipped without
   under-filling (seed 13+ pulls with one deleted card).
3. **Cache**: two consecutive GETs return identical bodies; after
   `clearProfileCache()` + a new pull, the response reflects the new pull.
   (Call `clearProfileCache()` in the spec's beforeEach — same pattern the
   leaderboard spec uses with `clearLeaderboardCache`; check
   `ls integration-tests/http | grep -i leaderboard` and copy its usage.)
4. **404s unchanged**: malformed handle and unknown handle both 404 (existing
   assertions keep passing).

## Done criteria

- [ ] `npx tsc --noEmit` exits 0
- [ ] `public-profile.spec` passes, including the parity, C1-exclusion,
      recent-feed, and cache cases
- [ ] `grep -n "MAX_PULLS" .../profiles/[handle]/route.ts` no longer shows a
      20k `listPulls` take in the route (the cap now lives inside the SQL
      aggregate)
- [ ] Response JSON shape unchanged (spec asserts the full key set)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The route or `leaderboardTop` doesn't match the excerpts (drift).
- The rarity fallback in `card-view.ts` turns out to be more complex than a
  static default (e.g. depends on card fields you can't join in SQL) — report
  the actual semantics instead of approximating them.
- The showcased `collection` derivation cannot be bounded without changing
  response semantics.
- Parity case 1 fails by more than the documented cents-level rounding drift
  on `volume`, or by ANY amount on `pulls`/`by_rarity`/`points`.
- You find yourself wanting to add a DB index or migration.

## Maintenance notes

- If profile pagination or an "all pulls" view is ever added, the SQL
  aggregate and the `MAX_PULLS` cap must be revisited together.
- The 30s cache means admin-side card/FX edits take up to 30s to appear on
  public profiles — same tolerance the leaderboard already accepts.
- Reviewer scrutiny: the SQL's `source='pack'` + `deleted_at IS NULL` filters
  (C1/PII semantics), per-card rounding of `volume`, and that no non-public
  field entered the response.
- Deferred (recorded in plans/README.md Round 3): memoizing
  `resolveFxRateInfo` and caching the `/cdn/cards` redirect — separate small
  finding, not this plan.
