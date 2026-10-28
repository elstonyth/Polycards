# Withdrawal gate: the screens say what the code does

> **FINAL RULE (owner, 2026-10-15, supersedes the revision boxes below):** a
> pull's sale is held "for packs" only for (a) the bonus-paid share of a pull and
> (b) the welcome pack's card (`source 'free'`). Everything else — paid pulls,
> task and weekly-challenge rewards (`source 'reward'`: cards, slabs, free rips)
> and admin gift packs (`source 'gift'`) — sells back as withdrawable money.
> Rule 1 (one real top-up before any withdrawal or delivery) and rule 2 (a
> top-up is spent on packs once) are unchanged. Delivery: every card ships for
> its zone fee after one top-up; only the welcome card waits for a paid pack.

> **REVISED A THIRD TIME 2026-10-15 (owner): every task and weekly-challenge
> reward pull sells back as cash.** That is every `source === 'reward'` pull:
> task card/slab rewards, weekly-challenge prize slabs AND task pack rewards
> (free rips, opened from a real pack). Sale withdrawable at once, still only
> after one real top-up. Unchanged (two rounds): bonus credit, admin gift packs
> (`source 'gift'`), the welcome pack (`source 'free'`). "Free packs" in customer
> copy now means gift packs and the welcome pack only.

