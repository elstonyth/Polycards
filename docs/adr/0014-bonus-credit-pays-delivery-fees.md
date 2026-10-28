# ADR 0014 — Bonus credit pays delivery fees

- **Status**: Accepted
- **Date**: 2026-10-17
- **Supersedes**: the delivery-fee part of ADR 0010 ("every other debit
  (withdrawal, delivery fee, admin deduction) is floored on the Normal
  Balance").
- **Keeps**: ADR 0012 (reward and gift sales are cash), ADR 0013 (nothing is
  withdrawable while money is still to use on packs) and #748's no-top-up
  rule.

## Context

On 2026-10-17 the owner restated the withdrawal and delivery rules: a top-up
before withdrawals and deliveries unlock, what was topped up spent before a
withdrawal, and **delivery fees can be paid with bonus credit**. The first two
were already in place. The third was the opposite of the code: since #748 and
#790, a fee was floored on the normal balance, so a customer with RM 5 of cash
and RM 30 of bonus was refused a RM 15 delivery and told to top up.

## Decision

- **Delivery fees spend bonus first.** `mutateCreditAtomic` floors a
  `delivery_fee` debit on the whole balance and stamps
  `bonus_cents = −min(bonus, fee)` on the row, the same order a pack open
  uses. A charge may not name its own bonus share.
- **A cancel gives the bonus part back as bonus.** The cancel arm in
  `transitionDeliveryOrderStatus` reads the bonus its charge took (the
  `delivery_fee` row with `reference = order id`) and passes it as the
  refund's `bonusCents` (0..refund). Without this, request-then-cancel would
  turn bonus into withdrawable cash. Workflow compensation already
  soft-deletes the charge row, which restores the bonus by itself.

## Consequences

- Fees still never count as pack spending (ADR 0013), so paying one with
  bonus changes nothing about what is still to use on packs.
- Reports already count only the cash part of each row (`reasonCashSenSql`,
  `normalSenSql`), so the bonus part of a fee is not read as fee revenue.
- The storefront delivery sheet compares the fee with the whole balance. It
  still maps the old "bonus credit can only be spent on packs" refusal, which
  only appears during deploy skew.
- Weekly-challenge credit prizes stay bonus credit, and prize-card sales stay
  behind ADR 0013's all-or-nothing gate (owner, 2026-10-17). The RM 50 floor
  is left to the gateways' per-payment minimums (owner chose not to add a
  lifetime check in code).
