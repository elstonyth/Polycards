# Odds precision: 4 decimals internal, configurable published decimals

Date: 2026-08-08 · Approved by operator (per-pack published decimals, 4-decimal internal scale).

## Problem

Draw weights are integer basis points normalized to Σ = 10000 (`TOTAL_BPS`), so the
finest manageable win rate is 0.01%. The operator needs at least 4 decimals of a
percent (0.0001%) for managing odds. Published (public) odds are hard-rounded to
2 decimals by the admin validator; the operator wants the published precision
editable.

## Design

### 1. Internal scale ×100

- `@acme/odds-math`: `TOTAL_BPS = 10000` becomes `TOTAL_UNITS = 1_000_000`, with
  `PCT_SCALE = 10_000` (integer units per 1%; 1 unit = 0.0001%). All pct↔unit
  conversions go through `PCT_SCALE`. `MIN_PCT` becomes `100 / TOTAL_UNITS` =
  0.0001 (a 1-in-a-million floor). All integer largest-remainder invariants keep
  holding — Σ per set is exactly `TOTAL_UNITS` after every save.
- The draw is scale-invariant (`secureRoll(totalWeight)` + cumulative walk), so
  rolls need no algorithmic change. `crypto.randomInt(1_000_000)` is well within
  its 2^48 bound. The reward-box roll's hardcoded `randomInt(10000)` switches to
  `TOTAL_UNITS`.
- Data migration: `UPDATE pack_odds SET weight = weight*100, weight_2 = weight_2*100,
  weight_3 = weight_3*100` and `UPDATE reward_box_prize SET weight = weight*100`.
  Because draws are relative, rows are consistent before and after the UPDATE —
  no downtime hazard. Integer columns hold 1e6 fine.
- Conversion call sites updated (`/100` → `/PCT_SCALE`, `*100` → `*PCT_SCALE`):
  odds-math internals, `save-pack-odds.ts`, `set-pack-members.ts`,
  `odds-sets.ts tierSplitForSet` (floor 0.01 → `MIN_PCT`, 2dp → 4dp),
  `service.ts` daily-box (`randomInt`, `pct: weight/100`), admin odds GET route
  (round2 → round4 so the editor round-trips 4dp without loss), admin
  `odds-rows.ts` (`weight_2/100` seeds), admin editor displays (4dp, trailing
  zeros trimmed).
- Historical `reward_draw.odds_snapshot` rows keep old-scale weights; they are
  draw-time audit records, not re-displayed as percentages — accepted.

### 2. Published odds decimals (per pack)

- `published_odds` JSON gains `decimals` (integer 0–4, default 2). The admin
  validator rounds `overall` and every tier to `decimals` places instead of the
  hard-coded 2, and accepts up to 4-decimal input.
- `normalizePublishedOdds` carries `decimals` through reads; storefront keeps
  printing the stored numbers verbatim (already rounded to the chosen precision),
  so no storefront change is required.
- Admin pack editor: a small "published decimals" selector next to the published
  tier inputs.

### 3. Tests

- odds-math unit suites re-run against the new scale (sums compare to
  `TOTAL_UNITS`); new cases prove 4-decimal rates survive save→load→draw-weight
  round-trips exactly.
- Admin odds GET route spec expectations move from 2dp to 4dp.
- Published-odds validator specs cover `decimals` (default 2, bounds, rounding).
- Integration specs (`odds-sets.spec`, `pack-published-odds.spec`,
  `set-pack-members.unit.spec`) updated to the new totals.
