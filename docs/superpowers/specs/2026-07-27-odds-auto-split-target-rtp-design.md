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
5. **Keep basis-point resolution.** Cards whose fair rate falls below 1 bps are
   floored and *reported*, not silently zeroed and not accommodated by
   re-scaling the odds system. See "Resolution floor".

Assumed rather than asked, for consistency with the existing model: **locked rows
stay pinned** and the solver works around them. The published-odds panel depends
on being able to pin a card at an exact advertised rate.

## Design

### Shape: a solved chase budget, not a solved exponent

The obvious approach — keep the ladder's relative weights and raise them to a
solved power `k` — is **rejected**. It hits the target but destroys the tail. On
`bronze-pack` the exponent that lands 70% is `k ≈ 6.15`, which drives the ladder
ratios (Legendary/Common = 0.01) to `0.01^6.15`, pushing the Legendary to roughly
1 in 4 trillion and the Mythicals to 1 in 4.9 million. The chase cards — the
entire point of the product — become unwinnable.

Instead, solve a single **chase budget** `c`: the total probability mass given to
all non-Common rows. Within that budget the ladder's *relative* proportions are
preserved exactly; the Common tier absorbs the rest. This keeps the existing
"Common absorbs what's left" intuition, and because EV is **linear in `c`** it
solves in closed form with no iteration.

All probabilities below are **fractions in `[0, 1]`**, not percentages. Values
`v_i` are MYR display prices. Per the Epic 3 convention, EV sums run in integer
cents internally; the formulae are written in RM for readability.

Given target RTP `t`, pack price `P`, locked rows `L` with pinned fractions
`q_j`, free chase rows `H` and free Common rows `C`:

```
E_L = Σ q_j·v_j                     EV already committed by locked rows
M   = 1 − Σ q_j                     free probability mass
V_H = Σ(w_i·v_i) / Σ w_i  over H    ladder-weighted mean value of chase rows
V_C = Σ(w_i·v_i) / Σ w_i  over C    ladder-weighted mean value of Common rows

c = (t·P − E_L − M·V_C) / (V_H − V_C)
```

Each chase row then takes `c · w_i / Σ_H w`, each Common row
`(M − c) · w_i / Σ_C w`.

**Feasible band.** `c` is clamped to `[0, M]`, so reachable RTP runs from
all-Common (`c = 0`) to all-chase (`c = M`) — 63.8%–3017% on this pack. Outside
that the solver returns a typed error naming the band rather than clamping
silently:

> Target 70% needs EV RM 35.00; this pool reaches RM 31.91–RM 1,508.69
> (63.8%–3017%). Lower the target, raise the price, or change the pool.

Degenerate cases return the same typed error: no free Common rows (no absorber),
no free chase rows, or `V_H == V_C`.

### Resolution floor

`TOTAL_BPS = 10000` and `pack_odds.weight` is an integer, so the smallest
non-zero win rate the system can express is **1 bps = 0.01% = 1 in 10,000**.
Fair rates below that would round to zero and make a card unwinnable — the exact
failure the chase-budget shape exists to avoid.

Restoring true ladder proportions is not an option: giving Mega Charizard even
1 bps at its ladder share requires `c ≥ 1.78%`, which lands **RTP ≈ 116%**. On
this pool the ladder and the grid are in direct conflict, so the floor wins and
the deviation is reported.

**Algorithm.** Solve, floor, re-solve until stable:

1. Solve `c` as above.
2. Any chase row whose fair share is below 1 bps joins the floored set `S`,
   pinned at exactly 1 bps.
3. Subtract `S`'s fixed mass and EV, then re-solve `c` over the remaining free
   chase rows.
4. Repeat until no new row falls below the floor. Each pass can only add rows to
   `S`, and `S` is bounded by the row count, so this terminates.
5. Emit the floored rows in the result so the UI can report them.

Flooring is *upward*, so it pushes real RTP above target. That overshoot is
reported, never hidden.

**On `bronze-pack`, the cascade runs three passes:** `c = 20.9 bps` floors the
Legendary; re-solving drops the Mythicals to 0.75 bps so they floor too;
re-solving again stabilises. Final shape:

| Card | Tier | Rate | Note |
| --- | --- | --- | --- |
| PW Pikachu / PW Bulbasaur | Common | ~49.94% ea | absorbers |
| PW Jolteon | Uncommon | 3 bps | |
| PW Gengar / PW Charizard / Mega Dragonite | Rare | 2 bps ea | |
| PW Mewtwo / Pikachu Grey Felt / Pikachu ex | Mythical | 1 bps ea | **floored** (fair 0.75) |
| Mega Charizard X | Legendary | 1 bps | **floored** (fair 0.118) |

