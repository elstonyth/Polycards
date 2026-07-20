# Postgres audit — implementation plan

Scope: `backend/packages/api` (Medusa v2 custom module `packs`), plus `medusa-config.ts` and `.do/backend.app.yaml`. Produced by a read-only audit.

## Status

| Item                                              | State                                                                                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** — pool cap                                 | **Applied** in PR #228 (`src/utils/db-driver-options.ts`). Merged ≠ live: still needs the post-deploy `SHOW max_connections` + connection-count watch described below. |
| **C2(a)** — `idle_in_transaction_session_timeout` | **Applied** in the same commit.                                                                                                                                        |
| **C2(b)** — `statement_timeout` / `lock_timeout`  | Not applied. Belongs on the runtime `DATABASE_URL`, which is a deploy secret outside this repo.                                                                        |
| Everything else (A1–A3, B1–B8, D1–D3)             | Not applied.                                                                                                                                                           |

**Standard verification loop** (all model-layer items). From `backend/packages/api`:

```bash
corepack yarn medusa db:generate packs      # inspect the emitted migration BEFORE applying
corepack yarn medusa db:migrate
corepack yarn check-types                   # = node node_modules/typescript/bin/tsc --noEmit
# local Postgres container, per CLAUDE.md § Running services
docker exec pokenic-postgres psql -U medusa -d medusa -c "\d <table>"   # confirm index landed
```

Rule that governs every index/constraint item: schema is owned by `model.define(...).indexes([...])`; migrations are generated from it. A hand-written `ALTER TABLE`/`CREATE INDEX` drifts and gets fought by the next `db:generate`. Raw SQL is proposed in exactly two places below, each with an explicit reason Medusa cannot express it.

---

## A. Correctness & data integrity

### A1 — Thread `sharedContext` into nested reads inside lock-holding transactions

**Files:** `src/modules/packs/service.ts` — lines 716, 870, 888, 945, 950, 995, 1282, 2020, 2034, 2040, 3501.

`@InjectTransactionManager` methods hold a pooled connection + the `credit:` advisory lock, then call `@InjectManager` `list*` methods **without** forwarding `sharedContext`. Medusa's `inject-manager.js` explicitly skips `transactionManager` and calls `getFreshManager()` → `em.fork()` (no `keepTransactionContext`), so each nested read checks out a **second** connection from the same knex pool. Verified empirically: that pool is `min 2 / max 10` per process (see C1).

Failure mode: peak concurrency on the money path where every in-flight locked transaction needs a second connection for each nested read → acquires block until knex's 60s `acquireConnectionTimeout` → `KnexTimeoutError: pool is full` while the DB is healthy. Secondary latent bug at 3501: `loadVipStateInputs` forwards context to `lifetimeExternalSenFor` then drops it on the next line for `creditSummary`, so the two halves of one VIP snapshot read on different connections.

**Fix** — add `sharedContext` as the trailing argument at each site. Pattern already used in the same functions (`this.isFrozen(input.customerId, sharedContext)` at 1935, `this.createCreditTransactions(..., sharedContext)` at 1991/2005):

```diff
-    const [existing] = await this.listCreditTransactions(
-      { customer_id: customerId, source_transaction_id: sourceTransactionId },
-      { take: 1 },
-    );
+    const [existing] = await this.listCreditTransactions(
+      { customer_id: customerId, source_transaction_id: sourceTransactionId },
+      { take: 1 },
+      sharedContext,
+    );
```

Notes the executor must not skip:

- **Line 2034 contradicts an in-code comment** (`"lifetimeExternalSenFor is @InjectManager like creditSummary, so the level read stays off the locked path. (F5)"`). Forwarding there is behaviour-neutral — `lifetimeExternalSenFor` filters `reason='pack_open' AND amount<0` while this transaction only writes sponsor commissions (`direct_referral`/`team_override`, amount>0) — but **update the comment in the same diff** or the next reviewer reverts it.
- **Lines 870/888/1282** (`reverseCreditTransaction`) are the same defect and were under-reported in the original finding. Fix them too; fixing only the listed 8 leaves siblings broken.
- **Line 995** (`reverseOpen` per-row probe) is an ORM `find`; a transactional context can trigger a MikroORM auto-flush of the loop's buffered inserts mid-iteration. Benign here (same txn, earlier write; each `reversal:${id}` key is distinct) but it touches the "UoW buffers ORM inserts" assumption documented at 984-986 and 1975-1980 — re-run the `reverseOpen` integration specs.
- Do **not** "fix" this by raising `pool.max`. That moves the cliff.

**Why here:** pure `service.ts` change. No schema, no model, no migration.

**Verify:** `corepack yarn check-types`; `corepack yarn test:integration:smoke`. Leave a regression check behind — an integration test that runs `settleOpen` concurrently for `pool_max + 2` distinct customers and asserts no `KnexTimeoutError`. Without it this silently regresses the next time someone adds a nested read.

**Effort:** small. **Ship with C1** — same failure mode from the other side.

---

### A2 — `buyback-pull`: commit the credit row and the pull status flip in ONE transaction

**Files:** `src/modules/packs/service.ts` (new method) + `src/workflows/steps/buyback-pull.ts:133-182`.

Today: `createCreditTransactions` (line 135) auto-commits its own transaction; `transitionPullStatus` (line 163) is a second, separate `@InjectTransactionManager` transaction. On failure of step 2 the code hand-rolls an undo whose own failure is only logged (`"UNDO FAILED — credit txn '...' exists but pull '...' was not flipped; repair manually"`, line 176).

This is **not** a concurrency race — `transitionPullStatus` is a guarded `UPDATE ... WHERE id IN (...) AND status = ?` (service.ts:3199-3212) so a concurrent duplicate loses cleanly. It is a crash window: process kill / DB failover / pool timeout between line 157 and line 163 leaves the customer **credited** with a pull still `'vaulted'`. That pull is still deliverable (`validateDeliveryRequest` accepts any owned vaulted pull, `request-delivery.ts:95-100`) — paid for the card _and_ can ship it. It does not self-heal: retry hits `IDX_credit_transaction_pull_id_unique` → `probeDuplicate` → "This card was already sold back." Permanently stuck until manual repair. No reconciliation job exists (`src/jobs` = `mature-commissions.ts`, `sync-market-prices.ts` only).

The in-repo correct pattern is `recordRewardWithdrawal` (service.ts:1450-1548), which even comments at 1524-1527 that it does this "unlike requestDeliveryStep, which has no surrounding transaction".

**Fix:**

