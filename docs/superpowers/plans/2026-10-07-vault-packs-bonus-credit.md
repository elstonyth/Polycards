# Vault Packs + Bonus Credit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins can gift unopened packs into a customer's vault (opened through the normal pack/spin pages as "Vault x1") and grant spend-only bonus credit (泥码); neither value can ever become withdrawable.

**Architecture:** Bonus credit is a signed `bonus_cents` column on the existing `credit_transaction` ledger, consumed first by `settleOpen` and carried onto each pull as `bonus_bp`, so buyback pays back in proportion. Gifts are rows in a new `pack_gift` table, claimed inside `openBatchWorkflow` by a compensated step before the charge. Gift and bonus pulls carry new `source` values (`gift`, `bonus`) so every positive `source='pack'` count excludes them for free.

**Tech Stack:** Medusa v2 + Mercur backend (`backend/packages/api`, MikroORM, Postgres), Medusa admin (Vite/React, `backend/apps/admin`), Next.js storefront (`src/`), Jest (backend), Vitest (storefront), Playwright (visual).

**Spec:** `docs/superpowers/specs/2026-10-07-vault-packs-bonus-credit-design.md`

## Global Constraints

- All money is MYR. Ledger math in integer sen; `amount` stays an RM decimal.
- Spend order on every open: **gifts → bonus → normal**. Bonus banks no playthrough.
- Bonus pays **pack opens only**. Every other debit is floored against the **Normal Balance** (Balance − Bonus Balance).
- Withdrawable = `gateOpen ? max(0, available − bonusBalance) : 0`.
- Sell-back of a pull pays `round(amountSen × bonus_bp / 10000)` as bonus; gift pulls `bonus_bp = 10000`.
- Gift and bonus pulls count toward nothing: Ranks, challenge, task rips/pixels, achievements (`vault_count`, lifetime pixel count), VIP, referral commission, feed, Telegram, profile, welcome-pack unlock.
- A stale "Vault xG" screen is refused with HTTP 409 `"Your vault pack is no longer available — refresh."` — never silently charged.
- Admin grants: audited, idempotency key, count toward `ADJUST_DAILY_MINT_MAX_RM` (gift = pack price × qty). Gift quantity 1–10; bonus amount ± up to RM 1,000,000, 2dp, note required (≤ 512).
- Gifts cannot target `free_welcome` / `reward_box` categories or a pack with `status != 'active'`.
- Migrations are hand-written; `.snapshot-packs.json` edited by node script only (memory: db:generate emits drift). Local `db:migrate` is not run — migration SQL is proven in http integration specs.
- The PostToolUse formatter can reflow unrelated lines; edit large existing files (`service.ts`, specs) by node script, then `git diff --stat` to confirm only intended hunks.
- Commit messages: conventional, end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Map

Backend (`backend/packages/api/src/`):

- Create `modules/packs/bonus-credit.ts` — pure sen math (consume, allocate, bp, share).
- Create `modules/packs/models/pack-gift.ts` — the gift row.
- Create `modules/packs/migrations/Migration20261007120000.ts` — all schema changes.
- Modify `modules/packs/models/{credit-transaction,pull,admin-action-audit}.ts` — new column/enum values.
- Modify `modules/packs/service.ts` — ledger core, wallet, turnover, gifts, admin grant, achievements.
- Modify `modules/packs/{credit-summary,vip-lifetime,economy,telegram,notify-feed}.ts`.
- Create `workflows/steps/claim-pack-gifts.ts`; modify `workflows/open-batch.ts`, `workflows/open-pack.ts`, `workflows/steps/{charge-pack-batch,charge-pack-open,record-pull,record-pulls-batch,buyback-pull,adjust-credits}.ts`.
- Modify routes: `api/store/packs/[slug]/open-batch/route.ts`, `api/store/packs/[slug]/open/route.ts`, `api/store/vault/route.ts`, `api/store/credits/route.ts`, `api/admin/customers/[id]/credits/route.ts`, `api/admin/customers/[id]/gacha/route.ts`, `api/admin/customers/[id]/pulls/route.ts`, `api/reports/growth/packs/route.ts`, `api/reports/finance/queries.ts`, `api/middlewares.ts`.
- Create routes: `api/store/pack-gifts/route.ts`, `api/admin/customers/[id]/pack-gifts/route.ts`, `api/admin/pack-gifts/[id]/revoke/route.ts`.
- Tests: `modules/packs/__tests__/bonus-credit.unit.spec.ts`, `modules/packs/migrations/__tests__/vault-packs-bonus.unit.spec.ts`, `integration-tests/http/bonus-credit.spec.ts`, `integration-tests/http/pack-gifts.spec.ts`, `integration-tests/http/vault-packs-migration.spec.ts`.

