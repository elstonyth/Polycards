# Stock GRN + Procurement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Physical "On hand" stock, a Goods Receive Note (GRN) with transfer to purchase invoice, split order buckets with Qty to be procured, and delivery orders that move to processed / ready to ship by themselves (oldest first).

**Architecture:** The packs module gets two new tables (GRN header + lines) and one new column (`purchase_invoice.from_grn_id`). On hand is computed from receipts (GRN lines + non-GRN invoice lines) minus shipped units. The old Medusa stock counter is NOT changed. A pure `allocateStock` function decides which orders become ready to ship; a runner applies it through the existing `transitionDeliveryOrderStatus` seam, from a 00:00 MYT job and after every GRN / invoice save. Admin gets the new columns, GRN pages, a transfer button on the invoice form and a Procurement page.

**Tech Stack:** Medusa v2 module (MikroORM, hand-written migrations), Mercur admin (React, @medusajs/ui, react-query, i18n en + zhCN), jest (unit + http integration), vitest (admin).

**Spec:** `docs/superpowers/specs/2026-10-28-stock-grn-procurement-design.md`

## Global Constraints

- Do not change `modules/packs/card-stock.ts` or any caller of `getCardStockByHandle` / `takeCardStock`. The Medusa counter keeps its current meaning.
- A GRN adds to the Medusa counter exactly like an invoice does today (`adjustInventoryForPurchaseStep`). An invoice with `from_grn_id` never touches the counter.
- GRN and invoice records are immutable to operators. Corrections are reversal records.
- Money in MYR as `bigNumber`. Quantities are signed integers; the sign lives in `qty` only.
- Display numbers: `GRN-00001` from Postgres sequence `goods_receive_note_seq`.
- Admin strings go through i18n with both `en.json` and `zhCN.json` keys.
- Migrations are hand-written in `modules/packs/migrations/`, and each is pinned by a unit spec. Do not commit `db:generate` output.
- Column order on the Stock page: Qty to be procured, On hand, In vault, Requested + processed, Ready to ship, Shipped.
- Requested + processed = order statuses `requested`, `processed`, legacy `packing`. Ready to ship = `ready_to_ship`. Shipped = `shipped`, `completed`, legacy `delivered`.
- `to_procure = max(0, requested_processed + ready_to_ship − on_hand)`.
- 00:00 MYT = cron `0 16 * * *` (UTC).

## Review Focus

1. One order holding two units of the same card: allocation counts per unit, not per distinct card. Pin it in Task 5.
2. Reversing an invoice that was transferred from a GRN must not lower On hand. Pin it in Task 4.
3. Two allocation runs at once (job + an invoice save) must not move one order twice. If an order already moved, the second run skips it without failing the request. Pin it in Task 6.
4. A canceled order releases its units. A canceled order is not an open order, so it is never counted. Pin it in Task 5.
5. A GRN for a product that has no Medusa inventory level (an untracked product): the save must still succeed and still count toward On hand. The invoice path behaves the same way today. Pin it in Task 3.

---

### Task 1: Schema — GRN tables, `from_grn_id`, enum widening

**Files:**
- Create: `backend/packages/api/src/modules/packs/models/goods-receive-note.ts`, `goods-receive-note-line.ts`
- Modify: `models/purchase-invoice.ts` (add `from_grn_id: model.text().nullable()`), `models/stock-movement.ts` (add kind `'goods_receive'`), `models/admin-action-audit.ts` (entity type `'goods_receive_note'`), `modules/packs/service.ts` (register both models in the MedusaService map)
- Create: `migrations/Migration20261028120000.ts` + `migrations/__tests__/goods-receive-note.unit.spec.ts`

**Interfaces — Produces:**
- `goods_receive_note { id, display_no, date, supplier, agent_user_id, reverses_grn_id|null }`
- `goods_receive_note_line { id, grn_id, card_handle, card_name, fmv_snapshot (bigNumber), qty (int, signed) }`
- `purchase_invoice.from_grn_id text null`
- Partial unique index `IDX_purchase_invoice_from_grn_unique` on `(from_grn_id)` `WHERE deleted_at IS NULL AND from_grn_id IS NOT NULL AND reverses_invoice_id IS NULL`
- Partial unique index `IDX_goods_receive_note_reverses_unique` on `(reverses_grn_id)` `WHERE deleted_at IS NULL AND reverses_grn_id IS NOT NULL`
- Generated service methods: `createGoodsReceiveNotes`, `listGoodsReceiveNotes`, `listAndCountGoodsReceiveNotes`, `createGoodsReceiveNoteLines`, `listGoodsReceiveNoteLines`, `deleteGoodsReceiveNotes`, `deleteGoodsReceiveNoteLines`