```ts
// src/modules/packs/service.ts — beside recordRewardWithdrawal
@InjectTransactionManager()
async settleBuyback(
  input: { customerId: string; pullId: string; amount: number },
  @MedusaContext() sharedContext: Context = {},
): Promise<{ id: string }> {
  const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
  await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `credit:${input.customerId}`,
  ]);
  // guarded flip FIRST so a non-vaulted pull aborts before any money moves
  await this.transitionPullStatus(
    { ids: [input.pullId], from: 'vaulted', to: 'bought_back',
      set: { buyback_amount: input.amount, buyback_at: new Date() } },
    sharedContext,
  );
  const [txn] = await this.createCreditTransactions(
    [{ customer_id: input.customerId, amount: input.amount,
       reason: 'buyback' as const, pull_id: input.pullId }],
    sharedContext,
  );
  // same lock already held — inline the auto-unfreeze instead of the post-commit call
  const rows = await em.execute<{ balance_cents: string | null }[]>(
    'SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS balance_cents ' +
    '  FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL',
    [input.customerId],
  );
  await this.maybeAutoUnfreeze(input.customerId, Number(rows[0]?.balance_cents ?? 0), sharedContext);
  return { id: txn.id };
}
```

`buyback-pull.ts` then calls this in place of lines 133-182 and deletes both hand-rolled undo blocks.

Three things the executor must preserve:

1. **Do not delete `maybeAutoUnfreezeForCustomer` behaviour** (currently `buyback-pull.ts:224-232`). That method takes the credit lock _and then_ re-reads the balance and calls the private `maybeAutoUnfreeze` (service.ts:1113-1136) to lift an AUTO freeze the credit repays (the F1 fix). Either keep lines 224-232 as-is, or inline it as above — `maybeAutoUnfreeze` is a private sibling in the same class, so the direct call is legal.
2. **Keep `insertOrMapDuplicate`** (`workflows/steps/duplicate-race.ts`) wrapped around the _call_ to `settleBuyback`, not inside it — otherwise a 23505 on `IDX_credit_transaction_pull_id_unique` escapes as a 500. By then the txn has rolled back, so `probeDuplicate`'s SELECT runs in a fresh txn, which is correct.
3. **Error copy changes** for the narrow concurrent-flip loser: flip-first throws "One or more cards changed state — refresh and try again." (service.ts:3208-3211) where today it throws "This card was already sold back." The early precheck at `buyback-pull.ts:70-77` still catches the common case. Map the `NOT_ALLOWED` through `probeDuplicate` if the copy matters.

Stock restore (`:184-214`, best-effort by design) and `creditBalance` (`:217`, must read post-commit) stay outside the transaction. The `StepResponse` compensation still needs the returned txn id.

**Why here:** no DDL, no model change, no migration. Pure service/workflow restructure.

**Verify:** `corepack yarn check-types`; `corepack yarn test:integration:http` (at minimum `vault-buyback.spec`, `ledger-conservation.spec`).

**Effort:** medium. **Ships alone.**

---

### A3 — `requestDeliveryStep`: three auto-committed transactions → one

**Files:** `src/modules/packs/service.ts` (new method) + `src/workflows/steps/request-delivery.ts:126-172` (+ compensation at `:186-194`).

`createDeliveryOrders` (126) → `createDeliveryOrderItems` (133) → `transitionPullStatus(from:'vaulted', to:'delivering')` (155): three independent commits, no surrounding transaction, both failure branches hand-roll deletes that only log on failure. `POST /store/delivery-orders` awaits `.run()` inline — non-durable workflow, no engine recovery, and durable execution would not roll back already-committed module sub-transactions anyway.

Crash between line 139 and line 159 leaves a `delivery_order` in status `'requested'` **with its items**, while the pulls are still `'vaulted'`. The operator sees a live shipment and packs the card; the customer can simultaneously sell it back (`buyback-pull.ts:69` gates on `status === 'vaulted'`) or request delivery again. The order is also unreachable from either terminal state: `transitionDeliveryOrderStatus` advances covered pulls `from:'delivering'` (service.ts:3295-3302), so both `delivered` and `canceled` throw "One or more cards changed state". Manual DB repair only.

No DB constraint covers it and none should: `IDX_delivery_order_item_order_pull_unique` is on `(delivery_order_id, pull_id)`, and a unique on `pull_id` alone would wrongly block re-requesting after a cancel (cancel re-vaults the pull without deleting the item row).

**Fix:**

```ts
// src/modules/packs/service.ts
@InjectTransactionManager()
async recordDeliveryRequest(
  input: { customerId: string; pullIds: string[]; snapshot: AddressSnapshot },
  @MedusaContext() sharedContext: Context = {},
): Promise<{ orderId: string; itemIds: string[] }> {
  await this.assertNotFrozen(input.customerId, sharedContext);
  const [order] = await this.createDeliveryOrders(
    [{ customer_id: input.customerId, status: 'requested' as const, ...input.snapshot }],
    sharedContext,
  );
  const items = await this.createDeliveryOrderItems(
    input.pullIds.map((pull_id) => ({ delivery_order_id: order.id, pull_id })),
    sharedContext,
  );
  await this.transitionPullStatus(   // guarded UPDATE; throws -> whole txn rolls back
    { ids: input.pullIds, from: 'vaulted', to: 'delivering' },
    sharedContext,
  );
  return { orderId: order.id, itemIds: items.map((i) => i.id) };
}
```

Four corrections to the obvious naive version:

1. **The defect is the missing transaction, not a missing lock.** Do NOT add `pg_advisory_xact_lock('credit:'+customerId)` here. `recordRewardWithdrawal` needs it for its daily-cap COUNT-then-INSERT; the regular delivery path has no read-modify-write, and `transitionPullStatus`'s conditional UPDATE is already the concurrency enforcer. Adding the lock is superfluous contention with spin/buyback on the same customer.
2. **Keep the compensation body at `request-delivery.ts:186-194` exactly as it is.** `delivery_order_item` has **no FK** to `delivery_order` (`pg_constraint` shows PK only), so reducing compensation to `deleteDeliveryOrders` orphans item rows and strands pulls at `'delivering'`. Compensation undoes a _committed_ transaction; rollback cannot do that for it.
3. The method must return `itemIds` — `CompensateData` (`request-delivery.ts:26-28`) requires them and compensation calls `deleteDeliveryOrderItems(data.itemIds)`. Once item creation moves into the service, the step no longer has them. (Alternative: re-list items by order id, the way `update-delivery-order.ts:91-100` does.)
4. `request-delivery.ts` keeps validation + address resolution, calls this once, deletes both try/catch undo blocks (130-172).

**Why here:** no DDL, no model change, no migration.

**Verify:** `corepack yarn check-types`; `corepack yarn test:integration:http` delivery specs. Note `delivery_order` / `delivery_order_item` are 0 rows in the local clone — this feature is early-stage, so integration tests are the only coverage.

**Effort:** medium. **Ships alone.**

---

## B. Index & query performance

