# Referral Rebuild Phase A — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Weekly turnover-tiered referral commissions + VIP personal rebate, computed Tuesday as a draft settlement run, admin-approved, paid Wednesday as straight site credit — with the storefront `/task` Referral + VIP tabs and the admin Referrals section.

**Architecture:** Everything lands in the existing `packs` Medusa module: four new tables, two column additions, two widened CHECKs, pure-function tier/week math, service methods for close/approve/void/pay, two cron jobs, store + admin HTTP routes, then UI. No synchronous work in `settleOpen` — weekly turnover is computed at close time from `credit_transaction` `pack_open` rows.

**Tech Stack:** Medusa v2 (`model.define`, `@InjectTransactionManager`, `recordLedgerEntry` double-entry discipline), MikroORM migrations, Jest (unit + `integration:modules` + `integration:http`), Next.js 16 App Router + zod, Vite/React admin (`@mercurjs/dashboard-sdk` file routes, TanStack Query).

**Spec:** `docs/superpowers/specs/2026-08-24-referral-tasks-rebuild-design.md`

## Global Constraints

- Branch `feat/referral-rebuild`, worktree `.worktrees/feat-referral-rebuild`, stacked on `chore/remove-referrals` (PR #482). Never commit to master.
- All rates in **basis points** (0.5% = 50 bp); settlement-table amounts in **cents** (int). `credit_transaction.amount` is **RM decimal** — convert `cents / 100` only at the ledger write.
- Money rounding: `Math.floor` to the cent.
- Week = Tuesday 00:00 MYT → next Tuesday 00:00 MYT (exclusive). MYT is fixed UTC+8, no DST — use the offset-arithmetic pattern from `globepay-settlement.ts:187`.
- Every credit write pairs `createCreditTransactions` + `recordLedgerEntry` inside ONE `@InjectTransactionManager()` method, per the discipline documented at `service.ts` (`recordLedgerEntry` comment block). Idempotency key = the ledger `(type, ref_id)` partial unique index.
- Backend tests: run jest via `node_modules/jest/bin/jest.js` on Windows; never pipe test output through `tail`. `integration:modules` schema comes from the spec's `moduleModels` array, never migrations.
- TS strict, no `any`. 2-space indent. Named exports.
- Commits: conventional format, `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- After each task: PostToolUse typecheck hook must stay green.

---

### Task 1: Models + migration

**Files:**

- Create: `backend/packages/api/src/modules/packs/models/referral-attribution.ts`
- Create: `backend/packages/api/src/modules/packs/models/referral-settings.ts`
- Create: `backend/packages/api/src/modules/packs/models/weekly-settlement.ts`
- Create: `backend/packages/api/src/modules/packs/models/weekly-settlement-line.ts`
- Modify: `backend/packages/api/src/modules/packs/models/customer-account-state.ts` (add `partner_referral_bp`)
- Modify: `backend/packages/api/src/modules/packs/models/vip-level.ts` (add `rebate_bp`)
- Modify: `backend/packages/api/src/modules/packs/models/credit-transaction.ts` (reason enum + 2)
- Modify: `backend/packages/api/src/modules/packs/models/ledger-entry.ts` (type enum + `RF`)
- Create: `backend/packages/api/src/modules/packs/migrations/Migration<STAMP>.ts` (hand-written, additive)

**Interfaces (produces):** table names `referral_attribution`, `referral_settings`, `weekly_settlement`, `weekly_settlement_line`; enums as below. Later tasks call the auto-generated `MedusaService` CRUD (`createReferralAttributions`, `listReferralSettings`, `createWeeklySettlements`, `listWeeklySettlementLines`, `updateWeeklySettlementLines`, …).

- [ ] **Step 1: Write the four model files**

```ts
// referral-attribution.ts
import { model } from '@medusajs/framework/utils';

// Who referred whom. One row per referred customer, written once at signup
// (bindReferral) and never updated — attribution is permanent by spec.
// referrer_id is a customer id; the public referral code is the referrer's
// profile handle, resolved at bind time (utils/customer-by-handle.ts).
export const ReferralAttribution = model
  .define('referral_attribution', {
    id: model.id().primaryKey(),
    customer_id: model.text().unique(),
    referrer_id: model.text(),
  })
  .indexes([
    {
      name: 'IDX_referral_attribution_referrer',
      on: ['referrer_id'],
      where: 'deleted_at IS NULL',
    },
  ]);
export default ReferralAttribution;
```

```ts
// referral-settings.ts
import { model } from '@medusajs/framework/utils';

// Singleton (id='global'), same pattern as tier_settings. `tiers` is the
// whole-amount tier table [{ min_cents, rate_bp }] sorted ascending by
// min_cents; resolveRateBp picks the last row whose min_cents <= turnover.
// partner_min_bp/partner_max_bp bound the manual partner override.
export const ReferralSettings = model.define('referral_settings', {
  id: model.id().primaryKey(),
  tiers: model.json(),
  partner_min_bp: model.number().default(300),
  partner_max_bp: model.number().default(500),
});
export default ReferralSettings;
```

```ts
// weekly-settlement.ts
import { model } from '@medusajs/framework/utils';

// One row per closed referral week (Tue 00:00 MYT start). week_start is the
// UNIQUE idempotency key for the Tuesday close job. Lifecycle:
// draft -> approved -> paid (void = whole run cancelled pre-pay).
export const WeeklySettlement = model.define('weekly_settlement', {
  id: model.id().primaryKey(),
  week_start: model.dateTime().unique(), // UTC instant of Tue 00:00 MYT
  status: model.enum(['draft', 'approved', 'paid', 'void']).default('draft'),
  approved_by: model.text().nullable(), // admin actor id
  approved_at: model.dateTime().nullable(),
  paid_at: model.dateTime().nullable(),
  total_commission_cents: model.number().default(0),
  total_rebate_cents: model.number().default(0),
});
export default WeeklySettlement;
```

```ts
// weekly-settlement-line.ts
import { model } from '@medusajs/framework/utils';

// One payable line: customer x kind within a settlement run. amount_cents is
// frozen at close time (basis x rate, floored). paid_transaction_id is the
// credit_transaction the Wednesday pay step wrote — its ledger row's
// (type='RF', ref_id=<line id>) unique index is the pay idempotency key.
export const WeeklySettlementLine = model
  .define('weekly_settlement_line', {
    id: model.id().primaryKey(),
    settlement_id: model.text(),
    customer_id: model.text(),
    kind: model.enum(['referral_commission', 'vip_rebate']),
    basis_cents: model.number(),
    rate_bp: model.number(),
    amount_cents: model.number(),
    status: model.enum(['pending', 'voided', 'paid']).default('pending'),
    void_reason: model.text().nullable(),
    voided_by: model.text().nullable(),
    paid_transaction_id: model.text().nullable(),
  })
  .indexes([
    {
      name: 'IDX_wsl_settlement',
      on: ['settlement_id'],
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_wsl_customer',
      on: ['customer_id'],
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_wsl_settlement_customer_kind_unique',
      on: ['settlement_id', 'customer_id', 'kind'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
  ]);
export default WeeklySettlementLine;
```

- [ ] **Step 2: Edit the four existing models**

`customer-account-state.ts` — after `phone_verified_at`:

```ts
    // Referral rebuild (spec 2026-08-24): non-null marks a PARTNER account —
    // this manual rate (basis points, validated against referral_settings
    // partner bounds) REPLACES the tier table for their weekly commission.
    partner_referral_bp: model.number().nullable(),
```

`vip-level.ts` — after `frame_unlock`:

```ts
    // Referral rebuild (spec 2026-08-24): weekly personal rebate (回水) on the
    // member's OWN pack turnover, in basis points. 0 = no rebate at this rung.
    // NOT the removed direct_referral_pct (that paid commission on DOWNLINE
    // spend); this pays the spender themself.
    rebate_bp: model.number().default(0),
```

`credit-transaction.ts` — append to the `reason` enum: `'referral_commission', 'vip_rebate'` (keep existing order, add at the end).

`ledger-entry.ts` — the type enum becomes `['TP', 'SP', 'SE', 'OD', 'AD', 'WP', 'WD', 'RF']`. Find the payload TS union the module exports for ledger payloads (grep `payload` in `ledger-entry.ts` / `service.ts` `recordLedgerEntry` callers) and add the variant:

```ts
export type RfPayload = {
  type: 'RF';
  kind: 'referral_commission' | 'vip_rebate';
  week_start: string; // ISO date of the MYT Tuesday
  basis_cents: number;
  rate_bp: number;
};
```

- [ ] **Step 3: Hand-write the migration**

Stamp = current UTC `YYYYMMDDHHmmss`. `up()`: `create table if not exists` for the four tables (mirror column types from a recent migration, e.g. `Migration20260824131342.ts`'s `down()` shows the house style), the two `alter table ... add column if not exists`, then widen both CHECKs (drop + re-add with the full new value lists — copy the current lists from `Migration20260824131342.ts:75` and append the new values). `down()`: drop the four tables, drop the two columns, narrow the CHECKs back — guarded by a `DO $$` block that RAISEs if any `credit_transaction.reason IN ('referral_commission','vip_rebate')` or `ledger_entry.type = 'RF'` rows exist (recipe: memory `destructive-migration-guard-recipe`).

- [ ] **Step 4: Regenerate the snapshot**

```bash
cd backend/packages/api && npx medusa db:generate packs
```

Prerequisites in a fresh worktree: copy `backend/packages/api/.env` in; `corepack yarn build` in `backend/packages/odds-math`. **Read the generated migration and delete it** — keep ONLY the regenerated `.snapshot-packs.json` half (the hand-written migration from Step 3 is the real one; `db:generate` also re-emits any accumulated drift — do not ship its file).

- [ ] **Step 5: Apply + verify locally**

```bash
cd backend/packages/api && npx medusa db:migrate
docker exec pokenic-postgres psql -U medusa -d medusa -c "\d referral_attribution"
docker exec pokenic-postgres psql -U medusa -d medusa -c "select conname, pg_get_constraintdef(oid) from pg_constraint where conname in ('credit_transaction_reason_check','ledger_entry_type_check')"
```

Expected: table exists; both CHECKs list the new values.

- [ ] **Step 6: Typecheck + commit**

```bash
cd backend/packages/api && node_modules/.bin/tsc --noEmit
git add -A && git commit -m "feat(referrals): schema for attribution, settings and weekly settlements"
```

---

### Task 2: Pure tier + week math (`referral.ts`) — TDD

**Files:**

- Create: `backend/packages/api/src/modules/packs/referral.ts`
- Test: `backend/packages/api/src/modules/packs/__tests__/referral.unit.spec.ts`

**Interfaces (produces):**

```ts
export type ReferralTier = { min_cents: number; rate_bp: number };
export const DEFAULT_REFERRAL_TIERS: ReferralTier[]; // 0→50, 600000→100, 1500000→150, 3000000→200
export function resolveRateBp(
  turnoverCents: number,
  tiers: ReferralTier[],
  partnerBp?: number | null,
): number;
export function payoutCents(basisCents: number, rateBp: number): number; // floor(basis*bp/10000)
export type ReferralWeek = {
  weekStartIso: string;
  startUtc: Date;
  endUtcExcl: Date;
};
export function referralWeekFor(at: Date): ReferralWeek; // week CONTAINING `at`
export function lastClosedReferralWeek(now: Date): ReferralWeek; // most recently ENDED week
```

- [ ] **Step 1: Write the failing tests**

```ts
import {
  DEFAULT_REFERRAL_TIERS,
  lastClosedReferralWeek,
  payoutCents,
  referralWeekFor,
  resolveRateBp,
} from '../referral';

describe('resolveRateBp', () => {
  const t = DEFAULT_REFERRAL_TIERS;
  it.each([
    [0, 50],
    [599_900, 50], // RM0–5,999 → 0.5%
    [600_000, 100],
    [1_499_900, 100],
    [1_500_000, 150],
    [2_999_900, 150],
    [3_000_000, 200],
    [99_999_900, 200],
  ])('%i cents → %i bp', (cents, bp) => {
    expect(resolveRateBp(cents, t)).toBe(bp);
  });
  it('partner override replaces the table entirely', () => {
    expect(resolveRateBp(100, t, 400)).toBe(400);
    expect(resolveRateBp(99_999_900, t, 300)).toBe(300);
  });
  it('null/undefined partner falls through to tiers', () => {
    expect(resolveRateBp(0, t, null)).toBe(50);
  });
});

describe('payoutCents', () => {
  it('floors to the cent', () => {
    expect(payoutCents(2_000_000, 150)).toBe(30_000); // RM20k @1.5% = RM300
    expect(payoutCents(999, 50)).toBe(4); // 4.995 → 4
    expect(payoutCents(0, 200)).toBe(0);
  });
});

describe('referral week (Tue 00:00 MYT → Tue 00:00 MYT)', () => {
  // 2026-08-24 is a Monday. Tue 2026-08-18 00:00 MYT = 2026-08-17T16:00:00Z.
  it('a Monday belongs to the week that started the previous Tuesday', () => {
    const w = referralWeekFor(new Date('2026-08-24T10:00:00Z'));
    expect(w.weekStartIso).toBe('2026-08-18');
    expect(w.startUtc.toISOString()).toBe('2026-08-17T16:00:00.000Z');
    expect(w.endUtcExcl.toISOString()).toBe('2026-08-24T16:00:00.000Z');
  });
  it('Tuesday 00:00 MYT exactly starts a new week', () => {
    const w = referralWeekFor(new Date('2026-08-24T16:00:00Z')); // Tue 25th 00:00 MYT
    expect(w.weekStartIso).toBe('2026-08-25');
  });
  it('one instant before the boundary is still the old week', () => {
    const w = referralWeekFor(new Date('2026-08-24T15:59:59Z'));
    expect(w.weekStartIso).toBe('2026-08-18');
  });
  it('lastClosedReferralWeek is the week before the current one', () => {
    const w = lastClosedReferralWeek(new Date('2026-08-26T02:00:00Z')); // Wed MYT
    expect(w.weekStartIso).toBe('2026-08-18');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`node node_modules/jest/bin/jest.js src/modules/packs/__tests__/referral.unit.spec.ts` from `backend/packages/api`; module not found)

- [ ] **Step 3: Implement**

```ts
// referral.ts — pure math for the weekly referral engine. No DB, no clock
// reads (callers pass `now`) so every branch is unit-testable.
export type ReferralTier = { min_cents: number; rate_bp: number };

// Defaults only — the live table is referral_settings.tiers (admin-editable).
// Whole-amount match, NOT marginal brackets: RM20,000 downline turnover pays
// 1.5% on all RM20,000.
export const DEFAULT_REFERRAL_TIERS: ReferralTier[] = [
  { min_cents: 0, rate_bp: 50 },
  { min_cents: 600_000, rate_bp: 100 },
  { min_cents: 1_500_000, rate_bp: 150 },
  { min_cents: 3_000_000, rate_bp: 200 },
];

export function resolveRateBp(
  turnoverCents: number,
  tiers: ReferralTier[],
  partnerBp?: number | null,
): number {
  if (partnerBp != null) return partnerBp; // partner rate replaces the table
  let rate = 0;
  for (const t of [...tiers].sort((a, b) => a.min_cents - b.min_cents)) {
    if (turnoverCents >= t.min_cents) rate = t.rate_bp;
  }
  return rate;
}

export function payoutCents(basisCents: number, rateBp: number): number {
  return Math.floor((basisCents * rateBp) / 10_000);
}

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Kuala_Lumpur, no DST
const DAY_MS = 24 * 60 * 60 * 1000;

export type ReferralWeek = {
  weekStartIso: string;
  startUtc: Date;
  endUtcExcl: Date;
};

// Week containing `at`: the most recent Tuesday 00:00 MYT at or before `at`.
export function referralWeekFor(at: Date): ReferralWeek {
  const myt = new Date(at.getTime() + MYT_OFFSET_MS);
  const day = myt.getUTCDay(); // 0=Sun … 2=Tue (in MYT thanks to the shift)
  const daysSinceTue = (day - 2 + 7) % 7;
  const tueMidnightMyt = Date.UTC(
    myt.getUTCFullYear(),
    myt.getUTCMonth(),
    myt.getUTCDate() - daysSinceTue,
  );
  const startUtc = new Date(tueMidnightMyt - MYT_OFFSET_MS);
  return {
    weekStartIso: new Date(tueMidnightMyt).toISOString().slice(0, 10),
    startUtc,
    endUtcExcl: new Date(startUtc.getTime() + 7 * DAY_MS),
  };
}

export function lastClosedReferralWeek(now: Date): ReferralWeek {
  const current = referralWeekFor(now);
  return referralWeekFor(new Date(current.startUtc.getTime() - DAY_MS));
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** `feat(referrals): tier resolution and MYT week-window math`

---

### Task 3: Service — attribution + settings

**Files:**

- Modify: `backend/packages/api/src/modules/packs/service.ts`
- Test: `backend/packages/api/src/integration-tests/modules/referral-attribution.spec.ts` (follow the structure of an existing `integration-tests/modules/*.spec.ts`; add ALL new models to its `moduleModels` array — schema comes from that array, not migrations)

**Interfaces (produces):**

```ts
async bindReferral(input: { customerId: string; referrerHandle: string }):
  Promise<{ bound: true } | { bound: false; reason: 'self' | 'already_bound' | 'referrer_not_found' }>;
async referralSettings(): Promise<{ tiers: ReferralTier[]; partner_min_bp: number; partner_max_bp: number }>; // lazy-seeds the 'global' row with DEFAULT_REFERRAL_TIERS
async updateReferralSettings(input: { tiers?: ReferralTier[]; partner_min_bp?: number; partner_max_bp?: number }): Promise<void>; // validates: sorted, first min_cents===0, bp 0..10000, min<max
async setPartnerRate(input: { customerId: string; rateBp: number | null; adminId: string }): Promise<void>; // validates against partner bounds; writes admin_action_audit (new action 'partner_rate_set', additive enum change)
```

`bindReferral` resolves the handle via `findCustomerByHandle` (`utils/customer-by-handle.ts`) — but that util lives in the API layer; if it needs the query container, do the handle→customer resolution in the ROUTE (Task 6) and make the service method take `referrerId` instead. Decide by reading the util first; keep the service free of cross-module lookups (house rule: the packs service only touches packs tables).

- [ ] **Step 1: Write failing integration:modules tests** — bind happy path; `self` rejected; second bind returns `already_bound` and the row is unchanged; settings lazy-seed returns defaults; `updateReferralSettings` rejects an unsorted tier table and `partner_min_bp >= partner_max_bp`; `setPartnerRate` rejects out-of-bounds, accepts in-bounds, `null` clears.
- [ ] **Step 2: Run — expect FAIL** (`corepack yarn test:integration:modules -- --testPathPattern referral-attribution` or the repo's equivalent script — check `package.json` scripts first)
- [ ] **Step 3: Implement the four methods** (plain CRUD + validation; no locks needed — attribution races are settled by the unique `customer_id` index, catch the 23505 and return `already_bound`)
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** `feat(referrals): attribution binding, settings and partner rates`

---

### Task 4: Service — closeReferralWeek

**Files:**

- Modify: `backend/packages/api/src/modules/packs/service.ts`
- Test: `backend/packages/api/src/integration-tests/modules/referral-close.spec.ts`

**Interfaces (produces):**

```ts
async closeReferralWeek(input?: { weekStartIso?: string; now?: Date }):
  Promise<{ settlementId: string; created: boolean; lines: number }>;
```

Behavior:

1. Resolve the week: explicit `weekStartIso` or `lastClosedReferralWeek(now)`.
2. If a `weekly_settlement` with that `week_start` exists → return `{ created: false }` (idempotent re-run).
3. One grouped raw query over the window (RM → cents in SQL):

```sql
SELECT customer_id, ROUND(SUM(-amount) * 100)::bigint AS turnover_cents
FROM credit_transaction
WHERE reason = 'pack_open' AND deleted_at IS NULL
  AND created_at >= ? AND created_at < ?
GROUP BY customer_id
```

4. Commission lines: join spenders → `referral_attribution.referrer_id`; sum each referrer's downline turnover; rate = `resolveRateBp(downline, settings.tiers, partnerBpOf(referrer))`; skip `amount_cents === 0`.
5. Rebate lines: for each spender, VIP level via the existing `levelForSpend`/`vip_member_state` path (read how `/store/vip` computes the level and reuse the same source), `rate_bp = vip_level.rebate_bp`; skip zero.
6. Insert settlement (status `draft`, totals) + lines in one `@InjectTransactionManager()` scope. A concurrent duplicate close loses on the unique `week_start` → catch 23505, re-read, return `{ created: false }`.

- [ ] **Step 1: Write failing tests** — seed pack_open rows in/outside the window for three customers (A referred by R, B referred by R, C unreferred), a partner rate on a second referrer, a `rebate_bp` on one VIP level; assert: correct downline sum for R, tier rate picked, partner rate honored, rebate line for the spender with a rebate level, zero-amount lines absent, second call `created: false` with no duplicate rows, week window excludes the outside row.
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** `feat(referrals): Tuesday close computes the weekly settlement draft`

---

### Task 5: Service — approve / void / pay

**Files:**

- Modify: `backend/packages/api/src/modules/packs/service.ts`
- Test: `backend/packages/api/src/integration-tests/modules/referral-pay.spec.ts`

**Interfaces (produces):**

```ts
async approveWeeklySettlement(input: { settlementId: string; adminId: string }): Promise<void>; // draft→approved only; audit row
async voidSettlementLine(input: { lineId: string; adminId: string; reason: string }): Promise<void>; // pending lines of draft|approved runs only; audit row
async payWeeklySettlement(input: { settlementId: string }): Promise<{ paid: number; skipped: number }>;
```

`payWeeklySettlement`: only `approved` runs. Per pending line, inside one transaction per line (mirrors `settleChallengeWeek`'s per-winner discipline):

- `createCreditTransactions([{ customer_id, amount: amount_cents / 100, reason: line.kind }])`
- `recordLedgerEntry({ type: 'RF', customerId, refId: line.id, walletDelta: amount_cents / 100, vaultDelta: null, payload: { type: 'RF', kind: line.kind, week_start, basis_cents, rate_bp } })` — the `(type, ref_id)` unique index makes a re-run of a crashed pay job skip already-paid lines.
- Update the line: `status: 'paid'`, `paid_transaction_id`.
- Deleted/missing customer → void the line with `void_reason: 'account_deleted'`, count as skipped, log one line.
  When no pending lines remain, flip the run to `paid` + `paid_at`.

- [ ] **Step 1: Write failing tests** — approve flips status + rejects non-draft; void works pre-pay, rejects paid lines; pay writes one credit_transaction + one RF ledger row per line, balances move by amount_cents/100, re-running pay is a no-op (no double credit — assert row counts), voided lines aren't paid, run flips to `paid`.
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** `feat(referrals): approve, void and the idempotent Wednesday pay`

---

### Task 6: Jobs + store/admin HTTP routes

**Files:**

- Create: `backend/packages/api/src/jobs/close-referral-week.ts` — `config = { name: 'close-referral-week', schedule: '0 * * * 2' }` (hourly on Tuesdays; the unique week_start makes extra runs no-ops). Body: resolve packs service from the container (copy the container/resolve boilerplate from `jobs/settle-challenge-week.ts`), call `closeReferralWeek()`, log created/skipped.
- Create: `backend/packages/api/src/jobs/pay-referral-week.ts` — `config = { name: 'pay-referral-week', schedule: '0 * * * 3' }` (hourly on Wednesdays). Body: find `approved` settlements, `payWeeklySettlement` each, log counts. An unapproved Tuesday run simply waits — the human gate IS the spec.
- Create: `backend/packages/api/src/api/store/referral/route.ts` — `GET`: auth'd (`req.auth_context.actor_id` guard, copy from `api/store/vip/route.ts`), returns `{ handle, invite_url, downline_count, week: { start, turnover_cents, rate_bp, projected_cents, partner }, history: [{ week_start, kind, amount_cents, status }] }` (history = this customer's settlement lines, newest 12).
- Create: `backend/packages/api/src/api/store/referral/bind/route.ts` — `POST { referrer_handle }`: resolves via `findCustomerByHandle`, calls `bindReferral`; 200 with the result object either way (no 4xx for `already_bound` — the storefront fires it blind after signup).
- Create: `backend/packages/api/src/api/store/vip-rebate/route.ts` — `GET`: `{ level, rebate_bp, week: { start, turnover_cents, projected_cents }, history }`.
- Create: `backend/packages/api/src/api/admin/referrals/settings/route.ts` — `GET`/`POST` (zod-validated body, calls `updateReferralSettings`).
- Create: `backend/packages/api/src/api/admin/referrals/settlements/route.ts` — `GET` list (+status filter).
- Create: `backend/packages/api/src/api/admin/referrals/settlements/[id]/route.ts` — `GET` detail with lines.
- Create: `backend/packages/api/src/api/admin/referrals/settlements/[id]/approve/route.ts`, `.../pay/route.ts` — `POST`.
- Create: `backend/packages/api/src/api/admin/referrals/lines/[id]/void/route.ts` — `POST { reason }`.
- Create: `backend/packages/api/src/api/admin/customers/[id]/partner-rate/route.ts` — `POST { rate_bp: number | null }`.
- Create: `backend/packages/api/src/api/admin/customers/[id]/referral/route.ts` — `GET` (who referred them, downline list, their lines).
- Modify: `backend/packages/api/src/api/admin/vip-levels/route.ts` + its update validator (grep `vip-levels` for the zod schema) — accept and persist `rebate_bp` (int, 0..10000) per level, so the ladder editor can set the rebate.
- Modify: `backend/packages/api/src/api/middlewares.ts` — matchers for the new admin routes (copy the auth/rate-limit shape of the existing `/admin/*` blocks; the removal commit `b646fa83` shows exactly which matcher blocks the OLD system had — the new list mirrors those paths). Store routes: same middleware treatment as `/store/vip`. Add a modest rate limit on `/store/referral/bind`.
- Test: `backend/packages/api/src/integration-tests/http/referral.spec.ts` — auth required on every route; bind → summary reflects the downline; close → admin list shows the draft; approve → pay → store history shows `paid`; partner-rate POST validates bounds; derive customer ids from post-login tokens, never the register token (memory: register JWT `actor_id` is empty).

- [ ] **Step 1: Write the failing http spec**
- [ ] **Step 2: Run — expect FAIL** (`integration:http` shard command from `package.json`)
- [ ] **Step 3: Implement jobs + routes + middlewares**
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** `feat(referrals): crons and the store/admin HTTP surface`

---

### Task 7: Storefront — invite flow + data layer

**Files:**

- Create: `src/app/invite/[handle]/route.ts` — GET route handler: validate handle shape (`HANDLE_RE` mirror in the storefront; a simple `/^[a-z0-9-]{3,30}$/i` guard is enough — the backend re-validates), set cookie `referral_code` (30 days, httpOnly, sameSite lax), redirect `/`.
- Create: `src/lib/referral-cookie.ts` — `REFERRAL_COOKIE = 'referral_code'`, `readReferralCookie()`, `clearReferralCookie()` (server-only helpers over `next/headers` cookies).
- Modify: `src/lib/actions/auth.ts` — after successful signup (the existing register→login flow), read the cookie; if present, fire `POST /store/referral/bind` with the fresh bearer token, then clear the cookie. Fire-and-forget with a `catch` that logs — signup must NEVER fail on a bind error.
- Modify: `src/lib/data/schemas.ts` — zod: `ReferralSummarySchema`, `VipRebateSchema` matching Task 6's payloads (looseObject per house style); add the two new reasons to the transaction-reason enum + labels in `src/lib/transactions.ts`.
- Create: `src/lib/data/referral.ts` — `getReferralSummary()`, `getVipRebate()` server loaders (copy the auth'd fetch pattern from `src/lib/data/challenge.ts`).
- Test: extend `src/lib/data/__tests__/` with schema parse fixtures (valid payload parses; missing keys rejected), and an auth-action test that bind failure does not throw out of signup.

- [ ] **Step 1: Write failing vitest specs**
- [ ] **Step 2: Run — expect FAIL** (`npm run test -- referral` at repo root; check the vitest invocation in `package.json`)
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run — expect PASS**; `node_modules/.bin/tsc --noEmit` clean
- [ ] **Step 5: Commit** `feat(referrals): invite cookie flow and the storefront data layer`

---

### Task 8: Storefront — /task page (Referral + VIP tabs)

**Files:**

- Modify: `src/app/task/page.tsx` — server component: `metadata` (drop the `robots: noindex` — the page is real now), fetch `getReferralSummary()` + `getVipRebate()` (+ auth state), render `<TaskHubClient>`; logged-out users see the tabs with a sign-in prompt panel.
- Create: `src/app/task/TaskHubClient.tsx` — `'use client'`; three pill-tabs (**Tasks** / **Referral** / **VIP**) using the existing pill primitives (`src/components/ui/pill.tsx`) and the server/client split pattern of `slots/[slug]/PackDetailClient.tsx`. Tasks tab = a "Weekly tasks are coming soon" panel (Phase B fills it). Referral tab: invite link + copy button, downline count, this-week turnover, current tier %, projected payout (RM, from cents/100 via the existing money formatter in `src/lib/format.ts`), past payouts list with status badges. VIP tab: level, rebate %, own turnover, projection, history.
- Follow DESIGN.md (mobile-first app-shell, pill primitives, dark neutral palette, `px-fluid` gutters, no `max-w-*` caps beyond what sibling account pages use).

- [ ] **Step 1: Build the page** (presentational — no TDD; the capture loop is the check, per `.claude/rules/common/testing.md`)
- [ ] **Step 2: Verify** — `npm run build`; then `pwsh scripts/serve-standalone.ps1 -Port 4000` and a Playwright screenshot script into `docs/research/` (copy an existing `qa-*.mjs` harness); read the PNG back. Logged-in state needs a seeded session — reuse whatever the existing qa scripts do for auth, else screenshot the logged-out state and verify the logged-in payload path via the vitest schema fixtures from Task 7.
- [ ] **Step 3: Commit** `feat(referrals): /task hub with Referral and VIP rebate tabs`

---

### Task 9: Admin — Referrals section + Customer-360 panel

**Files:**

- Create: `backend/apps/admin/src/routes/referrals/page.tsx` — `RouteConfig` file route (copy the shell of `routes/settlement/page.tsx`): three stacked cards — (1) settings editor: tier rows (min RM, rate %) with add/remove + partner bounds, Save; (2) settlement runs table (week, status, totals, Approve / Pay buttons with confirm dialogs); (3) run detail drawer/section listing lines (customer, kind, basis, rate, amount, status) with per-line Void (reason prompt).
- Modify: `backend/apps/admin/src/lib/admin-rest.ts`, `lib/queries.ts`, `lib/query-keys.ts` — typed fetchers + TanStack hooks for every Task 6 admin endpoint (`useReferralSettings`, `useUpdateReferralSettings`, `useReferralSettlements`, `useReferralSettlement`, `useApproveSettlement`, `usePaySettlement`, `useVoidSettlementLine`, `usePartnerRate` mutation, `useCustomerReferral`).
- Modify: `backend/apps/admin/src/routes/customers/[id]/page.tsx` — new "Referral" card: referred-by, downline count/list, their settlement lines, and the partner-rate setter (number input, bp↔% conversion in the UI, validated client-side against the bounds from settings).
- Modify: the VIP Levels editor (`backend/apps/admin/src/routes/daily-rewards/` — `vip-ladder-shape.ts` + its page) — add a "Rebate %" column bound to `rebate_bp` (UI shows %, stores bp), so the 回水 ladder is admin-set. Extend `vip-ladder-shape.test.ts` for the new column bounds (0..100%).
- Modify: `backend/apps/admin/src/i18n/en.json` — all new strings.
- Test: `backend/apps/admin/src/**/__tests__/` vitest for the tier-editor validation logic (client-side: sorted, first row 0, % within 0–100, partner min<max) — extract it to a pure helper `lib/referral-tiers.ts` so it's testable without DOM.

- [ ] **Step 1: Write the failing vitest for `lib/referral-tiers.ts`**
- [ ] **Step 2: Run — expect FAIL** (admin vitest invocation from `backend/apps/admin/package.json`)
- [ ] **Step 3: Implement helper + UI + wiring**
- [ ] **Step 4: Verify** — admin vitest green; `node ../../packages/api/node_modules/typescript/bin/tsc -b --force` clean (NEVER `-p tsconfig.json` — it checks zero files); `node_modules/.bin/vite build` clean; eslint via `backend/node_modules/.bin/eslint`. Watch the React-Compiler lint rule: no sync setState in useEffect.
- [ ] **Step 5: Commit** `feat(referrals): admin referrals section and Customer-360 partner controls`

---

### Task 10: Full verification sweep + PR

- [ ] **Step 1: Backend** — full unit suite + `integration:modules` + the http shards touched (jest via `node_modules/jest/bin/jest.js`). All green, zero skips added.
- [ ] **Step 2: Storefront** — vitest, `tsc --noEmit`, `npm run build`, prettier/lint.
- [ ] **Step 3: Admin** — vitest, `tsc -b --force`, vite build, eslint.
- [ ] **Step 4: Fresh-DB migration check** — `npx medusa db:migrate` against the local DB is already applied from Task 1; re-run to confirm no-op.
- [ ] **Step 5: Update docs** — `CONTEXT.md` vocabulary (commission, rebate, settlement run), note in `docs/adr/0007-referral-programme-removed.md` that the successor shipped (link the spec).
- [ ] **Step 6: Push + PR** — base: whatever `chore/remove-referrals` is at (if #482 already merged, retarget to `master`). PR body: summary, spec link, verification table. **Ask the operator before merging** — master auto-deploys, and the deploy order note from the removal PR applies.
