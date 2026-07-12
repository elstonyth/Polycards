# Plan 032: Slim the hot /store/credits read path (lean balance endpoint) + FX display cache + CDN redirect caching

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat dbce0561..HEAD -- backend/packages/api/src/api/store/credits backend/packages/api/src/api/middlewares.ts backend/packages/api/src/modules/packs/pricing.ts "backend/packages/api/src/api/cdn/cards/[file]/route.ts" src/lib/actions/vault.ts src/components/app-shell/TopUpProvider.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M (three independent S-sized parts — land them as separate commits)
- **Risk**: LOW-MED (part A adds a route + reroutes two client callers; parts B/C are one-liners with a TTL/header)
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `dbce0561`, 2026-07-13

## Why this matters

**A — balance amplification.** The hottest authenticated read path fans a
one-number question into ~6 DB round-trips. `GET /store/credits` runs
`creditSummary` + a 50-row `listCreditTransactions` + `walletSummary` in
parallel; `walletSummary` alone issues 4 serial queries (its own full-ledger
aggregate — near-identical to `creditSummary`'s — plus locked-commissions,
next-unlock CTE, frozen check). Yet its two hottest storefront callers want
only `balance`: `getCreditBalance()` (the header balance chip, re-fetched
after every open/sell/draw/top-up via `refreshBalance()`) and `getVault()`
(fetches the whole route in parallel with `/store/vault` just for
`credit.balance`). The service already has the lean answer —
`creditBalance()` is a one-scan delegate — it just has no route. Exposing
`GET /store/credits/balance` and pointing the two balance-only callers at
it removes the discarded 50-row fetch and the whole walletSummary fan-out
from the hot path. (All predicates are index-covered — this is round-trip
amplification, not slow queries.)

**B — FX resolver.** `resolveFxRateInfo` does a DB read
(`listFxRates({pair:'USD_MYR'}, {take:1})`) on every call, and ~14 store +
admin display routes call it per-request with no cache, for a value that
changes only on admin FX edits. A 30s process cache on the **display**
wrapper only (the strict money-write resolver must stay uncached — round-3
constraint) removes one DB round-trip from most catalog/vault/profile
renders.

**C — CDN redirect.** `/cdn/cards/[file]` issues a `302` with no
`Cache-Control`; browsers don't cache uncached 302s, so every admin/core
card-thumbnail render re-round-trips the backend for a stable mapping.

## Current state

Verified at `dbce0561`:

- `backend/packages/api/src/api/store/credits/route.ts` — GET handler:

```ts
const [summary, transactions, wallet] = await Promise.all([
  packs.creditSummary(customerId),
  packs.listCreditTransactions(
    { customer_id: customerId },
    { order: { created_at: 'DESC' }, take: RECENT_TRANSACTIONS },
  ),
  packs.walletSummary(customerId),
]);
```

- `backend/packages/api/src/modules/packs/service.ts:~585`:

```ts
async creditBalance(customerId: string): Promise<number> {
  return (await this.creditSummary(customerId)).balance;
}
```

- `backend/packages/api/src/api/middlewares.ts:~299-303` — the auth matcher
  to mirror:

```ts
{
  // Credit balance + ledger (GET /store/credits).
  matcher: '/store/credits',
  middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
},
```

Matchers here are exact-path (`/store/credits/topup` has its own separate
entry) — a new sub-path needs its own entry.

- `src/lib/actions/vault.ts` — `getVault()` (~line 73-92) fetches
  `/store/vault` + `/store/credits` in parallel, parses the credits response
  with `BalanceSchema`; `getCreditBalance()` (~line 103-110) fetches
  `/store/credits` and parses with `BalanceSchema`.
  `src/lib/data/schemas.ts:141`:
  `export const BalanceSchema = z.looseObject({ balance: finite });` — it
  will parse `{ balance }` from a lean endpoint unchanged.
- `src/components/app-shell/TopUpProvider.tsx` — the header chip calls
  `getCreditBalance()` on login and in `refreshBalance()`; no change needed
  there (it goes lean transitively).
