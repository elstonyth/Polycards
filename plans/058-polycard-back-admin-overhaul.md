# 058 — POLYCARD-BACK Admin Overhaul

Source: `POLYCARD-BACK.docx` (operator spec, 2026-07-26) + grill session that
resolved its ambiguities. This document is the implementation contract; the
docx is superseded. Scope: **admin dashboard** (`backend/apps/admin`) + the
backend modules under `backend/packages/api` that feed it, plus one
storefront-facing content change (referral policy page).

## 0. Locked decisions (from operator Q&A)

| #   | Decision                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Card price = FMV(MYR) × `market_multiplier` (per-card, default `DEFAULT_MARKET_MULTIPLIER = 1.2` in `modules/packs/pricing.ts`). No new price formula.                                                                                                                                             |
| D2  | Win rate 1/2/3 = **per-customer-group odds sets**. Exactly 3 fixed sets per pack. Fallback: set 2 empty → inherits set 1; set 3 empty → inherits set 2. A customer group selects its set at creation; the default group uses set 1. Groups control **odds only** — price identical for all groups. |
| D3  | Referral engine: **full replace, go-forward**. Basis = all pack-opening spend regardless of funding source. Old deposit-basis commission rows stay as history; no recompute.                                                                                                                       |
| D4  | Transaction ledger IDs: **go-forward only**, no backfill of historical events.                                                                                                                                                                                                                     |
| D5  | "All Orders" lists **all order types** (pack purchases + vault shipping requests) in one view. Core columns: order id, player, created date&time, status.                                                                                                                                          |
| D6  | Pull Ledger standalone admin page is removed; pull history moves **under Player detail**.                                                                                                                                                                                                          |
| D7  | Purchase invoice "PURCHASE WITH?" = **supplier / source**.                                                                                                                                                                                                                                         |
| D8  | Item cost = **weighted average** across purchase invoice lines.                                                                                                                                                                                                                                    |
| D9  | Week windows intentionally differ: referral week **Sun 00:00 – Sat 23:59**, weekly pull challenge stays **Mon–Sun**.                                                                                                                                                                               |
| D10 | Phase 1 = the entire doc; sequencing below is internal ordering only.                                                                                                                                                                                                                              |

Baked defaults (operator saw these and did not object — changeable cheaply if
wrong, flag before building against them):

- Collections/Categories: **admin UI removal only**, Medusa data untouched.
- SELL (instant buyback) stays at its current rate; doc's "90%" is an example,
  not a change request.
- Player disable switch = **blocks login** (and therefore all spend).
- Reference screenshots (channel tabs, "Champion" tier card) = **feature
  parity in the current Mercur admin style**, not pixel copies of the other
  system.
- Odds balancer: an adjustment that would push Common below 0% **blocks save**
  with a validation error.
- Gacha cards "no stock qty" = hide the column; real stock lives in Inventory.
- Inventory export = **.xlsx**.
- All week/date math in **Asia/Kuala_Lumpur**.

---

## 1. Orders

### 1.1 Navigation

- Remove **Pull Ledger** from the sidebar (`routes/pulls/page.tsx` retires as a
  top-level route; its table component is reused inside Player detail — §4.3).
  Timing: the removal ships **with the Players epic** (relocation atomic — the
  operator never loses access to pull history between epics).
- Rename **Deliveries → All Orders** — nav label + page heading only; the
  route dir/URL stays `/deliveries` (no churn).

### 1.2 Status pipeline (delivery orders)

Current enum on `delivery_order.status`:
`requested | packing | shipped | delivered | canceled`.
New enum:

```
requested | processed | ready_to_ship | shipped | completed | canceled
```

