# Plan 035: Storefront honesty — leaderboard prizes, profile error state, pack-party disclosure

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Your reviewer
> maintains `plans/README.md` — do not edit it.
>
> **Drift check (run first)**:
> `git diff --stat 38f7dbdd..HEAD -- src/app/leaderboard src/app/profile src/lib/data/profiles.ts src/app/pack-party`
> On any change, compare "Current state" against live code before proceeding.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug / trust
- **Planned at**: commit `38f7dbdd`, 2026-07-13

## Why this matters

Three storefront surfaces present fabricated data as production, and one
turns a backend outage into an impersonation. PR #24 (plan 024) cleaned the
merchants/social/repacks/series surfaces but its scope excluded these:

1. **Leaderboard prize rail** — a **primary nav tab** ("Ranks") promises
   concrete weekly payouts ("Grand prize pack + 50,000 pts") captioned "what
   the week pays out", with no disclosure. The backend leaderboard is a
   read-only ranking; **no prize/payout path exists anywhere**. This is the
   most-reachable fabricated surface in the app.
2. **Profile fetch failure → fabricated persona** — `getPublicProfile`
   returns `null` on _any_ error (5xx, network, schema-validation), not just
   a 404. The page then renders a deterministic **mock** collector — fake
   stats, fake "bought/listed/sold" activity — under the _real_ user's handle
   (linked from every leaderboard row). During an outage a real profile URL
   silently shows a fabricated person.
3. **Pack Party** — fully fabricated "live" parties with pulse dots,
   countdowns, and dead buttons, no disclosure. Lower severity: the
   `packParty` feature flag is off by default, so the route is unlinked and
   out of the sitemap (reachable only by direct URL).

PRODUCT.md design principle #3 is literally "Trust is a feature… Never
gamble-ify the money." These undercut it.

## Current state

**Leaderboard** — `src/app/leaderboard/LeaderboardClient.tsx`:

- Lines 13-19: `PRIZE_TIERS` hardcodes the five reward strings.
- Lines ~77-110: rendered under `{/* Prize rail — what the week pays out. */}`
  / `<section aria-label="Weekly prizes">`, with a footer caption "Points come
  from every ringgit you spend on packs. The weekly board covers the last 7
  days." (that caption is honest and should stay).
- Backend `backend/packages/api/src/api/store/leaderboard/route.ts` is a pure
  ranking aggregate — grep for prize/payout/settlement finds nothing.

**Profile fallback** — `src/lib/data/profiles.ts:70-85`:

```ts
export const getPublicProfile = cache(
  async (handle: string): Promise<PublicProfile | null> => {
    try {
      const profile = await sdk.client.fetch<PublicProfile>(
        `/store/profiles/${encodeURIComponent(handle)}`,
      );
      const valid = parseOne(PublicProfileSchema, profile);
      return valid ? (profile as PublicProfile) : null;
    } catch (error) {
      if (error instanceof FetchError && error.status === 404) return null;
      logger.error(`[profiles] failed to load profile "${handle}":`, error);
      return null; // <-- 5xx / network / (and schema-fail above) all → mock
    }
  },
);
```

`getPublicProfile` has **two call sites, both in
`src/app/profile/[user]/page.tsx`** (no other file imports it — grep
confirmed). Both consume the result and both must be updated:

1. `generateMetadata` (line ~21): `const profile = await
getPublicProfile(handle);` then `profile?.name ?? userOrGeneric(handle).username`.
2. `ProfilePage` (line ~36-42):

```ts
const [profile, avatarFrames] = await Promise.all([
  getPublicProfile(handle),
  getAvatarFrames(),
]);
const view = profile
  ? toProfileView(profile, avatarFrames)
  : mockProfileView(userOrGeneric(handle));
```

So `null` from _any_ cause (including schema-validation failure, which
returns `null` inside the `try`) falls to the mock persona in the page, and
the metadata title falls back to the generic name. If you change the return
type, **both** call sites must handle the new shape.

**Pack Party** — `src/app/pack-party/PackPartyClient.tsx`: `ACTIVE_PARTIES`
(line ~50) / `COMPLETED_PARTIES` hardcoded; live-pulse dots, countdowns,
progress bars; dead "Join Party" (~388) / "Create Party" buttons; only a
"Beta" badge (~433), no demo disclosure. `src/lib/features.ts:10`:
`packParty: process.env.NEXT_PUBLIC_FEATURE_PACK_PARTY === 'true'` (off by
default).

**Disclosure exemplars to match** (this is the established repo pattern from
plan 024 — copy its shape):

- `src/app/social/SocialClient.tsx:63` — "Demo — community features launch
  with trading."
- `src/app/repacks/RepacksClient.tsx:310` — "Demo preview — community repacks
  aren't live yet."

## Commands you will need

| Purpose                  | Command (repo root)    | Expected        |
| ------------------------ | ---------------------- | --------------- |
| Install                  | `npm install`          | exit 0          |
| Typecheck + lint + build | `npm run check`        | exit 0          |
| Unit tests               | `npm test`             | all pass (~200) |
| Targeted test            | `npm test -- <filter>` | pass            |

## Scope

**In scope**:

- `src/app/leaderboard/LeaderboardClient.tsx`
- `src/lib/data/profiles.ts`
- `src/app/profile/[user]/page.tsx`
- `src/app/profile/[user]/ProfileClient.tsx` (only if an error/empty view is
  cleanest to add there)
- `src/app/pack-party/PackPartyClient.tsx`
- A new or existing storefront test file for the profile-fallback logic (see
  Test plan).

**Out of scope**:

