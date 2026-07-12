# Plan 024: Storefront honesty cleanup — fake trust signals, dead-end flows, dead code

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat e9ce6968..HEAD -- src/app/merchants src/app/social src/app/repacks src/app/30th src/app/pokemon src/lib/site.ts src/components/auth/UserMenu.tsx package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M (many small S items)
- **Risk**: LOW — copy/markup changes, a sitemap-entry removal, one dead-file
  deletion, one dependency reclassification. No data paths.
- **Depends on**: none
- **Category**: bug / tech-debt (trust)
- **Planned at**: commit `e9ce6968`, 2026-07-12

## Why this matters

The product brief (`PRODUCT.md`) makes "Trust is a feature" a core design
principle. Several publicly reachable storefront pages violate it:
`/merchants` shows a fabricated directory of **real companies** (Cardmarket,
TCGPlayer, …) decorated with "verified" badges and invented ratings;
`/social` and `/repacks` present mock data as a live community with
non-functional controls; the self-declared demo page `/series` is advertised
to search engines in the sitemap; `/repacks` funnels users into `/clawmaker`,
a page that tells even logged-in users "Please login". Sibling pages
(`/activity`, `/roulette`) already solved this with a one-line demo
disclosure — this plan brings the stragglers to that same standard, and
sweeps two confirmed dead artifacts (an unimported component, a CLI in
runtime dependencies).

The disclose-vs-delete decision for whole routes is deliberately NOT this
plan (it's a maintainer direction call — see plans/README.md Round 3,
DIR-05). This plan makes every kept page honest and every dead control gone.

## Current state

All verified 2026-07-12.

- **The disclosure convention to copy** (already shipped on sibling pages):
  - `src/app/activity/page.tsx:176` — `Demo feed — the live activity stream goes live with the backend.`
  - `src/app/roulette/RouletteClient.tsx:186` — `Demo only — real roulette & provably-fair odds arrive with the ...`
- `src/app/merchants/MerchantsClient.tsx` — hardcoded merchant array with real
  brand names (`:32` `name: 'Cardmarket EU'`, `:52` `name: 'TCGPlayer'`, …),
  `BadgeCheck` import (`:13`) rendered as a verified mark (`:206`), page
  subtitle `:155` "Curated selection of verified trading card merchants
  worldwide", fabricated `rating` values and activity timestamps; search
  input has no value/onChange (~`:162-172`); merchant cards link `href="#"`
  (~`:199-201`). No demo disclosure anywhere.
- `src/app/social/SocialClient.tsx` — `TABS.map` buttons set `tab` state
  (`:33-47` verified) but the grid renders the full `MOCK_USERS` regardless
  (`:59+`); the `Sort: Points` button (`:49-55` verified) has **no onClick**;
  per-user Trade buttons have no handler. No demo disclosure.
- `src/app/repacks/RepacksClient.tsx` — fabricated community packs/creators;
  "Create a Claw" CTA at `:311` links `/clawmaker`; "Filters" / "Last Pulled"
  sort buttons have no `onClick` (~`:362-375`). Page metadata markets it as
  live ("Packs created by anyone — 85% guaranteed buyback").
- `src/app/clawmaker/page.tsx:14-33` — static, unconditional "Access
  Restricted / Please login to view this page" for ALL users. The file
  comment (verified) says this faithfully clones the anonymous live capture
  and "The logged-in builder, if ever needed, must be recloned" — so the page
  itself is by-design; the broken part is _linking to it_ from `/repacks`.
- `src/app/30th/page.tsx` (~`:46-51`) — "View Winners on Discord" button is
  `href="#"` (dead).
- `src/app/pokemon/generation/[gen]/PokedexClient.tsx` (~`:70-86`) — US/JP/KR
  language switcher sets `lang` state that nothing consumes.
- `src/lib/site.ts:11-22` (verified) — `ROUTES` includes `'/series'`
  unconditionally, while `src/app/series/page.tsx` self-identifies as "Demo
  catalog". `ROUTES` feeds `src/app/sitemap.ts`. The existing conditional
  pattern to copy:
  ```ts
  ...(features.marketplace ? ['/marketplace'] : []),
  ...(features.packParty ? ['/pack-party'] : []),
  ```
