# Lucky Pack ticket spin — design

Draft for operator approval, 2026-10-30. Builds on the Lucky Draw
(`2026-10-24-lucky-draw-design.md`). The separate one-winner-per-event change to
the draw gets its own design after this one.

## Why

The operator wants a pack that sells Lucky Draw tickets through the reel players
already know. _(My guess at the reason: it gives players another way into the
draw, and a reason to spend around it.)_

## What the operator decided

- A new pack category, **Poly**. The first pack in it is **Lucky Pack**.
- The customer pays and spins the reel, like any pack.
- The reel rails show ticket amounts: "Tickets x10", "x50", "x100", "x1000".
- Admin configures the amounts and their chances. The operator also named 5, 10
  and 1000 as examples, so amounts are free, not a fixed list.
- Confirmed on 2026-10-30 (playback accepted):
  - The price is set on the pack as usual and paid from the wallet.
  - Bonus credit pays the way it does on other packs.
  - Won tickets go straight to the customer's Lucky Draw balance.
  - There is no card, so no vault item, sell-back, delivery or stock.
  - A spin counts as a paid open for VIP, task goals and the spend-before-withdraw
    rule. It adds nothing to the weekly challenge.
  - The server decides the result. The reel only replays it.
  - Each reel tile is our ticket art with its "x10" label.
- Answered on 2026-10-30, after the builder check:
  - **Configured like our current packs.** Same admin setup as a card pack: each
    row has a rarity tier, a win %, a lock and the three win-rate sets, with the
    same Common balancer. The real rates stay secret. Customers see the same
    admin-written published odds as on a card pack.
  - **Both wallet money and bonus credit can pay.** This means bonus credit can
    become tickets, a ticket can win a card, and that card sells as cash, without
    the two-rounds rule. The operator accepted this knowing it. _(I read "Both" as
    both ways of paying.)_

## Goals

- Admin can create a ticket pack, set any list of amounts and chances, and change
  them later. A change affects future spins only.
- A customer is never charged without getting their tickets, and never gets
  tickets without being charged.
- Everything that counts a paid open keeps working (section 4).

## Non-goals (v1)

- Selling tickets any other way (no "buy 10 tickets" button).
- Live-pulls feed, Recent Pulls, Telegram or leaderboard volume for ticket wins.
- Gifting a ticket pack, or using one as a task free rip.
- Automation bots spinning ticket packs.
- Changing how the Lucky Draw itself draws (that is its own design:
  `2026-10-30-lucky-draw-one-winner-design.md`).

## Anti-goals (a failure even if it "works")

- A ticket shows up as a card anywhere: vault, sell button, delivery, inventory,
  Lucky Draw prize picker, price sync, stock.
- A charge without tickets, or tickets twice for one spin.
- The browser influences the result.
- It looks like a casino (`PRODUCT.md`). The ticket art carries it: no flashing
  coins, no "jackpot" wording.
- The Lucky Draw page still says tickets can't be bought.

## Design

### 1. Data: real ticket rows, no fake cards

Do not register ticket amounts as cards, and do not write `pull` rows. A fake card
would need a backing product and would leak into every surface listed in the
anti-goals. `pull.card_id` is required, and buyback, delivery, feed, boards,
profile and achievements all read `pull`. Do not reuse `pack_odds.kind` either:
`roll-pack`, `save-pack-odds`, `set-pack-members` and the store pack route all
drop or require card rows, so every one of them would change.

New, all additive:

- `pack.prize_type`: `cards` (default) or `tickets`. Set at creation, fixed after.
- `ticket_prize`: the configured table, one row per amount, with the same rate
  columns as `pack_odds` so `@acme/odds-math` and `odds-sets.ts` work unchanged:
  pack_id, tickets, rarity, weight, weight_2, weight_3, locked. `tickets` is a whole
  number of at least 1, unique within a pack. Units as `pack_odds` (1,000,000 = 100%).
- `ticket_spin` (customer_id, pack_id, tickets, source, bonus_bp, open_id,
  rolled_at): one row per spin, the record of what was won. `tickets` is a
  snapshot, so a later admin edit never changes a past spin. `source` and
  `bonus_bp` are worked out the same way a paid pull's are (`bonus-credit.ts`).
- `lucky_draw_ticket.reason` gains `pack_spin`, with `ref` = the `ticket_spin` id.
  This needs the model enum and a CHECK migration, like
  `Migration20261025120000.ts`. The open id cannot be the ref: a batch shares one.

### 2. Admin

- The pack form gets a "Prizes" choice: Cards or Tickets. It is locked once saved.
- A ticket pack's page keeps the card pack's editor and its rules. The only
  difference is that a row is a ticket amount typed in, not a card picked from
  inventory: Tickets, rarity tier, Win %, lock, the three rate sets, the Common
  balancer, the published odds panel, and "Add amount". Saving writes an audit row.
- Top Hits has no meaning without cards and is not offered.
- Activating a ticket pack needs at least one row with weight above 0
  (`update-pack.ts` today requires a card row). The card routes
  (`set-pack-members`, `save-pack-odds`) refuse a ticket pack.
