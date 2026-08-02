# Plan 067: CI/test hygiene — wire the CSP gate, cover close-instant, fix the backend React pair

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a993f34a..HEAD -- scripts/qa-csp.mjs .github/workflows/e2e.yml backend/packages/api/src/api/store/pulls/close-instant/ backend/package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: plan 059 recommended first (it also edits `e2e.yml`; land 059's step 3 before this plan's step 2, or rebase over it)
- **Category**: tests / dx / deps
- **Planned at**: commit `a993f34a`, 2026-08-01

## Why this matters

Three unrelated-but-small hygiene holes from the delta, bundled because each
is under a day and none touches product code paths. (1) Production ENFORCES
CSP (`.do/storefront.app.yaml` sets `CSP_ENFORCE: 'true'`) and the delta
changed the policy twice (Meta Pixel hosts, media-host default), yet
`scripts/qa-csp.mjs` runs in NO workflow and passes vacuously when the CSP
header is missing entirely — the same "gate never ran ≠ clean" class PR #244
fixed for the a11y gate. (2) The instant-buyback close route (#265) — an
owner-scoped money-adjacent write — has zero test references anywhere.
(3) `backend/package.json` declares react 18 with react-dom 19 (and @types
likewise split), an incoherent pair one hoist away from breaking the admin
build.

## Current state

**(1) CSP gate** — `grep -rn "csp" .github/workflows/` → zero hits;
`package.json:38` defines `"qa:csp": "node scripts/qa-csp.mjs"`.
`scripts/qa-csp.mjs` fails on navigation error / non-OK response
(`qa-csp.mjs:50-58`) and on observed violation events, but never asserts a
`content-security-policy` header exists, so a `next.config.ts` `headers()`
regression that DROPS the policy passes clean. Routes come from
`scripts/qa-routes.mjs` (single source shared with qa-a11y). The a11y gate is
the wiring exemplar — `.github/workflows/e2e.yml:194-201`:

```yaml
# a11y gate: axe-core scan of key public routes against the running
# ... BASE_URL defaults to :4000 (see scripts/qa-a11y.mjs).
# `always()` so a red E2E run doesn't mask a11y regressions (or vice versa).
- name: Run a11y gate
  if: always() # (verbatim guard style — read the file)
  run: npm run test:a11y
```

The "never-ran ≠ clean" exemplar is `scripts/qa-a11y.mjs:58-74` (fails when a
dealbreaker rule produced no result at all).

**(2) close-instant coverage** — route:
`backend/packages/api/src/api/store/pulls/close-instant/route.ts` — bearer-
auth'd (registered in `middlewares.ts`), dedupes + caps ids at
`MAX_CLOSE_IDS = 50`, calls `packs.closeInstantWindow(pullIds, customerId)`
(service `service.ts:~3783`), which the route comment documents as CLOSE-ONLY +
owner-scoped + idempotent. The rate MATH is covered
(`modules/packs/__tests__/buyback-rate.unit.spec.ts:55-73` pins both
`instant_closed_at` branches of `resolveBuybackRate`); the WRITE path is not:
`grep -rn "closeInstantWindow\|close-instant" backend/packages/api --include=*.spec.ts` → zero.
A regression in the owner check would let an authenticated customer close
ANOTHER customer's instant window, dropping their sell quote to the flat rate.

**(3) React pair** — `backend/package.json`:

```
23:    "react": "^18.3.1",
24:    "react-dom": "^19.2.8",
50:    "@types/react": "^18.3.2",
51:    "@types/react-dom": "^19.2.3",
```

Installed `react-dom` 19.2.8 peer-requires `react ^19.2.8`; the admin app
currently survives only because `backend/apps/admin/node_modules/react-dom`
resolves 18.3.1 locally. `@mercurjs/admin` peer-depends on React 18, so the
safe direction is pinning react-dom/@types/react-dom BACK to 18 (matching what
every workspace actually resolves), not bumping react to 19. Cause: Dependabot
PR #279 bumped one half of a coupled pair.

## Commands you will need

| Purpose                                            | Command                                                                                                               | Expected on success      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| CSP gate locally (needs built storefront on :4000) | `npm run build && pwsh scripts/serve-standalone.ps1 -Port 4000` then `npm run qa:csp`                                 | exit 0, per-route lines  |
| Backend install after manifest edit                | `cd backend && corepack yarn install`                                                                                 | exit 0, lockfile updated |
| Backend typecheck                                  | `cd backend && corepack yarn check-types`                                                                             | exit 0                   |
| Admin build                                        | `cd backend/apps/admin && corepack yarn build`                                                                        | exit 0                   |
| Modules tier (docker DB)                           | `cd backend/packages/api && corepack yarn test:integration:modules -- close-instant`                                  | all pass                 |
| YAML sanity                                        | `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/e2e.yml','utf8'));console.log('ok')"` | `ok`                     |

## Scope

**In scope**:

- `scripts/qa-csp.mjs` (header assertion)
- `.github/workflows/e2e.yml` (one step)
- NEW `backend/packages/api/src/modules/packs/__tests__/close-instant.integration.spec.ts`
- `backend/package.json` + `backend/yarn.lock` (the four React lines only)

**Out of scope**:

- `src/lib/security/csp.ts` policy content.
- `scripts/qa-routes.mjs` route list (single source — changing it affects the
  a11y gate too).
- Bumping react to 19 anywhere (blocked by @mercurjs/admin peers — recorded
  Dependabot-blocker class).
- The close-instant route/service code itself (tests only).

## Git workflow

- Branch: `advisor/067-ci-hygiene`
- Three conventional commits (one per numbered item).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Header assertion in qa-csp.mjs

After the `resp.ok()` check in `scripts/qa-csp.mjs`, read `resp.headers()` and
fail the route (same `fail()` helper) when neither
`content-security-policy` nor `content-security-policy-report-only` is
present — message: "no CSP header on <route> — the gate cannot attest a policy
it never saw". Match the file's existing output style.

**Verify**: with the standalone server running locally, `npm run qa:csp` →
exit 0 (headers present). Then temporarily set `CSP_ENFORCE` handling aside —
simplest negative proof: run the gate against a server started WITHOUT the CSP
env wiring if the local build omits the header, or grep-review; state which
proof you used.

### Step 2: Wire the gate into the nightly

In `.github/workflows/e2e.yml`, duplicate the a11y-gate step
(`e2e.yml:199-201`) as `Run CSP gate` / `run: npm run qa:csp`, same `if:`
guard and placement (immediately after the a11y gate; the storefront on :4000
is already up there). Copy the comment style, noting report-only mode still
produces catchable `[Report Only]` violations.

**Verify**: YAML sanity command → `ok`.

### Step 3: close-instant module spec

New `close-instant.integration.spec.ts` in
`backend/packages/api/src/modules/packs/__tests__/` (modules tier picks up
`src/modules/*/__tests__/**` per `jest.config.js`; model harness/bootstrapping
on `challenge-settle.integration.spec.ts` or a smaller sibling in the same
directory). Cases:

1. Owner closes own pull → `instant_closed_at` set; `resolveBuybackRate` now
   quotes the flat/vault rate.
2. Customer B passes customer A's pull id → A's pull is NOT closed (the
   service must scope by `customer_id`).
3. Second close of the same pull → no-op success (idempotent), timestamp
   unchanged from the first call.
4. Empty id list → no-op success.

**Verify**: `corepack yarn test:integration:modules -- close-instant` → 4 pass.

### Step 4: Re-pair React

In `backend/package.json`: `react-dom` → `^18.3.1`, `@types/react-dom` →
`^18.3.0` (or the latest 18.x the registry serves — let yarn resolve within
`^18.3.0`). Leave `react`/`@types/react` untouched. Run
`corepack yarn install`. Then group the pair against future half-bumps: in
`backend/.github`-level dependabot config — this repo's dependabot file is
`.github/dependabot.yml`; add a `groups:` entry (or an `ignore` on
react-dom major) so react/react-dom move together. If the dependabot file's
structure makes grouping awkward, an ignore entry for `react-dom`
`version-update:semver-major` is the acceptable minimum — record which you did.

**Verify**: `cd backend && corepack yarn check-types` → exit 0;
`cd backend/apps/admin && corepack yarn build` → exit 0;
`node -e "console.log(require('C:/Users/PC/Desktop/Projects/PixelSlot/backend/node_modules/react-dom/package.json').version)"` → `18.x`.

## Test plan

Step 3 is the new coverage. Steps 1–2 are gate plumbing verified by running
the gate; step 4 by typecheck + admin build.

## Done criteria

- [ ] `grep -n "content-security-policy" scripts/qa-csp.mjs` → match
- [ ] `grep -n "qa:csp" .github/workflows/e2e.yml` → match; YAML parses
- [ ] `close-instant.integration.spec.ts` exists, 4 cases pass on the docker DB
- [ ] `grep -n "react-dom" backend/package.json` → `^18.3.1`; admin build green
- [ ] `cd backend && corepack yarn check-types` exit 0
- [ ] No files outside the in-scope list modified (yarn.lock churn from step 4 is expected — it must contain ONLY the react-dom/@types pair movement; eyeball the lock diff stat)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Plan 059's e2e.yml changes aren't merged yet and your step 2 would conflict
  — rebase on its branch or wait; do not hand-merge two divergent e2e.yml
  edits.
- `yarn install` moves anything beyond the four React entries in the lock
  (a resolutions/hoist cascade) — abort the install, report the diff stat.
- The modules-tier harness cannot mint two customers cheaply — report the
  fixture gap rather than testing ownership vacuously against one customer
  (the anti-vacuous rule from the round-6 IDOR posture).

## Maintenance notes

- The CSP gate now fails when the header disappears — if someone deliberately
  ships header-less (e.g. a preview env), the gate's env knob is `BASE_URL`;
  don't weaken the assertion.
- react 19 for the backend tree stays blocked on @mercurjs/admin peers —
  same class as the documented mikro-orm/react-router Dependabot blockers;
  re-evaluate on the next Mercur major.
- If plan 061's guard-test pattern proves out, a sibling "every gate script in
  package.json is invoked by some workflow" check would close this whole class
  — deferred, noted for the operator.