### B1 — `notification_read`: flip the unique index column order

**File:** `backend/packages/api/src/modules/packs/models/notification-read.ts:13-19`.

The only non-pk index is `(notification_id, customer_id)` unique. The unread-badge count at `src/api/store/notifications/route.ts:63-66` filters `{ customer_id, read_at: { $ne: null } }` — customer_id alone. Proven unservable: with `enable_seqscan=off` the planner falls back to `IDX_notification_read_deleted_at` and filters `customer_id` in the heap. Cost scales with **total** table size (customers × notifications-they-have-read), not with the requesting user.

Uniqueness on `(a,b)` is order-independent, so this is a strict improvement — no second index, no semantic change. All seven `list*NotificationReads` call sites include `customer_id`; grepping raw `notification_read` outside models/migrations found no knex/SQL and no delete-cascade subscriber filtering `notification_id` alone. There is no losing query shape.

```diff
   .indexes([
     {
-      on: ['notification_id', 'customer_id'],
+      on: ['customer_id', 'notification_id'],
       unique: true,
       where: 'deleted_at IS NULL',
     },
   ]);
```

**Why here:** model DSL expresses it fully. A hand-written ALTER would drift.

**Verify:** run `db:generate` and **read the emitted migration before applying** — MikroORM's differ sometimes no-ops on partial-index (`where`) changes. It must contain BOTH `drop index if exists "IDX_notification_read_notification_id_customer_id_unique"` AND `create unique index ... ("customer_id","notification_id") ... where deleted_at is null`. Repo precedent for generated drops: `Migration20260713130000.ts:16`, `Migration20260704070016.ts:12`. Then `\d notification_read`. Table is 202 rows — the drop+create is instantaneous.

**Effort:** trivial. **Batchable** with B3/B4.

---

### B2 — `/store/vault`: stop truncating silently at 500

**File:** `src/api/store/vault/route.ts:37,47-50` (+ comment at `src/api/store/vault/buyback-batch/route.ts:34-35`).

`VAULT_LIMIT = 500` with no `limit`/`offset` params at all (contrast `credits/route.ts` and `notifications/route.ts`, which both use `parsePaginationParams`). Both sell paths consume `pull_ids` the client only ever obtains from that capped list, and there is no server-side "sell whole vault" endpoint — so a customer past 500 vaulted pulls loses the tail from view **and** from sale. Current headroom: 85 vaulted rows total, max 35 per customer; the vaulted set drains as cards are sold/shipped, so this is latent, not live.

Ship the minimal, non-regressing version:

```diff
-  const pulls = await packs.listPulls(
-    { customer_id: customerId, status: 'vaulted' },
-    { order: { rolled_at: 'DESC' }, take: VAULT_LIMIT },
-  );
+  const rows = await packs.listPulls(
+    { customer_id: customerId, status: 'vaulted' },
+    // id tiebreaker: batch opens land sibling rows in the same instant
+    { order: { rolled_at: 'DESC', id: 'DESC' }, take: VAULT_LIMIT + 1 },
+  );
+  const truncated = rows.length > VAULT_LIMIT;
+  const pulls = rows.slice(0, VAULT_LIMIT);
```

…and return `truncated` alongside `items` at `:159`.

**Excluded:** an earlier draft proposed `parsePaginationParams({ defaultLimit: 100, maxLimit: 200 })`. That regresses production on deploy — the storefront (`src/lib/actions/vault.ts:75`) calls `/store/vault` with no params and has no pager, so every customer would drop from 500 visible items to 100 on the exact surface that gates selling. If real pagination is ever wanted, `defaultLimit` must stay at 500 and it must ship together with a storefront change that pages to completion before submitting ids to `buyback-batch` — storefront is out of scope here.

Keep `MAX_BATCH = 500` in `buyback-batch/route.ts` as an independent request-size guard, and delete its now-false "Mirrors VAULT_LIMIT" comment.

**Why here:** application code only. `IDX_pull_customer_id_rolled_at` already serves this order — no schema change.

**Verify:** `corepack yarn check-types`. Follow-up (out of scope): surface the `truncated` flag in `VaultClient.tsx`.

**Effort:** small.

---

### B3 — `pull`: add the `card_id` lookup index

**File:** `src/modules/packs/models/pull.ts:62-76`.

Declares only `(customer_id, rolled_at)` and `(rolled_at)`. `src/workflows/steps/delete-card.ts:69-72` runs `listPulls({ card_id: input.handle, status: ['vaulted','delivering'] }, { take: 1 })` with no `customer_id`, so neither index applies — real (unforced) plan is a `Seq Scan on pull`. `take: 1` doesn't help: for a card nobody holds (the common case, and the one where the admin is waiting) Postgres must read the whole table to prove zero matches. Only two `listPulls` call sites filter anything: this one and `service.ts:1482` (by `id`, uses the pk).

```diff
     {
       name: 'IDX_pull_rolled_at',
       on: ['rolled_at'],
       where: 'deleted_at IS NULL',
     },
+    // delete-card's "customers still hold this" guard filters card_id with no
+    // customer predicate, so neither index above applies
+    // (workflows/steps/delete-card.ts:69).
+    {
+      name: 'IDX_pull_card_id',
+      on: ['card_id'],
+      where: 'deleted_at IS NULL',
+    },
   ]);
```

**Do not use** a `status IN ('vaulted','delivering')` predicate. Two reasons: (a) all 27 `where:` strings in `models/*.ts` are either bare `deleted_at IS NULL` or a _single_ equality — there is no IN-list precedent, so generator behaviour is unproven; (b) a value predicate must be _proven_ implied by the query, and a prepared statement that flips to a generic plan at execution 6 (`Filter: status = $1`) can no longer prove it, silently dropping the partial index. `deleted_at IS NULL` is parameter-free and always proves. At 86 rows, excluding history rows saves nothing anyway.

**Why here:** model DSL. **Verify:** standard loop + `\d pull`.

**Effort:** trivial. **Batchable** with B1/B4.

---

### B4 — `card_price_history`: widen `(card_id)` to `(card_id, created_at)`

**File:** `src/modules/packs/models/card-price-history.ts:14`.

Both — and only — readers need `created_at` ordering the current single-column index cannot supply: `sync-market-prices.ts:74-77` (`take: 1, order: created_at DESC, id DESC`, the per-card "did the price change?" check) and `api/store/cards/[handle]/route.ts:56-59` (`created_at >= since`, ASC, the public price chart).

```diff
-  .indexes([{ on: ['card_id'] }]);
+  // Both readers are (card_id) + created_at ordering: the sync job's
+  // latest-row check (DESC LIMIT 1) and the card page's 30-day window
+  // (>= since, ASC). The composite is a superset of the old (card_id) index.
+  .indexes([
+    {
+      name: 'IDX_card_price_history_card_id_created_at',
+      on: ['card_id', 'created_at'],
+      where: 'deleted_at IS NULL',
+    },
+  ]);
```