Migration maps existing rows: `packing → processed`, `delivered → completed`.
`ready_to_ship` is net-new. Update `delivery.ts` transition rules,
`delivery-view.ts`, storefront `src/lib/delivery-errors.ts` +
`src/lib/actions/delivery.ts`, and notification copy. Timestamps: keep
`shipped_at`/`delivered_at` (rename column NOT required — `delivered_at` now
means completed_at; add a comment, don't churn the column).

### 1.3 All Orders list

One list, two record kinds, with a **type filter tab** (All / Shipping /
Pack purchases):

- **Shipping rows** = `delivery_order` (status pipeline above applies).
- **Pack purchase rows** = existing `pull` + `credit_transaction`
  (`reason='pack_open'`) data — NOT the §5 ledger, so history shows from day
  one and Epic 1 ships without the ledger. When §5 lands, the SP display id
  overlays the internal id on new rows. Status column shows `completed`
  always.

Columns: order id (display id from §5 where present, else internal id), date
(created, date&time), item (photo + name + SKU; multi-line for multi-item
shipments), qty, player (link → Player detail), status. Sortable by date;
search by order id / player.

**Bulk tools** (shipping rows only):

- Mark as: any pipeline status + `canceled`. Illegal transitions are skipped
  and reported ("3 updated, 1 skipped: already shipped").
- Print details: opens a print-view page (browser print) rendering each
  selected order's detail block.

### 1.4 Order detail

Existing `routes/deliveries/` detail (admin) reshaped:

- **Player info**: name, email, phone, address.
- **Order details**: line items + shipping address snapshot (already
  denormalized on `delivery_order`). Keep tracking number + proof images.

Acceptance: status migration is lossless (row counts per mapped status match);
bulk mark-as writes one audit entry per changed order
(`admin-action-audit.ts`); print view renders n selected orders.

---

## 2. Product

### 2.1 Nav cleanup

- Remove **Collections** and **Categories** admin pages from nav. Data stays.
- Move **Add from PriceCharting** (`routes/products/from-pricecharting/`)
  under the Inventory nav group (§3). Route path may stay; nav placement moves.

### 2.2 Gacha Cards list

- Hide stock-qty column.
- Column-header sort asc/desc (name, FMV, price, created).
- Bulk tool: select cards → **Add to gacha pack** → pack picker →
  navigates to that pack's pool & odds editor (§2.4) with the selected cards
  appended to the pool (unsaved) → operator sets win rates → save.

### 2.3 Gacha Packs list — new columns

- **GROUP**: `RAW | GRADED | MIX`, auto-detected from the pack's pool (all
  cards raw → RAW, all graded → GRADED, else MIX). Derived, not stored — or
  stored+recomputed on pool save if list-query cost demands it.
