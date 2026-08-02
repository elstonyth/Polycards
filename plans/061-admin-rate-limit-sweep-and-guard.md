# Plan 061: Rate-limit the three unthrottled admin mutation routes and add a coverage guard

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a993f34a..HEAD -- backend/packages/api/src/api/middlewares.ts backend/packages/api/src/api/admin/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security (hardening)
- **Planned at**: commit `a993f34a`, 2026-08-01

## Why this matters

Every admin economy-mutation route shares one `adminActionRateLimit` budget so
a stolen or misused admin token cannot hammer state-changing endpoints. Three
routes added in the #249–#313 delta are missing from the matcher list: the
purchase-invoice writer (raises real inventory counters, up to 200 lines ×
1,000,000 qty per call), the delivery-orders bulk transition (up to 100 order
transitions + 100 customer notifications per call — an outbound-message
amplifier), and the pack reorder. This is the **fourth recurrence** of this
exact class (prior fixes: plans 004, 015, 044), so this plan also adds a
regression guard that makes the next omission fail a test instead of waiting
for an audit.

## Current state

- `backend/packages/api/src/api/middlewares.ts:76` — `const adminActionRateLimit = createAdminActionRateLimit();`
- The admin-mutation matcher block runs roughly lines 547–661; entries look like:

  ```ts
  {
    matcher: '/admin/customers/*/disable',
    method: ['POST'],
    middlewares: [adminActionRateLimit],
  },
  ```

  The block currently covers freeze/unfreeze, disable/enable, payout-details,
  commissions reverse/suspend/unsuspend, rewards-settings, credits,
  daily-rewards boxes/vouchers, vip-levels, challenge stages/settings,
  pricing/fx, site-settings, avatar-frames (`middlewares.ts:658`).

- Missing routes (all `export async function POST`, all admin-auth'd by
  default `/admin/*` auth, none rate-limited):
  - `backend/packages/api/src/api/admin/purchase-invoices/route.ts:26`
  - `backend/packages/api/src/api/admin/delivery-orders/bulk/route.ts:28`
  - `backend/packages/api/src/api/admin/packs/reorder/route.ts:11`
- Pre-existing siblings with the same gap (older than this delta — the
  operator may want them swept in the same commit; they are listed as an
  explicit option in Step 2, not silently included):
  `/admin/packs/*/odds`, `/admin/packs/*/members`, `/admin/cards`,
  `/admin/products/from-pricecharting`, `/admin/pixel-pokemon`.
- Convention: matchers are exact-path or `*`-segment patterns; Express 4
  path-to-regexp 0.1.x semantics (a prior round verified `*` spans `/`).
  Every entry pairs `method: ['POST']` (or the route's methods) with the
  shared limiter instance — never a new limiter per route.

## Commands you will need

| Purpose                      | Command                                                           | Expected on success |
| ---------------------------- | ----------------------------------------------------------------- | ------------------- |
| Backend typecheck            | `cd backend && corepack yarn check-types`                         | exit 0              |
| Unit tier                    | `cd backend/packages/api && corepack yarn test:unit`              | all pass            |
| HTTP smoke (needs docker DB) | `cd backend/packages/api && corepack yarn test:integration:smoke` | all pass            |

## Scope

**In scope**:

- `backend/packages/api/src/api/middlewares.ts` (matcher additions only)
- ONE new unit spec, e.g. `backend/packages/api/src/api/__tests__/admin-rate-limit-coverage.unit.spec.ts`

**Out of scope**:

- The limiter implementation (`createAdminActionRateLimit`) — budget and
  window stay as they are.
- Admin GET routes (deliberately unlimited; see plan 066's export note).
- Store-side matchers.
- The routes' handlers/validators themselves.

## Git workflow

- Branch: `advisor/061-admin-ratelimit-sweep`
- Conventional commit, e.g. `fix(security): rate-limit purchase-invoice, delivery bulk, pack reorder admin routes`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the three matchers

In the admin block of `middlewares.ts`, add entries for
`/admin/purchase-invoices`, `/admin/delivery-orders/bulk`, and
`/admin/packs/reorder`, each `method: ['POST']`, `middlewares: [adminActionRateLimit]`.
Place them adjacent to related entries (delivery near the customer actions,
purchase-invoices near daily-rewards, reorder near the pack entries) and match
the surrounding comment style.

**Verify**: `cd backend && corepack yarn check-types` → exit 0.

### Step 2: Decide the pre-existing sweep (single yes/no, then act)

If the operator instructed "delta only", skip this step and record that in the
commit body. Otherwise add the five pre-existing routes listed in Current
state to the same block. They are all POST mutation routes with the same risk
profile; prior rounds simply never audited them against the block.

**Verify**: typecheck again → exit 0.

### Step 3: Add the coverage guard test

New unit spec (runs in the no-DB unit tier — filename MUST end
`.unit.spec.ts` and live under an `__tests__` dir inside `src`; check
`backend/packages/api/jest.config.js` testMatch before naming). The test:

1. Recursively enumerates `src/api/admin/**/route.ts` files that export
   `POST`, `PUT`, `PATCH`, or `DELETE` (read the file text; a regex on
   `export async function (POST|PUT|PATCH|DELETE)` is sufficient and has zero
   runtime imports).
2. Loads `src/api/middlewares.ts` text and extracts the matcher strings in
   the `adminActionRateLimit` block.
3. Converts each route file path to its URL (`src/api/admin/foo/[id]/route.ts`
   → `/admin/foo/*`) and asserts every mutation route matches some limiter
   matcher OR appears in an explicit in-test `EXEMPT` list with a one-line
   reason. Seed `EXEMPT` with any route the operator declined in Step 2.

This is a text-level guard, deliberately: it needs no app boot, and its
failure message ("route X exports POST but is not rate-limited and not
exempt") is the whole point.

**Verify**: `cd backend/packages/api && corepack yarn test:unit -- admin-rate-limit-coverage` → passes. Then temporarily comment out one of the Step-1 matchers and re-run → the spec FAILS naming that route; restore it → passes again. State in your report that you performed this red-green proof.

## Test plan

Step 3 is the test plan. Structural pattern: any existing `*.unit.spec.ts`
under `src/api` (e.g. `src/api/admin/purchase-invoices/__tests__/validate.unit.spec.ts`)
for file layout; the enumeration logic is new.

## Done criteria

- [ ] `grep -n "purchase-invoices\|delivery-orders/bulk\|packs/reorder" backend/packages/api/src/api/middlewares.ts` → three matcher lines
- [ ] `cd backend && corepack yarn check-types` exit 0
- [ ] `corepack yarn test:unit` all pass, including the new coverage spec
- [ ] Red-green proof of the guard performed and reported
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- The matcher block's structure differs materially from the excerpt (e.g. the
  limiter was renamed or split per-domain since planning).
- The guard test cannot express a route↔matcher match without importing the
  Medusa framework (keep it text-level; if that's impossible, report why).
- `test:integration:smoke` fails after the matcher additions — a limiter on
  these routes must not affect any store-path spec; if it does, something else
  is wrong.

## Maintenance notes

- The `EXEMPT` list in the guard spec is the new single place to record "this
  admin mutation is deliberately unlimited" — reviewers should challenge any
  addition to it.
- If a future route uses Medusa's `MiddlewaresConfig` differently (regex
  matchers), the guard's path→matcher conversion needs updating in the same PR.
- This closes the recurring class only for admin mutations; store-side matcher
  coverage was verified clean in earlier rounds.