- [ ] **Step 1: Write the migration spec.** Capture `addSql` and assert: both tables are created, `goods_receive_note_seq` is created, the `from_grn_id` column and both partial unique indexes exist, the `stock_movement_kind_check` list contains `'goods_receive'`, and the `admin_action_audit_entity_type_check` list equals the latest list on master plus `'goods_receive_note'`. Read the latest list from the newest migration that redefines that constraint; do not copy it from Migration20260729010000. `down()` refuses while GRN rows exist.
- [ ] **Step 2:** Run `corepack yarn test:unit src/modules/packs/migrations/__tests__/goods-receive-note.unit.spec.ts`. Expect FAIL.
- [ ] **Step 3:** Write the models and the migration (same shape as Migration20260729010000).
- [ ] **Step 4:** Run the spec. Expect PASS. Run api `tsc --noEmit`. Expect clean.
- [ ] **Step 5:** Commit `feat(stock): GRN tables and invoice from_grn_id`.

### Task 2: Physical On hand + bucket split

**Files:**
- Modify: `modules/packs/service.ts` — `inventoryLifecycleBuckets` returns `{ inVault, requested, readyToShip, shipped }`; `requested` narrows to `requested`/`processed`/`packing`; shipped adds `delivered`. New `@InjectManager() receivedQtyByHandle(handles): Promise<Map<string, number>>` = Σ GRN line qty (GRN not deleted) + Σ invoice line qty where the invoice's `from_grn_id IS NULL`.
- Create: `modules/packs/stock-math.ts` exporting `toProcure(onHand: number, requested: number, readyToShip: number): number`
- Modify: `modules/packs/inventory-view.ts` — `InventoryRow` gets `on_hand: number` (received − shipped, never null), `ready_to_ship`, `to_procure`. Remove the counter read from this file.
- Modify: `api/admin/inventory/export.xlsx/route.ts` + `__tests__/columns.unit.spec.ts`. Columns follow the global order.
- Modify: `api/admin/inventory/[handle]/route.ts` if it reshapes the buckets.
- Test: `modules/packs/__tests__/stock-math.unit.spec.ts`, `integration-tests/http/inventory-buckets.spec.ts`, `inventory-list.spec.ts`, `inventory-detail.spec.ts`

- [ ] **Step 1: Failing tests.**
  - `toProcure(0,3,0)===3`, `toProcure(5,3,1)===0`, `toProcure(2,3,1)===2`, `toProcure(-1,1,0)===2`.
  - inventory-buckets: an order in `ready_to_ship` counts in `readyToShip` and not in `requested`.
  - inventory-list: a handle with a 5-qty invoice, one vaulted pull and one shipped order has `on_hand 4`, `in_vault 1`, `to_procure 0`. A vaulted pull does not lower `on_hand`.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement. Keep the queries sequential (the pool-full rule in the existing code).
- [ ] **Step 4:** Run unit + the three http specs (`node integration-tests/run-http-shards.mjs inventory-buckets inventory-list inventory-detail`). Expect PASS.
- [ ] **Step 5:** Commit `feat(stock): physical on hand, ready-to-ship and to-procure columns`.

### Task 3: GRN service, workflow, routes

**Files:**
- Modify: `modules/packs/service.ts` — `createGoodsReceiveNoteWithLines(input: { date: string; supplier: string; agent_user_id: string; reverses_grn_id: string | null; lines: { card_handle; card_name; fmv_snapshot: number; qty: number }[] })`. It does nextval, the header, the lines, one `goods_receive` stock_movement per line, and an audit row (`entity_type 'goods_receive_note'`, action `'create'`). Add `deleteGoodsReceiveNoteCascade(id)`, used by compensation only.
- Create: `workflows/create-goods-receive-note.ts` (records step, then `adjustInventoryForPurchaseStep({ lines })`)
- Create: `api/admin/goods-receive-notes/route.ts` (GET paged list with `status: 'open'|'transferred'|'reversed'` and `invoice_display_no`; POST create), `[id]/route.ts` (GET detail with lines + transfer/reversal info), `[id]/reverse/route.ts` (POST: full mirror of an untransferred, unreversed GRN), `validate.ts` (`coerceCreateGoodsReceiveNoteBody`: same limits as the invoice validator, qty > 0, fmv ≥ 0 with 2 dp, supplier 1–200 chars)
- Modify: `api/admin-rbac.ts` (`'goods-receive-notes': 'goods_receive_note'`), `api/middlewares.ts` (rate-limit POST `/admin/goods-receive-notes` and `/admin/goods-receive-notes/*/reverse`)
- Test: `api/admin/goods-receive-notes/__tests__/validate.unit.spec.ts`, `integration-tests/http/goods-receive-notes.spec.ts`

