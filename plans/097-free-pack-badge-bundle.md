# Plan 097: Free-pack badge — cache the guest read, stop covering CTAs, fix the own-page match, add the missing tests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 5c74ce17..HEAD -- src/components/FreePackBadge.tsx src/app/api/free-pack/route.ts src/lib/data/free-pack.ts src/app/layout.tsx`
> On drift, compare "Current state" excerpts; mismatch = STOP.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none (coordinates with 096 — see note in Scope)
- **Category**: perf / bug
- **Planned at**: commit `5c74ce17`, 2026-08-15

## Why this matters

The site-wide free-pack badge (#442) fires an **uncached backend round-trip on
every client-side navigation, for every visitor including anonymous ones**.
This is the exact chrome-fan-out class that caused the repo's 2026-07-07
sustained store-read-ceiling incident — and the mitigation pattern (a 30s
throttle, with the incident cited in its comment) lives two files away in
`create-unread-dot.tsx`. Worse, PR #441 sized the backend's shared store-read
circuit breaker on the premise that guest reads come from `/slots` renders
only (`middlewares.ts:74-86`); #442 landed one commit later and changed the
load to "every navigation on every page". The sustained budget is 480/60s
site-wide through one egress IP — ordinary browsing now consumes it, and
overflow fails soft (badge silently vanishes), the hardest failure to notice.

Separately: the badge renders `fixed ... z-40` after `<main>` in the layout, so
it wins paint AND hit-testing against the three z-40 bottom docks — the pack
page's mobile buy dock ("Open Pack"/"Log in"), the vault's Sell action bar, and
the leaderboard's sheet trigger. On mobile the signup badge sits over the
primary conversion CTA. The component's own comment carefully reasons about the
z-50 consent banner and never considers the z-40 siblings. Its own-page skip
also uses `startsWith` (a slug that prefixes another suppresses on the wrong
page), and the component has zero automated tests — its QA script
(`scripts/qa-free-pack.mjs`) runs only when a human types it.

## Current state

### Files

- `src/components/FreePackBadge.tsx` — the whole surface. Shell classes at
  `:47` (`fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-40 ... lg:bottom-6`);
  consent hold at `:39-44`; `GlobalFreePackBadge` mount at `:101-143`: fetch
  effect keyed `[pathname, customerId, isLoading]` at `:107-132`
  (`fetch('/api/free-pack', { cache: 'no-store' })`, cancellation flag, no
  throttle); `/slots` skips at `:112` and `:135`; own-page prefix match at
  `:139` (`pathname.startsWith(\`/slots/${state.slug}\`)`).
- `src/app/layout.tsx` — `<GlobalFreePackBadge />` mounted after `<main>`
  (`:107`).
- `src/app/api/free-pack/route.ts` — 13 lines, `force-dynamic`, delegates to
  `getFreePackState()`. Comment says "Never cached: the badge must vanish on
  the next navigation after the one-time claim is spent."
- `src/lib/data/free-pack.ts` — `mapFreePackState` pure mapper (`:33-42`,
  unit-tested); `getFreePackState()` (`:48-64`): guest branch reads only
  `promo` (a single global boolean that changes only when an operator
  activates/retires a free pack); authed branch reads `eligible`+`slug`.
- `src/components/app-shell/create-unread-dot.tsx` — the throttle exemplar:
  `REFETCH_TTL_MS = 30_000` at `:30` with the comment "The 2026-07-07 incident
  was a sustained store-read ceiling from exactly this kind of chrome fan-out."
- Backend comment invalidated by #442 (fix its text here too):
  `backend/packages/api/src/api/middlewares.ts:74-86` — sizes
  `STORE_READ_DEFAULTS` (120/10s, 480/60s) on "every guest /slots render is
  proxied through the storefront's ONE Next.js egress IP".
- Colliding docks (do NOT modify them): `src/app/slots/[slug]/PackDetailClient.tsx:652`
  (mobile buy dock, `fixed inset-x-0 bottom-[calc(4rem+...)] z-40`),
  `src/components/account/VaultActionBar.tsx:45` and
  `src/app/leaderboard/LeaderboardClient.tsx:254` (both `fixed inset-x-4 bottom-24 z-40`).
- QA script: `scripts/qa-free-pack.mjs` (covers global mount, /slots skip,
  own-page skip, vanish-after-claim, spin deep-link) — manual-only today.

### The two claim-freshness requirements to preserve

1. Authed `claim` state must still disappear promptly after the claim is spent
   (the route comment's reason for no-store). Throttling the AUTHED read to a
   short TTL (30s, matching the dot pattern) is acceptable staleness — the
   badge already only vanishes "on the next navigation".
2. The GUEST answer (`promo` boolean) is identity-free and near-static — it can
   be cached aggressively (60s server-side revalidate) with zero leak risk.

## Commands you will need

| Purpose                                                    | Command                         | Expected                        |
| ---------------------------------------------------------- | ------------------------------- | ------------------------------- |
| Typecheck+lint+build                                       | `npm run check` (root)          | exit 0                          |
| Tests                                                      | `npm test` (root)               | all pass, incl. new badge tests |
| Manual QA (needs a running stack; optional if unavailable) | `node scripts/qa-free-pack.mjs` | exit 0                          |

## Scope

**In scope**:

- `src/components/FreePackBadge.tsx`
- `src/app/api/free-pack/route.ts`
- `src/lib/data/free-pack.ts` (only if splitting the guest/authed read paths
  requires a parameter — keep `mapFreePackState` byte-identical)
- NEW `src/components/__tests__/FreePackBadge.test.tsx` (or the repo's
  equivalent test location — match where sibling component tests live)
- `backend/packages/api/src/api/middlewares.ts` — comment text at `:74-86` ONLY
  (describe post-#442 load + this plan's caching)

**Out of scope** (do NOT touch):

- The three dock components (PackDetailClient, VaultActionBar,
  LeaderboardClient) — the badge yields; the docks don't move.
- `mapFreePackState` logic and its tests.
- Backend `/store/free-pack` route.
- Rate-limit numbers in `rate-limit.ts` — the fix is fewer reads, not a bigger
  budget.
- Plan 096 touches `PackDetailClient` and eligibility semantics — if you were
  told 096 landed first, rebase and re-read `getFreePackState` call sites; the
  two plans touch disjoint files otherwise.

## Git workflow

- Branch: `advisor/097-free-pack-badge`
- Conventional commits, e.g. `perf(free-pack): throttle the badge read; fix(free-pack): keep the badge off the bottom docks`.
- No push/PR without operator instruction.

## Steps

### Step 1: cache the guest branch server-side

In `src/app/api/free-pack/route.ts`: when the caller has no auth cookie, the
answer is the identity-free `promo` boolean — serve it from a module-level TTL
cache (60s) instead of hitting the Store API per request. Shape:

```ts
let guestCache: { expires: number; body: FreePackState } | null = null;
const GUEST_TTL_MS = 60_000;
```

Auth detection: `getAuthToken()` is already what `getFreePackState` uses —
split `getFreePackState` into the existing signature plus an exported
`getGuestPromoState()` if that reads cleaner, or check the token in the route
and branch. Keep `force-dynamic` (the AUTHED branch must not be ISR-cached) and
update the route's "Never cached" comment to say: authed = per-request, guest =
60s module cache, and why each.

**Verify**: `npm run check` exit 0. Grep: `grep -n "GUEST_TTL_MS" src/app/api/free-pack/route.ts` → 1+.

### Step 2: throttle the client effect

In `GlobalFreePackBadge` (`FreePackBadge.tsx:107-132`), adopt the
`create-unread-dot` throttle shape: a module-level
`let lastFetch = { key: '', at: 0, state: HIDDEN-ish }` — skip the fetch when
the identity key (`customerId ?? 'guest'`) is unchanged AND the last fetch is
younger than 30s, reusing the last answer. Bust the throttle on identity change
(login/logout must refetch immediately). Keep the cancellation flag and the
malformed-answer fail-to-hidden exactly as they are. Cite the 2026-07-07
incident in the comment the way `create-unread-dot.tsx:27-30` does.

**Verify**: new tests in Step 4 cover this; `npm run check` exit 0.

### Step 3: get off the docks + fix the prefix match

1. Route skips: extend the existing skip list so the badge does not render on
   routes that own a z-40 bottom dock — `/vault`, `/leaderboard`, and any
   `/slots/<slug>` detail/spin page (the own-page skip already covers the free
   pack's own; the OTHER packs' detail pages have the buy dock, so skip
   `/slots/` prefixed paths entirely in the global mount — the catalog `/slots`
   is already skipped, and the free pack's entry point remains the catalog
   badge and other pages).
2. Where it does render, drop to `z-30` so any future z-40 surface wins.
3. Own-page match at `:139`: compare path segments, not a raw prefix:
   `const seg = pathname.split('/'); if (state.mode === 'claim' && seg[1] === 'slots' && seg[2] === state.slug) return null;`
   (preserving the decoded-pathname reasoning in the existing comment).

**Verify**: grep `z-40` in `FreePackBadge.tsx` → 0 matches; grep `startsWith` in
the file → 0 matches on the slug line.

### Step 4: the decision-table tests

NEW test file for `GlobalFreePackBadge` (jsdom; mock `usePathname`, `useAuth`,
`fetch`; the repo has no @testing-library — follow the hand-rolled
`createRoot`+`act` harness precedent from the pack-detail hook tests, grep
`createRoot` under `src/**/__tests__`). Cases:

1. `/slots` → no fetch fired.
2. `/vault`, `/leaderboard`, `/slots/some-pack` → no render (Step 3 skips).
3. claim mode + pathname `/slots/<slug>` (exact segment) → null; pathname
   `/slots/<slug>-2` → renders (the prefix bug, pinned).
4. malformed fetch payload → hidden.
5. second navigation within 30s, same identity → exactly one fetch total
   (throttle); identity flips guest→customer → second fetch fires.

**Verify**: `npm test` → all pass, new file listed.

### Step 5: fix the backend sizing comment

`backend/packages/api/src/api/middlewares.ts:74-86`: rewrite the premise
sentence to describe the post-#442 reality (site-wide badge, 30s client
throttle + 60s guest cache from this plan), so the budget's stated basis is
true again. Comment-only change — no behavior.

**Verify**: `corepack yarn check-types` (from `backend/`) exit 0 (comment-only,
but run it anyway).

## Test plan

Covered by Step 4 (5 cases). Existing `free-pack.test.ts` mapper tests must
stay green. Optional live proof: `node scripts/qa-free-pack.mjs` against a
running stack (`npm run build` + `pwsh scripts/serve-standalone.ps1 -Port 4000`)
— run it if a stack is available, note "not run" otherwise.

## Done criteria

- [ ] `grep -c "no-store" src/components/FreePackBadge.tsx` → the fetch is throttled (comment may still mention it)
- [ ] `grep -n "z-40" src/components/FreePackBadge.tsx` → 0
- [ ] Segment match replaces the slug `startsWith`
- [ ] `/api/free-pack` guest branch cached (60s), authed branch per-request
- [ ] New badge test file with the 5 cases; `npm test` green
- [ ] `middlewares.ts` comment updated; backend typecheck green
- [ ] `git status` clean outside scope; `plans/README.md` row updated

## STOP conditions

- `FreePackBadge.tsx` drifted materially from the excerpts (e.g. someone added
  a throttle already).
- The skip-list change breaks `scripts/qa-free-pack.mjs`'s own assertions in a
  way that reveals the script encodes the OLD routes as required — report which
  assertion; updating the QA script is in scope only for route-skip lines.
- Plan 096 landed and moved eligibility semantics such that `mode: 'claim'`
  timing changed — re-read `getFreePackState` before Step 1 and report if the
  guest/authed split no longer matches this plan's description.

## Maintenance notes

- Any NEW fixed bottom-rail surface must either claim a z-tier above `z-30` or
  add its route to the badge's skip list — name this in the PR description.
- The 60s guest cache means activating a free pack shows the signup badge up to
  60s late; retiring one hides it up to 60s late. Operator-visible, harmless —
  but if a "flash sale" free pack ever exists, revisit.
- Deferred (product call, recorded): a dismiss affordance for the signup badge
  (sessionStorage, the `deposit-return.ts` pattern). Not built here.
