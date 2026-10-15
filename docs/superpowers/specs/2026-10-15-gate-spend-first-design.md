# Withdrawals open once the money for packs is used

Date: 2026-10-15. Owner's boss, by voice note the same afternoon, after #793 (2e4f2a89) went live. Supersedes the partial hold of ADR 0011 (#781); keeps ADR 0012 (task, challenge and gift reward sales are cash).

## The rule

1. **No withdrawal or card delivery before one real top-up.** Unchanged.
2. **Withdrawals open only when "Still to use on packs" is RM 0.** While any money is still to use on packs (unspent top-ups, the bonus-paid share of a sale, the welcome card's sale), **nothing** is withdrawable. Once it is all used, everything except bonus credit is withdrawable, including task, challenge and gift reward sales.

Boss's example: a customer gets a RM 1,000 card, has not topped up, tops up RM 500 → they must spend that RM 500 on packs, then they can withdraw everything.

Code: `withdrawableCents` in `backend/packages/api/src/modules/packs/withdrawable.ts` becomes `remainingCents > 0 ? 0 : max(0, availableCents − bonusCents)`; still 0 before any top-up and while frozen (walletSummary). `sellbackHoldBp`, the ledger stamps, the spend order (bonus first, then money for packs, then the rest) and delivery rules do not change. Opening a pack already uses money for packs before other money, so normal play clears the hold.

With this rule "unlock" is TRUE again: using the money for packs unlocks withdrawals of the rest. Copy may say so.

## Numbers the screens show

From the wallet (`balance`, `available`, `bonus`, `withdrawable`, `playthrough.remaining`, `has_topup`, `is_frozen`):
- `stillToUse = min(remaining, max(0, available − bonus))`
- `lockedCash = max(0, available − bonus − stillToUse)` when `withdrawable == 0` (else 0): the money that becomes withdrawable once the gate opens.
- Balance = withdrawable + lockedCash + bonus + stillToUse (test it, in sen).

## Words

Labels stay: Balance / Withdrawable / For packs (Bonus credit + Still to use on packs).

- Locked state, topped up, `stillToUse > 0`: under Withdrawable → "Use RM X more on packs to unlock withdrawals. Then RM A can go to your bank." (X = bonus + remaining, because packs spend bonus first; A = lockedCash; omit the second sentence when A = 0). As shipped; see ADR 0013.
- Never topped up: banner → "Top up once (from RM N) and use it on packs to unlock withdrawals. Card deliveries start after your first top-up." If A > 0 add "Then RM A of your balance can go to your bank." Never promise A is withdrawable right after the top-up.
- Rules text (wallet + how-it-works):
  1. **Top-ups are for opening packs.** Withdrawals unlock once you've topped up and used all your money for packs.
  2. **Cards you pull are yours.** Ship them, or sell them back. Once nothing is left to use on packs, your whole balance except bonus credit can be withdrawn — including sales of cards you won from tasks, the weekly challenge and gift packs.
  3. **Bonus credit and the welcome pack are for packs.** (keep the existing body about bonus being used first and the bonus-paid share)
  - Example: "Sell a prize slab for RM 300, then top up RM 50 → RM 50 still to use on packs, withdrawals locked. Open packs with that RM 50 → withdrawals unlock: RM 300 plus whatever you sell back can go to your bank."
- Sell-back sentence (wallet footer, withdraw page, how-it-works, VaultClient, BUYBACK_EXPLANATION): "Sell-back money reaches your balance at once. The part paid with bonus credit, and the welcome pack's card, is for packs. Withdrawals unlock once your money for packs is used."
- /task, challenge, rank one-liners: replace "sell back as withdrawable money after your first top-up" with "sell back as cash you can withdraw once you've topped up and used your money for packs".
- Withdrawal refusal (backend `withdrawalGateError`), order unchanged (frozen > no top-up > locked > cap):
  - no top-up (shipped): `Top up at least once to unlock deliveries. To withdraw, you also need to use all your money for packs.`
  - locked (`remaining > 0`, shipped): `Withdrawals unlock once you've used RM X more on packs. Then your balance, except bonus credit, can be withdrawn.` (X = bonus + remaining, cents-exact)
  - plain cap: `You can withdraw up to RM X right now.` (unchanged)
  Storefront `vault-errors.ts` must pass "Withdrawals unlock once" through; `WithdrawForm.tsx` REMEDIES maps it to Open packs. Keep the old phrases ("is for opening packs", "more on packs") passing through for deploy skew.
- Top-up notice/toast: "RM X added — use it on packs to unlock withdrawals."

## Tests

- Unit: `withdrawableCents` (remaining 0 / >0 / bonus only / clamp), `withdrawalGateError` texts, storefront split math + sum invariant, refusal mapping.
- Integration specs that asserted partial withdrawal while a hold remained (vault-buyback, pack-gifts, withdrawable/playthrough specs, release-old-reward-holds spec) must expect 0 until `remaining` is 0, then the full non-bonus balance.
- ADR 0013 "withdrawals open once nothing is left to use on packs" superseding ADR 0011's partial hold; CONTEXT.md.