**Interfaces — Produces:** `POST /admin/goods-receive-notes` → `{ goods_receive_note: { id, display_no, lines } }`; `GET /admin/goods-receive-notes?status=open` used by Task 8's picker.

- [ ] **Step 1: Failing tests.**
  - Create returns `GRN-0000n`. On hand rises by qty. The Medusa counter rises by qty.
  - A product with no inventory level still saves (Review Focus 5).
  - Reverse: On hand returns to its old value; reversing twice → 400; reversing a transferred GRN → 400.
  - Status in the list is `open` / `reversed`.
  - Validator rejects qty 0, negative fmv and an empty supplier.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement. Mirror `purchase-invoices/route.ts`: product-handle check, actor from `req.auth_context.actor_id`.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5:** Commit `feat(stock): goods receive notes`.

### Task 4: Invoice "transfer from GRN"

**Files:**
- Modify: `api/admin/purchase-invoices/validate.ts` (optional `from_grn_id`, not allowed together with `reverses_invoice_id`), `route.ts` POST:
  - The GRN must exist, must not be reversed and must not be transferred.
  - The body's lines must equal the GRN lines as a multiset of `(card_handle, qty)`; the error names the first mismatch.
  - Supplier defaults to the GRN's.
  - A reversal of an invoice inherits its `from_grn_id`.
  - GET list/detail add `from_grn_id` + `from_grn_display_no`.
- Modify: `workflows/create-purchase-invoice.ts` — skip `adjustInventoryForPurchaseStep` when `from_grn_id` is set (`when()` from workflows-sdk). `service.createPurchaseInvoiceWithLines` stores `from_grn_id`. A unique-index violation maps to 409 "This goods receive note was already transferred."
- Test: extend `validate.unit.spec.ts` and `integration-tests/http/purchase-invoices.spec.ts`

- [ ] **Step 1: Failing tests.**
  - Transfer: On hand unchanged, Medusa counter unchanged, weighted cost = the typed unit cost, GRN status → `transferred` with the PI number.
  - A second transfer → 409.
  - Mismatched qty → 400.
  - Reversing the transferred invoice leaves On hand unchanged (Review Focus 2).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(stock): transfer a goods receive note into a purchase invoice`.

### Task 5: `allocateStock` (pure)

**Files:**
- Create: `modules/packs/stock-allocation.ts`
- Test: `modules/packs/__tests__/stock-allocation.unit.spec.ts`

**Interfaces — Produces:**
```ts
export type AllocOrder = { id: string; status: string; created_at: Date; handles: string[] }; // one handle per pull
export type AllocResult = { ready: string[]; short: string[] }; // order ids, oldest first
export function allocateStock(onHand: Map<string, number>, orders: AllocOrder[]): AllocResult;
```
Rules: `ready_to_ship` orders take their units first and are never in the result. Then `requested`/`processed`/`packing` orders go oldest `created_at` first (id as the tie-break). An order is `ready` only when free stock covers every unit. Otherwise it is `short` and still takes `min(free, need)` per handle (strict FIFO). Other statuses are ignored. Missing handles count as 0.

- [ ] **Step 1: Failing tests.**
  - Oldest wins a single unit.
  - A partially covered old order blocks a newer order for the same card, but not a newer order for a different card.
  - An order with 2× the same handle needs 2 (Review Focus 1).
  - A ready_to_ship order holds its units.
  - Canceled and shipped orders are ignored (Review Focus 4).
  - Negative on hand → treated as 0 free.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(stock): oldest-first allocation`.

### Task 6: Allocation runner + 00:00 job + post-save trigger

