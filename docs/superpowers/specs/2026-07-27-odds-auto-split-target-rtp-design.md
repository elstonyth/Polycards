# Odds Auto-Split by Target RTP — Design

**Date:** 2026-07-27
**Builds on:** POLYCARD-BACK Epic 3 (`feat/epic3-odds`) — 3 odds sets, Common-as-balancer, EV/RTP columns
**Status:** Approved, ready for planning

## Problem

The pack odds editor can only be driven one card at a time. Under the
Common-as-balancer model (§2.4) every non-Common row is pinned verbatim and the
unlocked Common rows absorb whatever is left over. That works when the pinned
rows are sane, and fails completely when they are not: the balancer can only
distribute a *remainder*, so if one pinned row takes 100% there is nothing to
split and every other card sits at 0%.

`bronze-pack` is in exactly that state today (local dev DB, `status = active`):

| Fact | Value |
| --- | --- |
| Pack price | RM 50 |
| Rows | 10 (0 locked, 9 unlocked Commons) |
| `pikachu-ex-238` (Legendary) | `weight = 10000` → 100% |
| Every other row | `weight = 0` → 0% |
| Pool value | RM 28,325.34 |
| EV / RTP | RM 4,860.11 / **9720%** |

Two distinct defects are tangled here, and only fixing both makes the pack
shippable:

1. **No way to aim at a payout.** The operator hand-types rates and reads EV/RTP
   back as a consequence. There is no path from "I want 70% RTP" to a set of
   weights.
2. **The rarity tags are wrong.** Eight of ten rows are tagged `Common`,
   including Mega Charizard X at RM 9,867.49, Pikachu with Grey Felt Hat at
   RM 4,856.08 and PW Mewtwo at RM 4,418.28. The system therefore believes the
   most valuable cards are the most common ones. Any rarity-driven distribution
   is meaningless until this is corrected — the rarity ladder applied to today's
   tags still yields **RTP ≈ 5219%**.

The ask: one action that sets every unlocked row's win rate to hit a target RTP,
following the existing rarity ladder.

## Decisions

Settled during brainstorming:

1. **Target-RTP solver**, not an even split. An even split across this pool
   yields RTP ≈ 5665% and would not help.
2. **Follow the existing rarity ladder** (`RARITY_WEIGHT`: Immortal 1,
   Legendary 5, Mythical 45, Rare 150, Uncommon 300, Common 500) as the shape.
3. **Solver proposes rarities, operator confirms.** Proposals land in the Rarity
   dropdowns as unsaved edits; nothing is written without an explicit save.
4. **One target for the whole pack**, not per odds set. Sets 2 and 3 remain
   hand-editable afterwards.

Assumed rather than asked, for consistency with the existing model: **locked rows
stay pinned** and the solver works around them. The published-odds panel depends
on being able to pin a card at an exact advertised rate.

## Design

### Shape: a solved chase budget, not a solved exponent

The obvious approach — keep the ladder's relative weights and raise them to a
solved power `k` — is **rejected**. It hits the target but destroys the tail. On
`bronze-pack` the exponent that lands 70% is `k ≈ 6.15`, which drives the ladder
ratios (Legendary/Common = 0.01) to `0.01^6.15`, giving:

| Tier | Win rate at `k ≈ 6.15` |
| --- | --- |
| Common (each of 2) | 48.9% |
| Uncommon | 2.17% |
| Rare (each) | 0.0316% |
| Mythical (each) | 1 in 4.9 million |
| Legendary | 1 in 4 trillion |

The chase cards — the entire point of the product — become unwinnable.

Instead, solve a single **chase budget** `c`: the total probability mass given to
all non-Common rows. Within that budget the ladder's *relative* proportions are
preserved exactly; the Common tier absorbs the rest. This keeps the existing
"Common absorbs what's left" intuition, and because EV is **linear in `c`** it
solves in closed form with no iteration.

Given target RTP `t`, pack price `P`, locked rows `L` with pinned rates `q_j`,
free chase rows `H` and free Common rows `C`:

```
E_L = Σ q_j·v_j                     EV already committed by locked rows
M   = 1 − Σ q_j                     free probability mass
V_H = Σ(w_i·v_i) / Σ w_i  over H    ladder-weighted mean value of chase rows
V_C = Σ(w_i·v_i) / Σ w_i  over C    ladder-weighted mean value of Common rows

c = (t·P − E_L − M·V_C) / (V_H − V_C)
```

Each chase row then takes `c · w_i / Σ_H w`, each Common row
`(M − c) · w_i / Σ_C w`. Results convert to basis points with largest-remainder
rounding so `Σ = 10000` exactly, matching `balanceOdds`.

On `bronze-pack` with corrected rarities this gives `c = 0.209%`:

| Card | Tier | Win rate | Odds |
| --- | --- | --- | --- |
| PW Pikachu (RM 24.55) | Common | 49.90% | — |
| PW Bulbasaur (RM 39.27) | Common | 49.90% | — |
| PW Jolteon (RM 122.73) | Uncommon | 0.0705% | 1 in 1,418 |
| PW Gengar / PW Charizard / Mega Dragonite | Rare | 0.0353% ea | 1 in 2,835 |
| PW Mewtwo / Pikachu Grey Felt / Pikachu ex | Mythical | 0.01058% ea | 1 in 9,451 |
| Mega Charizard X (RM 9,867.49) | Legendary | 0.00118% | 1 in 85,034 |

