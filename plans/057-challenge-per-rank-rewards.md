# Plan 057: Per-rank challenge rewards (ranks 1–10) — prerequisite for settlement

> **Executor instructions**: This is a BUILD plan for the config/schema layer only.
> It does NOT settle or pay anything — that is `plans/056-challenge-settlement-design-spike.md`
> and the build plans that spike produces. 057 must land FIRST: settlement cannot
> pay a shape the config cannot express.

## Status

- **Priority**: P2 (blocks 056's build phase)
- **Effort**: M
- **Risk**: MED (schema change on live stage config + admin UI + storefront display; no money movement)
- **Depends on**: none. **Blocks**: the 056 payout writer.
- **Category**: feature
- **Planned at**: 2026-07-21

## Operator decisions (2026-07-21) — these supersede assumptions in 056

Captured live from the operator. **Three of these contradict what 056 assumes**, so
056 must be re-read against them before its build plans are written:

1. **Per-rank rewards, ranks 1–10.** Each rank gets an optional card AND/OR an
   optional credit amount. This REPLACES the "top 3 → featured cards, ranks 4–10 →
   credits" split that 056 calls "the decision record" and designs against
   (`api/store/challenge/route.ts:9-15`). The rank-split model is dead; 056's
   payout writer must be re-specced against a per-rank table.
2. **Per stage, not per challenge.** Every stage carries its own ranks 1–10 table.
   Rewards stay CUMULATIVE — unlocking stage 3 means winners collect stages 1+2+3 —
   so the existing rules copy stands.
3. **Ties: every tied player receives the FULL prize.** Two players tied at #1 both
   get the #1 card. This answers 056 §6 "ties at rank 10" as an open question.
   NOTE the cost is unbounded by design — a settlement run has no fixed ceiling.
   056's admin review gate is the mitigation, and should be treated as mandatory
   rather than "probably: never auto-pay, initially".
4. **Out-of-stock prize cards are granted anyway.** The prize is promised, so it is
   honoured and the operator sources the card. This answers 056 §9's
   "prize-card sourcing/stock" question and means the payout writer must NOT gate
   on stock. It can oversell physical inventory — surface it in the review gate.

Still open (not asked): whether ranks with no player (fewer than 10 entrants) pay
nothing — assumed yes, nothing to pay.

## Current state

- `models/challenge-stage.ts` — `reward_credits` (bigNumber, the shared 4–10 value)
  and `reward_card_ids` (json array; only `[0..2]` are ever read, as ranks 1/2/3).
- `modules/packs/challenge-validate.ts` — whole-set replace validation for stages.
- `api/store/challenge/route.ts` — resolves `reward_card_ids` to `{name, image, slab_image}`
  thumbnails; ships `rewardCredits` per stage.
- `apps/admin/src/routes/challenge/page.tsx` — Stages tab; today edits one credits
  field + a card picker list.
- Storefront `src/lib/data/challenge.ts` — `rankCardsFor` slices `[0..3]` and tags
  `rank: i+1`; `ChallengeStage.reward` is the single formatted credits string.
- Storefront `src/app/leaderboard/StageCarousel.tsx` — a 2×2 prize grid: three
  podium tiles + one "#4–10TH credits" tile. **This grid cannot express 10 ranks**
  and is the main UI question below.

## Scope

**In scope**

- Replace `reward_credits` + `reward_card_ids` with a per-rank structure, e.g.
  `rank_rewards: json` — `[{ rank: 1..10, card_id: string | null, credits: number }]`.
- Migration that PRESERVES current intent: existing `reward_card_ids[0..2]` → ranks
  1–3 `card_id`; existing `reward_credits` → ranks 4–10 `credits` (each rank gets
  the full value, matching how the current UI copy reads).
- Validation: rank 1–10 unique and in range, credits ≥ 0, card ids resolvable,
  reward caps from plan 044 still enforced per rank.
- Admin Stages tab: a 10-row editor (rank, card picker, credits).
- `/store/challenge`: ship the per-rank table; keep resolving card thumbnails.
- Storefront display for 10 ranks (see open question).

**Out of scope**

- Settlement, payout, snapshots, notifications — all 056.
- Prod threshold values (runbook §1.2, operator config).

## Storefront display — DECIDED (operator, 2026-07-21)

The 2×2 prize grid STAYS. Ranks 1–3 keep their podium tiles; the fourth tile
(today the static "#4–10TH credits" tile) becomes a BUTTON that opens a sheet
listing ranks 4–10 with each rank's card and/or credits.

This keeps the stage tile readable at 390px and means the grid never has to grow
past four cells however the reward table is configured.

**Copy the existing sheet pattern, do not invent one** — this repo has no Dialog
primitive in `src/components/ui/`; sheets are hand-rolled against a shared hook:

- Pattern to follow: `src/app/slots/[slug]/OddsSheet.tsx` — a `'use client'` sheet
  using `useModalA11y` (`src/lib/use-modal-a11y.ts`) for focus trap / escape /
  scroll lock, with an `X` close button.
- Note how OddsSheet splits the LIST (`PublishedOddsList`) from the SHEET wrapper
  so the same rows can render inline elsewhere without drifting. Do the same here:
  a `RankRewardList` usable both in the sheet and (later) on any admin preview.
- The trigger tile must be a real `<button>` with an accessible name naming the
  range (e.g. "View rewards for ranks 4 to 10"), not a click handler on a div.
- Rows with a card show the slab thumbnail; graded slabs wear the prism frame via
  `SlabImage` `frameVariant="prism"`, matching the podium tiles shipped on
  `feat/prism-slab-frame`. Mind `sizes` — that branch had to raise it to 256px
  before the frame stopped smearing at thumbnail scale.
- A rank configured with neither card nor credits is omitted from the list, not
  rendered as an empty row.

## Test plan

- Module-tier: migration mapping (old shape → ranks 1–10), validation rejects
  (duplicate rank, rank 0/11, negative credits, unresolvable card), cap enforcement.
- Storefront: `src/lib/data/__tests__/challenge.test.ts` — extend the fixture to the
  per-rank shape; assert rank order survives an unresolvable card id (the existing
  "preserves podium rank" guarantee must hold across all 10).
- Visual: the stage tile at 390px with all ten ranks populated, and the ranks
  4–10 sheet open over it.
- A11y: the trigger tile is reachable and activatable by keyboard; the sheet traps
  focus and restores it to the trigger on close (what `useModalA11y` already
  guarantees for OddsSheet — assert it here rather than assuming).

## Notes for whoever executes 056 next

- Card grants should reuse the reward-Pull path (`source='reward'`, as 056 says).
  **Keep `source='reward'`** — `source <> 'reward'` is load-bearing in four SQL
  aggregates (`service.ts` :2490, :4826, :4856, :4905). A third enum value would
  silently make prize cards count toward pulled value and shift the rankings.
  Distinguish challenge prizes with a SEPARATE nullable column (e.g.
  `award_reason='challenge'`), not a new `source`.
- That column is also what the storefront vault needs: it is the only way to render
  the prism frame on challenge-won cards only (operator requirement, 2026-07-21).
  The frame and the `SlabImage` `frameVariant` prop already exist and ship on
  `/leaderboard` — the vault half is a one-line call-site change once provenance
  lands. See `feat/prism-slab-frame`.
