# POLYCARD-BACK Epic 1 — Orders Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename Deliveries → All Orders with the operator's 6-state shipping pipeline (`requested → processed → ready_to_ship → shipped → completed`, + `canceled`), bulk mark-as + print tools, a pack-purchases tab, and a player-info detail view.

**Architecture:** The delivery-order status enum is renamed/extended in one backend slice (`modules/packs/delivery.ts` is the single source of truth; every consumer imports from it), with a data migration mapping old values. A new bulk-status admin endpoint wraps the existing per-order workflow. The admin page is reworked in place (`routes/deliveries/`, URL unchanged) with tabs, bulk bar, and a print route. Pack purchases reuse the existing admin pulls endpoint — no ledger dependency.

**Tech Stack:** Medusa v2 module (MikroORM models, hand-written migrations), Jest (backend unit + http shards), Next.js storefront (vitest), Mercur admin (Vite + @medusajs/ui + react-query), Playwright e2e.

**Spec:** `plans/058-polycard-back-admin-overhaul.md` §1 (decisions D5; F4/F5/F11 corrections applied — no wallet charge, vault math untouched here, pack tab from existing pull data).

## Global Constraints

- **CRITICAL — pull enum vs delivery enum:** `pull.status` (`vaulted | bought_back | delivering | delivered`) is a DIFFERENT enum and does **NOT** change. Only `delivery_order.status` renames. When a delivery order completes, its pulls still flip to pull-status `delivered`.
- **Backend `.ts` edit trap:** a global formatter hook rewrites backend double-quotes to single quotes on every Edit/Write, burying changes in whole-file churn that fails CI's format check. Edit files under `backend/` by writing a small node script and running it via Bash (read file → targeted string replace → write), or make edits and immediately `git diff` to confirm only intended lines changed; if churn appears, revert and use the node-script path.
- Old→new status mapping (use everywhere, verbatim): `requested→requested`, `packing→processed`, `delivered→completed`, `shipped→shipped`, `canceled→canceled`; `ready_to_ship` is net-new between `processed` and `shipped`.
- Timestamps: columns `shipped_at` / `delivered_at` keep their names; `delivered_at` now means "completed at" (comment only, no column rename).
- Customer-facing copy still says "delivered" for the `completed` status — players read "delivered", operators read "Completed".
- Cancel is legal from `requested`, `processed`, `ready_to_ship` (anything pre-ship), both operator and customer side. `shipped → completed` is the only post-ship transition; tracking number still required to reach `shipped`.
- Bulk endpoint caps at 100 ids (precedent: plan 018 delivery batch cap).
- Commands: backend unit tests `corepack yarn test:unit` (from `backend/packages/api`); single http spec `NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http npx jest integration-tests/http/<name>.spec.ts --runInBand --forceExit` (needs `pokenic-postgres` docker up); backend types `corepack yarn check-types`; storefront `npm test` / `npm run check` (repo root); admin `corepack yarn build` + `corepack yarn lint` (from `backend/apps/admin`).
- Work in a worktree (superpowers:using-git-worktrees, consent pre-granted): `EnterWorktree` or `git worktree add .worktrees/epic1-orders -b feat/epic1-orders`; run `npm install` in it; copy `backend/packages/api/.env` in (missing .env = KnexTimeout).
- Conventional commits. Branch PRs from `origin/master`.

---

### Task 1: Status enum + transition rules in `delivery.ts`

**Files:**
- Modify: `backend/packages/api/src/modules/packs/delivery.ts:3-9` (DELIVERY_STATUSES), `:67-73` (ALLOWED)
- Test: `backend/packages/api/src/modules/packs/__tests__/delivery.unit.spec.ts`

**Interfaces:**
- Consumes: nothing (root of the slice).
- Produces: `DELIVERY_STATUSES` array and `DeliveryStatus` union = `'requested' | 'processed' | 'ready_to_ship' | 'shipped' | 'completed' | 'canceled'`; `validateDeliveryStatusTransition(from, to, hasTracking)` unchanged signature. Every later task imports these.

- [ ] **Step 1: Update the unit test to the new pipeline (failing first)**