- `backend/packages/api/src/modules/packs/pricing.ts` —
  `resolveFxRateInfo` (~line 81, does the DB read; degrades to
  `DEFAULT_USD_MYR` with `firm:false` on failure); `resolveFxRate` (~line
  100, "Lenient view for DISPLAY-ONLY call sites"); `resolveFxRateStrict`
  (~line 110) — derives from `resolveFxRateInfo` and MUST stay uncached
  (it gates money writes; round-3 decided this).
- `backend/packages/api/src/api/cdn/cards/[file]/route.ts`:

```ts
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { file } = req.params;
  res.redirect(302, `${STOREFRONT_URL}/cdn/cards/${encodeURIComponent(file)}`);
}
```

- Cache-pattern exemplar in this codebase: the 30s per-process cache +
  explicit `clearProfileCache()` seam added by plan 022 around
  `profileStatsForCustomer` (grep `profileCache` in
  `modules/packs/service.ts`). Match that shape.

## Commands you will need

| Purpose           | Command (working dir)                                                                               | Expected on success |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------- |
| Start DB/Redis    | `docker start pokenic-postgres pokenic-redis`                                                       | both printed        |
| Install + deps    | `corepack yarn install --immutable && corepack yarn build --filter="@acme/api^..."` (in `backend/`) | exit 0              |
| Backend typecheck | `corepack yarn check-types` (in `backend/`)                                                         | exit 0              |
| Credits spec      | `corepack yarn test:integration:http store-credits.spec` (in `backend/packages/api`, Git Bash)      | pass                |
| Storefront gate   | `npm run check && npm test` (repo root)                                                             | green               |

## Scope

**In scope** (the only files you should modify/create):

- `backend/packages/api/src/api/store/credits/balance/route.ts` (create)
- `backend/packages/api/src/api/middlewares.ts` (one new matcher block)
- `backend/packages/api/src/modules/packs/pricing.ts` (display cache)
- `backend/packages/api/src/api/cdn/cards/[file]/route.ts` (one header)
- `src/lib/actions/vault.ts` (two fetch URLs)
- `backend/packages/api/integration-tests/http/store-credits.spec.ts` (new assertions)
- `plans/README.md` — status row

**Out of scope** (do NOT touch):

- `walletSummary` / `creditSummary` internals — merging their overlapping
  scans and parallelizing walletSummary's serial awaits is **deliberately
  deferred**: the four reads share one non-transactional MikroORM manager
  and concurrent `em.execute()` behavior wasn't verified. Do not
  `Promise.all` them here.
- `resolveFxRateStrict` and every money-write path.
- `GET /store/credits`'s response shape — the wallet/me/transactions pages
  legitimately consume the full block.
- `src/lib/actions/wallet.ts` — the wallet page needs the full route.
- Admin FX POST route — no cache invalidation hook (30s staleness on
  display prices is acceptable; documented below).

## Git workflow

- Branch: `advisor/032-credits-read-diet`
- Three commits: `perf(store): lean /store/credits/balance for hot callers`,
  `perf(pricing): 30s display cache for FX rate`,
  `perf(cdn): cache card-image redirects`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step A1: Create the lean route

`backend/packages/api/src/api/store/credits/balance/route.ts`:

```ts
import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';

// GET /store/credits/balance — the bare number for hot callers (header chip,
// vault page). The full wallet/ledger view stays on GET /store/credits.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
) {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  res.json({ balance: await packs.creditBalance(req.auth_context.actor_id) });
}
```

(Match the import style of `store/credits/route.ts`; count the `../` depth —
this file is one level deeper.)

### Step A2: Auth matcher

In `middlewares.ts`, directly below the `/store/credits` block, add:

```ts
{
  // Bare balance for hot storefront callers (GET /store/credits/balance).
  matcher: '/store/credits/balance',
  middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
},
```

**Verify (A1+A2)**: `corepack yarn check-types` → exit 0. Extend
`store-credits.spec.ts`: unauthenticated GET `/store/credits/balance` → 401;
authenticated → `{ balance }` equal to the full route's `.balance`. Run
`corepack yarn test:integration:http store-credits.spec` → green.

### Step A3: Point the two balance-only callers at it

In `src/lib/actions/vault.ts`, change the fetch URL in **both**
`getCreditBalance()` and `getVault()`'s credit leg from `/store/credits` to
`/store/credits/balance` (headers/`cache: 'no-store'`/`BalanceSchema`
parsing all unchanged — the lean shape parses identically).

