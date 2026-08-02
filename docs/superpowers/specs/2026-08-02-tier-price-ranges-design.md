# Tier price ranges — auto-assign, add-confirm, drift badge

**Date:** 2026-08-02
**Status:** Approved for implementation (autonomous session — user request taken as the
requirements statement; open points resolved with the defaults documented below).

## Problem

Operators tier cards by hand in the pack odds editor. The operator wants:

1. A configurable **price range per rarity tier** ("Default Tier value") in the admin
   dashboard.
2. When a card is **added** to a pack's prize pool, its tier defaults from those ranges.
3. If the card's price falls **outside every configured range** (e.g. below the lowest
   tier's minimum), a confirmation modal: "are you sure you want to add it".
4. When a card's market price later **drifts out of its assigned tier's range**, a visible
   signal — but the tier must **never auto-switch**.

## Context facts (verified in code)

- Rarity lives on the pack↔card link (`PackOdds.rarity`), not the Card — assigned in the
  admin pack odds editor (`backend/apps/admin/src/routes/packs/[slug]/page.tsx`).
- The editor's per-card money column is the **RM display price** (FMV × fx × per-card
  multiplier) — `EditRow.market_value`. All odds math (EV/RTP, `proposeRarities`) uses the
  same number. Tier ranges therefore configure in **RM display price**, not raw USD FMV.
- Two add funnels: the cards list's bulk "Add to gacha pack" (stages `pending` rows into
  the editor via router state) and the editor's own pool modal (`saveMembers`, which
  persists membership immediately; new members enter server-side as Common).
- Singleton-settings pattern exists: `challenge_settings` (one row, fixed id `'global'`
  with a DB CHECK, create-on-first-edit, audited patch with a required `reason`).
- `@acme/odds-math` is the shared pure math package (jest-tested) used by both the save
  workflow and the editor preview.

## Approaches considered

- **A (chosen): advisory client-side tiering + audited config singleton.** Ranges are
  admin config; assignment/confirm/drift are computed in the admin app from the shared
  pure helpers. The server never rejects or rewrites a rarity.
- B: server-side enforcement in `save-pack-odds`. Rejected — "are you sure" implies the
  operator may override; a server rejection fights that, and rarity is deliberately
  operator-owned per pack.
- C: make the existing `proposeRarities` pack-price-multiple bands configurable.
  Rejected — the request is for absolute price ranges ("common minimum range is $100"),
  global not per-pack, and drift must be judged against an absolute range.

## Design

### 1. Pure helpers — `@acme/odds-math`

```ts
export type TierRange = { min: number | null; max: number | null }; // RM display price
export type TierRangeMap = Partial<Record<OddsRarity, TierRange>>;

/** Rarest matching tier (RARITIES order), or null when no configured range contains
 *  `value`. A tier with no range (or both bounds null) never matches. Bounds are
 *  inclusive-min, exclusive-max; a null bound is open on that side. */
export function rarityForValue(
  value: number,
  ranges: TierRangeMap,
): OddsRarity | null;

/** 'in' | 'below' | 'above' for a configured tier; 'unset' when the tier has no usable
 *  range (feature inert for that tier). Non-finite values are 'unset'. */
export function tierRangeStatus(
  value: number,
  rarity: string,
  ranges: TierRangeMap,
): 'in' | 'below' | 'above' | 'unset';
```

Empty config ⇒ everything `'unset'` / `null` ⇒ current behavior everywhere (feature off).

### 2. Backend — `tier_settings` singleton (packs module)

- Model `tier_settings`: `id` (CHECK `id = 'global'`), `ranges` json
  (`TierRangeMap`-shaped). Hand-written migration following `challenge_settings`;
  audit CHECK widened with entity_type `'tier_settings'` (action `'edit'` already exists).
- Service: `tierSettings()` → `{ ranges }` (`{}` when absent, never 404);
  `editTierSettings({ ranges, adminId, reason })` — create-on-first-edit, full-replace of
  the json column (json columns merge on update, so the whole map is written each save),
  audited like `editChallengeSettings`.
