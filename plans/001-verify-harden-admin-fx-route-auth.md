# Plan 001: Verify and harden admin FX-rate route authentication

> **✅ Status: DONE — implemented in PR #59.** The "Current state" / steps below
> describe the pre-implementation baseline at commit `4ca2593`, kept as the
> historical record; the live code already reflects the completed work. See
> [README.md](README.md) for status — do not re-run this as a fresh checklist.

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 4ca2593..HEAD -- backend/packages/api/src/api/admin/pricing/fx/route.ts backend/packages/api/src/api/middlewares.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `4ca2593`, 2026-07-02

## Why this matters

`POST /admin/pricing/fx` sets the global USD→MYR conversion rate. That rate
feeds `effectiveRate()` and, through it, every price the storefront and admin
display (market values are stored raw USD and multiplied at display time). If
this route is reachable without a verified admin identity, an anonymous actor
could rewrite the FX rate and distort every displayed price at once. The route
handler is typed `MedusaRequest` (not `AuthenticatedMedusaRequest`) and, unlike
the other admin money-mutation routes, is **not** listed in `middlewares.ts`.
Medusa v2 _does_ apply a default admin-auth guard to the `/admin` prefix, so
the route is very likely protected at runtime — but "very likely" is not
acceptable for a global pricing control. This plan proves it, then removes the
ambiguity.

## Current state

- `backend/packages/api/src/api/admin/pricing/fx/route.ts` — the FX read/write
  endpoint. Both handlers use the non-authenticated request type:

  ```ts
  // route.ts:1
  import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
  // route.ts:27
  export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  // route.ts:64
  export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  ```

  The POST body IS validated (`requireBoolean` for `manual_override`,
  `requirePositiveNumberOrNull` for `manual_rate`, lines 44-73) — so this plan
  is about **auth**, not body validation. Note there is no _upper_ bound on
  `manual_rate` (a positive finite number of any size is accepted); adding a
  sane cap is a small bonus in Step 3.

- `backend/packages/api/src/api/middlewares.ts` — registers every custom
  route's auth + rate-limit. The other admin money-mutation routes are grouped
  at the bottom (lines 318-364) and rely on the framework's default `/admin`
  auth, adding only the shared `adminActionRateLimit`. Example exemplar to match:

  ```ts
  // middlewares.ts:333-337
  {
    matcher: '/admin/commissions/*/reverse',
    method: 'POST',
    middlewares: [adminActionRateLimit],
  },
  ```

  `adminActionRateLimit` is created once at module scope (line 56) and shared.

- Comparison exemplar for the authenticated request type: the store reward
  claim route uses `AuthenticatedMedusaRequest` and reads the actor from the
  verified token —
  `backend/packages/api/src/api/store/rewards/claim/[grantId]/route.ts:1-3,21-30`.

## Commands you will need

| Purpose                | Command                                                                                                                        | Expected on success |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Backend typecheck      | from `backend/packages/api`: `corepack yarn build` (or `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`) | exit 0, no errors   |
| HTTP integration tests | from `backend/packages/api`: `corepack yarn test:integration:http`                                                             | all pass            |
| Runtime auth probe     | see Step 1                                                                                                                     | documented below    |

> Note: `corepack yarn` occasionally exits 127 in a fresh worktree — if so, run
> the tool directly via `node` as shown. Do not `npm install`/`yarn install`
> unless a command fails with a missing-module error.

## Step 1: Prove the current runtime behavior (verification — do this before any edit)

Determine empirically whether `POST /admin/pricing/fx` is reachable without
admin auth. Two acceptable methods — use whichever the environment supports:

**Method A (preferred — existing test harness):** Look for an existing admin
HTTP integration test that asserts an unauthenticated `/admin/*` call returns
401 (search `backend/packages/api/integration-tests/http` for `401` and
`admin`). If one exists, add an analogous case hitting
`POST /admin/pricing/fx` **with no auth header** and assert the status.

**Method B (manual, if a backend is already running locally):** with the
backend up (health at `:9000/health`), issue an unauthenticated
`POST /admin/pricing/fx` and record the HTTP status. A `401`/`403` means the
default guard covers it (expected). A `2xx` means it is **unprotected** — this
is now a CRITICAL finding: stop, mark plan 001 BLOCKED with "FX route
unauthenticated — confirmed", and escalate.