**Verify**: `npm run check && npm test` → green. Grep:
`grep -n "'/store/credits'" src/lib/actions/vault.ts` → no matches
(wallet.ts still has its full-route fetch — expected).

### Step B: FX display cache

In `pricing.ts`, add a module-level 30s cache used **only** by the display
wrapper `resolveFxRate` (pattern: plan 022's `profileCache` in
`service.ts` — TTL constant, `{ value, expiresAt }`, and an exported
`clearFxDisplayCache()` for tests):

```ts
// ponytail: 30s process cache, display reads only — the strict resolver
// (money writes) stays uncached by design (round-3 decision). No admin-edit
// invalidation: worst case a displayed price is 30s stale.
```

`resolveFxRateStrict` must keep calling `resolveFxRateInfo` directly —
verify by reading its body after your change.

**Verify**: `corepack yarn check-types` → exit 0. Add/extend a unit spec
(`src/modules/packs/__tests__/` or wherever pricing's existing unit specs
live — grep `resolveFxRate` under `__tests__`) covering: second call within
TTL does not re-query (mock `FxRateSource`, assert one `listFxRates` call);
`clearFxDisplayCache()` forces a re-read; strict path bypasses the cache.
`corepack yarn test:unit pricing` (or the matching filter) → green.

### Step C: CDN redirect caching

In `cdn/cards/[file]/route.ts`, before the redirect:

```ts
res.setHeader('Cache-Control', 'public, max-age=86400');
```

Keep the 302 (the storefront origin is env-dependent; a 301 would be cached
past config changes).

**Verify**: `corepack yarn check-types` → exit 0.

## Test plan

- `store-credits.spec.ts`: +2 cases (401 unauthenticated; balance parity
  with the full route) — pattern: the file's existing auth/shape cases.
- Pricing unit spec per Step B (3 cases: TTL hit, clear, strict bypass).
- Storefront: existing vitest + `npm run check` cover the URL swap (schemas
  unchanged). Manual sanity if a stack is running: header chip still shows
  the balance after a top-up (exercises `refreshBalance` → lean endpoint).

## Done criteria

Machine-checkable; ALL must hold:

- [ ] `backend/packages/api/src/api/store/credits/balance/route.ts` exists; matcher present in `middlewares.ts`
- [ ] `corepack yarn test:integration:http store-credits.spec` green (incl. 2 new cases)
- [ ] `grep -n "'/store/credits'" src/lib/actions/vault.ts` → 0 matches; `src/lib/actions/wallet.ts` unchanged (`git status`)
- [ ] Pricing unit spec green; `resolveFxRateStrict` body contains no cache read
- [ ] `grep -n "Cache-Control" "backend/packages/api/src/api/cdn/cards/[file]/route.ts"` → 1 match
- [ ] `corepack yarn check-types` (backend) and `npm run check && npm test` (root) exit 0
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The middlewares matcher semantics don't behave as exact-path (the new
  `/store/credits/balance` entry being shadowed or shadowing
  `/store/credits`) — prove with the 401/200 spec before touching matcher
  order, and report if reordering seems required.
- Any consumer of `getVault()`/`getCreditBalance()` turns out to read a
  field other than `balance` from the credits response (grep call sites
  first) — rerouting would drop data.
- The pricing module's unit-test seam doesn't exist (no mockable
  `FxRateSource` pattern in the existing specs) — report rather than
  inventing a new test harness.

## Maintenance notes

- **Deferred, on purpose**: merging `creditSummary`/`walletSummary`'s
  overlapping full-ledger scans and parallelizing walletSummary's 4 serial
  awaits. Prerequisite: verify whether concurrent `em.execute()` on a shared
  non-transactional MikroORM manager fans out over the pool or serializes.
  The lean endpoint removes the hot-path pressure that motivated it.
- If the wallet page ever becomes the hot surface (e.g. balance chip starts
  showing `withdrawable`), revisit — the lean endpoint intentionally omits
  the wallet block.
- FX cache: if an operator complains an FX edit doesn't show for 30s on
  catalog pages, that's the documented ceiling — wire
  `clearFxDisplayCache()` into the admin FX POST route then (one line).
- Reviewer scrutiny: strict-resolver bypass (money correctness), and that
  the two rerouted callers still send the bearer header.