EV = RM 35.00, RTP = 70.0%. The grand prize is steep but genuinely winnable —
unavoidable, since that card is worth 197× the ticket.

**Feasible band.** `c` is clamped to `[0, M]`, so reachable RTP runs from
all-Common (`c = 0`) to all-chase (`c = M`) — 63.8%–3017% on this pack. Outside
that the solver returns a typed error naming the band rather than clamping
silently:

> Target 70% needs EV RM 35.00; this pool reaches RM 31.91–RM 1,508.69
> (63.8%–3017%). Lower the target, raise the price, or change the pool.

Degenerate cases return the same typed error: no free Common rows (no absorber),
no free chase rows, or `V_H == V_C`.

### Rarity proposal

`proposeRarities({rows, packPrice})` tiers each card by its value as a multiple
of the ticket price, so the mapping is explainable and stays stable as prices
drift:

| Multiple of ticket | Tier |
| --- | --- |
| < 2× | Common |
| 2–10× | Uncommon |
| 10–50× | Rare |
| 50–150× | Mythical |
| 150–400× | Legendary |
| > 400× | Immortal |

On `bronze-pack` (RM 50) this produces the tiers in the table above. Value is the
display price — `market_value(USD) × fx × market_multiplier` via
`displayMarketPrice` — the same figure the Value column already shows.

Value-ranked tiers also guarantee the property the solver relies on: cheaper
cards carry heavier ladder weights, so `V_C < V_H` and the solve is
well-conditioned. An operator override that inverts this (a cheap card tagged
Immortal) can make `V_C ≥ V_H`; that lands in the typed-error path rather than
producing nonsense.

### Placement

Both functions are pure and live in `@acme/odds-math` beside `balanceOdds` and
`computeOdds`, which is already the single source of truth shared by the admin
preview and the backend save workflow.

The solver is a **preview-time input generator**, not a new write path. It emits
a pct per row; those pcts flow through the unchanged
`computeSetWeights` → `balanceOdds` → save pipeline. No change to the odds save
workflow, the 3-set inheritance rules, or the draw path.

> `@acme/odds-math` is CJS with `main: dist/index.js`. Rebuild
> (`corepack yarn build` in `backend/packages/odds-math`) after **every** source
> change or consumers load a stale dist.

### UI

- A **Target RTP %** field in the pack header, defaulting to 70.
- An **Auto-split** action that runs against the set currently in view.
- Proposed rarities populate the existing Rarity dropdowns; proposed rates
  populate the existing rate inputs. Both render as unsaved edits.
- The existing "After save" column and per-set EV/RTP tiles already display the
  outcome, so no new preview surface is needed.
- Infeasible targets surface the typed error inline; nothing is applied.

### Data model

One column on `pack`:

```
target_rtp_bps  integer  NOT NULL  DEFAULT 7000
```

Basis points, integer, via `model.number()`. Deliberately **not**
`model.bigNumber()` — that is two columns (numeric plus a `raw_*` jsonb) and a
hand-written migration omitting the `raw_` half passes mocked tests and fails on
first real insert.

Hand-written MikroORM migration, additive with a default, so existing rows
backfill to 70% without a data migration step.

## Testing

Unit (`@acme/odds-math`, pure — the bulk of the coverage):

- solver hits target RTP within tolerance across several pools
- locked rows keep their exact rate; `c` solves over the remaining mass only
- ladder proportions preserved within the chase budget
- bps output sums to exactly 10000, input-order independent
- infeasible target returns the typed error naming the band, applies nothing
- degenerate pools (no Commons, no chase rows, `V_H == V_C`) error cleanly
- `proposeRarities` band boundaries, including exact-multiple edges
- regression: exponent-style collapse does not recur — the rarest tier keeps a
  non-zero, representable win rate

Admin (vitest): auto-split populates dropdowns and inputs as unsaved edits and
writes nothing until save.

Integration (http): a pack saved via auto-split reproduces the target RTP from
its stored weights when read back through `packTheoreticalRtp`.

## Out of scope

- Per-set RTP targets (decision 4 — one pack-level target; sets 2/3 stay
  hand-editable).
- Auto-adjusting `pack.price` to make a target reachable.
- Touching `computeOdds`, which the reward/daily-box editors still use.
- Backfilling or re-solving existing packs. Operators opt in per pack.

## Risks

**`bronze-pack` is `status = active` at 9720% RTP in the local dev DB.** This
design fixes the tooling, not the live row. Whether production carries the same
weights was not verified — the postgres MCP used here points at local. Check
prod before assuming this is dev-only damage; it is the only spinnable pack.

**70% on this pool is inherently top-heavy.** ~99.8% of spins return a card worth
under RM 40. That is forced by a RM 28,325 pool against a RM 50 ticket, not by
the solver. If richer outcomes are wanted the levers are pack price or pool
composition.

**FX staleness feeds the solve.** Values derive from the `fx_rate` row, currently
dated 2026-07-02. A solved distribution is only as current as that rate; a large
FX move shifts real RTP away from the stored target until re-solved.
