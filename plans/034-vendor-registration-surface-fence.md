# Plan 034: Verify and fence the Mercur seller-registration / vendor surface

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Your reviewer
> maintains `plans/README.md` — do not edit it.
>
> **This plan has an investigate-first phase (Step 1) whose result decides
> Step 2.** Do not skip it. If Step 1's finding contradicts this plan's
> assumption, STOP and report — do not guess at the fencing.
>
> **Drift check (run first)**:
> `git diff --stat 38f7dbdd..HEAD -- backend/packages/api/medusa-config.ts backend/apps/vendor`
> On any change, compare "Current state" against live code before proceeding.

## Status

- **Priority**: P1
- **Effort**: S (verify) + S (fence)
- **Risk**: LOW-MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `38f7dbdd`, 2026-07-13

## Why this matters

`backend/packages/api/medusa-config.ts` enables `seller_registration: true`
and mounts the Mercur vendor dashboard at `/seller`; the `@mercurjs/core`
plugin provides the `/vendor/*` seller auth + CRUD routes. All four prior
security audits scoped middleware-coverage verification to `/admin/*` and
`/store/*` only — the `/vendor/*` surface has **never** been auth-audited.
This is a single-house-seller app (Mercur multi-vendor is installed but
unused; the marketplace's P2P promises are feature-flag-gated off). A live,
unaudited anonymous-registration surface on a payments-adjacent app is
attack surface nobody chose: `seller_registration: true` is almost certainly
the **stock Mercur basic-starter default**, never turned off for this
single-vendor product. This plan first _verifies what the surface actually
exposes_, then fences it if it is unused.

## Current state

`medusa-config.ts` (verified excerpts):

- Lines ~182-186:
  ```ts
  featureFlags: {
    rbac: true,
    seller_registration: true,
  },
  ```
- Lines ~229-235: `@mercurjs/core/modules/vendor-ui` mounts `appDir`
  `apps/vendor`, `path: '/seller'`.
- Lines ~237-242: the `@mercurjs/core` plugin (provides `/vendor/*` routes).
- Lines ~177-178: `// @ts-expect-error: vendorCors is not defined in medusa
config module` above `vendorCors: process.env.VENDOR_CORS!` — meaning either
  `@mercurjs/core` reads `vendorCors` at runtime, or the key is silently
  ignored and `VENDOR_CORS` is dead config.

`backend/Dockerfile` (lines ~38-46, ~68-73): `apps/vendor` is built by turbo
in the prod image and its `node_modules` pruned post-build; `preflight.ps1`
verifies `/seller` renders. So the vendor app **ships to prod**, it is not
dead in deploy terms.

`backend/apps/vendor/src/main.tsx` renders only the stock `@mercurjs/vendor`
`App` — no custom routes. `apps/vendor/src/lib/client.ts` and
`apps/vendor/src/i18n/` exist but are **not imported** by `main.tsx` (dead
stock scaffolding).

`apps/vendor/package.json` has no `test`/`check-types` script — turbo's
`test`/`check-types` skip it (its `build` = `tsc -b && vite build` does
type-check it).

Starter contract note (`backend/CLAUDE.md`): `apps/vendor/src/*` and
`medusa-config.ts` are listed as "starter contract surfaces — do not change
silently." This plan changes them deliberately, with the verification below
as justification; note that in the commit message.

## Commands you will need

| Purpose       | Command                                                 | Expected                                                |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| Install       | `corepack yarn install` (in `backend/`)                 | exit 0                                                  |
| Boot backend  | `corepack yarn dev` (in `backend/packages/api`)         | health at `:9000/health`                                |
| Typecheck     | `corepack yarn check-types` (in `backend/packages/api`) | exit 0                                                  |
| Backend build | `corepack yarn build` (in `backend/`)                   | exit 0 (proves vendor app still builds if you touch it) |

## Step 1 (INVESTIGATE — decides Step 2): determine what the seller surface exposes

With the backend booted locally, probe the seller-registration surface as an
**unauthenticated** client and record exactly what it returns. Use read-only
HTTP probes (curl/httpie); do not create persistent state beyond a throwaway
test seller you can identify and note.

Answer these, with evidence, in your report:

1. Does the `@mercurjs/core` seller-registration route accept an anonymous
   POST, and does it yield a **usable/approved** seller account, a **pending**
   stub requiring admin approval, or nothing usable? (Check the Mercur
   `seller_registration` flag semantics — search
   `backend/node_modules/@mercurjs/core` for the registration handler and
   whether it gates on approval.)
2. What does `GET /seller` render pre-authentication (login wall vs. usable
   dashboard)?
3. Is `vendorCors` actually consumed by `@mercurjs/core`? Grep
   `backend/node_modules/@mercurjs/core` for `vendorCors`. If it appears in
   the http-config handling, the `@ts-expect-error` guards a real key; if it
   appears nowhere, `VENDOR_CORS` is dead config governed only by
   `AUTH_CORS`/`storeCors`.
4. **Was the existing house seller created _through_ the registration flow?**
   Check `scripts/seed.ts` / seed data for how the house seller is
   provisioned. This decides whether disabling registration is safe.

**Verify**: your report contains a concrete answer to all four with the
evidence (route path, response status/shape, grep results, seed path).

**STOP and report** (do not proceed to Step 2) if:

- Anonymous registration yields a **usable, approved** seller that can list
  products or touch money — that is a live finding needing a decision on
  approval-gating, not just fencing, and the reviewer must weigh in.
- The house seller **was** provisioned via the registration flow (disabling
  it could break re-provisioning).

## Step 2 (FENCE — only if Step 1 clears): disable unused registration and gate the mount

Only if Step 1 shows registration yields nothing usable (or a pending stub)
AND the house seller is seeded independently:

1. In `medusa-config.ts`, set `seller_registration: false`.
2. If Step 1 found `vendorCors` is **not** consumed by `@mercurjs/core`:
   remove the `vendorCors` line and its `@ts-expect-error`, and delete the
   now-dead `VENDOR_CORS` from `.env.template` (line 31). If it **is**
   consumed: leave it, and replace the `@ts-expect-error` comment with one
   citing where `@mercurjs/core` reads it.
3. Delete the dead vendor scaffolding `apps/vendor/src/lib/client.ts` and
   `apps/vendor/src/i18n/` **only after** confirming `main.tsx` is their sole
   potential importer and `mercurDashboardPlugin` does not auto-discover them
   (grep the plugin's route-discovery for `src/lib`/`src/i18n`; the README
   documents discovery under `src/routes/` only, and there are no
   `src/routes/`). If unsure, leave them and note it.

Leave the `/seller` mount itself in place (removing it is a larger starter-
contract change; disabling registration removes the anonymous-onboarding risk,
which is the finding).

**Verify**:

- `corepack yarn check-types` → exit 0
- `corepack yarn build` (in `backend/`) → exit 0 (vendor app still builds)
- Re-boot and confirm `/dashboard` (admin) still renders and the house seller
  still exists (`preflight.ps1` if available on your OS, else manual).

## Scope

**In scope**:

- `backend/packages/api/medusa-config.ts`
- `backend/packages/api/.env.template` (only the `VENDOR_CORS`/
  `MERCUR_VENDOR_URL` lines, and only if Step 1 clears their removal)
- `backend/apps/vendor/src/lib/client.ts`, `backend/apps/vendor/src/i18n/`
  (deletion only, only if Step 1 clears)

**Out of scope**:

- The `/seller` and `/dashboard` mounts themselves — leave mounted.
- Any `@mercurjs/core` / `node_modules` file — read-only for investigation.
- `apps/vendor/src/main.tsx` and stock `@mercurjs/vendor` — untouched.
- The `.env.template` documentation cleanup for _other_ vars — that is plan
  041; touch only vendor-related lines here.

## Git workflow

- Branch: `advisor/034-vendor-registration-surface-fence`
- Commit style: `chore(security): disable unused Mercur seller registration`
  (note the deliberate starter-contract change in the body).
- Do not push or open a PR.

## Done criteria

- [ ] Step 1 report answers all four questions with evidence
- [ ] (If fenced) `grep -n "seller_registration" backend/packages/api/medusa-config.ts` shows `false`
- [ ] `corepack yarn check-types` exits 0
- [ ] `corepack yarn build` (in `backend/`) exits 0
- [ ] `/dashboard` renders and the house seller still exists post-change
- [ ] `git status` shows no files outside scope

## STOP conditions

- Any Step 1 STOP trigger above.
- Disabling `seller_registration` breaks the admin dashboard build or the
  house seller (revert and report — the flag may be load-bearing).
- Deleting the vendor scaffolding breaks `corepack yarn build`.

## Maintenance notes

- If P2P trading is ever built (round-3 direction option 1), the
  activate-Mercur-vs-custom-entity decision reopens this — re-enabling
  registration would be a deliberate, audited choice then.
- A reviewer should confirm the Step 1 evidence actually supports the fence;
  this is a security change justified by an investigation, so the
  investigation quality is the review's focus.
- Treat `/vendor/*` as a first-class matcher-coverage target in the next
  security audit regardless of the fence outcome.