`created_at` is a managed column not declared in `model.define`, but the DSL indexes it fine and this repo already does it twice — `credit-transaction.ts:53-58` and `delivery-order.ts:41-42`, both confirmed present in the live DB.

Justification is **cost, not current pain**: 5 rows / 3 cards today, and the composite is a strict superset on the leading column, so nothing is added — one index is replaced by a wider one. (`id DESC` tiebreak in the sync reader stays uncovered; irrelevant at this cardinality.)

**Why here:** model DSL, matching an established in-module pattern.

**Verify:** confirm the generated migration drops `IDX_card_price_history_card_id`. If it only adds, remove the redundant single-column index in the same migration. Then `\d card_price_history`.

**Effort:** trivial. **Batchable** with B1/B3.

---

### B5 — `credit_transaction`: two new model-declared indexes (one `db:generate`, two distinct indexes)

**File:** `src/modules/packs/models/credit-transaction.ts:53-59` — currently declares exactly ONE index.

These are **not** duplicates of each other; neither can serve the other's query shape.

**(a) `source_transaction_id` lookup.** `reverseOpen` (service.ts:945-955, 995) and `reverseCommission` (1232, 1242) page rows sharing an open_id with **no** `reason`/`amount` predicate, so neither existing partial idempotency index applies. Unforced plan is `Seq Scan on credit_transaction, Filter: (deleted_at IS NULL AND source_transaction_id = 'x')`. Cold compensation path on a table that grows forever (1030 rows / 680 kB today, 492 with a non-null anchor).

**(b) `UQ_credit_txn_idem_anchor`.** Four sibling money invariants on this exact table carry a DB backstop (pull buyback, pack*open debit, commission payout, charge reversal); the topup and voucher_claim credit-minting anchors carry none — dedupe is check-then-insert under `pg_advisory_xact_lock('credit:'+customerId)` only (service.ts:698-737, comment: *"no DB unique required"\_). Latent, not exploitable today (no writer bypasses `mutateCreditAtomic`), but a future PSP webhook or backfill inserting outside that lock double-credits spendable RM silently. 74 rows carry `topup-idem:%`; a group-by-having over the anchored rows found zero existing violators.

```diff
   .indexes([
     {
       name: "IDX_credit_transaction_customer_id_created_at",
       on: ["customer_id", "created_at"],
       where: "deleted_at IS NULL",
     },
+    // reverseOpen / reverseCommission collect every row sharing an open_id with
+    // NO reason or amount predicate, so neither partial idempotency index
+    // applies. Partial on NOT NULL: topup/buyback/adjustment rows carry none.
+    {
+      name: "IDX_credit_transaction_source_transaction_id",
+      on: ["source_transaction_id"],
+      where: "source_transaction_id IS NOT NULL AND deleted_at IS NULL",
+    },
+    // DB backstop for the topup/voucher/reward idempotency anchors, matching
+    // the backstops the other four money paths on this table already have.
+    {
+      name: "UQ_credit_txn_idem_anchor",
+      on: ["customer_id", "source_transaction_id"],
+      unique: true,
+      where:
+        "deleted_at IS NULL AND source_transaction_id IS NOT NULL AND reason IN ('topup', 'voucher_claim', 'reward_credit')",
+    },
   ]);
```

Design notes:

- (a) is single-column on purpose — the `created_at ASC, id ASC` sort covers only the handful of rows sharing one open_id. `source_transaction_id = 'x'` implies the `IS NOT NULL` predicate by standard strict-operator implication, so the index is usable.
- (b) uses `reason IN (...)`, a plain column predicate, **not** a `LIKE 'topup-idem:%'` pattern — the pattern form is the expression case `db:generate` can't emit, and a reason predicate also survives an anchor-prefix rename. Precedent for a partial _unique_ with a `where`: `vip-reward-grant.ts:21-26` and `pack-odds.ts:65-70`, both live in the DB.
- (b) cannot collide with commission rows (which legitimately share `(customer_id, source_transaction_id)` across generations) or pack_open rows — `reason` excludes both. NULL anchors coexist (indexes are NULLS DISTINCT, and the predicate excludes them anyway).
- **No `CONCURRENTLY`.** Medusa wraps migrations in a transaction, where `CONCURRENTLY` errors — documented in this repo at `Migration20260622161000.ts:12-15`. At 1030 rows the brief ACCESS EXCLUSIVE lock is what every peer index on this table already took.
- If the loud-failure behaviour is wanted, handle 23505 where the anchored insert happens — `mutateCreditAtomic` in `service.ts` (~line 814) — **not** by reusing `settleOpen`'s catch at 2211-2223, which is scoped to open settlement and would not see it.

**Why here:** model DSL expresses both. (The earlier proposal to hand-write a raw-SQL migration for (b) was wrong on both counts — it used `CONCURRENTLY`, which cannot run, and Medusa can express partial uniques.)

**Verify:** standard loop + `\d credit_transaction`; confirm both new indexes present with the intended predicates.

**Effort:** trivial. **Batchable** with B6 (different model file, same `db:generate packs` run).

---

### B6 — `reward_draw`: add the `vault_pull_id` index + declare the hand-written unique

**File:** `src/modules/packs/models/reward-draw.ts:4-7, 27-34`.

Two things on one table, one `db:generate`:

**(a)** No index on `vault_pull_id`, but `store/vault/route.ts:84-87` and `service.ts:4089-4094` (rewards summary `ship_prizes`) both do `listRewardDraws({ vault_pull_id: [...] })`. Forced plan is a full traversal of `UQ_reward_draw_customer_day_ordinal` with `Filter: vault_pull_id = ANY(...)`.

**(b)** `UQ_reward_draw_customer_day_ordinal` exists in the live DB but only in a hand-written migration (`Migration20260625000100.ts`), not in the model — so anyone regenerating or reasoning about this table from the model doesn't see it. Its stated justification (_"db:generate cannot emit partial-expression unique indexes"_) is **false**: its predicate is pure `deleted_at IS NULL`, structurally identical to the already-model-declared `IDX_reward_draw_customer_day` on the same table, and `notification-read.ts:13-19` + `Migration20260623212927.ts:3-4` prove the generator emits partial uniques correctly.