- Validation (`tier-settings-validate.ts`): keys ⊆ `RARITIES`; each bound null or a
  finite number ≥ 0; `min ≤ max` when both present; unknown keys rejected. Overlapping
  ranges across tiers are allowed (assignment picks the rarest match); gaps are allowed
  (a value in a gap is simply "outside every range").
- Routes: `GET/POST /admin/tier-settings` (challenge-settings shape, `reason` required on
  POST) + `adminActionRateLimit` matcher on the POST.

### 3. Admin — "Tier defaults" config page

New page `tier-defaults/page.tsx`: one row per rarity (rarest first), Min (RM) / Max (RM)
inputs (blank = open bound), inline validation, audit-reason input + save (sticky-bar
pattern from the challenge page). REST client + react-query hooks follow the
challenge-settings ones.

### 4. Admin — behavior at the two add funnels

- **Cards list `addToPack`:** before navigating, evaluate each selected card's display
  price with `rarityForValue`. If any card matches no range, `usePrompt` confirm naming
  the count ("N of the selected cards fall outside every tier price range — add anyway?").
  Cancel aborts the add. When config is empty, no prompt.
- **Editor staged rows (`pendingRow`):** rarity defaults to
  `rarityForValue(displayPrice) ?? 'Common'` instead of always `'Common'`.
- **Editor pool modal (`saveMembers`):** same confirm for the newly added handles
  (selected minus current pool) before the mutation. After the post-save reseed, the
  newly added rows get their proposed rarity staged as an unsaved edit (a ref carries the
  added ids across the reseed); the operator persists it with the normal odds save.
  The tier is a **staged default**, never a silent server write.

### 5. Admin — drift signal (no auto-switch)

In the editor table, each row where `tierRangeStatus(market_value, rarity, ranges)` is
`'below'`/`'above'` shows an orange "Out of tier range" badge (tooltip: the row's value vs
the configured range). A summary `Alert` above the table counts the affected rows. Rarity
is never changed automatically — the badge is the whole mechanism, exactly as requested
("it will not auto switch the tiers"). This also flags a manual pick outside the chosen
tier's range, and it covers price drift because the badge is computed live from the
current display price on every load.

## Error handling

- Config fetch failure in the editor/cards list ⇒ helpers receive `{}` ⇒ feature inert
  (no prompt, no badges, Common default) — an outage degrades to today's behavior.
- Validation errors on save return 400 with a message; the page surfaces them inline and
  via toast, save disabled until valid (challenge-page pattern).

## Testing

- odds-math: jest spec for `rarityForValue` / `tierRangeStatus` (bounds, gaps, overlaps
  → rarest wins, null bounds, empty config, non-finite input).
- Backend: unit spec for the validator; http integration spec for GET/POST
  `/admin/tier-settings` (defaults, save, reject bad ranges, audit row).
- Admin: type-check + build; editor behaviors are covered by the pure helpers plus the
  existing visual-QA loop (repo testing policy: no brittle markup assertions).

## Per-pack override (added 2026-08-02, second user request)

Each pack may value its tiers differently. `pack.tier_ranges` (jsonb, nullable)
holds a per-pack `TierRangeMap`; **null = inherit the global singleton**, a
stored map (even `{}`) replaces the global ladder wholesale for that pack.
Tri-state write plumbing mirrors `published_odds` (undefined = keep, null =
clear, map = validated by the same `validateTierRangeMap`). Surfaced on the
odds editor as a "Tier price ranges" section (inherit toggle + min/max grid,
saved through the normal pack update), returned on both the odds GET payload
and the packs list so the editor and the cards-list picker resolve the
EFFECTIVE ladder as `pack.tier_ranges ?? global`. All four behaviors
(auto-assign, add-confirm, drift badge, pool-modal staging) run on the
effective ladder of the pack in question.

## Out of scope

- No storefront changes; no server-side enforcement of rarity vs range.
- No persisted/pushed notifications for drift (the badge is the signal).
- No auto-retier of existing pool rows when config changes.