- A live pack can be edited. Saves apply to the next spin.
- Category `poly` joins the admin list and the storefront icon map (already done on
  this branch).

### 3. The spin

- Paid spins go through `POST /store/packs/:slug/open-batch` (1 to 3 reels). That
  route sends a ticket pack down a new path. The single `/open` route refuses one,
  because it only serves the free pack and automation.
- Roll on the server, weighted, with the same random source `roll-pack` uses. The
  customer's group picks the rate set, the same way it does on a card pack.
- Then, in **one database transaction**, under the customer's credit lock: the
  normal `settleOpen` debit (`pack_open`, bonus first), the `ticket_spin` rows, the
  `lucky_draw_ticket` credits, and the SP `ledger_entry` a paid open writes (with
  `vault_delta` 0 and no prize SKUs). Because it is one transaction there is no saga
  compensation to write. Failure rolls all of it back.
- The customer's transaction history names the ticket pack, as it does a card pack.
- After commit, run the same best-effort VIP settle and `vip.spend_settled` event as
  a paid open. A VIP hiccup never voids a spin.
- A double press is two spins, as it is on card packs today.

### 4. What counts a spin

Already fine, because they read the `pack_open` debit: VIP, playthrough, referral
commission, Economy, leaderboard spend.

Must change, because they read `pull`:

| Reader                                           | Change                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `hasPaidOpen` (`service.ts`)                     | Also true for a `ticket_spin` with source `pack`                                         |
| Task rip counts (`service.ts`)                   | Add `ticket_spin` with source `pack`                                                     |
| Pack-sales report (`reports/finance/queries.ts`) | Attribute revenue and count through `ticket_spin.open_id`, or it lands in "unattributed" |

Stay out, on purpose: weekly challenge, leaderboard volume, achievements
(`vault_count`), pack RTP, growth pack report. _(Growth report is my call.)_

### 5. Storefront

- Pack page: `odds[]` carries one row per amount, with its rarity and ticket amount
  and no weight, so the reel works and the real rates stay secret. These rows don't
  pass today's card schema (`PackDetailPageSchema`), so they get their own shape. The
  rates panel is the existing published odds, unchanged. The catalog card and hero are
  unchanged.
- The guest demo (`?demo=1`) samples the same way a card pack's does.
- Hide what assumes cards: Top Hits, Expected value and value range, Recent Pulls,
  buyback copy, Lossless copy. Home highlights skip the pack.
- Reel tile: the ticket art with its amount drawn on top as live text, because
  admin can set any number. `hreel.ts` and `ReelStrip` need a label beside the image.
- Reveal: instead of the slab, the ticket art and "100 tickets". One action, "Go to
  Lucky Draw", plus spin again. No Sell or Keep.
- Reel tile frames and reveal sounds follow the row's rarity, as on a card pack.
- Tickets show up in the customer's balance right away.

### 6. Lucky Draw wording

- The Lucky Draw page says "Tickets come from tasks and Polycards gifts — they
  can't be bought." It becomes "Tickets come from tasks, Lucky Packs and Polycards
  gifts."
- My Tickets and the admin ticket lookup label `pack_spin` as "Lucky Pack".
- Update the "no route sells them" comment in `lucky-draw-ticket.ts` and the
  non-goal in the Lucky Draw spec.

### 7. Keep ticket packs out of

- Automation pack choice (`automation-live-store.ts`, `automation-live.ts`): a
  cycle needs a pull and a card.
- Giftable packs (`pack-gifts.ts`).
- Task free-rip pack choice (`store/tasks/claims/[claimId]/spin`).
- The admin card pack pickers, EV and RTP lists.

## Constraints

- **Legal gate.** Paying for a chance at Lucky Draw prizes may count as a lottery or
  gambling under Malaysian rules. Lucky Pack stays Draft on live until the owner
  confirms this has been checked. Building it does not need that answer.
- **Deploy order.** The storefront must understand the new response before any ticket
  pack goes Active, because a roll it cannot parse shows the charged-but-unshowable
  error (`src/lib/actions/packs.ts`). New schema fields are optional. A Draft pack on
  live is the safety net.
- Migrations are additive and follow the usual migrate-then-serve order.
- Money stays decimal RM as elsewhere. Tickets are whole numbers.

## Art (done or in progress)

`public/images/polycards/lucky-pack.webp` (909x1666), `public/pack-index-icons/poly.webp`,
and the `lucky` factory (still, loop and poster). The tier gets added to
`FACTORY_VIDEO_TIERS` and `factory-video.test.ts`.

## Left to the builder

- Exact names, as long as they stay plain and match the repo.
- Whether `ticket_spin` writes live in a new service method or beside `settleOpen`,
  as long as it stays one transaction.
- Open-batch response shape, as long as old fields stay and the storefront can tell a
  ticket roll from a card roll.
- Ticket art sizing and label typography on the reel, measured with the Playwright
  scripts.