```diff
   .indexes([
     // Fast daily-cap COUNT: COUNT WHERE customer_id AND draw_day = today
     {
       name: 'IDX_reward_draw_customer_day',
       on: ['customer_id', 'draw_day'],
       where: 'deleted_at IS NULL',
     },
+    // Vault + rewards summary join reward pulls back to their draw row:
+    // listRewardDraws({ vault_pull_id: [...] }) — store/vault/route.ts:84,
+    // service.ts:4090.
+    {
+      name: 'IDX_reward_draw_vault_pull_id',
+      on: ['vault_pull_id'],
+      where: 'deleted_at IS NULL',
+    },
+    // Daily-cap arbiter. Applied by Migration20260625000100 before it was
+    // declared here; db:generate emits this shape fine.
+    {
+      name: 'UQ_reward_draw_customer_day_ordinal',
+      on: ['customer_id', 'draw_day', 'draw_ordinal'],
+      unique: true,
+      where: 'deleted_at IS NULL',
+    },
   ]);
```

Also fix the false comment at `reward-draw.ts:4-7` (and the matching claims in `Migration20260625000100.ts:2-4`, `Migration20260622161000.ts:11`, `Migration20260623100000.ts:6`).

**Do not** use `where: 'vault_pull_id IS NOT NULL AND deleted_at IS NULL'` for (a). The compound predicate is not a planner risk, but its _emittability_ is unproven: the only compound-predicate index in this module (`vip-reward-grant.ts:25`) landed in `Migration20260704070016.ts:13` with **unquoted** column names — the hand-written signature — versus the generated `("customer_id","level","kind")` style. Skipping `IS NOT NULL` costs only index entries for NULL rows on a table that is currently empty.

**Why here:** model DSL, and (b) is specifically about moving schema ownership _back_ to the model.

**Verify:** standard loop + `\d reward_draw`. For (b), the ideal outcome is that `db:generate` emits **nothing** for `UQ_reward_draw_customer_day_ordinal` (model now matches DB) and only creates the new `vault_pull_id` index. If it emits a drop+recreate, that's still safe here — `reward_draw` is 0 rows.

Context: `reward_draw` is 0 rows and `pull` has zero `source='reward'` rows; the whole reward economy is fail-closed behind `REWARDS_REDEMPTION_ENABLED` (`rewards-gate.ts:8`). The index is free to add now and should be in place before Phase P.

**Effort:** trivial. **Batchable** with B5.

---

### B7 — `/admin/customers/:id/gacha`: replace the paged JS fold with one SQL aggregate

**Files:** `src/modules/packs/service.ts` (new method beside `vaultLiabilityMyr` at :2645) + `src/api/admin/customers/[id]/gacha/route.ts:49-71`.

`pageAll((opts) => packs.listPulls({ customer_id: id, status: 'vaulted' }, opts))` (PAGE=1000, uncapped) hydrates a customer's entire vault into Node purely for the SUM at `:64-70` and the handles set at `:58`. Vaulted pulls are not rendered (only the `RECENT`-capped `pulls` are, `:122-140`), so narrowing is safe. The identical aggregate already exists globally-scoped at `service.ts:2645-2664`.

```ts
// src/modules/packs/service.ts, beside vaultLiabilityMyr
@InjectManager()
async vaultSummaryMyrForCustomer(
  customerId: string,
  fx: number,
  @MedusaContext() sharedContext: Context = {},
): Promise<{ count: number; liability: number }> {
  const em = (sharedContext.transactionManager ??
    sharedContext.manager) as unknown as LedgerSqlManager;
  const rows = await em.execute<{ n: string; cents: string }[]>(
    'SELECT COUNT(*)::bigint AS n, ' +
      '       COALESCE(SUM(ROUND(c.market_value * ? * 100)), 0)::bigint AS cents ' +
      '  FROM pull p ' +
      '  LEFT JOIN card c ON c.handle = p.card_id AND c.deleted_at IS NULL ' +
      " WHERE p.customer_id = ? AND p.status = 'vaulted' AND p.deleted_at IS NULL",
    [fx, customerId],
  );
  return { count: Number(rows[0]?.n ?? 0), liability: Number(rows[0]?.cents ?? 0) / 100 };
}
```

**`LEFT JOIN`, not `INNER JOIN`.** `vaultLiabilityMyr` uses INNER deliberately ("orphaned card refs drop out"), but this route's `vault.count` is `vaulted.length` — every vaulted pull regardless of card match — and it is the headline "Vault" number in `apps/admin/src/routes/customers/[id]/page.tsx:289`. There is no FK from `pull.card_id` to `card.handle` (`pg_constraint` on `pull` = `pull_source_check`, `pull_status_check`, `pull_pkey` only), and the live DB has 8 orphaned rows against 77 matched — INNER would silently under-report 85 → 77 in a finance view. `IDX_card_handle_unique` guarantees the LEFT JOIN cannot fan out. The `LEFT JOIN` also exactly reproduces the JS `card ? displayMarketPrice(...) : 0` branch.

Route changes: drop the `pageAll` entry and the `vaultValueCents` reduce (`:64-70`); narrow `:58` to `[...new Set(pulls.map((p) => p.card_id))]`; emit `vault: { count, market_value: liability }`. **The call must move to the second `Promise.all`** (with `creditSummary`/`listVipLevels`/`listVipMemberStates`) — `fx` comes from `resolveFxRate` in the first batch and is not yet resolved there.

**Why here:** read-path refactor. No schema, no migration, no model edit. Matches `leaderboardTop` / `profileStatsForCustomer` / `ledgerReasonTotals`.

**Verify:** `corepack yarn check-types`, plus one assertion that the new count equals the old `vaulted.length` for a customer holding an orphaned `card_id` — the local DB has 8 such rows and that is exactly the regression an INNER JOIN would ship.

**Effort:** small.

---

### B8 — `/admin/economy` and `/admin/pricing/health`: project the columns

**Files:** `src/api/admin/economy/route.ts:44,69`; `src/api/admin/pricing/health/route.ts:25`.

`economy/route.ts:44` pages the whole `card` table with all 27 columns — including `image`, `slab_image`, `slab_image_key`, and three jsonb sidecars (`raw_market_value`, `raw_price`, `raw_market_multiplier`) — to build a two-field map (`handle`, `market_value`) at `:50-55`. `:69` pages all of `pack_odds` (14 columns) to read three (`pack_id`, `card_id`, `weight`).

```diff
-const allCards = await pageAll((opts) => packs.listCards({}, opts));
+const allCards = await pageAll((opts) =>
+  packs.listCards({}, { ...opts, select: ['id', 'handle', 'market_value'] }),
+);
...
-const allOdds = await pageAll((opts) => packs.listPackOdds({}, opts));
+const activeSlugs = allPacks.map((p) => p.slug);
+const allOdds = activeSlugs.length
+  ? await pageAll((opts) =>
+      packs.listPackOdds({ pack_id: activeSlugs }, { ...opts, select: ['pack_id', 'card_id', 'weight'] }),
+    )
+  : [];
```

Details:

