# Stock: GRN, new inventory columns, auto order status — design (draft)

Status: APPROVED 2026-10-28 (operator: "defaults ok"). Branch feat/stock-grn-procurement.

## Why

The boss wants the admin Stock page to show the cards physically in hand, what still has
to be bought, and orders that move themselves from "processed" to "ready to ship". Every
day at 12am, two lists go out: cards to buy (to purchasing) and parcels to post (to
mailing). Oldest orders go first.

## What exists today (facts from the code)

- Inventory page columns: On hand, In vault, Requested, Shipped
  (`backend/apps/admin/src/routes/inventory/list/page.tsx`, data from
  `modules/packs/inventory-view.ts` + `service.inventoryLifecycleBuckets`).
- **On hand today = the Medusa inventory counter.** Every pull win takes one off it, so it
  goes negative ("units owed"). The same counter feeds the pack odds page, the store pack
  report, the task/challenge prize takes, and buyback restore.
- **Requested today = orders in requested + processed + ready_to_ship.** Shipped = shipped +
  completed.
- Purchase invoices: immutable, corrections by a reversal invoice (negative qty). Saving one
  adds to the Medusa counter and feeds the weighted-average cost column.
- Delivery order statuses already exist: requested → processed → ready_to_ship → shipped →
  completed (+ canceled). Every move is manual today, through one seam:
  `service.transitionDeliveryOrderStatus` (lock, audit, pull side effects).
- No goods receive note exists.

## 1. New Stock columns (order fixed by the boss)

| #   | Column                | Formula                                                                     |
| --- | --------------------- | --------------------------------------------------------------------------- |
| 1   | Qty to be procured    | `max(0, ReqProc + ReadyToShip − OnHand)` — see decision Q1                  |
| 2   | On hand               | `Σ GRN qty + Σ PI qty (only invoices NOT transferred from a GRN) − Shipped` |
| 3   | In vault              | unchanged (pulls with status vaulted)                                       |
| 4   | Requested + processed | orders in requested / processed (+ legacy `packing`)                        |
| 5   | Ready to ship         | orders in ready_to_ship                                                     |
| 6   | Shipped               | shipped + completed (unchanged)                                             |

- New On hand never goes negative from vault pulls. It only goes negative if more cards
  shipped than were ever received (bad or missing history — see Risk 1).
- **My call:** the old Medusa counter stays exactly as it is. It is a different number
  ("received minus won") and prize settlement depends on it. Only the Stock page changes.
- Same change in the item detail page and the Excel export.

## 2. Goods Receive Note (GRN)

- New admin pages under Inventory, placed **above** Purchase Invoices: list, new, detail.
- Fields: supplier, date, lines (card, qty, FMV). Number: `GRN-00001` (own sequence).
- Saving a GRN: adds to On hand, adds to the old Medusa counter (as a PI does today), writes
  a stock-movement audit row.
- **My call:** a GRN is immutable like a PI. A mistake is fixed with a reversal GRN
  (negative qty), the same pattern the team already uses for invoices.
- The list shows each GRN as "Open" or "Transferred → PI-000xx".

## 3. Purchase Invoice: "Transfer from goods receive note"

- New PI page gets a button: **Transfer from goods receive note** → pick an open GRN →
  supplier, cards, qty and FMV are copied in; the operator types the unit cost.
- The saved PI stores `from_grn_id` and shows "Transferred from GRN-000xx".
- That PI does **not** add to On hand again and does **not** touch the Medusa counter.
  It still counts for the weighted-average cost (a GRN has no cost).
- A GRN can be transferred once (unique index). A reversal of a transferred PI carries the
  same `from_grn_id`, so it does not subtract stock either.

## 4. Automatic order status

Allocation rule (a pure function with unit tests):

1. Ready-to-ship orders already hold their cards. Free stock per card =
   `OnHand − cards held by ready-to-ship orders`.
2. Walk requested + processed orders, **oldest first**.
3. If free stock covers every card in the order → the order becomes **ready_to_ship** and
   takes those units.
4. Otherwise it stays (see decision Q3 for whether it holds partial units).

When it runs:

- **00:00 MYT job** (cron `0 16 * * *` UTC): run allocation; every still-uncovered
  `requested` order → `processed` (it is now on the purchasing list).
- **After every GRN / PI save:** run allocation, so an order flips to ready-to-ship as soon
  as its last card arrives.