> **REVISED AGAIN 2026-10-15 (owner): prize cards and slabs sell back as
> withdrawable money.** A card or slab handed over as a prize (task card reward:
> `pack_id 'task-reward'`; weekly-challenge prize: `isChallengePrizePack`) sells
> back with NO hold: the sale is withdrawable at once, still only after one real
> top-up (rule 1). Shipping it is unchanged (zone delivery fee, #790). This is a
> backend rule change, decided at SELL time so prize cards already in vaults
> follow it; prize-card sales made before the deploy keep their hold. Free packs
> (gift, free rip — `source 'reward'` with a real pack slug —, welcome) and bonus
> credit stay at two rounds. Every "prize cards are for packs" text below is
> superseded: prize cards are now named with the cards you pay for.

> **REVISED 2026-10-15 (owner): rule 3 stays at TWO rounds, as today.** There is
> NO backend rule change: `sellbackHoldBp` is dropped, `pull.bonus_bp` keeps
> deciding the held share of a sale exactly as #712 does, and there is no ADR 0012.
> This change is wording, labels and display only. Where the text below talks
> about "one pack open" or prize cards being the only held sale, the revised
> section "Rule 3 as it stays" wins.
>
> ### Rule 3 as it stays
>
> Anything Polycards gives must go through packs twice before it is cash: bonus
> credit or a free pack (gift pack, free rip, welcome pack) is opened once, and
> the free share of selling that pull (`buyback.bonus` in the quotes = the pull's
> `bonus_bp` share; 100% for free packs and prize cards) lands in "Still to use on
> packs" and must be spent on a pack again. Prize cards: their whole sale lands
> there. A pull paid with the customer's own money sells back as withdrawable.
>
> ### Revised texts (these replace the matching rows in section 3)
>
> - Rules text item 2: **Cards you pull are yours.** Ship them, or sell them back. Selling a card from a pack you paid for with your own money gives you withdrawable money.
> - Rules text items 3+4 become one: **Bonus credit, free packs and prize cards are for packs.** Bonus credit comes from tasks, check-ins, challenges, VIP vouchers and promotions, and every pack uses it first. If you sell a card pulled with bonus credit or from a free pack (gift packs, free rips, the welcome pack), or sell a prize card, the free part of that sale is money for packs. Open a pack with it, and what you pull is yours.
> - Example: Top up RM 50.00 → RM 50.00 for packs. Open a RM 45.00 pack → RM 5.00 for packs. Sell the card back for RM 30.00 → RM 30.00 withdrawable. Open a free pack and sell its card for RM 20.00 → RM 25.00 for packs, still RM 30.00 withdrawable.
> - "Buyback credit is available immediately" replacement, everywhere: "Sell-back money reaches your balance at once. The part from bonus credit, free packs or prize cards is for packs; the rest is withdrawable."
> - Sell-back notice, free part H > 0 (H = `buyback.bonus`): H equals the sale: "RM X added for opening packs — this card came from free value." H smaller: "RM X added. RM (X−H) is withdrawable; RM H is for opening packs (the part paid with bonus credit)."
> - Sell-back notice, H = 0, topped up: "RM X added. It's withdrawable." Never topped up: "RM X added. Withdrawals start after your first top-up."
> - Sell-confirm warning when H > 0: "RM H of this sale is for opening packs (the part from bonus credit, a free pack or a prize card)." Nothing when H = 0.
> - Withdraw page For-packs line: "Open packs with it. Sell-back money from those packs is withdrawable, except any part paid with bonus credit."
> - Wallet top-up banner body ending: "After that, money from selling cards you pull is withdrawable, except the part from bonus credit or free packs."
> - Backend held refusal, X = 0: `Nothing is withdrawable yet. Your RM Y is for opening packs.` (X > 0 text unchanged: `You can withdraw up to RM X right now. The other RM Y is for opening packs.`)
> - Ledger: every buyback row with a stamped share (bonus-paid, free-pack or prize pulls) shows "+RM H for packs".
> - Gate: "held" = Y > 0 only (not `remaining > 0 || Y > 0`): an empty balance gets the plain cap `You can withdraw up to RM 0.00 right now.` instead of "Your RM 0.00 is for opening packs".
> - After review (2026-10-15): sell-back toasts never claim "withdrawable" (sell screens don't know `has_topup`): "RM X added for opening packs." / "RM X added · RM H for packs" / "RM X added."; the welcome lock reads "Pay for one pack yourself to unlock selling & delivery."; the long rules paragraph lives only on /wallet, other pages carry one line plus a link; "Spent on packs" includes the bonus part.

Date: 2026-10-15. Owner decisions taken in chat the same day.
Background research: `reports/Bonus credit and withdrawal gate UX.md` in the main checkout (local only, holds customer quotes, never commit it).

## 1. The owner's rules

1. **No withdrawal without a top-up.** At least one real top-up before any withdrawal or card delivery. Already live (#748). No change.
2. **A top-up must be spent on packs once** before it can be withdrawn. Already live. No change.
3. **Anything Polycards gives goes through ONE pack open.** After that, what is pulled and sold back is withdrawable.
   - Gift packs, free rips, the welcome pack: opening the pack is the one play. Their pulls sell back as withdrawable money.
   - Bonus credit: spending it on a pack is the one play. A pull paid partly or fully with bonus sells back as withdrawable money.
   - Prize cards (a card handed over with no pack open: task card rewards, weekly-challenge prize cards): the sale goes to "still to use on packs" in full and must be spent on a pack first. Same as today.

What changes in code: only rule 3. Today (#712, 2026-10-09) the bonus share of a sell-back (`pull.bonus_bp`) is stamped as `external_funded_cents` on the buyback row, so it must be played a second time. After this change, only prize cards are stamped.

Old holds stay. Buyback rows already written keep their stamp; there is no data change and no migration. The new rule applies to every sale from the deploy on, including cards already sitting in vaults.

## 2. The rule as one function (backend)

In `backend/packages/api/src/modules/packs/bonus-credit.ts`:

```ts
/** Basis points of a card's sell-back that must be spent on a pack before it
 *  can be withdrawn (owner rule 2026-10-15): everything Polycards gives goes
 *  through ONE pack open. A pull that came out of a pack (paid, bonus-paid,
 *  gift, welcome, free rip) has had its play: 0. Only a prize card handed
 *  over with no pack open is held in full. */
export function sellbackHoldBp(pull: {
  source?: string | null;
  pack_id: string;
  bonus_bp?: number | null;
}): number;
```

Returns `BONUS_BP_FULL` only when ALL of:

- `pull.source === 'reward'`
- `Number(pull.bonus_bp ?? 0) >= BONUS_BP_FULL` (minted under the 2026-10-11 promo rule; prize cards claimed before that were never held and must not start being held now)
- `pull.pack_id` is a prize-only pack id: `'task-reward'` (task card reward, see `service.ts` claim path) or a challenge prize pack id (use the existing exact matcher next to `challengePackId` in `challenge-prize.ts`; do not use a bare prefix test).

Otherwise `0`. A free rip is `source 'reward'` with a REAL pack slug, so it returns 0.

`bonus_bp` keeps its other job unchanged: VIP, leaderboard, challenge and task counting weigh pulls by `NORMAL_SHARE_SQL` / `paidPullSource`. Do not change how `bonus_bp` is minted.

Use `sellbackHoldBp` everywhere the held part of a sale is computed today from `pull.bonus_bp`:

- `workflows/steps/buyback-pull.ts` → `recordBuybackCreditTransaction` (rename its `bonusBp` input to `holdBp`).
- `api/store/packs/[slug]/open/route.ts` and `open-batch/route.ts` quotes (`buyback.bonus`, `vault_bonus`).
- `api/store/vault/route.ts` quote (`buyback.bonus`). Keep the JSON field names (`bonus`, `bonus_bp`) for API compatibility, fix their comments.

The storefront reads the held part from `buyback.bonus`, so reveal / vault / sell-confirm warnings follow automatically.

## 3. Words on screen

Never say that spending held money will "unlock" or "release" it. The held amount IS the money that gets spent: opening a pack lowers the balance and "still to use on packs" together, and withdrawable does not move. ("Unlock" stays honest only for real switches: the first top-up turning withdrawals on, and the welcome card's first-paid-pack unlock.)

### Labels (English only in this change)

| Concept                            | Label                                         | Never use                                                               |
| ---------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| Whole balance                      | **Balance**                                   | Available, Total balance, Current balance, Wallet (as a figure), Normal |
| Can go to the bank                 | **Withdrawable**                              | Available to withdraw, Unlocked, ready to withdraw                      |
| Can't go to the bank               | **For packs**                                 | Locked, held, to play, playthrough                                      |
| Promo money                        | **Bonus credit** (sub-line note "used first") | Bonus balance, coins                                                    |
| Unspent top-ups + prize-card sales | **Still to use on packs**                     | To play, Deposit playthrough, playthrough                               |
| Large withdrawal waiting for staff | **Awaiting approval**                         | Under review (that now means only a frozen account)                     |

Numbers: **For packs = available − withdrawable** (never below 0), with the two lines under it: **Bonus credit = bonus**, **Still to use on packs = For packs − Bonus credit** (never below 0). Computing it this way keeps the three figures adding up even when a delivery fee pushed `playthrough.remaining` above the balance. Wallet fields come from `WalletSchema` in `src/lib/data/schemas.ts` (`balance`, `available`, `bonus`, `withdrawable`, `playthrough`, `has_topup`, `is_frozen`).

### The rules text (wallet explainer and "How withdrawals work")

1. **Top-ups are for opening packs.** A top-up can't be withdrawn as it is. Topping up never lowers what you can already withdraw.
2. **What you pull is yours.** Ship it, or sell it back. Sell-back money is withdrawable.
3. **Bonus credit is for packs only.** It comes from tasks, check-ins, challenges, VIP vouchers and promotions, and every pack uses it first. Cards you pull with it are yours like any other pull.
4. **Prize cards** (from tasks and the weekly challenge) sell back as money for packs. Open a pack with it, and what you pull is yours.

You need one top-up before you can withdraw or ship cards.

Example: Top up RM 50.00 → RM 50.00 for packs. Open a RM 45.00 pack → RM 5.00 for packs. Sell the card back for RM 30.00 → RM 30.00 withdrawable. Sell a check-in prize card for RM 20.00 → RM 25.00 for packs, still RM 30.00 withdrawable.

Counting line (tasks, VIP, leaderboard): "VIP and the leaderboard count the part of each pack you paid yourself. Packs paid half or more with bonus credit don't count toward tasks." Free packs and prize cards count toward none of them.

### One sentence when money appears

| Moment                                            | Text                                                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Top-up sheet, before paying                       | Top-ups are for opening packs, not for withdrawing. What you pull and sell back is withdrawable.                                 |
| Top-up done                                       | RM X added — it's for opening packs.                                                                                             |
| Sell-back of a pulled card, account has topped up | RM X added. It's withdrawable.                                                                                                   |
| Sell-back of a pulled card, never topped up       | RM X added. Withdrawals start after your first top-up.                                                                           |
| Sell-back of a prize card                         | RM X added for opening packs. Prize-card sales are for packs.                                                                    |
| Task / check-in / challenge credit                | RM X bonus credit added. Use it on packs — it can't be withdrawn.                                                                |
| Prize card claimed                                | Card added to your Vault. Ship it, or sell it for money to open packs. (Never topped up: add "Shipping needs one top-up first.") |

Use whichever of these the surface has the data for; do not add API calls just to pick a variant.

### Withdrawal refusals (backend `withdrawalGateError`, byte-identical on both callers)

Order stays: frozen > no top-up > held > plain cap. Frozen and no-top-up texts are unchanged (`NO_TOPUP_MESSAGE` keeps "Top up at least once"). `WithdrawalGateWallet` gains `available` (walletSummary already returns it) so the held text can name the for-packs amount `Y = max(0, available − withdrawable)`:

- Held, X > 0: `You can withdraw up to RM X right now. The other RM Y is for opening packs.`
- Held, X = 0: `Nothing is withdrawable yet. Your RM Y is for opening packs — what you pull and sell back becomes withdrawable.`
- Not held (plain cap): `You can withdraw up to RM X right now.` (unchanged)

"Held" = `playthrough.remaining > 0 || Y > 0`. The minimum withdrawal is rail-specific (TGPay RM 50, A3Pay S$), so the backend gate never names it; the withdraw page shows the rail's minimum.

Storefront pass-through (`src/lib/vault-errors.ts`) must match the new phrases (`you can withdraw up to`, `is for opening packs`, `Top up at least once`, `under review`) and drop `more on packs`; `WithdrawForm.tsx` REMEDIES must link the held refusal to opening packs. Update both in the same change as the backend text.

## 4. Who builds what (file ownership)

Five builders work in ONE worktree at the same time, so each owns its files. Do not edit a file owned by another builder; if you need a change there, say so in your report.

| #   | Builder                        | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Backend rule + refusals + docs | `bonus-credit.ts` (+ its unit spec), `buyback-pull.ts`, `service.ts` (recordBuybackCreditTransaction + comments only), `withdrawable.ts`, `gateway-withdrawal.ts` + its unit spec, `open/route.ts`, `open-batch/route.ts`, `vault/route.ts`, `models/pull.ts` comment, `external-backfill.ts` comment, integration specs that assert the old bonus-share stamp, `src/lib/vault-errors.ts` (+ test), `src/lib/delivery-errors.ts`, `src/lib/errors.ts`, `backend/apps/admin/src/i18n/en.json` ("deposit still to play" → "still to use on packs"), `docs/adr/0012-*.md` (new), `docs/adr/0010` / `0011` cross-links, `CONTEXT.md` |
| 2   | Wallet page                    | `src/app/(account)/wallet/page.tsx`, `src/components/account/PlaythroughProgress.tsx` (delete if unused)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3   | Withdraw page                  | `src/app/bank-withdrawal/page.tsx`, `src/app/bank-withdrawal/WithdrawForm.tsx` (+ its tests)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 4   | Ledger                         | `src/app/(account)/transactions/page.tsx`, `src/lib/transactions.ts` (+ test), `backend/packages/api/src/api/store/credits/route.ts`, `backend/packages/api/src/modules/packs/credit-summary.ts` (+ spec), `src/app/(account)/me/page.tsx`, `src/components/app-shell/AppHeader.tsx`                                                                                                                                                                                                                                                                                                                                             |
| 5   | Moments + explainers           | `src/components/app-shell/TopUpSheet.tsx`, `TopUpProvider.tsx`, `src/components/SellConfirmModal.tsx` (+ test), `src/app/slots/[slug]/RevealStage.tsx`, `src/app/task/use-claim-task.ts`, `src/app/task/task-hub.ts`, `src/app/task/TaskHubClient.tsx`, `src/app/task/CheckInTrack.tsx`, `src/app/leaderboard/WeeklyChallenge.tsx`, `src/app/leaderboard/RankRewardSheet.tsx`, `src/lib/notifications/copy.ts` (+ test), `src/lib/packs-data.ts`, `backend/.../packs/free-pack.ts` (message text only), `src/app/how-it-works/page.tsx`                                                                                          |

## 5. Ledger markers (builder 4)

`/transactions` must explain "Still to use on packs" row by row. Mark only money going into or out of it, so the markers add up:

- Top-up row (non-null external basis): `+RM X for packs`.
- Pack open: bonus part `RM a bonus credit` and the part that used for-packs money `−RM b for packs` (b = the row's consumed external basis).
- Prize-card sell-back (stamped): `+RM X for packs`.
- Do not mark rows "withdrawable" (goes stale once spent).
  Split the history's "Total spent" into "Spent on packs" and "Withdrawn".

## 6. Out of scope

Chinese copy (no storefront locale exists yet), the RM 50 rail minimum, pack prices, clearing old holds, the AI desk bots (the Support desk is being switched off; its SOUL text is fixed later).

## 7. Testing

- TDD for `sellbackHoldBp` and the refusal texts: unit tests per pull type (paid, bonus-paid, gift, welcome, free rip, new task prize card, new challenge prize card, task prize card from before 2026-10-11).
- Integration: update every spec that expects a gift / bonus / free-rip sale to stamp `external_funded_cents`; prize cards still stamp in full. One spec proving RM 15 bonus + RM 30 own money → RM 45 pack → sell → the whole sale is withdrawable.
- Storefront: unit tests for any changed logic (for-packs math, refusal mapping, ledger markers); presentational copy needs no markup tests.
- Typecheck both packages; Prettier `--check` on every changed file with the repo's own binary.