Admin (`backend/apps/admin/src/`): `routes/customers/[id]/page.tsx`, `lib/admin-rest.ts`, `lib/queries.ts` (+ new component file `routes/customers/[id]/gift-and-bonus.tsx`).

Storefront (`src/`): `lib/data/schemas.ts`, `lib/actions/{packs,pack-gifts,wallet}.ts`, `lib/roll-batch.ts`, `lib/vault-packs.ts` (label builder + test), `app/slots/[slug]/PackDetailClient.tsx`, `app/slots/[slug]/spin/{page,SlotMachineClient}.tsx`, `app/(account)/vault/VaultClient.tsx` (+ sell modal), `app/(account)/wallet/page.tsx`, transactions list, `lib/notifications/copy.ts`.

Docs: `CONTEXT.md`, `docs/adr/0010-bonus-credit-is-a-ledger-column.md`.

---

### Task 1: Pure bonus math

**Files:** Create `backend/packages/api/src/modules/packs/bonus-credit.ts`; Test `backend/packages/api/src/modules/packs/__tests__/bonus-credit.unit.spec.ts`

**Interfaces — Produces:**

- `BONUS_BP_FULL = 10_000`
- `consumeBonusSen(totalSen: number, bonusBalanceSen: number): number`
- `allocateBonusSen(priceSen: number, rows: number, bonusSen: number): number[]` (row order, at most one partial)
- `bonusBpFor(bonusSen: number, priceSen: number): number`
- `bonusShareSen(amountSen: number, bp: number): number`
- `bonusShareMyr(amount: number, bp: number): number`
- `pullSourceFor(row: { gift: boolean; bonusSen: number }): 'gift' | 'bonus' | 'pack'`

- [ ] **Step 1: Write failing tests**

```ts
import {
  BONUS_BP_FULL,
  allocateBonusSen,
  bonusBpFor,
  bonusShareMyr,
  bonusShareSen,
  consumeBonusSen,
  pullSourceFor,
} from '../bonus-credit';

describe('bonus credit math', () => {
  it('consumes bonus first, never more than the total or the balance', () => {
    expect(consumeBonusSen(30000, 27000)).toBe(27000);
    expect(consumeBonusSen(30000, 50000)).toBe(30000);
    expect(consumeBonusSen(30000, 0)).toBe(0);
    expect(consumeBonusSen(30000, -5)).toBe(0);
    expect(consumeBonusSen(0, 100)).toBe(0);
  });
  it('allocates bonus row by row, at most one partial row', () => {
    expect(allocateBonusSen(30000, 2, 40000)).toEqual([30000, 10000]);
    expect(allocateBonusSen(30000, 3, 27000)).toEqual([27000, 0, 0]);
    expect(allocateBonusSen(30000, 1, 0)).toEqual([0]);
    expect(allocateBonusSen(30000, 0, 500)).toEqual([]);
  });
  it('turns bonus sen into basis points of the row price', () => {
    expect(bonusBpFor(27000, 30000)).toBe(9000);
    expect(bonusBpFor(30000, 30000)).toBe(BONUS_BP_FULL);
    expect(bonusBpFor(1, 30000)).toBe(0);
    expect(bonusBpFor(100, 0)).toBe(0);
  });
  it('splits a sell-back by basis points', () => {
    expect(bonusShareSen(27000, 9000)).toBe(24300);
    expect(bonusShareSen(27000, BONUS_BP_FULL)).toBe(27000);
    expect(bonusShareSen(27000, 0)).toBe(0);
    expect(bonusShareMyr(270, 9000)).toBe(243);
    expect(bonusShareMyr(0.07, 5000)).toBe(0.04);
  });
  it('labels a row by how it was paid', () => {
    expect(pullSourceFor({ gift: true, bonusSen: 0 })).toBe('gift');
    expect(pullSourceFor({ gift: false, bonusSen: 1 })).toBe('bonus');
    expect(pullSourceFor({ gift: false, bonusSen: 0 })).toBe('pack');
  });
});
```

- [ ] **Step 2: Run** `corepack yarn test:unit src/modules/packs/__tests__/bonus-credit.unit.spec.ts` from `backend/packages/api` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// Bonus credit (泥码) — spend-only credit, pure sen math. Kept DB-free like
// external-funded.ts so the rules are unit-testable. All inputs/outputs are
// integer sen unless named Myr. Spec 2026-10-07 §4.

/** A gift pull sells back entirely as bonus. */
export const BONUS_BP_FULL = 10_000;

/** Bonus spent by an open of `totalSen`: bonus first, capped both ways. */
export function consumeBonusSen(
  totalSen: number,
  bonusBalanceSen: number,
): number {
  return Math.max(0, Math.min(totalSen, bonusBalanceSen));
}

