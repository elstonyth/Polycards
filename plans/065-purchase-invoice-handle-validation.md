# Plan 065 (v2): Reject purchase-invoice lines whose card_handle matches no product

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a993f34a..HEAD -- backend/packages/api/src/api/admin/purchase-invoices/ backend/packages/api/src/workflows/steps/adjust-inventory-for-purchase.ts backend/packages/api/integration-tests/http/purchase-invoices.spec.ts backend/packages/api/integration-tests/http/inventory-buckets.spec.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M (v1 said S — raised: existing fixtures must be rewritten)
- **Risk**: LOW-MED
- **Depends on**: none
- **Category**: bug (cost-basis integrity)
- **Planned at**: commit `a993f34a`, 2026-08-01. **v2 2026-08-01**: refreshed
  after the v1 executor's investigative STOP — resolution source corrected to
  PRODUCT handles, scope widened to the two spec files whose fixtures post
  unbacked handles. The v1 executor's findings are folded into Current state.

## Why this matters

A purchase invoice (POLYCARD-BACK §3) records supplier receipts and drives the
weighted-average item cost (decision D8) plus one `stock_movement` audit row
per line. The route validates `card_handle` only as a non-empty string, and
the inventory-adjust step silently `continue`s when the handle resolves to
nothing — so a typo'd or stale handle posts a fully-successful 201 while the
cost basis and audit trail attach to a phantom key: the receipt is invisible
on the Inventory list (which keys on PRODUCT handles), on-hand never rises,
and nothing reports the mismatch. The sibling money route hard-fails an
unresolvable id (`from-pricecharting` rejects a bogus `pixel_pokemon_id`);
receipts should match that posture.

## Current state

Facts established by the v1 executor's read (verified, cite-checked):

- **The correct resolution table is PRODUCT, not Card.** The cost view keys
  purchase lines against product handles: `weightedAverageCostByHandle`
  (`service.ts:6818-6843`) matches raw `purchase_invoice_line.card_handle`
  against whatever handle set the caller supplies, and its only real caller
  `loadInventoryRows` (`inventory-view.ts:94-117`) supplies
  `products.map(p => p.handle)`. `inventory-view.ts:59-64` documents
  "a Product with NO Card row" as a legitimate state (the PriceCharting
  importer creates exactly that). `card-stock.ts` (docstring line 4:
  "Card.handle === Product.handle") resolves against `entity: 'product'`.
  A cards-only check would 400 legitimate receipts for imported-but-not-yet-
  gacha-registered products. **Validate against product handles.**
- Validation — `backend/packages/api/src/api/admin/purchase-invoices/validate.ts:107-116`:
  `card_handle` is a non-empty string ≤ MAX_TEXT, nothing more. Keep this
  file pure (shape-only); the existence check goes in the route.
- Route — `backend/packages/api/src/api/admin/purchase-invoices/route.ts:26`
  `POST` → validate → `createPurchaseInvoiceWorkflow`. The route's GET
  handler already uses `packs.listPurchaseInvoiceLines({ invoice_id: [...] })`
  (`route.ts:129-133`), so the reversal carve-out needs **no new service
  surface** (v1 executor confirmed).
- Adjust step — `backend/packages/api/src/workflows/steps/adjust-inventory-for-purchase.ts:26-30`:
  `if (!target) continue;` with no warn (the `logger.warn` below only fires
  on a thrown error).
- Exemplar for hard-fail-on-unresolvable —
  `backend/packages/api/src/api/admin/products/from-pricecharting/route.ts:184-196`
  (NOT_FOUND → `MedusaError.Types.INVALID_DATA` with a named-field message).
- **Fixture debt this plan must pay** (why v1 stopped): existing http specs
  post purchase-invoice lines whose handles back onto NOTHING —
  `integration-tests/http/purchase-invoices.spec.ts` (~17 tests, pure-string
  handles like `'charizard-psa-10'`, `'penny-common'`) and
  `integration-tests/http/inventory-buckets.spec.ts` (`buy(` at lines 81,
  197, 204 with `'lifecycle-card'`/`'reversed-card'`; line 197 is a plain
  non-reversal purchase, so the carve-out cannot rescue it). Both files must
  create backing products for the handles they buy. The convention already
  exists in siblings: `inventory-detail.spec.ts` (every `buy(` preceded by
  `makeProduct(` for the same handle) and `inventory-list.spec.ts`
  (`createProducts` before `POST /admin/purchase-invoices`) — copy their
  helper usage.
- Reversal invoices: body supports `reverses_invoice_id`; a reversal's lines
  mirror the original's handles. A product deleted AFTER the original
  purchase must not block its reversal.

## Commands you will need

| Purpose                          | Command                                                                                                        | Expected on success |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------- |
| Backend typecheck                | `cd backend && corepack yarn check-types`                                                                      | exit 0              |
| Unit tier                        | `cd backend/packages/api && corepack yarn test:unit -- purchase-invoices`                                      | all pass            |
| HTTP specs (docker DB)           | `cd backend/packages/api && corepack yarn test:integration:http purchase-invoices.spec inventory-buckets.spec` | all pass            |
| Neighbor http specs (regression) | `cd backend/packages/api && corepack yarn test:integration:http inventory-detail.spec inventory-list.spec`     | all pass            |

