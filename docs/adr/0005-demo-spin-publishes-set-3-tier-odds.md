# The guest demo spin publishes odds set 3's tier split

The logged-out demo spin (`/slots/:slug/spin?demo=1`) draws client-side. It used
to sample the pack's admin-authored `published_odds` — marketing copy, not a
distribution anyone plays — so the pre-signup taste was theater over theater.
The operator asked for it to roll **odds set 3**, the same sets customer groups
map to through `metadata.odds_set`.

That required narrowing a stated invariant. `GET /store/packs/:slug` carries a
"🔒 SECRET ODDS" rule — the per-card `weight` is the real, admin-tuned win rate
and must never reach a customer — and the Epic 3 plan
(`docs/superpowers/plans/2026-07-27-polycard-back-epic3-odds.md`) recorded "no
per-group disclosure change". This is that change, made deliberately and with
the operator's sign-off (2026-08-05, PR #372).

The route now returns `demo_odds: { tiers } | null`, computed by `demoTierSplit`
in `backend/packages/api/src/modules/packs/odds-sets.ts`.

## What is disclosed, and what is not

- **Tier level only.** Per-card weights never ship. The exception, accepted: a
  tier holding exactly ONE card publishes that card's draw probability, because
  the same response already lists every card with its rarity. Chase tiers are
  often single-card, so this is the real cost of the decision, not a corner.
- **Set 3 only.** Set 3 resolves per card (3 → 2 → 1), and `computeSetWeights`
  stores nothing for a set the operator never authored — so on such a pack the
  set-3 resolution _is_ set 1, which the DEFAULT group and every ungrouped
  player actually roll. `demoTierSplit` returns null whenever the set-3 split is
  indistinguishable from set 1, and the demo falls back to the published odds.
  Publishing the odds the paying majority rolls was never the ask.
- **Set 2 rides along when set 3 inherits it.** A pack that authored set 2 and
  not set 3 publishes set 2's values — by the operator's own configuration,
  those _are_ that pack's set 3.
- **Real spins are untouched.** `demo_odds` is read only under
  `isDemo` (`demoPool !== null && !customer`). A logged-in customer on `?demo=1`
  gets the real machine, as before.

## Consequences

- Turning the demo onto a pack's real odds is now an operator action: author set
  3 on that pack's Win rates tab. Until then the demo silently keeps using the
  published odds — by design, but it does mean "the demo didn't change" is an
  expected report, not a bug.
- The odds **panel** still renders `published_odds`. Where the two diverge, a
  guest sees one distribution and pulls another. Accepted for now; revisit if
  the demo's honesty becomes a trust question.
- Fidelity ceiling: tier probability is exact, card-within-tier stays uniform
  (`src/lib/demo-spin.ts`). Closing that gap would require per-card weights on
  the wire, which this ADR does not permit.
- `tierSplitForSet` is the raw aggregation and has no disclosure policy of its
  own. Anything sending odds to a customer must go through `demoTierSplit`, or
  restate the bound above.