- Include `id` in the card select. `pageAll` orders by `id` (`page-all.ts:18`), unlike every existing `select` precedent here (all single-page `take: 1000`). MikroORM auto-includes the PK on partial loads so it would likely work anyway; `challenge/route.ts:92` already selects `id` explicitly. Free insurance.
- **The odds win is the `select`, not the filter.** All 5 packs are currently `status='active'`, so `pack_id: activeSlugs` discards zero rows today — keep it as future-proofing, but the saving is skipping `credit_amount` + its `raw_credit_amount` jsonb.
- `select` on a `model.bigNumber()` column consumed via `Number(...)`/`toMoney()` is precedented: `store/vip/route.ts:33` and `admin/customers/[id]/gacha/route.ts:76` both select `spend_threshold` without its `raw_` sidecar.
- `pricing/health/route.ts:25` reads only `c.pc_product_id` (:26), `c.pc_synced_at` (:29-33), `c.handle` (:40) → `select: ['handle', 'pc_product_id', 'pc_synced_at']`. That file already uses `select: ['handle']` at :44.
- **Do NOT narrow `src/api/admin/cards/route.ts:25`.** It feeds `toAdminCardDto` and renders the full admin catalog row — it legitimately needs the wide select.
- No reorder needed: line 66 (`allPacks`) already precedes line 69 (`allOdds`).

**Why here:** application code only. No schema, no migration.

**Verify:** `corepack yarn check-types`; load both admin pages against the local backend and confirm identical numbers.

**Effort:** small. Hygiene — 3 cards / 3 odds rows today, so zero measurable gain now.

---

## C. Configuration & operations

### C1 — Pin the Postgres connection pool (highest-severity item in this audit)

**Files:** `backend/packages/api/medusa-config.ts:159-165`; `.do/backend.app.yaml` (per-component env).

`medusa-config.ts:159-165` is the only `databaseDriverOptions` block and sets `connection.ssl` alone — **no `pool`**. Repo-wide grep for `pool_size|DB_POOL|poolSize|databaseDriverOptions` returns two hits (that line, plus a comment). Empirically confirmed by running Medusa's own `createPgConnection` with the exact shape `pg-connection-loader.js:24-28` builds when no pool is configured: **`min/max = 2 / 10`** (knex `poolDefaults()` fills `max: undefined`).

The pool is **per process, not per module** (`medusa-app-loader.js:69-90` injects one shared `PG_CONNECTION` into all ~25 modules; no second pool exists in `src/`). Deploy shape: `backend` (1 instance, worker-mode server) + `worker` (1 instance) + a **PRE_DEPLOY `migrate` job that runs while the old containers still serve**. Idle floor is 4; burst ceiling is 20 steady / **30 during a deploy**.

Verified out-of-band via read-only `doctl databases list`: `polycards-pg` is `db-s-1vcpu-1gb` — DO's floor plan, **25 connections total, ~22 usable**. No pooler: every `25061` hit in the repo is the Valkey/Redis URL, never a PG pooler endpoint. Failure mode is a full API outage (`KnexTimeoutError` on every acquire) with a healthy DB, reachable by any traffic spike overlapping a deploy.

```ts
...(isProduction
  ? {
      databaseDriverOptions: {
        connection: { ssl: { rejectUnauthorized: false } },
        pool: {
          min: 0,
          max: Math.max(1, Number.parseInt(process.env.DB_POOL_MAX ?? '', 10) || 5),
        },
        idle_in_transaction_session_timeout: 30_000,   // see C2
      },
    }
  : {}),
```

Non-negotiable details:

- **The parse guard is not stylistic.** `Number(process.env.DB_POOL_MAX ?? 5)` yields `Number('') === 0` for a DO env var that is _declared but blank_ — the common case when adding a per-component var — and `max: 0` means every acquire hangs to the 60s timeout. A total, self-inflicted outage on the very deploy that adds the cap. Non-numeric gives NaN, also broken.
- **`pool` must be a SIBLING of `connection`, not nested inside it.** `pg-connection-loader.js:20-28` reads `driverOptions.pool` at the top level and `delete`s it before forwarding the rest.
- `min: 0` propagates intact (`?? 2` not `||` at loader:24; `pool?.min ?? 1` then a spread in `create-pg-connection.js`; lodash `defaults` only fills `undefined`). Idle-connection-vs-cold-connect tradeoff only — the `max` cap is the actual fix.
- Sizing: `max = floor((usable - reserved) / (instances + 1 for the overlapping migrate job))`. Divisor is **3**, not 2. `max 5` per component → 15 peak, leaving room for an admin psql. Set `DB_POOL_MAX` per component in `.do/backend.app.yaml` so the worker can run leaner. (`deploy:migrate-user` chains three Medusa boots — `db:migrate` + two `medusa exec` — but sequentially, so it contributes one pool at a time.)
- **Real mitigation:** attach DO's managed connection pool (**transaction mode**) and repoint `DATABASE_URL` at port 25061. Safe _here specifically_ because the locking module is Redis-backed (`medusa-config.ts:106-118` registers `@medusajs/medusa/locking` + `locking-redis`) — no session-scoped PG state that transaction pooling would break. State that precondition; it is not portable.

**Why here:** `projectConfig`, not the model layer. No models/migrations involved.

**Verify:** `corepack yarn check-types`; reproduce the resolved pool locally by executing `ModulesSdkUtils.createPgConnection` with the new shape and asserting `min/max`. Post-deploy: `SHOW max_connections;` on prod and watch active connection count across a deploy.

**Effort:** small. **Ships first.**

---

### C2 — Set the three session timeouts (none configured in-repo; prod values unverified)

**Files:** `backend/packages/api/medusa-config.ts:159-165` (part a); prod `DATABASE_URL` / cluster role (part b).

`create-pg-connection.js:22-33` builds the knex `connection` as a literal object containing exactly `{connectionString, ssl, idle_in_transaction_session_timeout, connectionTimeoutMillis, keepAlive, keepAliveInitialDelayMillis}`. So `statement_timeout` and `lock_timeout` set in `databaseDriverOptions` are **silently dropped**; only `idle_in_transaction_session_timeout` is a real passthrough. `medusa-config.ts` sets none; repo-wide grep for `statement_timeout|lock_timeout|idle_in_transaction|ALTER ROLE|ALTER DATABASE|options=-c` returns **zero** matches outside node_modules.

That establishes only that none of the three is configured **in this repository**. The effective production values are unknown: a cluster-level `ALTER ROLE`/`ALTER DATABASE` override would leave no trace here. Postgres's own default is 0 (disabled) for all three, so 0 is the likely case and the one worth planning against — but confirm with `SHOW statement_timeout; SHOW lock_timeout; SHOW idle_in_transaction_session_timeout;` on prod before and after, rather than treating it as established.

