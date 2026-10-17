# Bonus credit is a signed ledger column, not a second wallet

Operators wanted to give players spend-only credit (泥码, "dead chips"): it opens
packs, it can never be withdrawn. We store it as a signed `bonus_cents` column on
the existing append-only `credit_transaction` ledger rather than as a second
balance or wallet table. Bonus Balance is `Σ bonus_cents`; it sits inside the
one Balance every screen already shows; Normal Balance is the difference.

Why one ledger: every money rule we already trust (the per-customer advisory
lock, idempotency, append-only reversals, the playthrough gate, the economy
fold) keeps working on one Σ, and the bonus part of each row is stamped in the
same insert, under the same lock, so the two can never disagree. A second wallet
would need its own locks, its own reversals and a cross-wallet spend order
written twice.

The rule that makes it hold: **bonus credit itself is never withdrawable, and
the value of bonus credit or a gifted pack reaches withdrawable money only after
real play.** (As first built, a card's bonus share sold back as bonus and could
never leave; on 2026-10-09 the operator chose to pay it as normal credit that
must be played through once, like a deposit.)

## Consequences

- A pack open spends bonus FIRST (`settleOpen`), stamping `−bonus used`; only
  the rest draws on deposits, so bonus-funded play banks no playthrough.
- Every other debit (withdrawal, delivery fee, admin deduction) is floored on
  the Normal Balance inside `mutateCreditAtomic`. (Since ADR 0014, 2026-10-17,
  a delivery fee spends bonus first too, and a cancel refunds that part as bonus.)
- Withdrawable = `max(0, available − bonus)` once playthrough is done.
  (Amended by ADR 0011: `max(0, available − bonus − playthrough remaining)`
  at all times; back to this rule by ADR 0013, with 0 until playthrough is
  done.)
- Each pull records `bonus_bp`, the share of its price that was bonus (10000 for
  a gifted pack). A sell-back pays normal credit and stamps that share on the
  buyback row as `external_funded_cents`, which joins the playthrough basis like
  a deposit: that much stays unwithdrawable until it has been spent on packs
  (the whole balance did until ADR 0011, and does again since ADR 0013). Sales before 2026-10-09 were paid as bonus and stay bonus.
  A gift pack's or a task / challenge reward's sale (`source = 'gift'` or
  `'reward'`) stamps nothing since ADR 0012 (decided at sell time).
- Gift pulls carry `source = 'gift'`, and a paid pull bonus paid at least half
  of carries `source = 'bonus'`, so every positive `source = 'pack'` count
  (tasks, profile, feed, welcome unlock) excludes them; VIP and referral
  turnover and the economy's cash lines count only the normal part of each row
  (`−amount·100 + bonus_cents`), and the boards' and challenge's value sums
  weight each pull by its normal share (`bonus_bp`).
- Reversals restore `bonus_cents`; the down migration refuses while any bonus
  row exists, because dropping the column would silently make bonus withdrawable.
- See spec `docs/superpowers/specs/2026-10-07-vault-packs-bonus-credit-design.md`.