- **Real EV / RTP** per odds set s ∈ {1,2,3}:
  - `price(card) = fmv_myr(card) × market_multiplier(card)` (D1; reuse
    `admin-card.ts` display-price seam — PR #262 already computes set-1 EV/RTP).
  - `EV_s = Σ_pool price(card) × win_rate_s(card)` (fallback-resolved rates).
  - `RTP_s = EV_s / pack_price`.
- **Published EV / RTP**:
  - `PubEV = Σ_tier ( Σ price(card∈tier) / count(tier) ) × published_odd(tier)`
  - `PubRTP = PubEV / pack_price`.
- List shows: EV1/RTP1 prominent; EV2,3/RTP2,3 + published pair in the row
  expander or secondary line (avoid a 10-column table).

### 2.4 Pool & odds editor (`api/admin/packs/[slug]/odds` + admin editor)

- Value column shows **price** (FMV × multiplier), not raw FMV.
- **Three win-rate columns** (Set 1 / Set 2 / Set 3). Sets 2 and 3 are
  nullable per card; empty means "inherit previous set" (D2). UI shows
  inherited values grayed with the effective number visible.
- Schema (corrected — there is NO win-rate column today; odds are `weight`
  integers in **basis points**, normalized to Σ=10000 per pack on editor save,
  with a `locked` boolean and split logic in `@acme/odds-math`): `pack_odds`
  gains `weight_2`, `weight_3` (nullable `model.number()`, plain integers — no
  `raw_` sidecar needed). NULL = "inherit previous set" (D2 fallback chain).
  Each non-null set normalizes to Σ=10000 bps on save independently. The
  single `locked` boolean is **shared across sets** (a pinned card is pinned
  in every set; its pinned % may differ per set via `weight_N`).
- **Common as balancer REPLACES the current unlocked-remainder split** in
  `@acme/odds-math` and the editor save path (today: locked rows keep their %,
  unlocked rows split the remainder). New behavior per set: rarity columns
  default from set 1; editing any non-Common rate auto-adjusts Common so the
  set sums to 100%. If Common would go below 0 → inline error, save blocked.
  Worktree note: `@acme/odds-math` needs `corepack yarn build` (main → dist)
  or backend tests fail with "Cannot find module".
- Live EV/RTP 1/2/3 recompute client-side while editing.
- Published odds row per rarity tier stays; header's "overall" figure becomes
  **Published EV** (2.4.7.5).
- Edit page also exposes GROUP (read-only auto-detect) per 2.4.8.

### 2.5 Customer groups → odds set

- Use Medusa's native customer groups. Group metadata `odds_set: 1|2|3`
  (default 1). Admin group create/edit form exposes the selector.
- Open-pack flow (`api/store/packs/[slug]/open`): resolve customer → group →
  odds set → effective per-card win rates (fallback chain) **server-side at
  spin time**. Integration points are `modules/packs/pick.ts` and
  `modules/packs/rollable-pool.ts` (the weighted-draw seam) — the set number
  selects which `weight_N` column feeds the roll. Storefront displayed odds
  remain the published odds — no per-group disclosure change.

Acceptance: EV math unit-tested against the doc's worked examples — with the
doc's arithmetic CORRECTED: EV = 300×0.2+200×0.3+100×0.5 = 60+60+50 =
**RM170** (the docx writes RM210, and its RTP line divides 270/300 — both
typos; the formula is authoritative, so RTP for that example = 170/300 =
56.7%). PubEV = (100+200)/2×0.2+(50+60)/2×0.8 = 30+44 = RM74 (doc correct). Balancer property test: any edit sequence keeps Σ=100% ± ε and never
saves Common < 0. Open-pack integration test: two customers in groups with
set 1 vs set 2 draw from different distributions (seeded RNG).

---

## 3. Inventory + Purchasing (new)

New admin nav group **Inventory**: item stock view, Purchase Invoices, and the
relocated Add-from-PriceCharting page.

### 3.1 Data model (new, in `modules/packs` or a sibling `inventory` module)

Cards are keyed by **`Card.handle`** (unique; `=== Product.handle`) — there is
no `sku` column on Card. "SKU" anywhere in the UI = the Medusa product
variant's sku where present, else the handle. All new tables key on
`card_handle`.

```
purchase_invoice
  id, display_no (auto: PI-<seq> or ledger-style — see §5), date,
  supplier (text, "purchase with"), agent_user_id (logged-in admin, auto),
  created_at
purchase_invoice_line
  id, invoice_id, card_handle, card_name, fmv_snapshot (MYR, frozen at
  create), qty, unit_cost, line_total
stock_movement            (append-only AUDIT LOG — not a source of truth)
  id, card_handle, kind: purchase | pull | vault_out(buyback) | requested |
  shipped | completed | adjustment, qty (signed), ref_id (invoice line /
  pull / delivery item id), created_at
```

**Authority (corrected):** physical stock ALREADY exists as a Medusa
inventory fulfillment counter (`modules/packs/card-stock.ts`) — decremented
per win, **allowed to go negative** = units owed to winners still needing
sourcing (operator request 2026-07-03). That counter **stays authoritative**
for on-hand. Purchase-invoice create writes a Medusa inventory adjustment
(+qty at the stock location) — the same path the existing counter uses — and
appends a `stock_movement` audit row. `stock_movement` is a paper trail for
the item-detail history table only; no quantity is ever derived from it.

### 3.2 Stock buckets (list columns + item detail)

- **On hand** = Medusa `stocked_quantity` via the `card-stock.ts` seam
  (negative allowed — negative = owed units; render in red). NOT
  "purchased − shipped": the pre-existing counter already nets pulls.
- **In vault** = pulls currently `status='vaulted'` — computed from existing
  `pull` state, not stock_movement, to avoid double bookkeeping drift.
- **Requested** = delivery items whose order is in
  `requested|processed|ready_to_ship`.
- **Shipped** = delivery items whose order is in `shipped|completed`.
- **Cost** = weighted average of `unit_cost` over all invoice lines for the
  handle (D8): `Σ(qty×unit_cost)/Σ(qty)`.

### 3.3 Inventory list

Columns: photo, name, SKU, title (RAW/GRADED), FMV, price, cost, created
time, on hand, in vault, requested, shipped, **listing show** (count of
places the SKU is used: packs / rank rewards; click → associated products
panel). Sort asc/desc on all numeric/date columns. Search by name/SKU.

Bulk tools:

- **Import** from PriceCharting "My Collection" (extend the existing
  `create-product-from-pricecharting` workflow to batch mode).
- **List to gacha card**: bulk select → 1-click create gacha cards.
- **Export to Excel** (.xlsx, current filter applied).

### 3.4 Item detail

- Info: name, SKU, title RAW/GRADED, FMV, price (fmv × multiplier), cost,
  on-hand qty, in-vault qty, requested qty.
- Associated products (the listing-show expansion).
- Stock movement table (append-only log, newest first).

### 3.5 Purchase Invoices

- **List**: invoice no, date, create time, agent, supplier, total qty,
  subtotal, total FMV. Sort asc/desc + search (invoice no, supplier).
  Click → full invoice view.
- **Create**: header (agent auto = session admin; date; supplier; invoice no
  auto-generated on save). Lines: item search (existing cards) or bulk import
  from PriceCharting My Collection; FMV auto-filled and **not editable**
  (snapshot); qty; unit cost; line total. Footer: subtotal (Σ line totals),
  total FMV (Σ fmv_snapshot × qty).
- Invoices are immutable after create (corrections via a reversing invoice
  with negative qty — keeps weighted-average cost honest). Admin-action audit
  row on create.

Acceptance: weighted-average cost unit tests (multi-invoice, reversal);
bucket math integration test across a full lifecycle (purchase → pull →
delivery request → shipped); xlsx export opens in Excel with correct rows.

---

## 4. Players (Customers rework)

### 4.1 Rename

Customers → **Players** across admin nav, routes (`routes/customers/` →
`routes/players/`), i18n. Backend keeps Medusa `customer` naming.

### 4.2 All Players list

Columns: player name, email, phone, group, LVL (VIP level from
`vip-level.ts`/`vip-member-state.ts`), wallet balance (Σ credit_transaction),
vault value, total spend (= Σ pack-open spend), total packs pulled,
registered date&time, last spend date&time, status **switch**
(enable/disable). Disable = new `disabled` boolean on the existing
`customer_account_state` model (login block via auth guard), with confirm
dialog. The existing `frozen` flag (funds lock, `availableBalance()=0`) stays
separate and unchanged — one model, two orthogonal flags, no second
suspension mechanism.

List aggregates (wallet bln, vault value, total spend, packs pulled) must be
ONE batched query per page (reuse the `credit-summary.ts` seam), never
per-row queries.

### 4.3 Player detail tabs

- **Profile**: name, bank name / bank acc number (NEW fields — customer
  metadata or a small `player_payout_details` model; needed for manual
  cashouts), phone, address, referral code, registered date&time.
- **LVL**: tier card (current tier name, member since, total accumulative
  spend, "RM X more to upgrade" progress bar, tier history, validity date) —
  reference image12, restyled to admin. Inside: spend report (per-period
  totals).
- **Wallet**: balance; inside: wallet flow = `credit_transaction` list with
  reason, amount, running balance, ledger display id where present.
- **Vault**: vault value (price and FMV totals); inside: vault cards with
  picture / qty / value (price + FMV), vault report.
- **Orders**: this player's rows from §1.3.
- **Pulls**: the relocated Pull Ledger table filtered to this player (D6).

Acceptance: list totals reconcile with economy route figures; disable switch
blocks storefront login (integration test); bank fields round-trip.

---

## 5. Transaction ledger (new)

### 5.1 Model

```
ledger_entry
  id (internal), display_id (unique, e.g. TP26Q3A0001),
  type: TP | SP | SE | OD | RF | AD | WP,
  customer_id, occurred_at,
  wallet_delta (MYR, signed, nullable), vault_delta (MYR, signed, nullable),
  payload (json: type-specific fields below), ref_id (source row id)
ledger_sequence
  scope (type+year+quarter, e.g. "TP-26-Q3"), last_serial (text, e.g. "a0413")
```

### 5.2 Display id generator

`<TYPE><YY><Q#><serial>`. Serial: letter block + 4 digits — `a0001…a9999 →
b0001 … z9999 → aa0001 → …` (base-26 letter prefix, digits reset per block).
Scoped per (type, year, quarter); allocated inside the writing transaction via
`SELECT … FOR UPDATE` on `ledger_sequence` (no gaps required, uniqueness
required). Pure-function serial successor + unit tests for the rollovers.

### 5.3 Writers (hook into existing workflows; go-forward per D4)

| Type          | Source                         | Payload                                | Affect                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | ------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TP top-up     | top-up workflow                | payment method, gateway ref            | wallet +                                                                                                                                                                                                                                                                                                                                                                   |
| SP spend      | open-pack charge               | channel, pack, prize SKU               | wallet −, vault + (pull value)                                                                                                                                                                                                                                                                                                                                             |
| SE sell       | buyback workflow               | handle, [SP id], price, rate, amount   | wallet +, vault −                                                                                                                                                                                                                                                                                                                                                          |
| OD order      | delivery order create + cancel | handles×qty, status timeline           | vault − at order CREATE (pulls flip to `delivering` and leave the vault immediately — matches the pull lifecycle); a reversing OD entry restores vault on cancel. wallet_delta = 0 for now: shipping-fee/insurance charging does NOT exist (`shipping_fee` is a reserved nullable column, never charged) and is out of scope — payload records fee fields when they exist. |
| RF referral   | weekly payout job (§6)         | period, spend total, %, amount         | wallet +                                                                                                                                                                                                                                                                                                                                                                   |
| AD adjustment | operator adjust-credits        | admin, reason, detail, card            | wallet ±                                                                                                                                                                                                                                                                                                                                                                   |
| WP challenge  | challenge settlement           | period, stage, rank, SKU/credit, value | vault + or wallet +                                                                                                                                                                                                                                                                                                                                                        |

One ledger write per source event, same DB transaction as the source write
(never a ledger row without its event or vice versa). Idempotent per
`(type, ref_id)` unique index.

### 5.4 Admin UI

**Transactions** page: type filter tabs, search by display id / player,
date range. Row: display id, type, player, occurred_at, Affect summary
("wallet −RM5,000, vault +RM4,000"), expandable payload. Read-only.

Acceptance: serial generator unit tests (a9999→b0001, z9999→aa0001, quarter
rollover); concurrency test (parallel writers, no duplicate display_id);
every writer covered by an integration test asserting the paired ledger row.

---

## 6. Referral redo (replace engine)

### 6.1 Sponsorship rules (mostly existing — verify + enforce)

- One referral handle entry, ever; sponsor permanent after confirm.
- No self-referral; no cycles (walk-up check on link).

### 6.2 Eligible spend

All **pack-opening spend**, full amount, regardless of funding source
(deposit, credit, promo, commission balance, buyback proceeds). Excludes
refunded / reversed / fraud / canceled / admin-voided opens. This replaces the
`external_funded_cents` deposit basis for **commissions** (VIP level basis
untouched — it already runs on full turnover since PR #254; the deposit-basis
**withdrawal gate** is also untouched — out of scope here).

### 6.3 Weekly settlement

- Week: **Sun 00:00 → Sat 23:59:59 MYT** (D9 — deliberately ≠ challenge week).
- Monday job (cron/worker):
  1. Per sponsor: `S = Σ eligible spend of direct referrals in week`.
  2. Tier: 0–9,999 → 1% · 10k–19,999 → 2% · 20k–39,999 → 3% ·
     40k–79,999 → 4% · 80k–159,999 → 5% · ≥160k → 7%. Rate applies to the
     **full** S (not marginal).
  3. Direct commission `C = S × rate` → credit wallet + RF ledger entry +
     `commission` row (kind `direct`).
  4. **Upline chain**: walking up from each earner, each ancestor receives
     20% of the commission earned by the person directly below them
     (C, C×0.2, C×0.04, …) until the amount < RM0.01. Kind `override`.
     Does not reduce the lower earner's commission.
- Idempotent: unique `(beneficiary, week_start, kind, source)` — a re-run
  cannot double-pay; partial failure creates nothing (single transaction per
  beneficiary chain).

### 6.4 Reversals / clawbacks

- Reversal **before** settlement: open drops out of the week's eligible spend.
- Reversal **after** payout: clawback of direct + upline commissions
  (negative credit rows + commission status `reversed`); may drive commission
  balance negative — future commissions settle the debt; week may re-tier →
  platform may recalculate the whole week at the corrected rate (admin-
  triggered recalc, not automatic).
- Admin can freeze / unfreeze / adjust / reverse an individual commission
  (extend `api/admin/commissions`).

### 6.5 Cutover + copy

- Old deposit-basis engine stops producing new commissions at a configured
  cutover week boundary; history preserved (D3). Mechanics (corrected —
  current engine is **per-open**, VIP-level ladder 1–5%, deposit basis, with
  `matures_at` maturity):
  - The per-open commission writer is disabled by a `site-settings` flag at
    the cutover boundary (config, not code deletion — instant rollback).
  - Commissions already `pending` at cutover mature naturally under the old
    rules; nothing is canceled.
  - The weekly engine **reuses** the existing `commission` model (kind
    `direct` for weekly direct, `override` for upline, `generation` =
    distance) and the existing credit reasons `direct_referral` /
    `team_override` / `commission_reversal`. Weekly rows are written already
    mature (`matures_at` = payout instant) — Monday payout IS the maturity
    gate.
- The doc's referral policy text (sponsorship, eligible spending, weekly
  period, tier table, upline, clawbacks, notes) ships as the storefront
  referral/invite info page copy, lightly edited.

