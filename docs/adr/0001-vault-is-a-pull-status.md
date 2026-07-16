# The Vault is a Pull status, not its own table

A customer's vault is not a separate entity: a vault item _is_ a `Pull` whose
`status` is `vaulted`. Every Pull starts `vaulted` and moves through
`bought_back` / `delivering` / `delivered` in place. We chose this so the Pull
row stays the single source of truth shared by the live-pulls feed, the
leaderboard, and the vault — with no second table to keep in sync and no way for
a vault row to disagree with its Pull.

## Consequences

- "The vault" is a query (`Pull where status = vaulted`), never a join to a
  vault table — do not add one.
- Buyback, delivery, and showcase are Pull state transitions, so their
  invariants live on the Pull lifecycle, not on a separate vault record.
