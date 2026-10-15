# ADR 0013 — Withdrawals open once nothing is left to use on packs

- **Status**: Accepted
- **Date**: 2026-10-15
- **Supersedes**: ADR 0011 (the playthrough gate holds only the unplayed part).
- **Keeps**: ADR 0012 (task, challenge and gift reward sales are cash) and the
  no-top-up rule of #748.

## Context

ADR 0011 made the gate partial: while money was still to use on packs, the
rest of the balance could already leave. On 2026-10-15, after #793 went live,
the owner's boss set a stricter rule: a top-up must be used on packs before
anything is withdrawn. His example: a customer holding a RM 1,000 card who has
never topped up tops up RM 500, and must spend that RM 500 on packs before
they can withdraw anything.

## Decision

- **Withdrawable = 0 while `playthrough.remaining` > 0, else
  `max(0, available − bonus)`.** `withdrawableCents` in `withdrawable.ts` is
  still the one place it is computed. It also stays 0 before the first real
  top-up and while the account is frozen (`walletSummary`).
- Nothing else moves: `sellbackHoldBp`, the buyback stamps, the spend order
  (bonus first, then money for packs, then the rest) and the delivery rules.
  An open already uses money for packs before other money, so normal play
  clears the hold.
- The refusal while money is still to use on packs is: "Withdrawals unlock
  once you've used your RM R for packs. Open packs with it, then your balance
  can be withdrawn." (R = `playthrough.remaining`). Freeze, no-top-up and the
  plain "You can withdraw up to RM X right now." are unchanged, in the same
  order. Using the money for packs really does unlock the rest now, so copy
  may say "unlock" again.

## Consequences

- A delivery fee can take the balance below what is still to use on packs.
  Such a customer can only clear the hold by topping up again; the refusal
  names the full remaining amount.
- The storefront passes "Withdrawals unlock once" through and keeps the
  older phrases ("is for opening packs", "more on packs") for deploy skew.