## Scope

**In scope**:

- `backend/packages/api/src/api/admin/purchase-invoices/route.ts` (existence check before the workflow)
- `backend/packages/api/src/workflows/steps/adjust-inventory-for-purchase.ts` (add the missing warn only)
- `backend/packages/api/integration-tests/http/purchase-invoices.spec.ts` (fixture products + new cases)
- `backend/packages/api/integration-tests/http/inventory-buckets.spec.ts` (fixture products only — no behavioral case changes)

**Out of scope**:

- `validate.ts` (stays shape-only).
- The workflow's warn-only inventory posture (`!target` stays non-fatal —
  post-check it means "product exists but isn't inventory-tracked", a
  legitimate state).
- `create-purchase-invoice-records.ts`, cost math, any admin-UI change.
- `inventory-detail.spec.ts` / `inventory-list.spec.ts` (already conformant —
  run them as regression only).

## Git workflow

- Branch: `advisor/065-invoice-handle-check`
- Two commits: (1) fixtures (`test(inventory): back purchase-invoice fixtures with real products`), (2) the check + warn + new cases (`fix(inventory): 400 purchase-invoice lines with unknown product handles`). Fixtures first so commit 2's red→green story is clean.
- Do NOT push or open a PR.

## Steps

### Step 1: Back the existing fixtures with products

In `purchase-invoices.spec.ts` and `inventory-buckets.spec.ts`, create a
backing product for every handle the specs `buy(`/post lines against, using
the same helper pattern as `inventory-list.spec.ts` (`createProducts`) or
`inventory-detail.spec.ts` (`makeProduct`) — whichever helper those files can
import or replicate most cheaply. Do NOT change what the tests assert.

**Verify**: `corepack yarn test:integration:http purchase-invoices.spec inventory-buckets.spec` → all existing tests still pass (this proves the fixtures are sufficient BEFORE the check exists).

### Step 2: Existence check at the route

In `purchase-invoices/route.ts` POST, after body validation, before the
workflow: collect distinct `card_handle`s and resolve them in ONE batched
PRODUCT query — use the same access path the specs/loader use
(`productModule.listProducts({ handle: [...] })`; resolve the product module
the way `inventory-view.ts` does). Unknown handles → throw
`MedusaError.Types.INVALID_DATA` naming every offender with its line index
(match the from-pricecharting message style).

**Reversal carve-out**: when `reverses_invoice_id` is set, validate against
(product handles) ∪ (handles on the reversed invoice's lines via
`packs.listPurchaseInvoiceLines({ invoice_id: [reverses_invoice_id] })`).

**Verify**: `cd backend && corepack yarn check-types` → exit 0.

### Step 3: Make the untracked branch visible

In `adjust-inventory-for-purchase.ts`, keep the `continue` but add
`logger.warn('adjust-inventory-for-purchase: no inventory target for <handle> — counter not raised (untracked product).')`.

**Verify**: typecheck → exit 0.

### Step 4: New integration cases

In `purchase-invoices.spec.ts`:

1. POST with one unknown handle among valid lines → 400, message names the
   index and handle, NO invoice/lines/stock_movement rows written.
2. All-valid POST → 201 (existing happy path, now product-backed, still green).
3. Reversal referencing an original whose product has been deleted → still
   accepted (the carve-out). If product deletion is awkward in the harness,
   soft-delete via the product module or construct the original with a
   product you then remove; if neither is feasible, STOP and report the
   harness limitation rather than skipping the case silently.

**Verify**: `corepack yarn test:integration:http purchase-invoices.spec inventory-buckets.spec` → all pass incl. new cases; then the neighbor regression pair; then `corepack yarn test:unit -- purchase-invoices` → unchanged, passes.

## Done criteria

- [ ] Unknown-handle POST returns 400 and writes nothing (case 1 green)
- [ ] Reversal carve-out case green (or STOPPED with the harness limitation named)
- [ ] `grep -n "no inventory target" backend/packages/api/src/workflows/steps/adjust-inventory-for-purchase.ts` → match
- [ ] All four http spec files green; `cd backend && corepack yarn check-types` exit 0; unit tier passes
- [ ] No files outside the in-scope list modified

## STOP conditions

Stop and report if:

- Step 1's fixture work reveals a spec that DELIBERATELY tests unbacked-handle
  purchases as a product behavior (not fixture laziness) — name it; that would
  mean the 400 posture needs an operator decision.
- `listProducts({ handle: [...] })` doesn't accept an array (check
  `inventory-view.ts:94-100` usage first).
- The reversal case cannot be constructed in the harness (report the
  limitation, keep cases 1–2).
- Fixture creation makes an existing assertion fail for a REASON OTHER than
  the new check (would mean the fixtures change aggregate numbers — report
  which assertion).

## Maintenance notes

- The check validates PRODUCT existence. A product with no Card row is
  accepted by design (PriceCharting import flow); the adjust step's warn now
  makes the untracked case visible in logs.
- If bulk imports ever create products asynchronously, a receipt can race the
  check — the 400 tells the operator to retry; acceptable.
- Reviewer scrutiny: ONE batched query, not per-line; the carve-out union
  must not weaken validation for non-reversal invoices; commit 1 (fixtures)
  must be green on its own BEFORE commit 2 lands.