**(a) `idle_in_transaction_session_timeout` — config, one line.** Already folded into the C1 snippet above (it's the same `databaseDriverOptions` edit — do not make two separate edits). 30s is safe: every `@InjectTransactionManager` method in `service.ts` (501, 543, 681, 865, 932, 1146, 1204, …) is DB-only; `fetch`/axios live exclusively in non-transactional routes and jobs (`api/admin/*`, `modules/packs/pricing.ts`, `jobs/sync-market-prices.ts`).

**(b) `statement_timeout` / `lock_timeout` — raw, app-scoped.** Medusa forwards neither and the model DSL has no concept of a server GUC, so this cannot live in a model file. Prefer the **app-only URL path**, which `pg` honours (`connection-parameters.js:83,139):

```dotenv
DATABASE_URL=...?options=-c%20statement_timeout%3D60000%20-c%20lock_timeout%3D5000
```

set on the **runtime** components only, leaving the `migrate` job's URL without it.

**Do NOT use** `ALTER ROLE <app_user> IN DATABASE <db> SET statement_timeout='60s'` as a first choice. It binds to the _role_, so it also applies to the PRE_DEPLOY `db:migrate` connection; Medusa's migrator never issues `SET statement_timeout = 0` for itself and emits plain non-`CONCURRENT` `CREATE INDEX`, which statement_timeout kills. A latent deploy-failure trap (largest table is 1030 rows today, so not imminent — but the trap is structural). If a role-level setting is unavoidable, pair it with an explicit `SET statement_timeout = 0` in the migrate step and document it.

`lock_timeout = 5s` is safe either way and is the point: a blocked DDL fails the deploy loudly instead of queueing behind a long query and wedging prod.

Since `DATABASE_URL` is a redacted SECRET injected by `scripts/do-apply.ps1` from gitignored `deploy/.env.deploy`, **record the change in `docs/ops/`** — neither URL options nor role-level settings survive a cluster fork (which is how `polycards-pg` was created, per `docs/ops/infra-rename-migration-runbook.md:97-101`).

**Verify:** `corepack yarn check-types` for (a). Post-deploy, on prod: `SHOW statement_timeout; SHOW lock_timeout; SHOW idle_in_transaction_session_timeout;`.

**Effort:** small.

---

## D. Deferred — needs production volume, not a code decision

### D1 — Declare the four hand-written `credit_transaction` indexes in the model (gated on a dry run)

`UQ_credit_txn_pack_open_debit_open_id`, `IDX_credit_transaction_commission_idem`, `IDX_credit_transaction_reversal_reference`, `IDX_credit_transaction_pack_open_created_at` exist in the live DB (from `Migration20260622161000` / `20260623001000` / `20260623100000` / `20260703150000`) but not in `models/credit-transaction.ts`, so anyone reasoning about this table from the model sees a ledger with **no idempotency arbiters at all**.

**Do not just declare them.** Postgres normalizes the stored predicates away from source text (`amount > 0` → `(amount > (0)::numeric)`, `reason IN (...)` → `= ANY (ARRAY[...])`, `LIKE` → `~~`). If MikroORM's differ doesn't round-trip that, `db:generate` emits `drop index; create unique index` — the pattern `Migration20260704070016.ts:12-13` already shows — which on the production ledger is a write-blocking rebuild that leaves the **double-charge arbiter absent for the rebuild window**. Strictly worse than the drift.

**Procedure:** on a throwaway branch, add all four to `.indexes([...])`, run `corepack yarn medusa db:generate packs` against a migrated clone, and adopt **only if the emitted migration is empty**. Encouraging sign: `UQ_vip_reward_grant_customer_level_kind` (this repo's one model-declared value-predicate index, DB-normalized to `(origin = 'ladder'::text)`) was not re-dropped by any generated migration after `Migration20260704070016`. If it churns, leave them hand-written and instead correct their migration comments to state the real reason.

**Cheaper alternative that closes the actual gap** (recommended regardless): one integration test that queries `pg_indexes` for the five index names against the migrated test DB. Unlike the existing `addSql`-stub regex specs (`hardening-migration.unit.spec.ts`, `reward-draw-unique.unit.spec.ts`), it validates the post-migration **schema** rather than one file's emitted string, and catches any future loss.

Also fix the stale comment at `service.ts:929-931` — it claims "no DB unique on reference" while `IDX_credit_transaction_reversal_reference` has existed since `Migration20260623001000`.

### D2 — `/admin/pulls`: move the rollup into SQL

`src/api/admin/pulls/route.ts:20,36-39,52-54,63-81` reads 5000 full `pull` rows per request (separate from the paginated ledger read at `:40-43`) to fold three JS Maps into a top-10 and a rarity histogram. Past 5000 rows the "top cards / top rarities" become newest-5000 rollups presented as global, with no operator signal.

86 rows today, admin-only, display-only, one operator. **Defer** — the SQL rewrite is the right long-term shape but is not worth the semantic risk now. If touched, three things must be preserved and the naive SQL gets them wrong:

1. `topCards.rarity` is the rarity a card was most often **pulled** at (`cardRarityCounts` increments per pull). A standalone `SELECT ... FROM pack_odds GROUP BY rarity ORDER BY count(*)` counts _odds rows_ and flips the answer for a card listed Common in three packs but usually pulled from the one listing it Rare. Derive it from the `pull ⋈ pack_odds` join grouped by `(card_id, rarity)`.
2. `route.ts:69` **skips** pulls whose rarity is null; `pack_odds.rarity` is nullable. Use `WHERE o.rarity IS NOT NULL`, not `COALESCE(o.rarity,'Common')`, which would inflate the Common bucket.
3. Rarity is keyed on the `(pack_id, card_id)` **pair** (`route.ts:55-59`) — join on both columns.

Also decide explicitly whether the aggregate is all-time or keeps the 5000 window; dropping the cap changes displayed numbers. `profileStatsForCustomer` keeps its cap as a `LIMIT 20000` CTE — follow that if parity matters.

Cheapest defensible action today: leave the route alone and document the cap in the admin UI.

### D3 — Autovacuum tuning / retention / partitioning: revisit on volume, not on time

Checked and clean. Largest module table is `credit_transaction` at 1030 rows / 680 kB; largest table in the DB is `pixel_pokemon` at 736 kB. Growth from the only two schedulers: `sync-market-prices.ts:95` (`0 3 * * *`, ~1.1k `card_price_history` rows/yr against 3 cards) and `mature-commissions.ts:57` (`0 * * * *`, updates not appends). No `feed_event`/`audit_log` table exists.

Revisit triggers are volume-based: `credit_transaction` past ~10⁷ rows → `ALTER TABLE credit_transaction SET (autovacuum_vacuum_scale_factor = 0.02)`; any table past ~10 GB → partition by `created_at`. Both are per-table storage parameters outside `model.define(...).indexes([...])`, so raw SQL would be correct _then_.

---

## Apply order

Group order is not apply order. Ship in this sequence:

1. **C1 + C2(a) — one edit, ships first, alone.** The `databaseDriverOptions` block gets `pool` and `idle_in_transaction_session_timeout` in a single change. Highest severity in the audit, verified plan ceiling (25 conns), and a config-only diff. Deploy and watch connection counts across one full deploy cycle before anything else lands.
2. **A1 — ships next, alone.** Same failure mode as C1 from the application side (nested connection checkout). Landing it after the pool cap means the cap is enforced against a workload that no longer doubles its own connection demand. Needs a full integration run.
3. **C2(b)** — `statement_timeout`/`lock_timeout` on the runtime `DATABASE_URL`, plus the `docs/ops/` note. Independent of everything else; can go with step 1 if the deploy secret is being edited anyway.
4. **B1 + B3 + B4 + B5 + B6 — batch together.** All five are model-file index edits in `src/modules/packs/models/*.ts`, resolved by ONE `corepack yarn medusa db:generate packs`. **Read the emitted migration before applying** — specifically confirm B1 produced both a `drop index` and the flipped `create unique index`. All affected tables are ≤1030 rows, so index builds are instantaneous; no maintenance window needed.
5. **B2 + B7 + B8 — batch together.** Read-path/application-only, no schema, no migration, independently revertable.
6. **A2, then A3 — each ships alone.** Money/goods correctness restructures with real behavioural surface (error copy, compensation contracts, auto-unfreeze). Do not batch with each other or with anything else; each needs its own integration run and its own revert boundary.
7. **D1** — only after its dry run shows an empty diff. **This is the one prod-locking item in the plan**: if `db:generate` churns the four `credit_transaction` idempotency indexes, applying it drops and rebuilds the double-charge arbiter on the live ledger. Maintenance-aware deploy, or don't ship it — take the `pg_indexes` integration test instead.
8. **D2, D3** — no action; volume triggers recorded above.

---

## Not applicable

Checked and deliberately excluded:

- **RLS / row-level security policies, PostgREST grants, `anon`/`authenticated` roles, `SECURITY DEFINER` audits, `search_path` pinning on policy functions.** This is plain Postgres. There is no Supabase, no PostgREST, no anon role. Authorization is app-level Medusa. Any RLS finding here would be noise.
- **`CREATE INDEX CONCURRENTLY` anywhere.** Medusa wraps migrations in a transaction, where `CONCURRENTLY` errors out — documented in-repo at `Migration20260622161000.ts:12-15`. An earlier draft of B5(b) proposed it; it would have failed on deploy.
- **A unique constraint on `delivery_order_item(pull_id)`.** Correctly ruled out: cancel re-vaults the pull (`service.ts:3295`) without deleting the item row, so a unique would block legitimate re-requests. The "live order" predicate needs a join, which a partial index cannot express.
- **Autovacuum tuning, retention policies, table partitioning.** Measured, not skipped — see D3.
- **`pull.card_id` partial index on `status IN ('vaulted','delivering')`** — rejected in B3; no IN-list precedent in any of the 27 model `where:` strings, and a value predicate is proof-fragile under generic plans.
- **`reward_draw` compound `vault_pull_id IS NOT NULL AND deleted_at IS NULL` predicate** — rejected in B6; the module's only compound-predicate index landed hand-written (unquoted columns), so emittability is unproven and the refinement buys nothing on a 0-row table.
- **Narrowing `src/api/admin/cards/route.ts:25`** — it legitimately needs all card columns for `toAdminCardDto`.
- **Raising `pool.max` as a response to A1** — moves the cliff, doesn't remove the nested checkout.
- **Advisory lock in `recordDeliveryRequest` (A3)** — no read-modify-write on that path; the guarded UPDATE is already the enforcer. Adding it is pure contention.

Refuted impact claims a reader might expect to see, and shouldn't:

- `reward_draw`'s missing index does **not** cost anything today: zero `source='reward'` pulls, feature fail-closed behind `REWARDS_REDEMPTION_ENABLED`, and both call sites short-circuit on an empty id list.
- `reverseOpen`'s scan does **not** run inside the advisory lock — the fetch (946/951) precedes the lock (974), and the lock set is derived from the scan results.
- The `credit_transaction` topup/voucher idempotency gap is **not** currently exploitable — no writer bypasses `mutateCreditAtomic`, and the lock key is deterministic in every caller.
- A1's nested checkout is **per nested query**, not held for the whole transaction; it terminates at knex's 60s `acquireConnectionTimeout` rather than deadlocking permanently.
- The `backend/.claude/lessons.md` "KnexTimeout" citation attached to A1 in the original finding is false — that file has no such entry. The repo's actual pool-full history (`.claude/skills/launching-pokenic-stack/SKILL.md:57`) is orphaned worktree `medusa develop` watchers exhausting `max_connections`, an unrelated cause.

---

## Could not measure

Everything above is ranked on structural facts (index definitions, column types, call-site shapes, row counts, `EXPLAIN` structure) from a clone of prod **data**. Local `pg_stat_statements` / index-scan / seq-scan counters reflect only dev + test traffic and were not used to rank anything. These need production instrumentation before they can be ordered against each other:

- **Prod `SHOW max_connections`.** Requires the redacted `DATABASE_URL` plus a firewall entry. C1's sizing rests on DO's documented allocation for `db-s-1vcpu-1gb` (25 total, ~3 reserved) and the verified plan slug — enough to establish the floor, but the exact number should be confirmed before finalizing `DB_POOL_MAX`.
- **Prod `SHOW statement_timeout / lock_timeout / idle_in_transaction_session_timeout`.** C2 infers 0 from repo absence; a cluster-level override would leave no trace in this repo. Confirm before and after.
- **Request rate on `GET /store/notifications`.** B1's cost model (scan scales with total table size) is structurally proven, but "how hot" is unknowable here — storefront polling is out of scope and workload counters are barred.
- **Real per-customer vault sizes in prod over time.** B2's severity depends entirely on whether any customer approaches 500 vaulted pulls. Max today is 35, and the set drains as cards are sold/shipped.
- **Actual `pull` / `credit_transaction` / `card_price_history` growth rates under launch traffic.** Current ledger spans 2026-07-15 → 2026-07-20 at ~17 pulls/day. Every "unbounded growth" argument in B3/B5/B7 is a projection off that, not a measurement.
- **Whether any of the B7/B8/D2 admin reads are actually slow in prod.** All are admin-only, human-rate, and free at current volumes; `pg_stat_statements` on prod is the only thing that would justify promoting them.
- **Whether MikroORM's differ round-trips Postgres-normalized value predicates** (D1). Answerable locally via the dry run described there, but not from reading source.