/** A batch's bonus split over its paid rows in row order (at most one partial). */
export function allocateBonusSen(
  priceSen: number,
  rows: number,
  bonusSen: number,
): number[] {
  let left = Math.max(0, bonusSen);
  return Array.from({ length: rows }, () => {
    const take = Math.min(priceSen, left);
    left -= take;
    return take;
  });
}

/** Share of a row's price paid in bonus, in basis points. */
export function bonusBpFor(bonusSen: number, priceSen: number): number {
  if (priceSen <= 0 || bonusSen <= 0) return 0;
  return Math.min(
    BONUS_BP_FULL,
    Math.round((bonusSen * BONUS_BP_FULL) / priceSen),
  );
}

/** The bonus part of a sell-back of `amountSen`. */
export function bonusShareSen(amountSen: number, bp: number): number {
  return Math.round(
    (amountSen * Math.max(0, Math.min(BONUS_BP_FULL, bp))) / BONUS_BP_FULL,
  );
}

export function bonusShareMyr(amount: number, bp: number): number {
  return bonusShareSen(Math.round(amount * 100), bp) / 100;
}

export function pullSourceFor(row: {
  gift: boolean;
  bonusSen: number;
}): 'gift' | 'bonus' | 'pack' {
  if (row.gift) return 'gift';
  return row.bonusSen > 0 ? 'bonus' : 'pack';
}
```

- [ ] **Step 4: Run** the spec → PASS.
- [ ] **Step 5: Commit** `feat(bonus): pure bonus credit math`.

---

### Task 2: Schema (models, migration, snapshot, enums)

**Files:**

- Create: `modules/packs/models/pack-gift.ts`, `modules/packs/migrations/Migration20261007120000.ts`, `modules/packs/migrations/__tests__/vault-packs-bonus.unit.spec.ts`
- Modify: `models/credit-transaction.ts`, `models/pull.ts`, `models/admin-action-audit.ts`, `service.ts` (register `PackGift`, `CreditMutationReason += 'bonus_grant'`), `notify-feed.ts` (`FeedTemplate += 'pack_gift_received' | 'bonus_credit_received'`), `.snapshot-packs.json` (script).

**Interfaces — Produces:** model `PackGift` (service gets `createPackGifts/listPackGifts/updatePackGifts`), `credit_transaction.bonus_cents: number | null`, `pull.bonus_bp: number` (default 0), `pull.source` enum `pack|reward|free|gift|bonus`, reason `bonus_grant`, audit entity `pack_gift`, actions `grant_pack_gift`, `revoke_pack_gift`, `grant_bonus_credit`.

`PackGift` model:

```ts
import { model } from '@medusajs/framework/utils';