Real RTP ≈ **70.3%** against a 70% target — the overshoot is the floored cards
being handed out more often than fair.

Two things the operator must be told, because both are real product problems the
solver cannot fix:

- Mega Charizard's fair rate is 1 in 85,034 but it will drop 1 in 10,000 — about
  **8.5× more often than the target implies**.
- Legendary and Mythical both sit at 1 bps, so **the tiers are indistinguishable
  at this target**. The ladder has stopped meaning anything.

Both are symptoms of a RM 28,325 pool behind a RM 50 ticket, and the honest fixes
are raising the price or removing the RM 4.4k–9.9k cards. The report says so.

For reference, the floor also raises the pack's true minimum: with all eight
chase cards pinned at 1 bps, RTP bottoms out at **69.4%**. A 70% target clears
that by a hair; anything lower is unreachable without dropping cards.

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

Note this is a departure from odds-math's current role: the solver is the first
export that needs **card values**, not just weights. Values arrive as function
arguments, so the package stays dependency-free.

The solver is a **preview-time input generator**, not a new write path. It emits
a decimal pct per row; those pcts flow through the unchanged
`computeSetWeights` → `balanceOdds` → save pipeline. No change to the odds save
workflow, the 3-set inheritance rules, or the draw path.

Two consequences of that pipeline an implementer must not miss:

- **`balanceOdds` owns rounding.** The solver emits decimal pcts and does *not*
  round to bps itself; double rounding would drift the result. The single
  largest-remainder pass in `balanceOdds` stays authoritative for `Σ = 10000`.
- **`balanceOdds` discards the solver's Common pcts.** Unlocked Commons are
  balancers — their submitted pct is ignored and recomputed as an even split of
  the remainder. This happens to match the solver's intent *only* because every
  Common row shares `RARITY_WEIGHT` 500, making "proportional within `C`" and
  "even split" identical. Load-bearing coincidence: if per-card weighting within
  a tier is ever introduced, the two diverge and the solver's Common output
  starts being silently overwritten.

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
- A **report panel** after each run listing floored cards, their fair vs actual
  rate, the resulting RTP overshoot, and any tier collapse. This is the feature's
  main safety output — it is how an operator learns the pack is mispriced.
- Infeasible targets surface the typed error inline; nothing is applied.

Running auto-split on set 2 or 3 materialises explicit rates for that set, ending
its NULL-inheritance from the previous set. The UI must say so before applying,
since inheritance is otherwise invisible.

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
- ladder proportions preserved within the chase budget when no flooring occurs
- infeasible target returns the typed error naming the band, applies nothing
- degenerate pools (no Commons, no chase rows, `V_H == V_C`) error cleanly
- `proposeRarities` band boundaries, including exact-multiple edges

Resolution floor — the subtle half, and where regressions will hide:

- a sub-1-bps card is floored to exactly 1 bps, never 0
- the floor **cascade** converges: the `bronze-pack` fixture needs three passes
  and must land Legendary and all three Mythicals in `S`
- floored rows are reported with fair vs actual rate and the RTP overshoot
- a pool needing no flooring reports an empty set and hits target exactly
- the solver never returns a chase row at 0 bps

Admin (vitest): auto-split populates dropdowns and inputs as unsaved edits,
renders the report panel, and writes nothing until save.

Integration (http): a pack saved via auto-split reproduces the expected RTP from
its stored weights when read back through `packTheoreticalRtp` — asserting the
*floored* RTP (≈70.3% on the fixture), not the nominal target.

## Out of scope

- Per-set RTP targets (decision 4 — one pack-level target; sets 2/3 stay
  hand-editable).
- Auto-adjusting `pack.price` to make a target reachable.
- Raising odds resolution beyond basis points (decision 5).
- Touching `computeOdds`, which the reward/daily-box editors still use.
- Backfilling or re-solving existing packs. Operators opt in per pack.

## Risks

**`bronze-pack` is `status = active` at 9720% RTP in the local dev DB.** This
design fixes the tooling, not the live row. Whether production carries the same
weights was not verified — the postgres MCP used here points at local. Check
prod before assuming this is dev-only damage; it is the only spinnable pack.

**The floor makes the ladder decorative on rich pools.** At 70% on this pack,
four of eight chase cards sit at the 1 bps floor and Legendary is
indistinguishable from Mythical. The solver reports it, but no odds setting fixes
it — only price or pool composition will.

**70% on this pool is inherently top-heavy.** ~99.9% of spins return a card worth
under RM 40. Forced by a RM 28,325 pool against a RM 50 ticket, not by the
solver.

**FX staleness feeds the solve.** Values derive from the `fx_rate` row, currently
dated 2026-07-02. A solved distribution is only as current as that rate; a large
FX move shifts real RTP away from the stored target until re-solved.
