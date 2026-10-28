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
  once you've used RM X more on packs. Then your balance, except bonus credit,
  can be withdrawn." X = bonus + `playthrough.remaining`, because packs spend
  bonus first. The no-top-up refusal reads "Top up at least once to unlock
  deliveries. To withdraw, you also need to use all your money for packs."
  Freeze and the plain "You can withdraw up to RM X right now." are unchanged,
  and the order is the same. Spending on packs really does unlock the rest
  now, so copy may say "unlock" again.

## Consequences

- A delivery fee can take the balance below what is still to use on packs.
  A top-up alone does not close that gap, since it adds to what is still to
  use as much as to the balance. The customer clears it by spending that much
  more on packs, for example with money from sell-backs. Fees are deliberately
  not counted as used: that would let a top-up be laundered by requesting a
  delivery and cancelling it. The owner re-confirmed this on 2026-10-15; the
  screens explain it instead.
- If the fee left the balance at RM 0 with money still to use on packs, the
  customer has nothing to spend. Only selling back cards from paid packs, and
  spending that on packs, closes the gap; a top-up adds to both sides.
- A pack open is a saga: `chargePackOpenStep` commits the debit before the
  pull is recorded, and a failed open is undone by `reverseOpen`, which
  restores what is still to use on packs. In that brief window it may read 0
  and other cash could be withdrawn. The top-up itself never leaves (the
  debit has already spent it), so this is accepted.
- `withdrawalGateError` refuses while anything is still to use on packs even
  when the `withdrawable` figure it is handed says otherwise (defense in
  depth).
- The storefront passes "Withdrawals unlock once" through and keeps the
  older phrases ("is for opening packs", "more on packs") for deploy skew.