// pack_gift — an admin-granted unopened Pack for one customer (spec
// 2026-10-07 §3.1). Shown in the Vault UI but NOT a Pull (ADR 0001 stands):
// an Open claims it (opened_at + open_id) and stamps the pull it became.
// Unopened = opened_at IS NULL AND revoked_at IS NULL, or a claim older than
// GIFT_CLAIM_LEASE_MS that never got its pull (a crashed open).
export const PackGift = model
  .define('pack_gift', {
    id: model.id({ prefix: 'pgift' }).primaryKey(),
    customer_id: model.text(),
    pack_id: model.text(), // = Pack.slug
    value_myr: model.bigNumber(), // pack price at grant — the mint-cap basis
    note: model.text(),
    granted_by: model.text(),
    grant_key: model.text(),
    open_id: model.text().nullable(),
    pull_id: model.text().nullable(),
    opened_at: model.dateTime().nullable(),
    revoked_at: model.dateTime().nullable(),
    revoked_by: model.text().nullable(),
  })
  .indexes([
    {
      name: 'IDX_pack_gift_customer_pack',
      on: ['customer_id', 'pack_id', 'created_at'],
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_pack_gift_grant_key',
      on: ['grant_key'],
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_pack_gift_created_at',
      on: ['created_at'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default PackGift;
```

Migration SQL (up): add `credit_transaction.bonus_cents integer null`; swap `credit_transaction_reason_check` to the full list + `bonus_grant`; add `pull.bonus_bp integer not null default 0`; swap `pull_source_check` to `pack, reward, free, gift, bonus`; create `pack_gift` (+ indexes + pkey + bigNumber `raw_value_myr jsonb not null`); swap both `admin_action_audit` CHECKs (copy the full lists from `Migration20261006110000.ts`, append `pack_gift` to entity types and the three actions). Down: refuse while any `bonus_grant`, `gift`/`bonus` pull, or `pack_gift` audit row exists; then reverse.

- [ ] Step 1: Unit spec pins the emitted CHECK lists (pattern: `migrations/__tests__/task-kind-daily.unit.spec.ts`) — the reason list contains `bonus_grant`, the source list `gift` and `bonus`, audit lists contain the new values, and every value already in the models is present.
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Write models, migration, service registration, enum unions; insert `pack_gift` table + new columns into `.snapshot-packs.json` by node script (`JSON.parse` → splice → `JSON.stringify(j, null, 2)`).
- [ ] Step 4: Run unit spec → PASS; `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → clean.
- [ ] Step 5: Commit `feat(bonus): schema for pack gifts and bonus credit`.

---

### Task 3: Ledger core — bonus balance, consume, floors, wallet, turnover, reports

**Files:** Modify `modules/packs/service.ts` (`mutateCreditAtomic`, `settleOpen`, `reverseCreditTransaction`, `reverseOpen`, `creditSummary`, `walletSummary`, `lifetimeTurnoverSenFor`, `packTurnoverCentsByCustomer`, downline turnover query), `credit-summary.ts`, `vip-lifetime.ts`, `economy.ts`, `api/reports/finance/queries.ts`, `api/store/credits/route.ts`. Test: `integration-tests/http/bonus-credit.spec.ts` + updated unit folds.

**Interfaces — Produces:**

- `CreditMutationInput.bonusCents?: number` (only for `bonus_grant`; must equal amount sen).
- `settleOpen(...)` returns `{ id, balance, bonusCents }` (bonus sen consumed, ≥ 0).
- `creditSummary` returns `bonusBalance` (MYR) and VIP basis excluding bonus.
- `walletSummary(customerId, precomputed?: { balance, depositedCents, usedCents, bonusCents })` returns `bonus` (MYR) and `withdrawable` per Global Constraints.
- `/store/credits` → `wallet.bonus`, each transaction `bonus` (MYR, `bonus_cents/100`).

Rules (copy into code comments where they apply):

1. Every locked ledger read sums `COALESCE(SUM(bonus_cents), 0) AS bonus_cents` beside balance and ext.
2. `mutateCreditAtomic`: `bonus_grant` requires `bonusCents === deltaCents`; refuse if `bonusBefore + delta < 0` ("Bonus credit cannot go below RM 0."). Any other debit (`delta < 0`, reason ≠ `pack_open`): if `(before − bonusBefore) + delta < floor` refuse; message = when `before + delta >= floor` → `"Bonus credit can only be spent on packs — it can't pay for this."`, else the existing message. Insert `bonus_cents` = `bonusCents` for `bonus_grant`, else 0.
3. `settleOpen`: `bonusUsed = consumeBonusSen(-delta, bonusBalance)`; `ext = consumeExternalSen(-delta - bonusUsed, extBalance)`; insert `bonus_cents: -bonusUsed`; return `bonusCents: bonusUsed`.
4. Both reversal writers insert `bonus_cents: -(original.bonus_cents ?? 0)`.
5. VIP/referral turnover expression for `pack_open` rows: `ROUND(-amount * 100) + COALESCE(bonus_cents, 0)` (in `creditSummary.vip_spend_cents`, `lifetimeTurnoverSenFor`, `packTurnoverCentsByCustomer`, downline query). Folds mirror it (`credit-summary.ts`: `vipSpendCents += pack_open ? -cents + bonus : 0`, new `bonusBalanceCents`; `vip-lifetime.ts` rows accept optional `bonusCents`).
6. `economy.ts`: new bucket `bonusPromo` (Σ `bonus_grant`); revenue counts `pack_open` normal part (`cents − bonus`), payouts count `buyback` normal part; `LedgerRow` gains optional `bonusCents`. Finance queries (`api/reports/finance/queries.ts`) select `bonus_cents` and apply the same split.

- [ ] Step 1: Write `integration-tests/http/bonus-credit.spec.ts` (service-level, `medusaIntegrationTestRunner`, `getContainer().resolve(PACKS_MODULE)`):
  - grant RM 270 bonus via `mutateCreditAtomic({ reason: 'bonus_grant', amount: 270, bonusCents: 27000 })` + topup RM 500 → `walletSummary` balance 770, bonus 270, withdrawable 500 (playthrough satisfied by a prior deposit-funded open or grandfathered — seed a NULL-basis topup).
  - `settleOpen(-300)` → `bonusCents 27000`; row `bonus_cents -27000`, `external_funded_cents -3000` when ext ≥ 30.
  - delivery-fee debit of RM 600 with normal RM 500 → refused with the bonus message; RM 400 passes.
  - negative `bonus_grant` beyond bonus balance → refused.
  - `reverseOpen` restores bonus (wallet bonus back to 270).
  - `creditSummary.vipSpendTotal` excludes bonus part; `lifetimeTurnoverSenFor` too.
  - `/store/credits` (HTTP, customer token via existing test helpers) returns `wallet.bonus` and per-row `bonus`.
- [ ] Step 2: Run `node integration-tests/run-http-shards.mjs bonus-credit.spec` → FAIL.
- [ ] Step 3: Implement rules 1–6 (node-script edits to `service.ts`).
- [ ] Step 4: Run the spec + `corepack yarn test:unit src/modules/packs` (folds, economy) → PASS; re-run existing ledger specs: `pull-status-transitions.spec`, `credit-*.spec`, `withdrawal*.spec`, `referral*.spec`, `vip*.spec`, `economy*.spec`.
- [ ] Step 5: Commit `feat(bonus): bonus credit in the ledger, wallet and turnover`.

---

### Task 4: Admin bonus grant + mint cap

**Files:** Modify `service.ts` (`adminAdjustCredit` gains `bonus?: boolean`; `rollingAdjustmentMintCents` sums positive `adjustment` + positive `bonus_grant` + `pack_gift.value_myr` of the last 24h), `workflows/steps/adjust-credits.ts` (accept `kind`), `api/admin/customers/[id]/credits/route.ts` (body `kind?: 'credit' | 'bonus'`), `api/admin/customers/[id]/gacha/route.ts` (`bonus_balance`). Test: extend `bonus-credit.spec.ts`.

Behaviour: `kind: 'bonus'` → reason `bonus_grant`, `bonusCents = amountCents`, audit action `grant_bonus_credit` with `before/after: { balance, bonus }`, AD ledger payload `detail: 'bonus'`, idempotency hash includes `'bonus'`, replay compares reason too. On a positive grant, after commit, `notifyFeedNonfatal` template `bonus_credit_received` data `{ amount }` key `bonus-grant:<txnId>`. Invalid `kind` → 400 `"kind must be 'credit' or 'bonus'."`.

- [ ] Step 1: Specs: POST `/admin/customers/:id/credits` `{amount: 300, note, kind: 'bonus'}` → 200; gacha route shows `bonus_balance: 300`; replay same key returns same; mint cap counts it (set `ADJUST_DAILY_MINT_MAX_RM=500` in the spec env, second 300 grant refused); negative bonus beyond balance refused.
- [ ] Step 2–4: implement, run, pass.
- [ ] Step 5: Commit `feat(bonus): admins grant and take back bonus credit`.

---

### Task 5: Pack gifts — service, admin + store routes

**Files:** Modify `service.ts` (methods below), `api/middlewares.ts`; Create `api/admin/customers/[id]/pack-gifts/route.ts` (GET, POST), `api/admin/pack-gifts/[id]/revoke/route.ts` (POST), `api/store/pack-gifts/route.ts` (GET). Test `integration-tests/http/pack-gifts.spec.ts`.

**Interfaces — Produces (service):**

- `GIFT_CLAIM_LEASE_MS = 10 * 60 * 1000`; SQL fragment `UNOPENED_GIFT_SQL = "revoked_at IS NULL AND deleted_at IS NULL AND pull_id IS NULL AND (opened_at IS NULL OR opened_at < now() - interval '10 minutes')"`.
- `grantPackGifts({ customerId, packSlug, quantity, note, adminId, idempotencyKey }) → { gifts: PackGiftRow[]; replayed: boolean }` — validates pack (exists, `status='active'`, category not `free_welcome`/`reward_box`), quantity 1–10 integer, note 1–512; global mint-window lock + cap (value = price × qty); replay by `grant_key` (hash of admin, customer, key) returns existing; audit `grant_pack_gift` (`after: { pack_id, quantity }`); AD ledger `detail: '<slug> ×N'`, `ref_id = grant_key`. Takes the `credit-adjust:mint-window` lock (lock order global → customer); update the comment in `adminAdjustCredit` that says the lock is requested at one site. Post-commit notify `pack_gift_received` `{ pack_id, title, quantity }`.
- `revokePackGift({ giftId, adminId }) → { revoked: boolean }` — conditional UPDATE where unopened (no lease reclaim: `opened_at IS NULL`); 409 `"Already opened"` if 0 rows; audit `revoke_pack_gift`.
- `listPackGiftsForCustomer(customerId)` → all rows newest first with `state: 'unopened'|'opened'|'revoked'|'stuck'`.
- `unopenedPackGiftCounts(customerId) → { pack_id, count }[]`.
- `claimPackGifts({ customerId, packSlug, count, openId }) → string[]` — inside a transaction: freeze gate; `UPDATE pack_gift SET opened_at = now(), open_id = ? WHERE id IN (SELECT id FROM pack_gift WHERE customer_id = ? AND pack_id = ? AND <UNOPENED> ORDER BY created_at, id LIMIT ? FOR UPDATE SKIP LOCKED) RETURNING id`; fewer than `count` → throw `MedusaError(CONFLICT, 'Your vault pack is no longer available — refresh.')` (rolls back the partial claim).
- `releasePackGifts(ids: string[], openId: string)` — `SET opened_at = NULL, open_id = NULL WHERE id IN (...) AND open_id = ? AND pull_id IS NULL`.
- `stampPackGiftPulls(pairs: { giftId: string; pullId: string }[], openId: string)` — `SET pull_id = ? WHERE id = ? AND open_id = ? AND pull_id IS NULL`; any 0-row update → throw (the claim was taken over), so the workflow compensates.

Routes:

- `GET /store/pack-gifts` (bearer + `storeReadRateLimit`, matcher exact) → `{ gifts: [{ pack_id, count, title, image, price, available }] }` (`available = status==='active' && in_stock`).
- `GET /admin/customers/:id/pack-gifts` → `{ gifts: [...] }`; `POST` body `{ pack_id, quantity, note, idempotency_key }` → 201 `{ gifts }` (`adminActionRateLimit`).
- `POST /admin/pack-gifts/:id/revoke` → `{ revoked: true }` (`adminActionRateLimit`).

- [ ] Step 1: Specs: grant 2 Bronze → store GET shows count 2; replay key → still 2; free_welcome refused 400; quantity 11 refused; revoke one → count 1; revoke an opened gift → 409; mint cap includes gift value; claim more than held → 409 and nothing claimed; a claim with `opened_at` 11 min ago and no pull is claimable again.
- [ ] Step 2–4: implement, run, pass.
- [ ] Step 5: Commit `feat(gifts): admins gift packs into a customer's vault`.

---

### Task 6: Open flow — gifts in the batch, bonus split on every open

**Files:** Create `workflows/steps/claim-pack-gifts.ts`; Modify `workflows/open-batch.ts`, `workflows/steps/charge-pack-batch.ts`, `workflows/steps/record-pulls-batch.ts`, `workflows/open-pack.ts`, `workflows/steps/charge-pack-open.ts`, `workflows/steps/record-pull.ts`, `api/store/packs/[slug]/open-batch/route.ts`. Test: extend `pack-gifts.spec.ts` + `bonus-credit.spec.ts`.

**Interfaces:**

- `OpenBatchInput.gifts: number` (0 ≤ gifts ≤ count).
- `claimPackGiftsStep({ customer_id, pack_id, count: gifts, open_id }) → { gift_ids: string[] }`, compensation `releasePackGifts(gift_ids, open_id)`; no-op when gifts = 0.
- `chargePackBatchStep({ ..., count, gifts })` charges `(count − gifts) × price`, returns `{ price, total, balance, bonus_cents_by_row: number[] }` (length `count`; gift rows 0, paid rows from `allocateBonusSen`).
- `recordPullsBatchStep` input gains `rows: { source: 'gift'|'bonus'|'pack'; bonus_bp: number }[]` and writes the SP ledger payload's `bonus` (MYR consumed) and `gifts` (count) through `recordPullsWithLedger`.
- New `stampPackGiftsStep({ open_id, pairs })` runs AFTER the record step (a step's own compensation never runs when the step itself throws, so the stamp must not live inside the record step). Its compensation un-stamps (`pull_id = NULL WHERE open_id = ?`). `releasePackGifts(openId)` clears `opened_at`, `open_id` AND `pull_id` by `open_id`, so a gift is never left pointing at a deleted pull.
- Single open: `ChargePackOpenResult.bonus_cents`; recordPull `source` = `free` | `pullSourceFor(...)`; `bonus_bp = bonusBpFor(bonus_cents, priceSen)`.
- Route: body `gifts` validated integer `0..count`; 409 passes through as Medusa CONFLICT. Response roll `buyback.bonus = bonusShareMyr(amount, bonus_bp)`, `vault_bonus = bonusShareMyr(vault_amount, bonus_bp)`, plus `pull.source`, `pull.bonus_bp`, and top-level `gifts_used`.

Workflow order in `openBatchWorkflow`: roll → mint open_id → `claimPackGiftsStep` → charge → record → `stampPackGiftsStep` → stock → events → settleVip.

- [ ] Step 1: Specs: (a) `gifts=1, count=2`, RM 300 pack, normal balance 300 → 2 pulls, sources `gift`,`pack`, ONE debit of RM 300, gift row stamped with the gift pull id; (b) `gifts=1, count=1` → no debit row, pull `gift`, `bonus_bp 10000`; (c) `gifts=2` with 1 held → 409, balance unchanged, gift unclaimed; (d) two concurrent `gifts=1` opens for one gift → one 200, one 409; (e) bonus 400 + normal 500, count 2 → rows `bonus` (bp 10000) and `bonus` (bp 3333), debit bonus_cents −40000; (f) single open with bonus 270 → pull `bonus`, `bonus_bp 9000`; (g) forced failure AFTER the stamp (make `decrementCardStockBatchStep`'s service call throw non-best-effort, or spy a later step) and AT the stamp → in both cases gift fully released (`opened_at`, `open_id`, `pull_id` null), debit reversed, no pulls, no SP row.
- [ ] Step 2–4: implement, run, pass; re-run `open-batch*.spec`, `open-pack*.spec`, `free-pack*.spec`, `task*.spec`.
- [ ] Step 5: Commit `feat(gifts): open gifted packs through the normal open, bonus first`.

---

### Task 7: Buyback split + vault/open quotes

**Files:** Modify `workflows/steps/buyback-pull.ts` (pass `bonusBp: pull.bonus_bp ?? 0`), `service.ts` `recordBuybackCreditTransaction` (`bonus_cents = bonusShareSen(amountSen, bonusBp)`; SE payload `bonus`), `modules/packs/ledger.ts` (SE payload optional `bonus?: number`, SP payload optional `bonus?: number; gifts?: number`), `api/store/vault/route.ts` (item `bonus_bp`, `buyback.bonus`), `api/store/packs/[slug]/open/route.ts` (quote `bonus`). Test: extend `bonus-credit.spec.ts`.

- [ ] Step 1: Specs: sell a gift pull at reveal (instant) → credit row `bonus_cents = amount sen`, wallet bonus up by the amount, withdrawable unchanged; sell a 90%-bonus pull from the vault (flat) → split 90/10; batch buyback of mixed pulls sums correctly; `/store/vault` shows `buyback.bonus`.
- [ ] Step 2–4: implement, run, pass; re-run `buyback*.spec`, `vault*.spec`.
- [ ] Step 5: Commit `feat(bonus): cards from gifts and bonus sell back for bonus credit`.

---

### Task 8: Count exclusions

**Files:** Modify `service.ts` task facts (`vault_count` query: `AND source NOT IN ('gift','bonus')`; pixel query lifetime `n`: `COUNT(*) FILTER (WHERE p.source NOT IN ('gift','bonus'))`), `modules/packs/telegram.ts` (`EXCLUDED_SOURCES = ['reward', 'gift', 'bonus']`), `api/admin/customers/[id]/pulls/route.ts` (accept `gift`, `bonus`), `api/reports/growth/packs/route.ts` (add `gift`, `bonus` counts). Test: extend `pack-gifts.spec.ts`.

- [ ] Step 1: Specs: after a gift open and a bonus open — leaderboard/feed/profile show neither; `GET /store/tasks` vault achievement progress unchanged; `hasPaidOpen` false; Telegram `buildPost`-level helper returns null for both sources (unit).
- [ ] Step 2–4: implement, run, pass.
- [ ] Step 5: Commit `feat(gifts): gift and bonus pulls count toward nothing`.

---

### Task 9: Admin dashboard panels (subagent)

**Files:** `backend/apps/admin/src/routes/customers/[id]/page.tsx`, new `backend/apps/admin/src/routes/customers/[id]/gift-and-bonus.tsx`, `backend/apps/admin/src/lib/admin-rest.ts`, `backend/apps/admin/src/lib/queries.ts`.

API contract (from Tasks 4–5): `POST /admin/customers/:id/credits {amount, note, idempotency_key, kind:'bonus'}`; `GET /admin/customers/:id/gacha` → `bonus_balance`; `GET/POST /admin/customers/:id/pack-gifts`; `POST /admin/pack-gifts/:id/revoke`; pack list for the select from the existing packs admin query (`GET /admin/packs`), filtered to `status==='active'` and category not `free_welcome`/`reward_box`.

UI (follow the existing credit-adjust panel's components, `@medusajs/ui`, `medusa-ui-conformance` skill):

- **Gift packs** panel: pack `Select`, quantity input 1–10, note `Textarea` (required), Send button with confirm Prompt ("Send 2× Bronze Pack to <email>?"), fresh `idempotency_key` (`crypto.randomUUID()`) per confirmed submit. Table of gifts: pack, state badge (Unopened / Opened / Revoked / Stuck), granted at, note, Revoke button on unopened (confirm Prompt).
- **Bonus credit** panel: shows Bonus balance; amount input (signed), note, Apply with confirm Prompt; uses `kind: 'bonus'`.
- Invalidate the gacha + pack-gifts queries on success; toast errors with the backend message.

Verify: `corepack yarn lint` and `corepack yarn build` in `backend/apps/admin`; Playwright screenshot of the customer page with both panels (local admin `:7000` against a backend with the branch) saved under `docs/research/`.

Commit `feat(admin): gift packs and bonus credit on the customer page`.

---

### Task 10: Storefront (subagent)

**Files:** see File Map. API contract: `GET /store/pack-gifts`; `POST /store/packs/:slug/open-batch {count, gifts}` (409 stale); roll `pull.source`, `pull.bonus_bp`, `buyback.bonus`, `buyback.vault_bonus`; `/store/vault` item `bonus_bp`, `buyback.bonus`, `source` incl. `gift|bonus`; `/store/credits` `wallet.bonus`, row `bonus`; reason `bonus_grant`; feed templates `pack_gift_received {pack_id,title,quantity}`, `bonus_credit_received {amount}`.

Behaviour (spec §1 verbatim):

- `src/lib/vault-packs.ts`: `giftsUsed(qty, held) = Math.min(qty, held)`; `vaultCostLabel(qty, gifts, price)` → `"Vault x1"`, `"Vault x1 + RM 300.00"`, or `null` (no gifts); `vaultButtonLabel(qty, gifts)` → `"Open Vault x1"` when `gifts === qty`, else `null` (keep default); `sellLabel(amount, bonus)` → `"Sell for RM 270.00 bonus"`, `"Sell for RM 243.00 bonus + RM 27.00"`, or `null`. Vitest `src/lib/__tests__/vault-packs.test.ts` covers each.
- Actions: `getPackGifts()` (no-store, signed like other writes/no-store reads via `src/lib/medusa.ts`), `openBatch(slug, count, gifts)` maps 409 to `{ ok:false, error: <backend message>, staleGifts: true }`.
- Vault page: "Packs" row above cards when any gift; tile: pack image, `"<Title> ×N"`, "Gift from Polycards", Open → `/slots/<slug>`; disabled "Unavailable" when `!available`.
- Pack page bottom bar: fetch gifts client-side after mount when signed in; price line and button per labels.
- Spin page: `rollMode` unchanged except `?freeRip` wins; in `paid` mode `gifts = giftsUsed(reels, held)`; bet line `Bet Vault x1` / `Bet Vault x1 + RM300.00`; `canAfford` uses `(reels − gifts) × price`; `openBatch(..., gifts)`; on `staleGifts` refetch gifts and show the message; decrement held gifts after a successful open.
- Reveal sell button and vault sell modal use `sellLabel` when `buyback.bonus > 0`.
- Wallet page: Total / Normal / Bonus rows ("spend only · can't withdraw"), Withdrawable unchanged (backend already excludes bonus).
- Transactions list: `bonus_grant` → "Bonus credit"; rows with `bonus ≠ 0` get a small "bonus" tag.
- Notifications copy for both templates (drift test in `src/lib/notifications/__tests__/copy.test.ts` must pass).
- Schemas: add new enum values / fields with `.optional()` defaults so old payloads still parse; credit reason mirror + drift test.

Verify: `node ../../../node_modules/vitest/vitest.mjs run` (affected), `node ../../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`, `npm run lint`, `npm run build` (after `npm ci` in the worktree); Playwright screenshots against the local stack: vault Packs row, pack page qty 1 and 2, spin bet line (1 row, + row, 2 gifts), reveal sell label, wallet breakdown → `docs/research/vault-packs-*.png`.

Commit `feat(storefront): vault packs, Vault x1 opens and bonus credit display`.

---

### Task 11: Docs

- `CONTEXT.md`: add **Pack Gift** and **Bonus Credit** (spec glossary text), extend **Pull** sources, **Available**/**Withdrawal** note (withdrawable = normal only), **VIP Level** note (bonus-funded turnover excluded).
- `docs/adr/0010-bonus-credit-is-a-ledger-column.md`: decision, why not a second wallet, consequences (floors, turnover, buyback split, deploy order).

Commit `docs: pack gifts and bonus credit in the glossary and ADR 0010`.

---

### Task 12: Whole-branch verification

- [ ] Backend: `corepack yarn test:unit` (api, with `--testPathIgnorePatterns "/node_modules/" "\.medusa"` if a build ran), full `corepack yarn test:integration:http` sharded run, `check-types`.
- [ ] Storefront: vitest all, tsc, lint, build.
- [ ] Admin: lint, build.
- [ ] Backend end-to-end proof = the http integration specs (real Postgres, the migration SQL, real routes). Local `db:migrate` against the shared dev DB is blocked in auto mode, so there is no live-stack run against a migrated local DB; say so in the report.
- [ ] Visual proof = storefront standalone build against a fixture mock backend (memory: design-preview-mock-backend) with cookie-seeded Playwright: vault Packs row, pack page qty 1/2, spin bet line (1 row, + row, 2 gifts), reveal sell label, wallet breakdown; admin panels via the admin dev server against the same mock where feasible. Label as demo data.
- [ ] `pull-status-transitions.spec`'s "creditSummary SQL matches the unit-tested fold" test gets a `bonus_grant` and a bonus-funded `pack_open` row.
- [ ] Rebase onto `fix/desk-bot-sql-partner-password` (both add a packs migration, edit `.snapshot-packs.json` and the `MedusaService({...})` list); re-run migration unit specs and tsc.
- [ ] `/code-review` on the branch; fix CRITICAL/HIGH.
- [ ] Do NOT push without the user's OK. Leave both branches ready with PR bodies and deploy notes: backend first (migration is additive), then storefront, then start granting; plus the security branch's "no partner minting during its deploy" note.
