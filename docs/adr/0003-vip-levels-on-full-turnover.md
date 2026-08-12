# VIP levels rank on full pack-open turnover, not external-funded spend

Through #254 (2026-07-22), a customer's VIP level was driven by the same
external-funded basis as commissions and the withdrawal gate: only
deposit-funded pack opens counted, so a winnings-funded open (a prize
re-opened, a promo credit spent) advanced neither the ladder nor the reward
tier. #254 changed the VIP **level** basis to full turnover — every
`pack_open` debit, regardless of funding source — while leaving commission
basis and the withdrawal gate untouched on external-funded spend. We chose
this split, not a single basis for everything, because the three consumers
answer different questions: VIP level answers "how much has this customer
played" (turnover — winnings replayed still show engagement), commission
answers "how much new money did the sponsor's recruit bring in" (must stay
external-funded, or a recruit could pump a sponsor's commission by cycling
winnings with no new deposit), and the withdrawal gate answers "has deposited
money been sufficiently played through" (must stay deposit-tied by
definition — see `backend/packages/api/src/modules/packs/withdrawable.ts:5-36`
and the deposited-basis fold in `credit-summary.ts:26-50`, called from
`service.ts:2807-2928`).

The turnover counter lives in two mirrored places: `service.ts`'s SQL
aggregate (`lifetimeTurnoverSenFor`, `service.ts:4395-4418`, "Sums ORIGINAL
pack_open debits (amount<0) only") and the pure-fold equivalent used in tests
(`vip-lifetime.ts`, `lifetimeTurnoverSen`). Both sum every `pack_open` debit
with no external-funded filter — that omission is the change #254 made, not
an oversight. The commission fan-out at `service.ts:2449` still computes its
own basis as `-externalFundedCents` (deposit-only) and reads the sponsor's
turnover counter only to look up their *level* (`service.ts:2457-2465`), not
to size the payout.

## Consequences

- Two counters exist by design and must not be unified: the turnover counter
  (VIP level, ladder grants) and the external-funded basis (commission size,
  withdrawal gate). A future change that "simplifies" them into one basis
  would silently alter either payout economics or level-up pacing.
- The admin Players list column and its i18n label read "Turnover", not
  "Spend" — "Spend" reads as money the customer paid, which is exactly the
  external-funded basis this counter does *not* track. **Done** (commit
  `052ceb8c`): the shared `players.spend` i18n key in
  `backend/apps/admin/src/i18n/en.json` serves both the Players list column
  and the per-customer monthly spend-report table, and both are
  funding-source-agnostic pack-open sums (`spendReportForCustomer` sums
  `pack_open` rows with no external-funded filter), so the single shared
  "Turnover" label is correct in both places. The sibling strings
  (`subtitle`, `lastSpend`, `spendReport`, `spendEmpty`) and the report
  table's non-i18n `aria-label` were relabeled in the same change.
- `backfillExternalFundedBasis` (`service.ts:4562-4606`) is a **separate**
  mechanism that stamps `external_funded_cents` on pre-1b grandfathered
  topups — it corrects the external-funded basis (commission/withdrawal
  inputs), not the turnover counter, which was never gated on that field.
  Don't conflate "backfilling the external basis" with "backfilling
  turnover" when reading that code.
- The DB column stays named `lifetime_external_spend_sen`
  (`vip_member_state` model) even though it now holds turnover — renaming a
  live table column is a separate, higher-risk change than the code-symbol
  rename this ADR accompanies. See the column's own comment for the pointer
  back here.

## Reversal exclusion (added 2026-08-12)

`lifetimeTurnoverSenFor` filters `amount < 0`, so `reverseOpen`s compensating
row — also `reason = pack_open`, but positive — is excluded and the counter
never decreases. Three audit passes have now filed that filter as a bug and one
of them changed it. It is deliberate and it stays.

The decision above is about the *funding* basis (full turnover vs
external-funded) and does not settle the reversal question, which is why the
reversal filter kept being re-litigated against this ADR. Recording it here so
the next pass has somewhere to land:

- The counter is mirrored in `vip-lifetime.ts` (`lifetimeTurnoverSen`), the pure
  fold the tests use. Netting one and not the other desyncs the tests from
  production silently — the concrete failure of the 2026-08-12 attempt, and the
  reason it was reverted.
- Netting is **not** needed to stop grant farming, contrary to what that
  attempts commit message claimed. `grantLevelUpRewards` inserts
  `ON CONFLICT (customer_id, level, kind) ... DO NOTHING` against
  `UQ_vip_reward_grant_customer_level_kind`, so a levels reward cannot be issued
  twice at the database layer. `highest_level_ever` (a `GREATEST` ratchet) and
  `levelsToGrant`s `start = max(highestEver + 1, 2)` are two further guards
  above it. None of the three depends on the arithmetic here.
- Reversals are reflected on the OTHER basis: `creditSummary().vipSpendTotal` is
  net, drops on a reversal, and drives `current_level`. The monotonic counter
  drives `highest_level_ever`. Running both is intended.

Net effect: a refund never lowers lifetime turnover, and a clawback-then-respend
neither re-earns a grant nor is blocked from opening.