In `delivery.unit.spec.ts`, replace every status-transition case with the new pipeline and add the new edges. The describe block for transitions must contain exactly these expectations (merge into the file's existing style — it already tests `validateDeliveryStatusTransition`):

```ts
// Happy path — full pipeline
expect(validateDeliveryStatusTransition('requested', 'processed', false)).toBe('ok');
expect(validateDeliveryStatusTransition('processed', 'ready_to_ship', false)).toBe('ok');
expect(validateDeliveryStatusTransition('ready_to_ship', 'shipped', true)).toBe('ok');
expect(validateDeliveryStatusTransition('shipped', 'completed', false)).toBe('ok');

// Tracking gate unchanged
expect(validateDeliveryStatusTransition('ready_to_ship', 'shipped', false)).toBe('tracking_required');

// Cancel legal from every pre-ship state
expect(validateDeliveryStatusTransition('requested', 'canceled', false)).toBe('ok');
expect(validateDeliveryStatusTransition('processed', 'canceled', false)).toBe('ok');
expect(validateDeliveryStatusTransition('ready_to_ship', 'canceled', false)).toBe('ok');

// Illegal
expect(validateDeliveryStatusTransition('shipped', 'canceled', false)).toBe('invalid_transition');
expect(validateDeliveryStatusTransition('completed', 'canceled', false)).toBe('invalid_transition');
expect(validateDeliveryStatusTransition('requested', 'shipped', true)).toBe('invalid_transition');
expect(validateDeliveryStatusTransition('completed', 'shipped', true)).toBe('invalid_transition');
expect(validateDeliveryStatusTransition('canceled', 'requested', false)).toBe('invalid_transition');
```

- [ ] **Step 2: Run to verify failure**

Run (from `backend/packages/api`): `corepack yarn test:unit --testPathPattern delivery.unit`
Expected: FAIL — TS errors on `'processed'` etc. not assignable to `DeliveryStatus`.

- [ ] **Step 3: Implement in `delivery.ts`**

Replace the two blocks (keep the file's existing quote style; see the backend-edit trap in Global Constraints):

```ts
export const DELIVERY_STATUSES = [
  "requested",
  "processed",
  "ready_to_ship",
  "shipped",
  "completed",
  "canceled",
] as const;
```

```ts
// Allowed admin transitions. Cancel is only legal before the parcel ships
// (a shipped parcel can't revert to the vault). completed/canceled are terminal.
const ALLOWED: Record<DeliveryStatus, DeliveryStatus[]> = {
  requested: ["processed", "canceled"],
  processed: ["ready_to_ship", "canceled"],
  ready_to_ship: ["shipped", "canceled"],
  shipped: ["completed"],
  completed: [],
  canceled: [],
};
```

`validateDeliveryStatusTransition` body is unchanged (the `to === "shipped"` tracking check stays).

- [ ] **Step 4: Run to verify pass**

Run: `corepack yarn test:unit --testPathPattern delivery.unit`
Expected: PASS. (Other suites will now fail typecheck — that's Tasks 2–3.)

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/modules/packs/delivery.ts backend/packages/api/src/modules/packs/__tests__/delivery.unit.spec.ts
git commit -m "feat(orders): new delivery status pipeline in delivery.ts"
```

---

### Task 2: Model enum, data migration, service transition writes

**Files:**
- Modify: `backend/packages/api/src/modules/packs/models/delivery-order.ts:12-14`
- Create: `backend/packages/api/src/modules/packs/migrations/Migration20260727000000.ts`
- Modify: `backend/packages/api/src/modules/packs/service.ts:3320-3350` (`transitionDeliveryOrderStatus`)
- Test: `backend/packages/api/src/modules/packs/__tests__/delivery-transition-atomic.unit.spec.ts`

**Interfaces:**
- Consumes: `DeliveryStatus` from Task 1.
- Produces: DB column accepts the six new values (old rows mapped); `transitionDeliveryOrderStatus({ orderId, to, trackingNumber, proofImages, pullIds })` — same signature, new semantics: `to='completed'` stamps `delivered_at` and flips pulls to pull-status `'delivered'`; `to='canceled'` re-vaults pulls; `to='shipped'` stamps `shipped_at`.

- [ ] **Step 1: Update `delivery-transition-atomic.unit.spec.ts` (failing first)**

Rename status literals per the mapping (`packing→processed`, `delivered→completed`) throughout the spec. Any case asserting pull side-effects must expect: order `completed` ⇒ pulls updated to `'delivered'` (pull enum, unchanged); order `canceled` ⇒ pulls to `'vaulted'`.

- [ ] **Step 2: Run to verify failure**

Run: `corepack yarn test:unit --testPathPattern delivery-transition-atomic`
Expected: FAIL (service still checks `'delivered'` on the order side).

- [ ] **Step 3: Update the model enum**

In `models/delivery-order.ts`:

```ts
status: model
  .enum(["requested", "processed", "ready_to_ship", "shipped", "completed", "canceled"])
  .default("requested"),
```

- [ ] **Step 4: Write the migration**

Create `Migration20260727000000.ts` (copy the class shape from `Migration20260723000000.ts` in the same directory — Migration subclass with `up()`/`down()` executing raw SQL):

```ts
import { Migration } from '@mikro-orm/migrations';

// Delivery pipeline rename (POLYCARD-BACK §1.2): packing→processed,
// delivered→completed, new ready_to_ship. Old check constraint (if any) is
// dropped first; enum values live in a CHECK on the text column.
export class Migration20260727000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table if exists "delivery_order" drop constraint if exists "delivery_order_status_check";`);
    this.addSql(`update "delivery_order" set "status" = 'processed' where "status" = 'packing';`);
    this.addSql(`update "delivery_order" set "status" = 'completed' where "status" = 'delivered';`);
    this.addSql(`alter table if exists "delivery_order" add constraint "delivery_order_status_check" check ("status" in ('requested','processed','ready_to_ship','shipped','completed','canceled'));`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "delivery_order" drop constraint if exists "delivery_order_status_check";`);
    this.addSql(`update "delivery_order" set "status" = 'packing' where "status" = 'processed';`);
    this.addSql(`update "delivery_order" set "status" = 'shipped' where "status" = 'ready_to_ship';`);
    this.addSql(`update "delivery_order" set "status" = 'delivered' where "status" = 'completed';`);
    this.addSql(`alter table if exists "delivery_order" add constraint "delivery_order_status_check" check ("status" in ('requested','packing','shipped','delivered','canceled'));`);
  }
}
```

Before finalizing, check the actual constraint name the schema uses: `docker exec pokenic-postgres psql -U postgres -d medusa -c "\d delivery_order"` — if the CHECK constraint has a different generated name (or the column has none), adjust the drop line to that name (keep `if exists`).

- [ ] **Step 5: Update `service.ts` `transitionDeliveryOrderStatus`**

In the patch/side-effect section (lines ~3330-3350), apply exactly:
- `if (input.to === 'shipped') patch.shipped_at = new Date();` — unchanged.
- `if (input.to === 'delivered')` → `if (input.to === 'completed')` (still sets `patch.delivered_at` — add comment `// delivered_at doubles as completed_at post-rename`).
- The pull-flip condition `(input.to === 'delivered' || input.to === 'canceled')` → `(input.to === 'completed' || input.to === 'canceled')`.
- The pull target `input.to === 'delivered' ? 'delivered' : 'vaulted'` → `input.to === 'completed' ? 'delivered' : 'vaulted'` (right side stays `'delivered'` — that's the PULL enum).
- Update any comment naming the old statuses in this method.

- [ ] **Step 6: Run to verify pass + migrate locally**

Run: `corepack yarn test:unit --testPathPattern delivery-transition-atomic`
Expected: PASS.
Run: `npx medusa db:migrate` (from `backend/packages/api`, with `pokenic-postgres` up).
Expected: migration applies cleanly. Verify mapping: `docker exec pokenic-postgres psql -U postgres -d medusa -c "select status, count(*) from delivery_order group by 1;"` — no `packing`/`delivered` rows remain.

- [ ] **Step 7: Commit**

```bash
git add backend/packages/api/src/modules/packs/models/delivery-order.ts backend/packages/api/src/modules/packs/migrations/Migration20260727000000.ts backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/modules/packs/__tests__/delivery-transition-atomic.unit.spec.ts
git commit -m "feat(orders): delivery_order status enum migration + transition writes"
```

---

### Task 3: Backend consumers — notifications, workflow step, cancel route, probe script

**Files:**
- Modify: `backend/packages/api/src/modules/packs/feed-events.ts:7-14`
- Modify: `backend/packages/api/src/workflows/steps/update-delivery-order.ts:126-129`
- Modify: `backend/packages/api/src/api/store/delivery-orders/[id]/cancel/route.ts:38-43`
- Modify: `backend/packages/api/src/scripts/seed-notification-probe.ts` (status literals)
- Test: `backend/packages/api/src/modules/packs/__tests__/feed-events.unit.spec.ts`, `backend/packages/api/src/api/admin/delivery-orders/__tests__/delivery-notify.unit.spec.ts`, `backend/packages/api/src/api/store/delivery-orders/[id]/__tests__/cancel.unit.spec.ts`

**Interfaces:**
- Consumes: `DeliveryStatus` (Task 1), service semantics (Task 2).
- Produces: `shouldNotifyDeliveryStatus(from, to)` notifies on `shipped | completed | canceled` only; customer cancel allowed while `requested | processed | ready_to_ship`.

- [ ] **Step 1: Update the three unit specs (failing first)**

- `feed-events.unit.spec.ts`: notify-worthy set = `shipped`, `completed`, `canceled`; NOT `processed`, NOT `ready_to_ship` (replace the old `packing` non-notify case with both).
- `delivery-notify.unit.spec.ts`: rename literals per mapping.
- `cancel.unit.spec.ts`: cancelable from `requested`, `processed`, AND `ready_to_ship`; rejected from `shipped`, `completed`, `canceled`.

- [ ] **Step 2: Run to verify failure**

Run: `corepack yarn test:unit --testPathPattern "feed-events|delivery-notify|cancel.unit"`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `feed-events.ts`: notify list becomes `['shipped', 'completed', 'canceled']`; update the comment — `processed`/`ready_to_ship` are operator back-office steps, deliberately silent (same rationale as old `packing`).
- `update-delivery-order.ts` step: `(input.status === 'delivered' || input.status === 'canceled')` → `(input.status === 'completed' || input.status === 'canceled')` in the `prevPullStatus` condition (line ~127). The `CompensateData.prevPullStatus` type `'delivering' | 'delivered' | null` refers to PULL statuses — unchanged.
- `cancel/route.ts`: guard becomes

```ts
const CANCELABLE = ['requested', 'processed', 'ready_to_ship'];
if (!CANCELABLE.includes(order.status)) {
```

  keeping the existing error-copy branch (`already canceled` vs `already ${order.status} and can no longer be canceled`).
- `seed-notification-probe.ts`: rename any `packing`/`delivered` delivery-order literal per mapping.

- [ ] **Step 4: Run to verify pass + full backend typecheck**

Run: `corepack yarn test:unit` (full suite — catches stragglers referencing old statuses)
Expected: PASS.
Run: `corepack yarn check-types`
Expected: clean. Grep to confirm zero survivors: `grep -rn "'packing'" backend/packages/api/src` → only the migration file.

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src
git commit -m "feat(orders): migrate status consumers (notify, step, cancel, probe)"
```

---

### Task 4: Storefront status rename

**Files:**
- Modify: `src/lib/data/schemas.ts:549`, `src/lib/actions/delivery.ts:32,174,235`, `src/app/(account)/orders/OrdersClient.tsx:23-40`, `src/lib/notifications/copy.ts:117-125`
- Test: `src/lib/notifications/__tests__/copy.test.ts`

**Interfaces:**
- Consumes: backend now returns the new status strings (Tasks 2–3).
- Produces: storefront zod schema + UI accept exactly the six new values; customer copy for `completed` still reads "delivered".

- [ ] **Step 1: Update `copy.test.ts` (failing first)**

The delivery-status cases: input status `'completed'` must produce the existing "Your order was delivered." sentence; `'shipped'` and `'canceled'` cases unchanged; remove/replace any `'delivered'`-input case.

- [ ] **Step 2: Run to verify failure**

Run (repo root): `npm test -- src/lib/notifications`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `schemas.ts:549`: `z.enum(['requested', 'processed', 'ready_to_ship', 'shipped', 'completed', 'canceled'])`.
- `actions/delivery.ts:32`: same union in the type; update the two comments (`requested`/`packing` → `requested`/`processed`/`ready_to_ship`); fallback copy/regex at 226-230 already matches "shipped" generically — leave.
- `OrdersClient.tsx`: tone map and status list:

```ts
const TONE = {
  requested: 'amber',
  processed: 'amber',
  ready_to_ship: 'amber',
  shipped: 'sky',
  completed: 'green',
  canceled: 'neutral',
} as const;
```

  Status display labels (find the label map or inline rendering in the same file): `requested → Requested`, `processed → Processed`, `ready_to_ship → Ready to ship`, `shipped → Shipped`, `completed → Delivered` (customer-facing wording — Global Constraints), `canceled → Canceled`.
- `notifications/copy.ts`: `if (status === 'delivered')` → `if (status === 'completed')`, sentence unchanged.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- src/lib/notifications` → PASS.
Run: `npm run typecheck` → clean (this catches every other storefront reference).

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(orders): storefront delivery status rename (completed shows as Delivered)"
```

---

### Task 5: Bulk-status endpoint + list search

**Files:**
- Modify: `backend/packages/api/src/api/admin/delivery-orders/validate.ts`
- Create: `backend/packages/api/src/api/admin/delivery-orders/bulk/route.ts`
- Create: `backend/packages/api/src/api/admin/delivery-orders/notify.ts` (shared notify helper, extracted from `[id]/route.ts`)
- Modify: `backend/packages/api/src/api/admin/delivery-orders/[id]/route.ts` (use the helper), `backend/packages/api/src/api/admin/delivery-orders/route.ts` (GET list gains `?q=` id-substring filter)
- Modify: `backend/packages/api/src/modules/packs/models/admin-action-audit.ts` (BOTH enums extend: `entity_type` gains `'delivery_order'`, `action` gains `'bulk_status'`)
- Create: `backend/packages/api/src/modules/packs/migrations/Migration20260727000001.ts` (admin_action_audit check-constraint refresh for BOTH columns — same drop/re-add pattern as Task 2's migration; new value lists = current model lists + the two new values; read the current lists from the model file)
- Test: `backend/packages/api/src/api/admin/delivery-orders/__tests__/bulk-validate.unit.spec.ts` (new), `backend/packages/api/integration-tests/http/delivery-orders-bulk.spec.ts` (new)

**Interfaces:**
- Consumes: `updateDeliveryOrderWorkflow`, `notifyFeed`, `shouldNotifyDeliveryStatus`, `deliveryFeedKey`, `DeliveryStatus`.
- Produces: `POST /admin/delivery-orders/bulk` body `{ ids: string[], status: DeliveryStatus }` → `{ updated: string[], skipped: { id: string, reason: string }[] }`; `coerceBulkStatusBody(raw)` in validate.ts; `notifyDeliveryChange(scope, before, result, trackingInput)` in notify.ts; `GET /admin/delivery-orders?q=<substr>` filters by id substring.

- [ ] **Step 1: Write `bulk-validate.unit.spec.ts` (failing first)**

```ts
import { coerceBulkStatusBody } from '../validate';

describe('coerceBulkStatusBody', () => {
  it('accepts a valid body', () => {
    expect(coerceBulkStatusBody({ ids: ['a', 'b'], status: 'processed' })).toEqual({
      ids: ['a', 'b'],
      status: 'processed',
    });
  });
  it.each([
    [{ ids: [], status: 'processed' }],
    [{ ids: ['a', 'a'], status: 'processed' }],           // duplicates
    [{ ids: Array.from({ length: 101 }, (_, i) => `id${i}`), status: 'processed' }], // >100
    [{ ids: ['a'], status: 'packing' }],                  // dead status
    [{ ids: ['a'] }],                                     // missing status
    [{ status: 'processed' }],                            // missing ids
    [{ ids: [1], status: 'processed' }],                  // non-string id
  ])('rejects %j', (body) => {
    expect(() => coerceBulkStatusBody(body)).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `corepack yarn test:unit --testPathPattern bulk-validate`
Expected: FAIL — `coerceBulkStatusBody` not exported.

- [ ] **Step 3: Implement validate + notify helper + routes**

`validate.ts` — add (same `bad()` helper, same style):

```ts
export type BulkStatusBody = { ids: string[]; status: DeliveryStatus };

export function coerceBulkStatusBody(raw: unknown): BulkStatusBody {
  if (!raw || typeof raw !== 'object') bad('Body must be an object.');
  const b = raw as Record<string, unknown>;
  if (
    !Array.isArray(b.ids) ||
    b.ids.length === 0 ||
    b.ids.length > 100 ||
    b.ids.some((v) => typeof v !== 'string') ||
    new Set(b.ids).size !== b.ids.length
  ) {
    bad('`ids` must be 1-100 unique strings.');
  }
  if (
    typeof b.status !== 'string' ||
    !DELIVERY_STATUSES.includes(b.status as DeliveryStatus)
  ) {
    bad(`Invalid status '${String(b.status)}'.`);
  }
  return { ids: b.ids as string[], status: b.status as DeliveryStatus };
}
```

`notify.ts` — extract the notification block from `[id]/route.ts:63-83` verbatim into:

```ts
export async function notifyDeliveryChange(
  scope: MedusaRequest['scope'],
  before: { status: string; customer_id: string; tracking_number?: string | null },
  result: { order_id: string; status: DeliveryStatus },
  trackingInput: string | null | undefined,
): Promise<void>
```

(same shouldNotifyDeliveryStatus guard, same idempotency key, same swallow-all catch); `[id]/route.ts` calls it.

`bulk/route.ts`:

```ts
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { ids, status } = coerceBulkStatusBody(req.body);
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const updated: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of ids) {
    const [before] = await packs.listDeliveryOrders({ id }, { take: 1 });
    if (!before) { skipped.push({ id, reason: 'not found' }); continue; }
    try {
      const { result } = await updateDeliveryOrderWorkflow(req.scope).run({
        input: { order_id: id, status },
      });
      updated.push(id);
      // Spec acceptance: one audit row per changed order. admin_id is
      // server-derived; reason names the bulk tool.
      await packs.createAdminActionAudits([
        {
          admin_id: req.auth_context.actor_id,
          entity_type: 'delivery_order',
          entity_id: id,
          action: 'bulk_status',
          before: { status: before.status },
          after: { status: result.status },
          reason: `bulk mark as ${status}`,
        },
      ]);
      await notifyDeliveryChange(req.scope, before, result, undefined);
    } catch (err) {
      skipped.push({ id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  res.json({ updated, skipped });
}
```

Sequential loop is deliberate (per-order advisory lock in the service; 100 max). `route.ts` GET list: when `q` present and non-empty, add `id: { $like: `%${q}%` }` to the filter object passed to `listDeliveryOrders` (validate `q` is a string ≤ 64 chars, else 400).

- [ ] **Step 4: Write the http spec (failing → passing)**

`integration-tests/http/delivery-orders-bulk.spec.ts` — copy setup boilerplate (medusaIntegrationTestRunner, admin auth header helper) from an existing spec in the same directory (e.g. the one covering `delivery-orders`). Cases:
1. Seed two delivery orders in `requested` (reuse the existing spec's seeding path) → `POST /admin/delivery-orders/bulk {ids:[a,b], status:'processed'}` → 200, `updated:[a,b]`, both re-read as `processed`, AND two `admin_action_audit` rows exist (`entity_type='delivery_order'`, `action='bulk_status'`, `entity_id` ∈ {a,b}).
2. One `requested` + one already-`shipped` order → bulk to `'canceled'` → `updated:[requestedId]`, `skipped:[{id: shippedId, reason: /invalid|not allowed/i}]`, and NO audit row for the skipped id.
3. 101 ids → 400.
4. `GET /admin/delivery-orders?q=<last-6-of-id>` → returns only the matching order.

Run: `NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http npx jest integration-tests/http/delivery-orders-bulk.spec.ts --runInBand --forceExit`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/api/admin/delivery-orders backend/packages/api/integration-tests/http/delivery-orders-bulk.spec.ts
git commit -m "feat(orders): bulk status endpoint + id search on admin delivery list"
```

---

### Task 6: Admin app — All Orders page (tabs, columns, bulk bar)

**Files:**
- Modify: `backend/apps/admin/src/lib/admin-rest.ts:471-475` (status union; add `bulkUpdateDeliveryOrders`, `q` param on the list call), `backend/apps/admin/src/lib/queries.ts` (add `useBulkUpdateDeliveryOrders`, thread `q` through `useDeliveryOrders`), `backend/apps/admin/src/lib/query-keys.ts` (include `q` in the deliveries key), `backend/apps/admin/src/routes/deliveries/page.tsx`

**Interfaces:**
- Consumes: Task 5's `POST /admin/delivery-orders/bulk` + `?q=`.
- Produces: nav label **All Orders** (path `/deliveries` unchanged); page with status tabs, search box, selectable rows, bulk mark-as; `useBulkUpdateDeliveryOrders(): { mutateAsync({ ids, status }) }`.

- [ ] **Step 1: admin-rest + queries**

- Status union → `'requested' | 'processed' | 'ready_to_ship' | 'shipped' | 'completed' | 'canceled'`.
- `bulkUpdateDeliveryOrders(ids: string[], status: DeliveryStatus)` → POST `/admin/delivery-orders/bulk`, returns `{ updated: string[]; skipped: { id: string; reason: string }[] }` (follow the file's existing fetch-wrapper pattern).
- List call gains optional `q?: string`; `useDeliveryOrders(filter, page, q)`; query key includes `q`; `useBulkUpdateDeliveryOrders` invalidates the deliveries key on settle (mirror `useUpdateDeliveryOrder`).

- [ ] **Step 2: Rework `page.tsx`**

Keep the existing FocusModal manage flow intact. Changes:
- `config.label: 'All Orders'`; Heading "All Orders"; subtitle "Orders and physical shipment requests."
- Status maps:

```ts
const STATUSES: DeliveryStatus[] = ['requested', 'processed', 'ready_to_ship', 'shipped', 'completed', 'canceled'];
const TONE: Record<DeliveryStatus, 'orange' | 'blue' | 'green' | 'grey'> = {
  requested: 'orange', processed: 'orange', ready_to_ship: 'orange',
  shipped: 'blue', completed: 'green', canceled: 'grey',
};
const STATUS_LABEL: Record<DeliveryStatus, string> = {
  requested: 'Requested', processed: 'Processed', ready_to_ship: 'Ready to ship',
  shipped: 'Shipped', completed: 'Completed', canceled: 'Canceled',
};
```

- Replace the status `<Select>` filter with a tab strip (`Tabs` from `@medusajs/ui` if exported, else a horizontal `Button variant="transparent"` row — check what `@medusajs/ui` exposes and follow `medusa-ui-conformance`): All + one per status; selecting sets `filter` and resets page. `nextStatus` initial state `'packing'` → `'processed'`.
- Add a search `<Input placeholder="Search order id">` (debounce 300 ms) wired to `q`.
- Columns become: checkbox | Order (`#` + id slice) | Date (`created_at` formatted `dd-MM-yyyy hh:mm a` — the serializer already returns `created_at`; add it to the `AdminDeliveryOrder` type if missing) | Item (thumbnail + card name + handle, first item + "+N more") | Qty (`items.length`) | Player (`customer_email`) | Status badge | Manage button.
- Selection state `Set<string>`; header checkbox = select page. When non-empty, a bulk bar renders above the table: count, `<Select>` of STATUSES, Apply → `bulkUpdateDeliveryOrders`, then `toast.success(`${updated.length} updated${skipped.length ? `, ${skipped.length} skipped` : ''}`)` and per-skip `toast.error(`#${id.slice(-6)}: ${reason}`)` (cap at 5 error toasts); plus a **Print** button (Task 7).

- [ ] **Step 3: Verify**

Run (from `backend/apps/admin`): `corepack yarn build` → clean (`tsc -b` catches all stale status references — fix any it reveals in this app). `corepack yarn lint` → clean.
Manual: `corepack yarn dev` (port 7000, backend on :9000) → tabs filter, search narrows, bulk mark-as two requested orders → both badge `Processed`, toast "2 updated".

- [ ] **Step 4: Commit**

```bash
git add backend/apps/admin/src
git commit -m "feat(orders): All Orders admin page - tabs, search, bulk mark-as"
```

---

### Task 7: Print details view

**Files:**
- Create: `backend/apps/admin/src/routes/deliveries/print/page.tsx`
- Modify: `backend/apps/admin/src/routes/deliveries/page.tsx` (Print button navigates)

**Interfaces:**
- Consumes: existing per-order GET (`admin-rest`'s delivery-order detail fetcher) — reuse whatever `useDeliveryOrders`/detail query exists; if only the list hook exists, add `useDeliveryOrder(id)` wrapping `GET /admin/delivery-orders/:id`.
- Produces: route `/deliveries/print?ids=<comma-separated>` rendering one print block per order.

- [ ] **Step 1: Implement the page**

File-based route, **no `config` export** (keeps it out of the nav). Read `ids` from `useSearchParams`/location, fetch each order, render per order a plain block: `Order #<id>`, created date, status label, ship-to (name, address_1/2, city, province, postal, country, phone), customer email, item table (thumbnail, card name, handle, qty 1 per pull), tracking number. Style: white background, black text, `@media print { .no-print { display: none } }`; a top `.no-print` bar with a "Print" button calling `window.print()`. Cap: if `ids.length > 100` show an error text instead of fetching.

In `page.tsx`, the bulk bar's Print button opens `/deliveries/print?ids=${[...selected].join(',')}` in a new tab.

- [ ] **Step 2: Verify**

`corepack yarn build` + `corepack yarn lint` clean. Manual: select 2 orders → Print → new tab shows both blocks; browser print preview paginates.

- [ ] **Step 3: Commit**

```bash
git add backend/apps/admin/src/routes/deliveries
git commit -m "feat(orders): print details view for selected orders"
```

---

### Task 8: Pack purchases tab

**Files:**
- Modify: `backend/apps/admin/src/routes/deliveries/page.tsx`
- Reference (read, reuse, do not modify): `backend/apps/admin/src/routes/pulls/page.tsx`, its hook in `lib/queries.ts`, backend `api/admin/pulls/route.ts`

**Interfaces:**
- Consumes: the existing admin pulls list hook (the one `routes/pulls/page.tsx` uses — same pagination shape).
- Produces: a record-kind toggle on All Orders: **Shipping** (default, everything from Tasks 6–7) | **Pack purchases** (read-only list of pack-open pulls).

- [ ] **Step 1: Implement**

Add a two-value kind toggle above the status tabs (`Shipping` / `Pack purchases`). When `Pack purchases` is active: hide status tabs, search, and bulk bar; render a table using the pulls hook with columns Order (`#` + pull id slice) | Date (pull created) | Item (card thumb + name + pack title) | Qty (`1`) | Player (customer email/id as the pulls page shows it) | Status (constant `<StatusBadge color="green">Completed</StatusBadge>`). Paginate with the same `Pager`. No row actions.

- [ ] **Step 2: Verify**

`corepack yarn build` + `lint` clean. Manual: toggle shows pull history (seeded DB), toggling back restores shipping view state.

- [ ] **Step 3: Commit**

```bash
git add backend/apps/admin/src/routes/deliveries/page.tsx
git commit -m "feat(orders): pack purchases tab on All Orders"
```

---

### Task 9: Detail modal — player info block

**Files:**
- Modify: `backend/apps/admin/src/routes/deliveries/page.tsx` (FocusModal body, lines ~270-300)

**Interfaces:**
- Consumes: `AdminDeliveryOrder` fields already returned (`address.*`, `customer_email`).
- Produces: detail modal with a "Player" section (name, email, phone) and an "Order details" section (full shipping address, items, tracking, proof photos).

- [ ] **Step 1: Implement**

Replace the two loose `<Text>` lines (address one-liner + "Customer:") with two labelled sections:
- **Player** — `address.name`, `customer_email ?? customer_id`, `address.phone ?? '—'`.
- **Order details** — full address block (`address_1`, `address_2`, `city province postal_code`, `country_code.toUpperCase()`), then the existing status select, tracking input, proof photos, and item thumbnails (add card name + handle text beside each thumbnail).

- [ ] **Step 2: Verify + commit**

`corepack yarn build` + `lint` clean; manual: open Manage on any order — both sections render, save flow unchanged.

```bash
git add backend/apps/admin/src/routes/deliveries/page.tsx
git commit -m "feat(orders): player info + order details sections in manage modal"
```

---

### Task 10: e2e + full verification sweep

**Files:**
- Modify: `tests/e2e/ship-orders.spec.ts` (status literals + any label assertions)

- [ ] **Step 1: Update the e2e spec**

Rename status values per the mapping; storefront label assertions per Task 4 (customer sees "Delivered" for `completed`; admin flow drives requested→processed→ready_to_ship→shipped→completed if the spec walks the pipeline).

- [ ] **Step 2: Full verification**

- `backend/packages/api`: `corepack yarn test:unit` PASS, `corepack yarn check-types` clean, `corepack yarn test:integration:smoke` PASS.
- New http spec: the Task 5 jest command PASS.
- `backend/apps/admin`: `corepack yarn build && corepack yarn lint` clean.
- Repo root: `npm run check` clean, `npm test` PASS.
- e2e (needs seeded DB + serve per repo rules): `npx playwright test tests/e2e/ship-orders.spec.ts`.
- Grep sweep: `grep -rn "'packing'" src backend/packages/api/src backend/apps/admin/src tests` → only the migration's down() and any pull-status `'delivered'` sites (which are correct).

- [ ] **Step 3: Commit + PR**

```bash
git add tests/e2e/ship-orders.spec.ts
git commit -m "test(orders): e2e pipeline statuses"
```

Then `/code-review`, fix findings, push, PR to `master` titled `feat(orders): All Orders rework — status pipeline, bulk tools, pack purchases tab (POLYCARD-BACK epic 1)`.

---

## Coverage check (spec §1 → tasks)

- 1.1 rename Deliveries→All Orders → Task 6 (Pull Ledger removal deferred to Players epic per spec).
- 1.2 status pipeline + migration → Tasks 1–4.
- 1.3 list columns/search/sort → Task 6; type tabs → Task 8; bulk mark-as → Tasks 5–6; print → Task 7.
- 1.4 detail player info + order details → Task 9.
- Acceptance (lossless migration, audit, print n orders) → Task 2 step 6, Task 5 (explicit `admin_action_audit` row per bulk-changed order), Task 7.
