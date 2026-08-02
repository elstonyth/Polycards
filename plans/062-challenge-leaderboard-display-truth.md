# Plan 062: Make the challenge/leaderboard surfaces say only what the backend pays and ranks

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a993f34a..HEAD -- src/lib/data/challenge.ts src/app/leaderboard/ src/lib/data/leaderboard.ts src/lib/packs-format.ts "src/app/slots/[slug]/"`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (display truth on the highest-visibility surfaces)
- **Planned at**: commit `a993f34a`, 2026-08-01

## Why this matters

PR #296 made the Weekly Challenge auto-payout real, which converts display
inaccuracies on the leaderboard/challenge surfaces from cosmetic to
promise-breaking. Four vetted issues: (A) the "Top 3 will receive" tile lists
prize cards that the settlement job will actually hand to ranks 4–10; (B) the
All-Time board's caption says it shows "lifetime pulled value" as if that were
the ranking, while the backend deliberately ranks by spend (an operator
decision recorded in-code) — and the now-unused `points` field ships dead on
the wire; (C) the pack page renders two adjacent sections both titled "Top
Hits"; (D) the odds panel quotes a card-value range (including Common/Uncommon
tier rows) computed over the FULL pool while no surface on the page lists
anything below Rare — the cheapest advertised value is unverifiable.

## Current state

**(A) Top-3 tile** — `src/lib/data/challenge.ts:289-297`: `summary.cards`
collects card ids from EVERY rank of each unlocked stage:

```ts
cards: resolveCards([
  ...new Set(
    unlocked.flatMap((s) =>
      s.rankRewards.map((r) => r.cardId).filter((id): id is string => Boolean(id)),
    ),
  ),
]),
```

while the sibling `credits` figure (`challenge.ts:302-307`) IS rank-filtered
(`creditsOf(s.rankRewards, 4)` — ranks 4+). The tile renders at
`src/app/leaderboard/WeeklyChallenge.tsx:171` under the heading
"Top 3 will receive", with the caption at `:202`
"Every featured card from stages 1–{summary.unlockedCount}" — the header and
the caption already contradict each other. Ranks 4–10 can carry cards:
`src/app/leaderboard/StageCarousel.tsx:80-84` splits `podium` (rank ≤ 3, has
card) from `rest` (rank ≥ 4) and renders cards for both.

**(B) All-Time board** — `backend/packages/api/src/modules/packs/service.ts:3008`
ranks all-time by `ORDER BY s.spend_cents DESC, w.pulls DESC NULLS LAST, ...`.
`src/app/leaderboard/LeaderboardClient.tsx:247-250` records the decision:
"the old points figure is retired from the UI; **ranking stays backend
spend-order**" (operator, 2026-07-23). That decision is settled — do NOT change
the SQL. What's wrong: the caption at `LeaderboardClient.tsx:85`
("All Time — lifetime pulled value across every eligible pack draw.") implies
pulled value is the ranking; and `points` is still parsed/formatted/shipped
(`src/lib/data/leaderboard.ts:34` and `:82`) but rendered nowhere (both tabs
render `entry.volume` — `LeaderboardClient.tsx:175` and `:252`).

**(C) Duplicate headings** — `src/app/slots/[slug]/PackDetailClient.tsx:483`
renders `<h2>Top Hits</h2>` ("The top items available in this pack.",
admin-curated, gated at `:478`); immediately below, `:505-513` renders
`PoolByRarity`, whose own `<h2>` at `src/app/slots/[slug]/PoolByRarity.tsx:43`
is "Top hits" ("The top cards available in this pack."), with dialog
`aria-label="Top hits"` at `:143`. A screen-reader user hears the same heading
twice for different things.

**(D) Value range vs visible pool** — `PackDetailClient.tsx:137,142`:

```ts
const valueRange = useMemo(() => poolValueRange(pool), [pool]); // FULL pool
const tierRanges = useMemo(() => tierValueRanges(pool), [pool]); // FULL pool
```

feed `OddsSheet` (`:532-533`), while the only pool listing is `topPool`
(Rare+ only, `:127-133`, passed at `:508`); `PoolByRarity`'s expand dialog
receives that same pre-filtered pool (`PoolByRarity.tsx:89 pool={pool}` — its
`pool` prop IS the caller's `topPool`), and its expand button says
"Show all {pool.length} cards" (`:49`) — an undercount of the real pack.
The rail being Rare+ is deliberate (`PoolByRarity.tsx:14`: "commons/uncommons
are catalogue noise there"); the dialog inheriting the filter is what makes
the odds panel's Common/Uncommon rows unverifiable.

Conventions: dark-only Tailwind neutrals; dialogs use `useModalA11y`;
`PoolModal` already buckets by `RARITY_ORDER` and drops empty tiers, so a full
pool renders without structural change.

## Commands you will need

| Purpose               | Command                | Expected on success |
| --------------------- | ---------------------- | ------------------- |
| Storefront unit tests | `npm test` (repo root) | all pass            |
| Typecheck+lint+build  | `npm run check`        | exit 0              |

## Scope

**In scope**:

- `src/lib/data/challenge.ts` (+ its test `src/lib/data/__tests__/challenge.test.ts`)
- `src/app/leaderboard/LeaderboardClient.tsx` (caption + dead field)
- `src/lib/data/leaderboard.ts` (drop `points`)
- `src/app/slots/[slug]/PackDetailClient.tsx`, `src/app/slots/[slug]/PoolByRarity.tsx`
- `src/lib/packs-format.ts` (drop unused `PublishedOdds.overall` ONLY if the
  grep in Step 5 confirms zero remaining consumers)

**Out of scope**:

- `backend/packages/api/**` — the All-Time ORDER BY is an operator decision;
  the store leaderboard route may keep emitting `points` (dropping a wire
  field is a backend contract change; only stop READING it client-side).
- `src/app/leaderboard/WeeklyChallenge.tsx` layout beyond the tile's text/data
  (no redesign).
- `StageCarousel.tsx` — already correct.

## Git workflow

- Branch: `advisor/062-display-truth`
- Conventional commits, one per lettered issue, e.g. `fix(challenge): top-3 tile lists podium cards only`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (A): Filter the top-3 tile to podium ranks

In `getChallenge` (`src/lib/data/challenge.ts:289-297`), collect card ids only
from `rankRewards` entries with `r.rank <= 3` (mirror the `creditsOf(…, 4)`
boundary: podium = 1–3, sheet = 4+). Update the caption string in
`WeeklyChallenge.tsx:202` to describe the podium set (e.g. "Podium prize cards
from stages 1–N") so header and caption agree.

**Verify**: `npm test -- challenge` → passes including the new case (Step 6).

### Step 2 (B): Honest All-Time caption + drop the dead field

- `LeaderboardClient.tsx:85`: change the All-Time caption to state both facts,
  e.g. "All Time — ranked by lifetime pack-open spend; showing each player's
  lifetime pulled value." Keep it one sentence; keep the existing tone (the
  This-Week caption is the register exemplar).
- Remove `points` from the `LeaderboardEntry` interface and mapping in
  `src/lib/data/leaderboard.ts` (`:34`, `:82`) and from any remaining client
  references. Update the file-header comment (`leaderboard.ts:5-7`) — it may
  keep saying alltime ranks by spend (true), but must stop calling it
  "points" if the field is gone.

**Verify**: `grep -rn "points" src/app/leaderboard src/lib/data/leaderboard.ts` → no code references (comments describing ranking basis are fine); `npm run check` → exit 0.

### Step 3 (C): Rename the Rare+ section heading

In `PoolByRarity.tsx`: heading `:43` → "Rare & above" (or "The Rare+ pool"),
subtitle `:56` to match, dialog `aria-label` `:143` and the expand button's
`aria-label` `:49` to the same term. Do NOT touch the curated "Top Hits"
section in `PackDetailClient.tsx:483`.

**Verify**: `grep -n "Top hits" src/app/slots/[slug]/PoolByRarity.tsx` → no matches.

### Step 4 (D): Restore a full-pool surface OR scope the quoted ranges

Preferred (matches #306's "expand" intent): give `PoolByRarity` a second prop
— rail keeps the Rare+ subset, the expand dialog and its "Show all N cards"
count receive the FULL pool. In `PackDetailClient.tsx` pass `rail={topPool}`
`full={pool}`. `PoolModal` already handles all tiers. Keep `valueRange`/
`tierRanges` computed over the full pool (they become verifiable again).
Fallback if the operator has said the dialog must stay Rare+: compute
`valueRange`/`tierRanges` over `topPool` instead, so quoted numbers match
visible cards — but record which option you took in the commit body.

**Verify**: `npm run check` → exit 0; if the preferred option: the expand
button's count equals the full pool length (assert via the Step-6 test or a
targeted `npm test -- PoolByRarity` if a component test exists; otherwise
state the manual check you did against a `?demo=1` pack detail page).

### Step 5: `PublishedOdds.overall` consumer check

`grep -rn "\.overall" src/lib src/app src/components` — if the ONLY hits are
the `PublishedOdds` interface (`src/lib/packs-format.ts:25`) and its schema
parse, remove the field from the interface and the parse site; if anything
still reads it, leave it and note the consumer.

**Verify**: `npm run check` → exit 0.

### Step 6: Tests

In `src/lib/data/__tests__/challenge.test.ts` add: a stage whose rank-5 reward
carries a card → `summary.cards` excludes it; a stage whose rank-2 reward
carries a card → included. Follow the existing fixture-building pattern in
that file.

**Verify**: `npm test` → all pass, including the two new cases.

## Test plan

Step 6 covers (A). (B)–(D) are display-only refactors covered by typecheck +
the existing component render tests; no new brittle markup assertions (repo
testing rule: presentational work is covered by the Playwright capture loop,
not unit markup tests).

## Done criteria

- [ ] `npm run check` exit 0; `npm test` all pass with 2 new challenge cases
- [ ] Podium tile derives from rank ≤ 3 only (`grep -n "rank" src/lib/data/challenge.ts` shows the filter)
- [ ] All-Time caption names spend as the ranking basis
- [ ] `points` gone from `src/lib/data/leaderboard.ts`
- [ ] No "Top hits" string remains in `PoolByRarity.tsx`
- [ ] Full-pool dialog OR scoped ranges (one of the Step-4 options) implemented and recorded
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `rankRewards` entries carry no usable `rank` field at the point
  `summary.cards` is built (the shape drifted).
- Step 4's preferred option requires backend changes to get the full pool
  (it should NOT — `PackDetailClient` already holds `pool` unfiltered).
- Removing `points` breaks a consumer the grep missed (report it, don't
  half-remove).

## Maintenance notes

- If the operator later decides All-Time should RANK by pulled value, that is
  a backend `ORDER BY` change (`service.ts:3008`) plus cache invalidation —
  out of this plan deliberately; the in-code decision comment at
  `LeaderboardClient.tsx:247-250` is where to record any reversal.
- The Step-4 choice interacts with pack-page conversion; watch bounce metrics
  if the full pool makes cheap packs look cheap.
- Reviewer scrutiny: the tile filter boundary (≤3 vs ≥4) must match
  StageCarousel's podium split exactly.