- `src/components/auth/UserMenu.tsx` — exports `UserMenu`; **zero importers**
  (verified by repo-wide grep). Dead redesign leftover.
- `package.json:54` (verified) — `"shadcn": "^4.13.0"` under `dependencies`;
  zero `from 'shadcn'` imports in `src/`. It's the scaffolding CLI. NOTE: the
  main tree has a small uncommitted `package.json` change at planning time —
  work on a branch and rebase if needed.
- Repo conventions: Tailwind utility classes, 2-space indent, named exports,
  `cn()` from `src/lib/utils.ts`. The demo-disclosure line is plain muted text
  (`text-neutral-…`/`text-white/50`-style) near the page header or footer —
  match `activity/page.tsx:176`'s styling exactly.

## Commands you will need

| Purpose              | Command           | Expected on success               |
| -------------------- | ----------------- | --------------------------------- |
| Full storefront gate | `npm run check`   | exit 0 (lint + typecheck + build) |
| Unit tests           | `npm run test`    | all pass                          |
| Targeted greps       | see Done criteria | as stated                         |

## Scope

**In scope** (the only files you should modify):

- `src/app/merchants/MerchantsClient.tsx`
- `src/app/social/SocialClient.tsx`
- `src/app/repacks/RepacksClient.tsx`
- `src/app/30th/page.tsx`
- `src/app/pokemon/generation/[gen]/PokedexClient.tsx`
- `src/lib/site.ts`
- `src/components/auth/UserMenu.tsx` (delete)
- `package.json` (one dependency moved)

**Out of scope** (do NOT touch, even though they look related):

- Deleting or gating whole routes (`/merchants`, `/social`, `/roulette`, …) —
  maintainer decision (DIR-05).
- `src/app/clawmaker/page.tsx` — by-design clone artifact; only the CTA
  pointing at it changes.
- `src/app/activity/*`, `src/app/roulette/*`, `src/app/series/page.tsx` —
  already disclosed; only `site.ts` changes for series.
- `src/app/profile/[user]` mock-fallback behavior — documented intent,
  separate discussion.
- `src/app/pack-party/*` — carries a "Beta" badge; acceptable as-is.

## Git workflow

- Branch: `advisor/024-storefront-honesty-cleanup`
- Commit style: conventional commits; one commit per page is ideal, e.g.
  `fix(merchants): disclose demo directory, drop fabricated trust badges`.
- Do NOT push or open a PR unless the operator instructed it.
- **Coordination note**: `package.json` and `src/app/slots/[slug]/SlotMachineClient.tsx`
  have uncommitted changes in the main tree (other agents). This plan touches
  `package.json` only to move one dep — keep that a separate commit for easy
  rebase. No overlap with plans 009–018 files.

## Steps

### Step 1: `/merchants` — disclose and de-fabricate