**Files:**
- Modify: `modules/packs/service.ts` — `openDeliveryOrdersForAllocation(): Promise<AllocOrder[]>`. One SQL over open statuses joined to items → pulls, `deleted_at IS NULL` everywhere.
- Create: `modules/packs/stock-allocation-run.ts` — `runStockAllocation(container, opts: { nightly: boolean }): Promise<{ ready: string[]; processed: string[]; failed: string[] }>`:
  - Loads the orders, On hand for their handles (Task 2's math) and `allocateStock`.
  - For each `ready` order: from `requested`, first → `processed`; then → `ready_to_ship`.
  - When `nightly`: each `short` order still in `requested` → `processed`.
  - Every move goes through `packs.transitionDeliveryOrderStatus({ orderId, to, trackingNumber: null, pullIds: [], audit: { adminId: 'system:stock-allocation', action: 'bulk_status', reason } })`, then `notifyDeliveryChange`.
  - A thrown error on one order is logged, added to `failed`, and the run continues (Review Focus 3).
  - Shortcut comment: there is no cross-run lock; this is safe because the transition seam re-reads status under its own lock. Upgrade if allocation ever writes anything besides status.
- Create: `jobs/stock-allocation.ts` (`schedule: '0 16 * * *'`, `nightly: true`)
- Modify: GRN create + reverse and invoice create routes call `runStockAllocation(req.scope, { nightly: false })` after the workflow commits. A runner error is logged, never thrown to the caller.
- Test: `integration-tests/http/stock-allocation.spec.ts`

- [ ] **Step 1: Failing tests.**
  - Two requested orders for one card plus a GRN of 1 → only the older one becomes `ready_to_ship`.
  - The nightly run moves the other one to `processed`.
  - Two concurrent runs leave both orders in valid states with no 500 (Review Focus 3).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(orders): orders move to processed / ready to ship by themselves`.

### Task 7: Procurement endpoints

**Files:**
- Create: `api/admin/procurement/to-buy/route.ts`:
  - Returns `{ rows: { handle, name, sku, photo, to_procure, on_hand, requested, ready_to_ship, fmv, oldest_order_at }[] }`, only rows where `to_procure ≥ 1`.
  - Sorted by `oldest_order_at` ascending.
  - `oldest_order_at` = the earliest open order needing that handle.
- Create: `api/admin/procurement/to-ship/route.ts`:
  - Returns `{ orders: { id, created_at, customer_id, customer_name, ship_* snapshot, items: { handle, name, qty }[] }[] }` for `ready_to_ship`, oldest first.
- Modify: `api/admin-rbac.ts` (`procurement: 'procurement'`)
- Test: `integration-tests/http/procurement.spec.ts` (ordering, filter, shape)

- [ ] Steps 1–5 as above. Commit `feat(stock): to-buy and to-ship lists`.

### Task 8: Admin UI

**Files:**
- Modify: `backend/apps/admin/src/routes/inventory/list/page.tsx` + `[handle]/page.tsx`
  - Six columns in the global order, all sortable.
  - `to_procure > 0` and negative `on_hand` show in the error colour.
- Create: `routes/goods-receive-notes/page.tsx`
  - `nested: '/inventory/list'`, `rank: 2`. Bump `purchase-invoices` to `rank: 3`.
  - List with a status badge.
- Create: `routes/goods-receive-notes/new/page.tsx`
  - Same card search as the invoice form; no unit cost.
- Create: `routes/goods-receive-notes/[id]/page.tsx`
  - Lines and status.
  - "Transfer to purchase invoice" → `/purchase-invoices/new?from_grn=<id>`.
  - "Reverse" button behind a confirm.
- Modify: `routes/purchase-invoices/new/page.tsx`
  - A "Transfer from goods receive note" button opens a picker over `GET /admin/goods-receive-notes?status=open`. `?from_grn=` preselects.
  - Picking prefills the lines and locks card + qty; only unit cost stays editable.
  - Sends `from_grn_id`.
- Modify: `routes/purchase-invoices/page.tsx` + `[id]/page.tsx`
  - "From GRN-0000n" badge.
- Create: `routes/procurement/page.tsx`
  - `nested: '/inventory/list'`, `rank: 4`.
  - Two tables (To buy, To ship).
- Modify: `lib/admin-rest.ts`, `lib/queries.ts`, `lib/query-keys.ts`, `lib/purchase-invoice-form.ts` (GRN prefill helper), `i18n/en.json`, `i18n/zhCN.json`, `_navigation.ts` / `nav-contract.test.ts` if they pin entries.
- Test: `lib/purchase-invoice-form.test.ts` (prefill from GRN locks qty), `lib/query-keys.test.ts`

- [ ] **Step 1:** Write the vitest tests for the prefill helper. Expect FAIL.
- [ ] **Step 2:** Implement the helper + pages.
- [ ] **Step 3:** Run admin vitest + `node ../../node_modules/typescript/bin/tsc -b` + eslint. Expect clean.
- [ ] **Step 4:** Commit `feat(admin): GRN pages, invoice transfer, procurement lists, new stock columns`.

### Task 9: Local verification

- [ ] Run the api unit tier on the touched paths and every new or changed http spec.
- [ ] Ask the operator once before local `db:migrate`, then run `node node_modules/@medusajs/cli/cli.js db:migrate`. Check `mikro_orm_migrations`.
- [ ] Start backend `:9100` (`MEDUSA_WORKER_MODE=server`) and admin vite `:7000` from the worktree.
- [ ] Mint a QA admin JWT and take Playwright screenshots in `docs/research/` of: the Stock list, GRN new → detail → transfer → PI detail, and the Procurement page, at a tall viewport.
- [ ] Walk the operator through the scenario in chat: request an order → GRN → order becomes ready to ship.