- The backend leaderboard route and any backend file — do NOT try to build a
  real prize system; this plan only stops the false promise.
- The honest leaderboard caption and standings rendering.
- The `mockProfileView`/`userOrGeneric` helpers' behavior for genuine 404s —
  keep the mock for legacy/unknown handles; only the _error_ path changes.
- Marketplace dead controls (flag-gated, separate concern).

## Git workflow

- Branch: `advisor/035-storefront-honesty-error-states`
- Conventional commits, one per surface is fine, e.g.
  `fix(leaderboard): drop fabricated prize rail`,
  `fix(profile): show error state instead of a fake persona on fetch failure`.
- Do not push or open a PR.

## Steps

### Step 1: Leaderboard — remove or disclose the prize rail

Preferred: **remove** `PRIZE_TIERS` and the entire `<section
aria-label="Weekly prizes">` block (the app has no prize system to link to).
Keep the honest points caption — relocate it if it lived inside the removed
section. If you judge the rail is worth keeping as aspiration, instead add a
clear disclosure line in the same shape as `RepacksClient.tsx:310` (e.g.
"Illustrative — weekly prizes aren't live yet.") and change the caption
"what the week pays out" so it no longer asserts a live payout. **Pick one;
default to removal.**

**Verify**: `npm run check` → exit 0. `grep -n "PRIZE_TIERS\|what the week
pays out" src/app/leaderboard/LeaderboardClient.tsx` → no match (removal) OR a
disclosure string is present near the rail.

### Step 2: Profile — distinguish "not found" from "failed"

Change `getPublicProfile` to signal _why_ it returned no profile so the page
can branch. Minimal shape: return a discriminated result, e.g.
`{ status: 'ok'; profile } | { status: 'notfound' } | { status: 'error' }`
(or keep `null` for not-found and throw/return a distinct sentinel for
error — match whatever is cleanest). Update **both call sites** in
`profile/[user]/page.tsx`:

- `ProfilePage` (line ~36): `notfound` → the existing `mockProfileView`
  fallback (unchanged behavior for legacy handles); `error` → render an
  error/empty state (a simple "Couldn't load this profile right now — try
  again." panel), **not** a fabricated persona.
- `generateMetadata` (line ~21): keep it resilient — on `ok` use
  `profile.name`, on `notfound`/`error` fall back to
  `userOrGeneric(handle).username` (its current behavior). Metadata must never
  throw, so treat `error` the same as `notfound` here.

Do not remove the mock path for the 404 case; only the transient-error and
schema-fail cases stop falling into the mock in the page body.

**Verify**: `npm run check` → exit 0.

### Step 3: Pack Party — disclose (or gate) the demo

Add a demo disclosure banner matching `SocialClient.tsx:63` /
`RepacksClient.tsx:310` at the top of the parties list, and disable the dead
controls (render them `disabled` or remove the buttons) so nothing looks
actionable. Deletion of the whole route is an acceptable alternative if you
confirm nothing links to it and it is out of the sitemap — but **default to
disclosure** (lower risk, reversible).

**Verify**: `npm run check` → exit 0. `grep -ni "demo\|illustrative\|not
live" src/app/pack-party/PackPartyClient.tsx` → at least one match.

### Step 4: Full gate

**Verify**: `npm test` → all pass; `npm run check` → exit 0.

## Test plan

- New: a unit test for the profile-fallback branching (the one piece of real
  logic here). In `src/lib/data/` (co-locate as
  `profiles.test.ts`, or add to an existing profile test if present), assert:
  a 404 yields the not-found signal (→ page shows mock), a thrown non-404
  yields the error signal (→ page must NOT show mock), and a schema-invalid
  response yields the error signal. Mock `sdk.client.fetch` the way existing
  `src/lib/data` tests mock the SDK (look at a sibling `*.test.ts` in
  `src/lib/data/__tests__/` for the pattern).
- The leaderboard/pack-party changes are presentational (removed/disclosed
  static content) — covered by `npm run check` compiling and the visual E2E,
  not new unit tests.
- Verification: `npm test -- profiles` → the new cases pass.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `npm test` passes, including new profile-fallback cases
- [ ] `grep -n "PRIZE_TIERS" src/app/leaderboard/LeaderboardClient.tsx` → no match (or a disclosure is present)
- [ ] Profile error path renders an error state, not `mockProfileView` (verify by reading `page.tsx`)
- [ ] `grep -ni "demo\|illustrative\|not live" src/app/pack-party/PackPartyClient.tsx` → ≥1 match
- [ ] `git status` shows no files outside scope

## STOP conditions

- `getPublicProfile` has a caller **outside** `src/app/profile/[user]/page.tsx`
  (grep `getPublicProfile` across `src/`; the two known call sites — the page
  and its `generateMetadata`, both in that file — are expected and handled in
  Step 2). If a third, out-of-file caller exists, report and let the reviewer
  decide on the shape.
- The leaderboard prize section turns out to be wired to real backend data
  (it isn't per the audit, but if the drift check shows a new backend prize
  route, STOP).
- Removing pack-party controls breaks the build due to shared components.

## Maintenance notes

- If a real leaderboard-prize or pack-party feature is ever built, these are
  the surfaces to re-populate — the removal/disclosure is the honest interim,
  not a deletion of intent.
- A reviewer should confirm the profile error state cannot itself be reached
  for a legitimately-missing handle (that must stay on the mock path, which is
  a deliberate product choice for legacy usernames).
- The wallet "eligible for withdrawal" copy softening (round-4 DIR-01 interim)
  is a **separate** item — not in this plan.