1. Add the demo-disclosure line (copy `activity/page.tsx:176` styling):
   `Demo directory — merchant partnerships aren't live yet; listings are
illustrative.`
2. Remove the `BadgeCheck` "verified" mark and the fabricated `rating` +
   "Xh ago" activity fields from the card rendering AND the data array
   (remove the fields, don't just hide them). Remove the word "verified" from
   the subtitle (`:155`).
3. Remove the non-functional search input and the `href="#"` on cards (render
   the card as a non-link, or drop the anchor).

**Verify**: `grep -niE "BadgeCheck|verified|rating" src/app/merchants/MerchantsClient.tsx`
→ no matches (`-i` so capitalized variants can't slip past); `npm run check` → exit 0.

### Step 2: `/social` — disclose and remove dead controls

1. Add the demo-disclosure line: `Demo — community features launch with
trading.`
2. Remove the no-op `Sort: Points` button and the per-user Trade buttons.
3. Tabs: either remove the tab row entirely, or make each tab actually filter
   `MOCK_USERS` (only if the mock data already has a relationship field —
   check; if not, REMOVE the tabs; do not invent mock fields).

**Verify**: every remaining `<button>` in the file has an `onClick` (grep for
`<button` and inspect); `npm run check` → exit 0.

### Step 3: `/repacks` — disclose, unlink clawmaker, remove dead controls

1. Add the demo-disclosure line near the header: `Demo preview — community
repacks aren't live yet.`
2. Remove the "Create a Claw" CTA (`:311` region) — `/clawmaker` is a dead
   end for logged-in users.
3. Remove the no-op "Filters" and "Last Pulled" buttons.

**Verify**: `grep -n "clawmaker" src/app/repacks/RepacksClient.tsx` → no
matches; `npm run check` → exit 0.

### Step 4: Small dead-affordance sweeps

- `30th/page.tsx`: remove the `href="#"` "View Winners on Discord" button
  (the event is concluded; keep the rest of the page).
- `pokemon/generation/[gen]/PokedexClient.tsx`: remove the US/JP/KR switcher
  and the now-unused `lang` state.

**Verify**: `grep -n 'href="#"' src/app/30th/page.tsx` → no matches;
`npm run check` → exit 0.

### Step 5: Un-sitemap `/series`

In `src/lib/site.ts`, remove `'/series'` from `ROUTES` (leave the page
reachable; it's disclosed). Keep the array's comment accurate.

**Verify**: `grep -n "'/series'" src/lib/site.ts` → no matches.

### Step 6: Delete `UserMenu.tsx`, move `shadcn`

1. Re-confirm zero importers:
   `grep -rn "UserMenu" src/ --include="*.tsx" --include="*.ts"` → only the
   file itself. Then delete `src/components/auth/UserMenu.tsx`.
2. In `package.json`, move `"shadcn"` from `dependencies` to
   `devDependencies` (keep the version). Run `npm install` to refresh the
   lockfile.

**Verify**: `npm run check` → exit 0; `node -e "const p=require('./package.json');console.log(!!p.dependencies.shadcn, !!p.devDependencies.shadcn)"`
→ `false true`.

### Step 7: Full gate

**Verify**: `npm run check` → exit 0; `npm run test` → all pass.

## Test plan

No unit tests — these are presentational surfaces, covered by the repo's
Playwright-visual philosophy (`.claude/rules/common/testing.md`). The
grep-based done criteria below are the regression pins. If
`scripts/qa-*.mjs` visual baselines exist for these pages, re-capture is the
operator's call (screenshots change by design here).

## Done criteria

- [ ] `npm run check` exits 0; `npm run test` exits 0
- [ ] Case-insensitive grep for `verified` and `BadgeCheck` in
      `src/app/merchants/` → no matches
- [ ] `/merchants`, `/social`, `/repacks` each render a demo-disclosure line
      (grep for `Demo ` in each client file → ≥1 match)
- [ ] `grep -rn "clawmaker" src/app/repacks/` → no matches
- [ ] `grep -n "'/series'" src/lib/site.ts` → no matches
- [ ] `src/components/auth/UserMenu.tsx` does not exist
- [ ] `shadcn` in `devDependencies` only; lockfile updated
- [ ] No files outside the in-scope list are modified (`git status` — lockfile
      excepted)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any in-scope file's cited lines don't match the excerpts (drift — several
  agents are active in this repo).
- `UserMenu` turns out to have an importer (dynamic import, string reference,
  or an importer added since planning).
- Removing the merchants search/cards or social tabs breaks layout in a way
  that needs real redesign (more than spacing tweaks) — report with a
  screenshot instead of redesigning.
- `npm install` after the dependency move changes more than `shadcn`'s
  placement in the lockfile (unexpected resolution churn).

## Maintenance notes

- If/when the maintainer decides DIR-05 (delete vs keep the mock routes),
  this plan's disclosures make "keep" safe in the interim; deletion later
  supersedes Steps 1–3 harmlessly.
- Any NEW marketing/demo surface should copy the `activity/page.tsx`
  disclosure convention from day one — reviewers should ask for it.
- The mobile-first storefront redesign (PRODUCT.md near-term direction) will
  rework these pages; this plan intentionally keeps changes minimal (copy,
  dead controls, sitemap) so nothing here fights that redesign.
