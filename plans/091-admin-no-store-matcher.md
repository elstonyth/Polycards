# Plan 091: Set `no-store` on the whole `/admin` surface, not route by route

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat db2767f5..HEAD -- backend/packages/api/src/api/middlewares.ts backend/packages/api/src/api/utils/cache-headers.ts backend/packages/api/src/api/admin`
> On any mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `db2767f5`, 2026-08-07

## Why this matters

PR #377 solved this correctly for `/store`: one blanket matcher sets
`Cache-Control: no-store` on every authenticated store response, and the
middleware's own comment explains why a blanket matcher beats per-route
wiring — routes with no `middlewares.ts` entry are still covered, and a route
added next month is covered without anyone remembering to opt in.

`/admin` never got the same treatment, and the divergence appeared
**immediately**: within the same delta, the two new GlobePay admin routes set
`no-store` by hand citing CWE-524, while `admin/challenge/winners` (which
returns `customer_email`) and `admin/ledger` (customer email + name +
per-player money movement) ship header-less. The winners route has **two**
response sites, which is itself the argument — a route-local fix has to
remember both.

The framework sets no default (there is no `Cache-Control` in
`@medusajs/medusa`'s loaders or `@medusajs/framework`'s http layer), so those
responses are heuristically cacheable under RFC 9111 §4.2.2. And admin auth is
a **cookie session** (`backend/apps/admin/src/lib/admin-rest.ts:3,56` uses
`credentials: 'include'`), not a bearer header — so RFC 9111 §3.5's bar on
shared caches storing authenticated responses, which is scoped to
`Authorization`, does not cover `/admin` at all. The side with the weaker
spec-level backstop is the side missing the explicit header.

This is not cross-user CDN leakage — DO's CDN does not cache credentialed
responses. It is admin JSON with player emails and money movement outliving an
admin session in a browser cache on a shared operator workstation.

## Current state

### The `/store` version to mirror (`api/utils/cache-headers.ts`, verbatim)

```ts
// Every /store response carrying a verified customer identity is per-customer
// data — a vault, a credit balance, a notification feed, a saved payout
// account. None of it may be stored and replayed across identities
// (CWE-525: sensitive information in a browser cache).
//
// Registered ONCE as a blanket /store/* matcher rather than per route, for the
// same reason blockDisabledCustomerSession is: the framework registers
// `app.use('/store', authenticate('customer', ['bearer','session'],
// { allowUnauthenticated: true }))` before any middleware from
// middlewares.ts, so req.auth_context is already populated whenever a valid
// bearer is present. That buys two things per-route wiring cannot:
//
//   - routes with NO entry in middlewares.ts are still covered
//     (/store/customers/me and its addresses are framework-authed), and
//   - a route added next month is covered without anyone remembering to opt in.
//
// Anonymous store traffic carries no auth_context and passes through
// untouched, so the public catalog stays cacheable.
//
// RFC 9111 §3.5 already bars a SHARED cache from storing a response to an
// Authorization-bearing request without an explicit opt-in. This closes the
// PRIVATE browser cache too, and states the intent in the response rather than
// leaving it to every intermediary to implement that clause correctly.
export function noStoreForAuthenticatedStore(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): void {
  const auth = (
    req as { auth_context?: { actor_id?: string; actor_type?: string } }
  ).auth_context;
  if (auth?.actor_id && auth.actor_type === 'customer') {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}
```

### Its registration (`middlewares.ts:912-918`, verbatim)

```ts
    {
      matcher: '/store/*',
      middlewares: [
        noStoreForAuthenticatedStore,
        blockDisabledCustomerSession,
      ],
    },
```

### The routes that already do it by hand

- `backend/packages/api/src/api/admin/globepay/withdrawals/route.ts:127`
- `backend/packages/api/src/api/admin/globepay/deposits/route.ts:135`

Both with a CWE-524 comment. **Leave them.** A handler-set header still wins
over a middleware-set one, and removing them would make this plan's diff a
behaviour change rather than a strict addition.

### The routes that don't

`backend/packages/api/src/api/admin/challenge/winners/route.ts` (two response
sites, around :71 and :160), `admin/ledger/route.ts` (around :161),
`admin/players`, `admin/pulls`, `admin/delivery-orders` and
`admin/delivery-orders/[id]`. Confirm the current state yourself with:

```shell
grep -rLn "Cache-Control" backend/packages/api/src/api/admin --include=route.ts
```

### The one cache-positive header in the tree

`backend/packages/api/src/api/cdn/cards/[file]/route.ts:24` sets
`public, max-age=86400`. It is under `/cdn`, **not** `/admin`, so a
`/admin/*` matcher cannot touch it. Verify that before you start.

### Repo conventions to match

- Blanket matchers carry a long comment explaining why they are blanket.
- Backend source is Prettier-formatted with single quotes.

## Commands you will need

| Purpose            | Command                                                                                                                   | Expected on success |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Backend typecheck  | `cd backend/packages/api && corepack yarn check-types`                                                                    | exit 0              |
| Cache-header tests | `cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest cache --runInBand --forceExit` | all pass            |
| Backend unit tier  | `cd backend/packages/api && corepack yarn test:unit`                                                                      | all pass            |
| Backend lint | NONE. `backend/packages/api` has no eslint config and no `lint` script, so `turbo run lint` skips it and CI never lints this package. Do NOT author one — out of scope. | n/a |

## Scope

**In scope**:

- `backend/packages/api/src/api/utils/cache-headers.ts` (add a sibling function)
- `backend/packages/api/src/api/middlewares.ts` (one new matcher)
- `backend/packages/api/src/api/utils/__tests__/cache-headers*.unit.spec.ts` (extend; find it with `ls backend/packages/api/src/api/utils/__tests__/`)
- `plans/README.md` (status row)

**Out of scope**:

- Removing the two hand-set headers on the GlobePay admin routes.
- `/cdn`, `/vendor`, `/hooks`, and the storefront's own `/api/*` route
  handlers.
- Anything about admin authentication itself.

## Git workflow

- Branch: `advisor/091-admin-no-store`
- Conventional commits, e.g.
  `fix(admin): mark every authenticated /admin response no-store`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the admin sibling

In `cache-headers.ts`, add `noStoreForAuthenticatedAdmin`, structurally
identical to the store version but gated on `actor_type === 'user'`.

**Confirm the actor type first.** Read how an existing admin route or guard
reads `auth_context` (`grep -rn "actor_type" backend/packages/api/src | grep -v __tests__`)
and use whatever value Medusa actually sets for an admin session. If admin
requests carry a different shape entirely, adapt — do not assume `'user'`
because it is the conventional value.

Write the comment as a short one that **points at** the store version rather
than duplicating its 25 lines, plus the two facts specific to admin:

- admin auth is a cookie session, so RFC 9111 §3.5's `Authorization`-scoped
  bar does not apply — this header is the only thing stating the intent;
- the two GlobePay routes set it by hand and keep doing so; a handler-set
  header still wins.

**Verify**: `corepack yarn check-types` → exit 0.

### Step 2: Register the matcher

Add an `/admin/*` entry to `middlewares.ts`. Place it near the `/store/*`
blanket entry so the two read as a pair.

Before committing to the matcher string, confirm it matches. This repo has a
recorded routing gotcha (the sorter drops a zero-segment matcher — see the
comment around `middlewares.ts:168-176`), and wildcard behaviour has bitten
plan 061. Verify empirically and state **how** in your completion note.

Also confirm the matcher does not shadow or reorder any existing `/admin/...`
entry — read the admin matchers already in the file and check that adding a
broader one does not change which middleware stack a specific route gets.
`RoutesSorter` orders by specificity, but "it should" is not verification.

**Verify**: `grep -n "'/admin/\*'" backend/packages/api/src/api/middlewares.ts`
returns the new matcher; `corepack yarn check-types` → exit 0;
`corepack yarn test:unit` → all pass (a reordering regression would surface as
an admin route losing its rate limiter, and plan 061's coverage-guard spec
should catch that — confirm that spec still passes and say so).

### Step 3: Tests

See "Test plan", then run the gates.

## Test plan

Extend the existing cache-headers spec (read it first and mirror its shape).

Cases (all required):

1. An admin request with an `auth_context` carrying the admin actor type →
   `Cache-Control: no-store` is set.
2. A request with **no** `auth_context` → header not set (anonymous traffic
   passes through, matching the store version's behaviour).
3. A request whose `auth_context` is a **customer** → the admin middleware does
   not set the header (the two middlewares stay independent).
4. `next()` is always called, in every branch.

Prove case 1 red-green. Report both directions.

Verification:
`cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest cache --runInBand --forceExit`
→ all pass.

## Done criteria

- [ ] `cd backend/packages/api && corepack yarn check-types` exits 0
- [ ] `cd backend/packages/api && corepack yarn test:unit` exits 0 (including plan 061's admin rate-limit coverage guard)
- [ ] `grep -n "'/admin/\*'" backend/packages/api/src/api/middlewares.ts` returns the new matcher
- [ ] How the matcher was verified (and that it does not reorder existing admin matchers) is stated in the completion note
- [ ] The `/cdn` cache-positive header is confirmed unaffected
- [ ] The red-green proof for test 1 is reported
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- Adding the `/admin/*` matcher changes which middlewares an existing admin
  route receives (the rate-limit coverage guard going red is the signal).
  Report it rather than working around it — silently dropping a limiter from a
  money-mutation route would be a far worse bug than the one being fixed.
- Admin `auth_context` does not carry an actor type you can gate on. Report
  what it does carry.
- Any admin response is genuinely meant to be cacheable. Name it; a blanket
  `no-store` would be wrong for it and the matcher needs a carve-out.

## Maintenance notes

- **Blanket beats per-route, and the winners route is the proof** — it has two
  response sites, so a route-local fix has two chances to be forgotten.
- The two hand-set headers on the GlobePay admin routes are now redundant but
  harmless. Leave them; they document intent at the point of use, and a
  handler-set header still wins.
- A reviewer should scrutinize: the actor-type gate matches what Medusa
  actually sets for admin sessions, and the new matcher did not perturb the
  existing admin middleware stacks.
- **Deferred**: the storefront's own `/api/*` route handlers
  (`src/app/api/**/route.ts`) sit on a different origin and cache surface.
  They all declare `export const dynamic = 'force-dynamic'`, but their bodies
  were not audited for per-user data. That is a separate, small piece of work.
