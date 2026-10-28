# ADR 0011 — The playthrough gate holds only the unplayed part

- **Status**: Superseded by ADR 0013 (2026-10-15): withdrawals open only once
  nothing is left to use on packs, so the partial hold below no longer applies.
- **Date**: 2026-10-14
- **Amends**: ADR 0010 (the "whole balance stays unwithdrawable" consequence)
  and `plans/082-withdrawal-gate-under-lock.md` (the all-or-nothing gate).

## Context

The playthrough gate was all-or-nothing: while `deposited − used` was above 0,
nothing could be withdrawn. On 2026-10-14 a customer had RM 38.95 and could
withdraw none of it. They had opened a RM 45 pack with RM 15 of task-reward
bonus and sold the card back for RM 31.63, and the bonus share of that sale
(RM 10.55) locked the whole balance. Topping up had the same effect: it locked
winnings that were already withdrawable.

## Decision

- **Withdrawable = available − bonus − `playthrough.remaining`, never below 0.**
  It stays 0 for a frozen account or one that never topped up.
- What is still to play is exactly the money that has not been played. A pack
  open spends bonus first, then the unplayed part, then normal money, so the
  gate still blocks every path that cashes out a deposit or promo value
  without playing it. Releasing winnings from packs that were played has no
  anti-laundering or anti-promo value.
- The refusal names both figures: "You can withdraw up to RM X. Spend RM Y
  more on packs to unlock the rest." The storefront matches "more on packs"
  and still matches the old "must be spent on packs", so a storefront deploy
  can land before the backend one. (Reworded 2026-10-15, since spending held
  money lowers it rather than unlocking anything: "You can withdraw up to RM X
  right now. The other RM Y is for opening packs." / "Nothing is withdrawable
  yet. Your RM Y is for opening packs.", where Y = available − withdrawable,
  bonus included. The storefront matches "is for opening packs" and keeps
  "more on packs" for a backend deploy that lands later.)
- `GET /store/credits` returns `playthrough` (MYR) on each row, so the history
  shows what added to the hold and what spent it. Since 2026-10-15 it is
  signed and set on top-up (+ its basis), sell-back (+ its stamped free
  share) and pack-open rows (− the for-packs money the open used); every
  other row carries 0. Until then it was set on sell-back rows only, never
  below 0.

## Consequences

- `withdrawableCents` in `withdrawable.ts` is the one place the figure is
  computed; `walletSummary` calls it and the cashout gate reads that figure
  under the `credit:` lock, as before.
- The RM 50 payout minimum and the RM 45 cheapest pack are unchanged. A
  customer whose free money is below the minimum still cannot withdraw.