- All moves go through `transitionDeliveryOrderStatus` with a system audit reason.
- Never auto-ships, never auto-demotes. Manual buttons stay as an override.

## 5. Daily lists (for the 12am AI)

- `GET /admin/procurement/to-buy`: cards with Qty to be procured ≥ 1 — name, SKU, qty, FMV,
  oldest waiting order date.
- `GET /admin/procurement/to-ship`: ready-to-ship orders, oldest first — order no, customer,
  address, cards.
- Admin page "Procurement" with both tables and an Excel export.
- Sending the lists to the departments is a separate step (decision Q2). The status logic
  never depends on the AI.

## Build phases

- **A. Numbers only (read-only, safe):** new On hand, split columns, Qty to be procured,
  export. The boss checks the numbers against the physical cards before anything moves.
- **B. GRN + transfer.**
- **C. Auto status + daily lists.**
- **D. Local test:** integration specs for every money/stock path, Playwright screenshots of
  the admin pages, then refine.

Work happens in a fresh worktree from `master`, never in the main checkout.

## Risks

1. **Opening stock.** New On hand = received − shipped. If cards were shipped that were never
   put on a purchase invoice, those cards show negative On hand on day one. Check prod
   (read-only) before Phase A ships; if any exist, record an "opening stock" GRN.
2. **Customer notifications.** Today a manual status move can notify the customer. Automatic
   moves at 00:00 would do the same unless told not to (decision Q5).
3. **Status logic and old orders.** Orders already sitting in processed / ready_to_ship are
   kept as they are on the first run.

## Decisions (approved 2026-10-28)

1. **Shortage sign:** shown as a positive "need N" = `max(0, ReqProc + RTS − OnHand)`; the
   to-buy list carries every card with N ≥ 1.
2. **Lists:** live in the admin dashboard (a Procurement page + JSON endpoints). No Discord bot.
   Operator direction 2026-10-28: AI agents move INTO the admin dashboard later (an in-admin
   chatbot that queries data, plus image generation colleagues download there) — so the two
   lists are plain JSON a future admin chatbot can read. The chatbot is a separate project.
3. **Queue fairness:** strict oldest-first. An older order holds the units it can get, even when
   it cannot be completed yet; a newer order for the same card waits.
4. **GRN → PI transfer:** whole GRN, card and qty locked; the operator only types unit cost. A
   GRN has at most one live transfer. A reversed GRN cannot be transferred; a transferred GRN
   cannot be reversed. To correct a transferred GRN (wrong cost or qty), reverse its invoice —
   a transferred invoice can only be reversed in full — which re-opens the GRN; then transfer
   it again with the right cost, or reverse it and book a correct GRN. (Review fix 2026-10-28:
   before this, re-entering the cost as a plain invoice counted the cards twice.) A transfer
   must also carry the GRN's FMV unchanged.
5. **Notifications:** automatic moves notify the customer exactly as a manual move would
   (same `notifyDeliveryChange` path).
6. **Cancel window (operator, 2026-10-28):** customers can cancel or change the address only
   while an order is requested / processed. An automatic move to ready_to_ship ends that window
   as soon as the cards are on hand — accepted; no change to the cancel rules.

## Build notes (2026-10-28)

- **Switch:** automatic order moves (00:00 MYT job + the run after every GRN / invoice save)
  only happen with `STOCK_AUTO_ALLOCATION=true` on the backend. Off by default, so the boss can
  check the new Stock numbers against the shelf first. Turning it on in prod = add the env var
  to the DigitalOcean backend app spec (edit `.do/backend.app.yaml` by script — the formatter
  hook re-quotes secrets in that file). The to-buy / to-ship lists work either way.
- **Column placement:** the six stock columns sit right after Title on the Stock page; the table
  scrolls sideways and at the end they were off screen even at 1920px.
- **Lucky Draw** prize picker reads `counter` (the Medusa counter, received minus won), not the
  new physical `on_hand`, because the draw takes from that counter.
- **Coin-flip branch:** its `Migration20261028120000` also rewrites the `admin_action_audit`
  entity_type CHECK with a hard-coded list. Pending migrations run in name order on a fresh DB but
  in deploy order on prod, so EITHER can run last: once both branches are merged, BOTH
  migrations' lists (and the model enum) must carry both values (`goods_receive_note` and
  `coin_flip_config`). Codex was asked on 2026-10-28 to add ours to the coin-flip side; this
  branch adds `coin_flip_config` when it rebases onto a master that has coin flip.
