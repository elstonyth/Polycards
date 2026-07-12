# Plan 010: Reject client-supplied customer metadata on the account-create route

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat e9ce6968..HEAD -- backend/packages/api/src/api/middlewares.ts backend/packages/api/src/api/utils/customer-metadata-guard.ts`
> If either file changed, re-read it and compare against the "Current state"
> excerpts before editing; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `e9ce6968`, 2026-07-12

## Why this matters

This app stores server-validated state in customer `metadata` — `avatar_url`,
`equipped_frame_level`, and the backend-assigned public `handle` — written
**only** by `/store/profile/avatar`, `/store/profile/frame`, and the
handle-ensure workflow. The `rejectCustomerMetadata` guard exists to stop
clients from writing those reserved keys directly. It is wired to
`/store/customers/me` (the **update** route) but **not** to `POST
/store/customers` (the **create** / register-completion route), which forwards
the whole validated body — including `metadata` — into
`createCustomerAccountWorkflow`. Anyone who can register (a public flow) can
therefore set reserved metadata at account creation and:

1. self-equip a milestone avatar frame they haven't earned (bypassing the
   `highest_level_ever` gate in `store/profile/frame/route.ts`);
2. inject an arbitrary `avatar_url` that renders on the public leaderboard and
   profile pages;
3. occupy an arbitrary public `handle` before the ensure-handle step runs.

No money is at risk, but it is a validation bypass on public-facing profile
surfaces. The fix is to extend the existing, already-fail-closed guard to also
cover the create route — one middleware registration entry.

## Current state

- `backend/packages/api/src/api/middlewares.ts:151-157` — the guard is
  registered for the update route only:

  ```ts
  // /store/customers/me is framework-authenticated; this guard rejects
  // client-supplied metadata on profile updates.
  {
    matcher: '/store/customers/me',
    method: 'POST',
    middlewares: [rejectCustomerMetadata],
  },
  ```

  (Re-read the exact object; the surrounding entries also show the repo's
  matcher/method style — match it.)

- `backend/packages/api/src/api/utils/customer-metadata-guard.ts:16-31` — the
  guard is generic and fail-closed: it rejects _any_ request whose body contains
  a `metadata` field. It needs no change — only a new registration site:

  ```ts
  export function rejectCustomerMetadata(req, _res, next) {
    const body = req.body as Record<string, unknown> | null | undefined;
    if (body && typeof body === 'object' && 'metadata' in body) {
      next(
        new MedusaError(
          MedusaError.Types.INVALID_DATA,
          'metadata is not updatable on this route.',
        ),
      );
      return;
    }
    next();
  }
  ```

- The create route is Medusa's stock `POST /store/customers` handler (no custom
  override file exists); its validator accepts `metadata`. The guard runs before
  it and rejects the field, so the legitimate register flow (which sends no
  metadata) is unaffected.

## Commands you will need

| Purpose                        | Command                                                      | Expected |
| ------------------------------ | ------------------------------------------------------------ | -------- |
| Backend HTTP integration tests | from `backend/packages/api`: `npm run test:integration:http` | all pass |
| Backend build                  | from `backend/packages/api`: `npm run build`                 | exit 0   |

> These are integration tests against a test DB; they may be slow. If the full
> suite is too heavy, the runner shards — run the single new spec file directly
> (see the run-http-shards harness / existing spec invocation).

## Scope

**In scope:**

- `backend/packages/api/src/api/middlewares.ts` (add one registration entry)
- `backend/packages/api/integration-tests/http/customer-metadata-guard.spec.ts`
  (extend — this spec already exists for the `/me` case)
- `plans/README.md` (this plan's status row only)

**Out of scope:**

- `customer-metadata-guard.ts` — the guard function is correct as-is; do not change it.
- Any change to `/store/profile/avatar` or `/store/profile/frame` — the legitimate writers.
- The Medusa stock create handler — do not add a custom override; the middleware
  is the right layer.

## Git workflow

- Branch: `advisor/010-customer-metadata-create-guard`
- Conventional commits, e.g. `fix(security): reject client metadata on customer create, not just update`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Register the guard on the create route

In `middlewares.ts`, add a registration entry for `POST /store/customers`
mirroring the existing `/store/customers/me` entry:

```ts
{
  matcher: '/store/customers',
  method: 'POST',
  middlewares: [rejectCustomerMetadata],
},
```

Place it near the existing `/store/customers/me` entry for readability. Confirm
the matcher does not also unintentionally catch a sub-path you don't want — if
the repo's matcher semantics are prefix-based, verify `/store/customers` does
not shadow `/store/customers/me/addresses` etc. (the method+exact-path should
scope it; if in doubt, read how sibling exact-path matchers behave and match).

**Verify**: backend build → exit 0.

### Step 2: Extend the integration test

In `customer-metadata-guard.spec.ts`, add a case: a register/create request that
includes `metadata` (e.g. `{ equipped_frame_level }` or `{ avatar_url }`) is
rejected with `INVALID_DATA`, while a create request **without** metadata
succeeds. Model the request setup after the existing `/me` case in the same file.

**Verify**: from `backend/packages/api`, run the spec → all pass.

## Test plan

- Extend `customer-metadata-guard.spec.ts`: (a) create with reserved metadata →
  rejected; (b) create without metadata → succeeds (guard doesn't break the
  legitimate register flow).
- Verification: the spec passes; backend build exit 0.

## Done criteria

- [ ] `POST /store/customers` with a `metadata` field is rejected (`INVALID_DATA`).
- [ ] `POST /store/customers` without metadata still succeeds.
- [ ] `/store/customers/me` behavior is unchanged (existing test still passes).
- [ ] Backend build exits 0.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The matcher semantics are unclear and `/store/customers` risks shadowing
  `/store/customers/me/*` — stop and confirm the correct matcher form before
  shipping.
- The create route already has a custom override file (drift) — stop; the plan
  assumed the stock handler.
- The legitimate register flow sends metadata for a real reason — stop; the
  guard would break it and the design assumption is wrong.

## Maintenance notes

- Any new customer-metadata reserved key must remain write-only via its server
  route; this guard is the client-side stop for both create and update now.
- A reviewer should confirm the new matcher scopes to the create route only and
  that the register flow still works end-to-end.