Acceptance: tier table unit tests incl. boundaries (9,999.99 vs 10,000);
upline chain terminates < RM0.01 and sums correctly (doc example: 1,000 →
200 → 40 → 8); clawback integration test incl. negative balance; settlement
job re-run produces zero new rows.

---

## 7. Sequencing & risk

Order of implementation (each its own worktree branch + PR):

1. **Orders rework** (§1) — enum migration is the only risky bit; smallest
   blast radius, unblocks operator immediately.
2. **Players rework** (§4, minus wallet display-id column) — UI-heavy, reuses
   existing data; includes Pull Ledger relocation.
3. **Odds sets + EV/RTP + groups** (§2) — touches spin economics; needs the
   seeded-RNG integration tests before merge.
4. **Transaction ledger** (§5) — pure additive; wire writers one by one.
5. **Inventory + Purchasing** (§3) — largest net-new surface; depends on §1's
   status enum for bucket math.
6. **Referral redo** (§6) — depends on §5 (RF ledger entries) and is the
   highest-stakes money path; `/security-review` + `/code-review` mandatory
   before merge.

Cross-cutting rules: every money-path change gets unit tests on the pure math

- an http integration spec; hand-written migrations touching `bigNumber()`
  include the `raw_` column; admin edits respect the global-prettier-hook
  workaround for backend files; `medusa develop` local patch caveat applies.

## 8. Out of scope

- Storefront redesign, challenge mechanics changes, VIP level basis changes,
  withdrawal gate changes, carrier integration for shipping, historical
  ledger backfill, per-group pricing, shipping-fee/insurance charging on
  delivery orders (fields recorded when present; no wallet charge).