**Verify**: You have a recorded status code for an unauthenticated
`POST /admin/pricing/fx`. Expected: `401` or `403`.

## Step 2: Make the auth contract explicit in the type

Regardless of the Step 1 result (assuming it was 401/403), remove the
ambiguity that caused this audit finding. Change both handlers to use
`AuthenticatedMedusaRequest` so the type states the requirement and the handler
can key on the verified actor.

Target shape:

```ts
// route.ts:1
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
// route.ts:27
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
// route.ts:64
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
```

`loadRow(scope)` takes `MedusaRequest["scope"]` — either widen it to
`AuthenticatedMedusaRequest["scope"]` or leave it (the scope type is
identical). Do not change `loadRow`'s logic.

**Verify**: `corepack yarn build` (or the `tsc --noEmit` fallback) → exit 0.

## Step 3: Add the shared admin rate limiter (parity with sibling routes) and a rate cap

In `middlewares.ts`, add an entry for the FX POST route alongside the other
admin money-mutation routes (after line 364, inside the same `routes` array),
matching the exemplar exactly:

```ts
{
  matcher: '/admin/pricing/fx',
  method: 'POST',
  middlewares: [adminActionRateLimit],
},
```

Then, in `route.ts`, add a sane upper bound to `requirePositiveNumberOrNull`
for `manual_rate` (a USD→MYR rate realistically lives in ~1–20; cap generously,
e.g. reject `> 1000`), so a fat-fingered or hostile value can't set an absurd
global multiplier. Keep the existing lower bound (`> 0`).

**Verify**: `corepack yarn build` → exit 0. Then
`corepack yarn test:integration:http` → all pass.

## Test plan

- If Method A was used in Step 1, that unauthenticated-401 assertion IS the
  regression test — keep it.
- Add one case asserting `manual_rate > 1000` is rejected with a 400 (mirror an
  existing `INVALID_DATA` assertion in the HTTP test dir).
- Model the test after any existing spec in
  `backend/packages/api/integration-tests/http/*.spec.ts`.
- Verification: `corepack yarn test:integration:http` → all pass, including the
  new case(s).

## Scope

**In scope:**

- `backend/packages/api/src/api/admin/pricing/fx/route.ts`
- `backend/packages/api/src/api/middlewares.ts`
- one HTTP integration spec under `backend/packages/api/integration-tests/http/`
  (new or extended)

**Out of scope:**

- `modules/packs/pricing.ts` (`effectiveRate`, `DEFAULT_USD_MYR`) — the FX math
  is correct; do not touch it.
- The `GET` response shape — the admin UI reads these exact fields.
- The `×1.2` display FX convention elsewhere — deliberate, unrelated.

## Git workflow

- Branch: `advisor/001-fx-route-auth`
- Conventional commits, e.g. `fix(admin): make FX-rate route auth explicit + rate-limited`
- Do NOT push or open a PR unless the operator instructed it.

## Done criteria

- [ ] An unauthenticated `POST /admin/pricing/fx` is proven to return 401/403 (Step 1 evidence recorded).
- [ ] Both FX handlers use `AuthenticatedMedusaRequest`.
- [ ] `/admin/pricing/fx` POST is registered with `adminActionRateLimit` in `middlewares.ts`.
- [ ] `manual_rate` rejects values `> 1000` with a 400.
- [ ] `corepack yarn build` exits 0.
- [ ] `corepack yarn test:integration:http` passes, including new case(s).
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- **Step 1 returns a 2xx for an unauthenticated POST** → the route is genuinely
  unprotected. Stop, mark BLOCKED with that finding, escalate immediately (this
  is now critical and may need a broader `/admin` middleware audit).
- The code in "Current state" doesn't match the live file (drift).
- `corepack yarn build` fails and the error is unrelated to your edit.
- Adding the middleware entry breaks an existing HTTP test in a way you can't
  attribute to the rate limiter.

## Maintenance notes

- If more custom `/admin` routes are added, prefer registering them here
  explicitly (even if the default guard covers them) so auth intent is visible.
- A reviewer should confirm the middleware entry sits in the admin group and
  reuses the shared `adminActionRateLimit` instance (not a new one).
- Deferred: a blanket `matcher: '/admin/*'` mutation limiter was considered but
  left out — Medusa glob + method matching across all verbs is a larger change;
  see plan 008 for the related "not all admin mutations are rate-limited" note.
