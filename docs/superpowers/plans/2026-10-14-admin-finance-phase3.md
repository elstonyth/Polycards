# Admin Phase 3 (Finance Pages and Real-Customer Numbers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four pages. The Profit report becomes a cash-view report that counts real customers by default, and the Dashboard gets the same switch. Settlement, Transactions and Players are decluttered.

**Architecture:**

- **Backend:** one SQL helper (`realCustomerSql`) defines "real customer". It scopes a new read-only `GET /admin/profit-report` and adds an optional `scope` to `/admin/stats` and `/admin/payments/settlement`.
- **Fixes:** the ledger route's missing `RF` type is fixed, and the players list gains a `group` filter.
- **Admin:** existing logic and forms are re-composed into the approved layouts, with drawers for the rarely used edit forms.
- **Unchanged:** `/admin/economy` and `/reports/*`.

**Tech Stack:** Medusa v2 (custom routes, PacksModuleService raw SQL via `em.execute`), jest and medusaIntegrationTestRunner; Mercur admin (React 18, @medusajs/ui, TanStack Query, react-i18next), vitest, Playwright QA scripts.

**Spec:** `docs/superpowers/specs/2026-10-14-admin-finance-pages-design.md`

## Global Constraints

- Frontend + read-only backend only. No migrations, and no writes to production data.
- `/admin/economy` and `/reports/*` behaviour and shape are unchanged.
- **Real customer:** not in any non-default group (`EFFECTIVE_GROUP_SQL`) AND no `metadata.partner_credential`. Ungrouped counts as real.
- Money is RM, summed as integer cents in SQL and divided by 100 once.
- Every window is Malaysia time and half-open `[from, to)`, via `statsWindows`.
- New scope params default to `all` on old endpoints (`/admin/stats`, `/admin/payments/settlement`) and to `default` on the new profit report. Unknown values return 400.
- **i18n:**
  - new labels go under our own namespaces (`profit.*`, plus additions to `settlement.*`, `ledger.*`, `players.*`, `dashboard.*`, `statsBoard.ranges.all`);
  - never a core Medusa namespace (`i18n/no-core-shadow.test.ts`);
  - zhCN may fall back to English.
- **Medusa UI only:**
  - components and tokens from `@medusajs/ui` (`Drawer`, `DropdownMenu`, `Select`, `Tooltip`, `Switch`, `Badge`, `StatusBadge`);
  - no hardcoded colours;
  - `tabular-nums` for money.
- Keep the `data-testid`s `rail-card-<CUR>`, `fx-card-<CUR>`, `fx-preview-<CUR>` and `report-card-<CUR>`, because `scripts/qa-a3pay-ui.mjs` reads them.
- Prettier only on changed files: `node backend/node_modules/prettier/bin/prettier.cjs --write <files>`.
- **Gates per task:**
  - admin: `node ../../node_modules/typescript/bin/tsc -b`, `node ../../node_modules/eslint/bin/eslint.js .` and `node node_modules/vitest/vitest.mjs run` from `backend/apps/admin`;
  - backend: `corepack yarn tsc --noEmit -p .` and jest from `backend/packages/api`.

## Review Focus

1. **A customer in BOTH Default and a partner group.** `EFFECTIVE_GROUP_SQL` puts them in the partner group, so they must be excluded from `scope=default`. Covered by the integration spec (customer "both").
2. **Withdrawals larger than top-ups in the window.** Cash kept is negative; the money trail must not draw bars past 100% or with negative width. Covered by a `moneyTrail` unit test.
3. **A deposit with no `net_amount`** (TGPay leaves some). Its fee is unknown, so it must not count as a zero fee silently: `missing_fees` > 0 and a "minimum" note. Covered by the integration spec (deposit d3) and the page.
4. **`range=all`.** There is no previous window, so "vs last period" must be hidden, not compared with 0. Covered by a route unit test and the page.
5. **Ledger `type=RF`.** Returns 400 today; it must return 200 with RF rows. Covered by the ledger route spec.

---

### Task 1: Real-customer scope helper (backend)

**Files:**

- Create: `backend/packages/api/src/modules/packs/real-customers.ts`
- Test: `backend/packages/api/src/modules/packs/__tests__/real-customers.unit.spec.ts`

**Interfaces:**

- Consumes: `EFFECTIVE_GROUP_SQL` from `modules/packs/odds-sets.ts`.
- Produces:
  - `type CustomerScope = 'default' | 'all'`;
  - `parseScope(raw: unknown, fallback: CustomerScope): CustomerScope | null` (null = invalid);
  - `realCustomerSql(column: string): string`;
  - `scopeSql(scope: CustomerScope, column: string): string` (`''` for `all`, `' AND ' + realCustomerSql(column)` for `default`).

- [ ] **Step 1: Write the failing test**

```ts
import { parseScope, realCustomerSql, scopeSql } from '../real-customers';

describe('real-customer scope', () => {
  it('parses default / all, falls back when absent, rejects anything else', () => {
    expect(parseScope('default', 'all')).toBe('default');
    expect(parseScope('all', 'default')).toBe('all');
    expect(parseScope(undefined, 'all')).toBe('all');
    expect(parseScope('', 'default')).toBe('default');
    expect(parseScope('partners', 'all')).toBeNull();
    expect(parseScope(['all'], 'all')).toBeNull();
  });
  it('adds no SQL for all, and both exclusions for default', () => {
    expect(scopeSql('all', 'gd.customer_id')).toBe('');
    const sql = scopeSql('default', 'gd.customer_id');
    expect(sql.startsWith(' AND ')).toBe(true);
    expect(sql).toContain('gd.customer_id NOT IN');
    expect(sql).toContain('partner_credential');
    expect(realCustomerSql('x.cid')).toContain("IS DISTINCT FROM 'DEFAULT'");
  });
});
```

- [ ] **Step 2: Run, expect FAIL** ("Cannot find module '../real-customers'")

Run: `corepack yarn jest src/modules/packs/__tests__/real-customers.unit.spec.ts` (from `backend/packages/api`; first run in a fresh worktree needs `corepack yarn install` in `backend/` and `corepack yarn build` in `backend/packages/odds-math`).

- [ ] **Step 3: Implement**

```ts
import { EFFECTIVE_GROUP_SQL } from './odds-sets';

/** Who a money figure counts: real customers only, or every account. */
export type CustomerScope = 'default' | 'all';

/** `?scope=` → scope; absent/blank → `fallback`; anything else → null (400). */
export function parseScope(
  raw: unknown,
  fallback: CustomerScope,
): CustomerScope | null {
  if (raw === undefined || raw === '') return fallback;
  return raw === 'default' || raw === 'all' ? raw : null;
}

/**
 * A real customer: in no non-default group (EFFECTIVE_GROUP_SQL is the odds
 * engine's own rule, so ungrouped counts as Default) and not an account the
 * operator generated (metadata.partner_credential, which signupTopupStats
 * already excludes). Scope follows CURRENT membership.
 */
export const realCustomerSql = (column: string): string =>
  `${column} NOT IN (SELECT customer_id FROM (${EFFECTIVE_GROUP_SQL}) eff)` +
  ` AND ${column} NOT IN (SELECT id FROM customer WHERE metadata -> 'partner_credential' IS NOT NULL)`;

export const scopeSql = (scope: CustomerScope, column: string): string =>
  scope === 'all' ? '' : ` AND ${realCustomerSql(column)}`;
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit**: `feat(api): real-customer scope helper`.

### Task 2: Scope on `/admin/stats` and `/admin/payments/settlement` (backend)

**Files:**

- Modify: `backend/packages/api/src/modules/packs/service.ts`
  - `signupTopupStats` (line ~7535): new param `scope: CustomerScope = 'all'`. Add `scopeSql(scope, 'customer_id')` inside the `topups` CTE WHERE and `scopeSql(scope, 'id')` in the sign-up subquery.
  - `withdrawalStats` (~7596): same, with `scopeSql(scope, 'customer_id')`.
  - `settlementRows` (~7797): fourth param `scope: CustomerScope = 'all'`. Add `scopeSql(scope, 'customer_id')` to the deposit, withdrawal and ledger queries; the scope SQL binds no params.
- Modify: `backend/packages/api/src/modules/packs/facets.ts`: the `GatewayReports` type picks `settlementRows`, so the signature flows automatically. Check it with tsc.
- Modify: `backend/packages/api/src/api/admin/stats/route.ts`: `const scope = parseScope(req.query.scope, 'all')`. Null → `MedusaError INVALID_DATA "scope must be default or all"`. Pass it to both service calls and echo `scope` in the JSON.
- Modify: `backend/packages/api/src/api/admin/payments/settlement/route.ts`: same parse and 400. Pass to `settlementRows(granularity, since, currency, scope)` and echo `scope`.
- Test: `backend/packages/api/integration-tests/http/admin-stats.spec.ts` (new `it`).

**Interfaces:**

- Consumes: Task 1 `parseScope`, `scopeSql`, `CustomerScope`.
- Produces:
  - `signupTopupStats(from, to, scope?)`, `withdrawalStats(from, to, scope?)`, `settlementRows(granularity, since, currency, scope?)`;
  - `/admin/stats?scope=` and `/admin/payments/settlement?scope=`, both echoing `scope`.

- [ ] **Step 1: Write the failing test** (append inside `describe('admin stats')`):

```ts
it('scope=default counts only real customers; scope=all and absent count everyone', async () => {
  const container = getContainer();
  const customers = container.resolve(Modules.CUSTOMER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const [real, grouped, both] = await customers.createCustomers([
    { email: 'scope-real@test.dev', has_account: true },
    { email: 'scope-grouped@test.dev', has_account: true },
    { email: 'scope-both@test.dev', has_account: true },
  ]);
  for (const c of [real, grouped, both])
    await setCreatedAt('customer', c.id, IN_CURRENT);
  const [def, partner] = await customers.createCustomerGroups([
    { name: 'DEFAULT' },
    { name: 'Scope Partners' },
  ]);
  await customers.addCustomerToGroup([
    { customer_id: grouped.id, customer_group_id: partner.id },
    { customer_id: both.id, customer_group_id: def.id },
    { customer_id: both.id, customer_group_id: partner.id },
  ]);
  const minted = await unwrapResponse(
    api.post(
      '/admin/players',
      { count: 1 },
      { headers: { authorization: `Bearer ${adminToken}` } },
    ),
  );
  const generated = minted.data.players[0].id as string;
  await setCreatedAt('customer', generated, IN_CURRENT);

  await packs.createGatewayDeposits(
    [real.id, grouped.id, both.id, generated].map((customer_id, i) => ({
      merchant_transaction_id: `scope-mt-${i}`,
      customer_id,
      amount_requested: 100,
      amount_settled: 100,
      payment_method_code: 'BQR',
      status: 'settled' as const,
      settled_at: new Date(IN_CURRENT),
    })),
  );
  await packs.createGatewayWithdrawals(
    [real.id, grouped.id].map((customer_id, i) => ({
      merchant_transaction_id: `scope-wd-${i}`,
      customer_id,
      amount: 40,
      amount_settled: 40,
      bank_code: 'MBB',
      account_number: '000000000000',
      account_holder_name: 'Scope Test',
      status: 'settled' as const,
      settled_at: new Date(IN_CURRENT),
    })),
  );

  const q = '?range=custom&from=2026-09-10&to=2026-09-11';
  const real_ = await stats(`${q}&scope=default`);
  expect(real_.status).toBe(200);
  expect(real_.data.scope).toBe('default');
  expect(real_.data.current.stats).toMatchObject({
    signups: 1,
    topup_count: 1,
    topup_amount: 100,
    withdrawal_count: 1,
    withdrawal_amount: 40,
  });
  const all = await stats(`${q}&scope=all`);
  expect(all.data.current.stats).toMatchObject({
    signups: 3,
    topup_count: 4,
    topup_amount: 400,
    withdrawal_count: 2,
    withdrawal_amount: 80,
  });
  expect((await stats(q)).data.current.stats.topup_count).toBe(4);
  expect((await stats(`${q}&scope=partners`)).status).toBe(400);

  const settle = (s: string) =>
    unwrapResponse(
      api.get(`/admin/payments/settlement?granularity=month&periods=60${s}`, {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
  const sumIn = (r: { data: { periods: { deposits: { gross: number } }[] } }) =>
    r.data.periods.reduce((n, p) => n + p.deposits.gross, 0);
  expect(sumIn(await settle('&scope=default'))).toBe(100);
  expect(sumIn(await settle(''))).toBe(400);
  expect((await settle('&scope=nope')).status).toBe(400);
});
```

Generated sign-ups never count (an existing rule). So `signups` is 1 for default (`real`) and 3 for all (real + grouped + both). The `generated` account is out of both.

- [ ] **Step 2: Run, expect FAIL**: `corepack yarn test:integration:http -- admin-stats.spec.ts` (or `TEST_TYPE=integration:http corepack yarn jest integration-tests/http/admin-stats.spec.ts`). The failure is `data.scope` undefined, or counts of 4 when 1 is expected.
- [ ] **Step 3: Implement** the service and route changes described above.
- [ ] **Step 4: Run the spec, expect PASS. Also run** `gateway-settlement.spec.ts`, which must stay green with no `scope`.
- [ ] **Step 5: Commit**: `feat(api): real-customer scope on stats and settlement report`.

### Task 3: Profit report endpoint (backend)

**Files:**

- Create:
  - `backend/packages/api/src/modules/packs/profit.ts` (pure fold);
  - `backend/packages/api/src/api/admin/economy/pack-rtp.ts` (the RTP block moved out of the economy route; the economy route imports it, output identical);
  - `backend/packages/api/src/api/admin/profit-report/route.ts`.
- Modify: `backend/packages/api/src/modules/packs/service.ts`:
  - `ledgerReasonTotals(from?, to?, scope = 'all')`, with `scopeSql(scope, 'customer_id')` appended;
  - new `profitCashTotals(from: Date | null, to: Date | null, scope)`;
  - new `profitOwed(scope, fx)`.
- Test:
  - `backend/packages/api/src/modules/packs/__tests__/profit.unit.spec.ts`;
  - `backend/packages/api/integration-tests/http/profit-report.spec.ts`;
  - `economy.spec.ts` must stay green.

**Interfaces:**

- Consumes: Task 1; `statsWindows`, `STATS_RANGES` (`modules/packs/stats.ts`); `normalSenSql` (`bonus-credit.ts`); `LIVE_VALUE_USD_SQL`, `DEFAULT_MARKET_MULTIPLIER`, `resolveFxRate` (`pricing.ts`); `FLAT_PERCENT` (`buyback-rate.ts`).
- Produces: `GET /admin/profit-report`, with the response exactly as spec §4.1. `packRtpRows(packs: PacksModuleService): Promise<EconomyPackRow[]>`.

Pure fold (`profit.ts`):

```ts
export type CashSide = {
  count: number;
  grossCents: number;
  feeCents: number;
  missingFees: number;
};
export type CashCents = { topups: CashSide; withdrawals: CashSide };
export type OwedCents = {
  walletCashCents: number;
  walletBonusCents: number;
  walletNoTopupCents: number;
  cardCount: number;
  deliveringCount: number;
  cardSellbackCents: number;
};

export const keptCents = (c: CashCents): number =>
  c.topups.grossCents -
  c.topups.feeCents -
  c.withdrawals.grossCents -
  c.withdrawals.feeCents;

const side = (s: CashSide) => ({
  count: s.count,
  gross: s.grossCents / 100,
  fees: s.feeCents / 100,
  missing_fees: s.missingFees,
});

export function profitCash(current: CashCents, previous: CashCents | null) {
  return {
    topups: side(current.topups),
    withdrawals: side(current.withdrawals),
    kept: keptCents(current) / 100,
    previous_kept: previous ? keptCents(previous) / 100 : null,
  };
}

export function profitOwed(owed: OwedCents, allTime: CashCents) {
  const totalCents = owed.walletCashCents + owed.cardSellbackCents;
  const allKept = keptCents(allTime);
  return {
    wallet_cash: owed.walletCashCents / 100,
    wallet_bonus: owed.walletBonusCents / 100,
    wallet_no_topup: owed.walletNoTopupCents / 100,
    cards: {
      count: owed.cardCount,
      delivering: owed.deliveringCount,
      sellback: owed.cardSellbackCents / 100,
    },
    total: totalCents / 100,
    all_time_kept: allKept / 100,
    if_all_cashed_out: (allKept - totalCents) / 100,
  };
}

/** Ledger per-reason totals (ledgerReasonTotals rows) → the activity lines. */
export function profitActivity(rows: { reason: string; amount: number }[]) {
  const cents = (r: string) =>
    Math.round((rows.find((x) => x.reason === r)?.amount ?? 0) * 100);
  return {
    pack_sales: -cents('pack_open') / 100,
    sellbacks: cents('buyback') / 100,
    promo_given:
      (cents('bonus_grant') +
        cents('reward_credit') +
        cents('voucher_claim') +
        cents('daily_reward')) /
      100,
    delivery_fees: -cents('delivery_fee') / 100,
    referral_commission: cents('referral_commission') / 100,
    adjustments: cents('adjustment') / 100,
  };
}
```

Service SQL. Both methods are `@InjectManager()` and use `em.execute` like `withdrawalStats`.

`profitCashTotals(from, to, scope)` runs one statement:

```sql
SELECT
  (SELECT count(*) FROM gateway_deposit d WHERE d.deleted_at IS NULL AND d.status='settled' AND d.settled_at IS NOT NULL {win:d} {scope:d.customer_id})::int AS t_n,
  (SELECT COALESCE(SUM(ROUND(d.amount_settled*100)),0) FROM gateway_deposit d WHERE … same …)::bigint AS t_gross,
  (SELECT COALESCE(SUM(ROUND((d.amount_settled - d.net_amount)*100)),0) FROM gateway_deposit d WHERE … same … AND d.net_amount IS NOT NULL AND d.amount_settled IS NOT NULL)::bigint AS t_fee,
  (SELECT count(*) FROM gateway_deposit d WHERE … same … AND d.net_amount IS NULL)::int AS t_missing,
  (SELECT count(*) FROM gateway_withdrawal w WHERE w.deleted_at IS NULL AND w.status='settled' AND w.settled_at IS NOT NULL {win:w} {scope:w.customer_id})::int AS w_n,
  (SELECT COALESCE(SUM(ROUND(w.amount*100)),0) FROM gateway_withdrawal w WHERE … same …)::bigint AS w_gross,
  (SELECT COALESCE(SUM(ROUND((w.net_amount - COALESCE(w.amount_settled, w.amount))*100)),0) FROM gateway_withdrawal w WHERE … same … AND w.net_amount IS NOT NULL)::bigint AS w_fee,
  (SELECT count(*) FROM gateway_withdrawal w WHERE … same … AND w.net_amount IS NULL)::int AS w_missing
```

- `{win:x}` = `AND x.settled_at >= ?::timestamptz AND x.settled_at < ?::timestamptz` when from/to are given, else empty.
- `{scope:col}` = `scopeSql(scope, col)`.
- Build the WHERE once per table as a string, and repeat the window params per subquery in order.

`profitOwed(scope, fx)` runs two statements:

```sql
WITH bal AS (
  SELECT customer_id,
         SUM(ROUND(amount*100) - COALESCE(bonus_cents,0)) AS normal_cents,
         SUM(COALESCE(bonus_cents,0)) AS bonus_cents,
         bool_or(reason = 'topup' AND amount > 0) AS has_topup
    FROM credit_transaction
   WHERE deleted_at IS NULL {scope:customer_id}
   GROUP BY customer_id
)
SELECT COALESCE(SUM(GREATEST(normal_cents,0)) FILTER (WHERE has_topup),0)::bigint AS cash_cents,
       COALESCE(SUM(GREATEST(normal_cents,0)) FILTER (WHERE NOT has_topup),0)::bigint AS no_topup_cents,
       COALESCE(SUM(GREATEST(bonus_cents,0)),0)::bigint AS bonus_cents
  FROM bal
```

```sql
SELECT COUNT(*)::bigint AS n,
       (COUNT(*) FILTER (WHERE p.status = 'delivering'))::bigint AS delivering,
       COALESCE(SUM(ROUND(${LIVE_VALUE_USD_SQL} * ? * ? )), 0)::bigint AS cents
  FROM pull p JOIN card c ON c.handle = p.card_id AND c.deleted_at IS NULL
 WHERE p.status IN ('vaulted','delivering') AND p.deleted_at IS NULL {scope:p.customer_id}
```

- The second statement's params are `[DEFAULT_MARKET_MULTIPLIER, fx, FLAT_PERCENT]`. The value is display MYR × percent: `ROUND(value_usd * fx * percent)`, which is cents, because × 100 and ÷ 100 cancel.

Route (`profit-report/route.ts`):

```ts
const RANGES = [...STATS_RANGES, 'all'] as const;
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const scope = parseScope(req.query.scope, 'default');
  if (!scope)
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'scope must be default or all',
    );
  const range =
    typeof req.query.range === 'string' && req.query.range
      ? req.query.range
      : 'month';
  const now = new Date();
  const windows =
    range === 'all'
      ? null
      : statsWindows(range, now, str(req.query.from), str(req.query.to));
  if (range !== 'all' && !windows)
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `range must be one of ${RANGES.join(', ')}; custom needs from <= to as YYYY-MM-DD, starting no later than today.`,
    );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const fx = await resolveFxRate(packs);
  const [cur, prev, all, owed, reasons, rtp] = await Promise.all([
    packs.profitCashTotals(
      windows?.current.from ?? null,
      windows?.current.to ?? null,
      scope,
    ),
    windows
      ? packs.profitCashTotals(
          windows.previous.from,
          windows.previous.to,
          scope,
        )
      : Promise.resolve(null),
    packs.profitCashTotals(null, null, scope),
    packs.profitOwed(scope, fx),
    packs.ledgerReasonTotals(
      windows?.current.from.toISOString(),
      windows?.current.to.toISOString(),
      scope,
    ),
    packRtpRows(packs),
  ]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    as_of: now,
    scope,
    range,
    window: windows
      ? { from: windows.current.from, to: windows.current.to }
      : null,
    previous: windows
      ? { from: windows.previous.from, to: windows.previous.to }
      : null,
    cash: profitCash(cur, prev),
    owed: profitOwed(owed, all),
    activity: profitActivity(reasons),
    packs: rtp,
  });
}
```

- [ ] **Step 1: Write the failing unit test** (`profit.unit.spec.ts`):

```ts
import { keptCents, profitActivity, profitCash, profitOwed } from '../profit';
const side = (n: number, g: number, f: number, m = 0) => ({
  count: n,
  grossCents: g,
  feeCents: f,
  missingFees: m,
});
describe('profit fold', () => {
  it('cash kept = top-ups − their fees − withdrawals − their fees, and can go negative', () => {
    const c = { topups: side(3, 30000, 450), withdrawals: side(1, 50000, 100) };
    expect(keptCents(c)).toBe(30000 - 450 - 50000 - 100);
    expect(profitCash(c, null).previous_kept).toBeNull();
    expect(profitCash(c, c).previous_kept).toBe(-205.5);
  });
  it('owed = wallet cash + cards at sell-back; if-all-cashed-out uses all-time cash', () => {
    const owed = {
      walletCashCents: 10000,
      walletBonusCents: 500,
      walletNoTopupCents: 700,
      cardCount: 3,
      deliveringCount: 1,
      cardSellbackCents: 9000,
    };
    const all = { topups: side(5, 100000, 0), withdrawals: side(2, 20000, 0) };
    expect(profitOwed(owed, all)).toEqual({
      wallet_cash: 100,
      wallet_bonus: 5,
      wallet_no_topup: 7,
      cards: { count: 3, delivering: 1, sellback: 90 },
      total: 190,
      all_time_kept: 800,
      if_all_cashed_out: 610,
    });
  });
  it('maps ledger reasons to activity lines with signs flipped for spend', () => {
    expect(
      profitActivity([
        { reason: 'pack_open', amount: -300 },
        { reason: 'buyback', amount: 120 },
        { reason: 'bonus_grant', amount: 50 },
        { reason: 'daily_reward', amount: 5 },
        { reason: 'delivery_fee', amount: -15 },
        { reason: 'referral_commission', amount: 2 },
        { reason: 'adjustment', amount: -10 },
        { reason: 'topup', amount: 999 },
      ]),
    ).toEqual({
      pack_sales: 300,
      sellbacks: 120,
      promo_given: 55,
      delivery_fees: 15,
      referral_commission: 2,
      adjustments: -10,
    });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module missing).
- [ ] **Step 3: Implement `profit.ts`** as above, then run the unit test and expect PASS.
- [ ] **Step 4: Write the failing integration spec** (`profit-report.spec.ts`). It reuses `mintSuperAdmin`, `unwrapResponse` and the group-seeding pattern of Task 2.
  - **Customers:** `real` (DEFAULT member), `grouped` (Scope Partners), and a generated account.
  - **Deposits:** `real` 100 settled with net 98 (d1), `real` 50 settled with net NULL (d3), `grouped` 1000 settled with net 1000.
  - **Withdrawal:** `real` 60 settled, net 61.
  - **Credit rows:**
    - `real`: topup +150, pack_open −80 (bonus_cents 0), buyback +30;
    - `grouped`: topup +1000, bonus_grant +200 (bonus_cents 20000).
  - **Card:** one vaulted pull for `real` on a card with market_value 10 USD (multiplier 1.2). Create the card with `packs.createCards` and the pull with `packs.createPulls`, minimal fields as in `economy.spec.ts`.

  Assertions for `?range=all&scope=default`:

  ```ts
  expect(r.data.window).toBeNull();
  expect(r.data.previous).toBeNull();
  expect(r.data.cash.topups).toEqual({
    count: 2,
    gross: 150,
    fees: 2,
    missing_fees: 1,
  });
  expect(r.data.cash.withdrawals).toEqual({
    count: 1,
    gross: 60,
    fees: 1,
    missing_fees: 0,
  });
  expect(r.data.cash.kept).toBe(87);
  expect(r.data.cash.previous_kept).toBeNull();
  expect(r.data.owed.wallet_cash).toBe(100); // 150 − 80 + 30
  expect(r.data.owed.cards.count).toBe(1);
  expect(r.data.activity).toMatchObject({
    pack_sales: 80,
    sellbacks: 30,
    promo_given: 0,
  });
  ```

  `?range=all&scope=all`: `cash.topups.gross` 1150, `owed.wallet_bonus` 200, `activity.promo_given` 200. `?scope=bad` → 400, `?range=forever` → 400, and no token → 401.
  The card sell-back equals `ROUND(10 × 1.2 × fx × 90)` cents. Read fx back via `GET /admin/economy` liability ÷ 1 card, then compare with `× 0.9`, within 0.01.

  Run: `TEST_TYPE=integration:http corepack yarn jest integration-tests/http/profit-report.spec.ts`. Expect FAIL (404).

- [ ] **Step 5: Implement** the service methods, `pack-rtp.ts` (move lines 58-120 of `economy/route.ts` verbatim into `export async function packRtpRows(packs)`, returning `packRows`), the economy route import, and the profit route.
- [ ] **Step 6: Run** `profit-report.spec.ts`, `economy.spec.ts` and `desk-reports.spec.ts`. Expect all PASS.
- [ ] **Step 7: Commit**: `feat(api): profit report with real-customer scope`.

### Task 4: Ledger RF type and players group filter (backend)

**Files:**

- Modify: `backend/packages/api/src/api/admin/ledger/route.ts:16-24`: add `'RF'` to `LEDGER_TYPES`.
- Modify: `backend/packages/api/src/api/admin/players/route.ts`: parse `group` (absent | `default` | a `cusgroup_…` id; anything else 400).
  - **Resolving the group:**
    - for `default`, `exclude` = ids from `SELECT customer_id FROM (${EFFECTIVE_GROUP_SQL}) eff` (new service method `nonDefaultMemberIds(): Promise<string[]>`);
    - for an id, `include` = `SELECT customer_id FROM customer_group_customer WHERE customer_group_id = ? AND deleted_at IS NULL` (new `groupMemberIds(id)`).
  - **Applying it:**
    - fold the restriction into `filters`: `include` intersects `filters.id` or becomes `{ id: include }`;
    - `exclude` becomes `{ id: { $nin: exclude } }`, or filters the explicit `filters.id` list;
    - in `ledgerSortedPage`, pass the intersected `ids`, plus a new `excludeIds` param to `playerIdsByLedger`, which appends `AND customer_id <> ALL(?::text[])`;
    - an empty `include` → return `{ total: 0, players: [] }` early.
- Test: `integration-tests/http/admin-ledger-route.spec.ts` (RF case); `integration-tests/http/players-list.spec.ts` (group cases).

**Interfaces:** Produces `GET /admin/players?group=default|<id>`, and `GET /admin/ledger?type=RF` → 200.

- [ ] **Step 1: Failing tests.**
  - In the ledger spec: insert a `ledger_entry` of type RF the way the spec seeds other types, then `GET /admin/ledger?type=RF` → 200 with one entry of type RF.
  - In the players spec: create customers `a` (no group), `b` (DEFAULT) and `c` (partner group), then:
    - `?group=default` → ids include a and b, not c;
    - `?group=<partnerId>` → only c;
    - `?group=default&sort=wallet:desc` → still excludes c;
    - `?group=bogus` → 400.
- [ ] **Step 2: Run, expect FAIL** (400 for RF; group ignored).
- [ ] **Step 3: Implement** as described.
- [ ] **Step 4: Run both specs, expect PASS**, plus `players-create.spec.ts`.
- [ ] **Step 5: Commit**: `fix(api): ledger RF filter; players group filter`.

### Task 5: Admin data layer

**Files:**

- Modify: `backend/apps/admin/src/lib/admin-rest.ts`
  - add `export type CustomerScope = 'default' | 'all'`;
  - add the `ProfitRange = StatsRange | 'all'`, `ProfitReport` interface (spec §4.1) and `getProfitReport(range, from, to, scope)`, which sends `from`/`to` only for custom;
  - `getStatsReport(range, from, to, scope = 'all')` appends `&scope=` only when `scope !== 'all'`;
  - `getSettlementReport(…, scope = 'all')` likewise;
  - `listPlayers(page, q, limit, sort, group?)` appends `&group=`;
  - `StatsReport` / `SettlementReport` gain `scope?: CustomerScope`.
- Modify: `backend/apps/admin/src/lib/query-keys.ts`
  - `profitReport(range, from, to, scope)` = `['admin','profit-report',range,from,to,scope]`;
  - `stats(...)` and `settlement(...)` gain a trailing `scope` segment;
  - `players(page, q, sort, group)` gains `group ?? ''`.
- Modify: `backend/apps/admin/src/lib/queries.ts`: add `useProfitReport`; thread `scope` through `useStats` and `useSettlementReport`, and `group` through `usePlayers`. Defaults keep existing call sites compiling.
- Create: `backend/apps/admin/src/lib/scope-param.ts`: `useScopeParam(): [CustomerScope, (s: CustomerScope) => void]`, which reads and writes `?scope=all` with `useSearchParams` (absent = `default`, and set `default` deletes the param, `replace: true`), plus the pure `scopeFromParam(v: string | null): CustomerScope`.
- Modify: `backend/apps/admin/src/routes/overview/use-live-refresh.ts`: add `['admin','profit-report']` to `LIVE_KEYS` (harmless; only refetches when mounted).
- Test: `lib/query-keys.test.ts` (new keys under the `['admin','profit-report']` prefix; stats key ends with scope), `lib/scope-param.test.ts` (`scopeFromParam(null) === 'default'`, `('all') === 'all'`, `('x') === 'default'`).

- [ ] Steps: failing tests → run (FAIL) → implement → run (PASS) → tsc and eslint → commit `feat(admin): profit report client, scope param, players group filter client`.

### Task 6: Profit report page

**Files:**

- Replace: `backend/apps/admin/src/routes/economy/page.tsx`. Keep the route config label `pcNav.profitReport`, rank and nesting.
- Create, in `backend/apps/admin/src/routes/economy/`:
  - `ScopeSwitch.tsx`, also used by the Dashboard;
  - `CashCard.tsx`, `OwedCard.tsx`, `ActivityCard.tsx`, `PayoutRateCard.tsx`;
  - `money-trail.ts`.
- Modify: `backend/apps/admin/src/routes/overview/RangePicker.tsx`: optional `ranges` prop (default `RANGES`). `range` and `onRange` widen to `string`, with a generic `R extends string`.
- Modify: `backend/apps/admin/src/i18n/en.json`: `profit.*` keys (below) and `statsBoard.ranges.all: "All time"`.
- Test: `backend/apps/admin/src/routes/economy/money-trail.test.ts`.

**Interfaces:**

- Consumes: Task 5 `useProfitReport`, `useScopeParam`, `ProfitReport`.
- Produces:
  - `ScopeSwitch({ scope, onScope })`;
  - `moneyTrail(cash)` → `{ rows: { key, amount, left, width, tone }[], max }`. `left` and `width` are percentages in 0..100. `tone` is `'in' | 'out' | 'kept' | 'loss'`.

`money-trail.ts`:

```ts
export type TrailRow = {
  key: 'topups' | 'fees' | 'withdrawals' | 'kept';
  amount: number;
  left: number;
  width: number;
  tone: 'in' | 'out' | 'kept' | 'loss';
};
const pct = (n: number, max: number) =>
  max > 0 ? Math.min(100, Math.max(0, (n / max) * 100)) : 0;
/** Waterfall geometry: top-ups fill from the left, fees and withdrawals are
 *  taken off the right of what remains, cash kept is what is left. Scaled to
 *  the larger of top-ups and money out so a loss still fits. */
export function moneyTrail(c: {
  topups: { gross: number; fees: number };
  withdrawals: { gross: number; fees: number };
  kept: number;
}) {
  const out = c.topups.fees + c.withdrawals.gross + c.withdrawals.fees;
  const max = Math.max(c.topups.gross, out);
  const afterFees = c.topups.gross - c.topups.fees;
  return {
    max,
    rows: [
      {
        key: 'topups',
        amount: c.topups.gross,
        left: 0,
        width: pct(c.topups.gross, max),
        tone: 'in',
      },
      {
        key: 'fees',
        amount: -c.topups.fees,
        left: pct(Math.max(0, afterFees), max),
        width: pct(c.topups.fees, max),
        tone: 'out',
      },
      {
        key: 'withdrawals',
        amount: -(c.withdrawals.gross + c.withdrawals.fees),
        left: pct(
          Math.max(0, afterFees - c.withdrawals.gross - c.withdrawals.fees),
          max,
        ),
        width: pct(c.withdrawals.gross + c.withdrawals.fees, max),
        tone: 'out',
      },
      {
        key: 'kept',
        amount: c.kept,
        left: 0,
        width: pct(Math.abs(c.kept), max),
        tone: c.kept < 0 ? 'loss' : 'kept',
      },
    ] as TrailRow[],
  };
}
```

Test (`money-trail.test.ts`):

```ts
import { moneyTrail } from './money-trail';
it('scales to top-ups and keeps every bar inside 0..100', () => {
  const t = moneyTrail({
    topups: { gross: 1000, fees: 20 },
    withdrawals: { gross: 400, fees: 4 },
    kept: 576,
  });
  expect(t.rows.map((r) => r.width)).toEqual([100, 2, 40.4, 57.6]);
  expect(t.rows[2].left).toBeCloseTo(57.6);
});
it('a loss scales to money out and marks kept as loss', () => {
  const t = moneyTrail({
    topups: { gross: 100, fees: 0 },
    withdrawals: { gross: 300, fees: 0 },
    kept: -200,
  });
  expect(t.max).toBe(300);
  for (const r of t.rows) {
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.left + r.width).toBeLessThanOrEqual(100.0001);
  }
  expect(t.rows[3]).toMatchObject({ tone: 'loss', width: (200 / 300) * 100 });
});
it('all zero draws nothing', () => {
  expect(
    moneyTrail({
      topups: { gross: 0, fees: 0 },
      withdrawals: { gross: 0, fees: 0 },
      kept: 0,
    }).rows.every((r) => r.width === 0),
  ).toBe(true);
});
```

**Page composition (mockup A).**

- **State:** range (default `month`), custom from and to (`todayMyt`), and `[scope, setScope] = useScopeParam()`. Data: `useProfitReport(range, from, to, scope)`.
- **Header `Container`:**
  - `Heading` with `t('profit.title')`;
  - subtitle `t('profit.subtitle', { window })`, using `windowText(data.window)`, or `t('profit.subtitleAll')` when the window is null;
  - on the right, `ScopeSwitch`: a `Badge color="green"` "● Real customers" pill when scope is default, else grey "All groups", next to a `Switch` labelled "All groups" (checked = scope all, with a `Tooltip` holding `profit.scopeAllHint`);
  - below the header, `RangePicker ranges={[...RANGES.slice(0, 6), 'all', 'custom']}`.
- **CashCard:** label `profit.cashKept` with an ⓘ `Tooltip` (`profit.cashKeptHint`).
  - Big value: `Heading level="h1"`, `text-ui-tag-green-text` or `text-ui-fg-error` by sign, with `useCountUp` from `lib/use-count-up`.
  - A "vs last period" `Badge`, only when `previous_kept !== null`: diff = `amountChange(kept, previous_kept)` from `lib/dashboard`.
  - A trail grid `grid-cols-[minmax(0,12rem)_1fr_8rem]`, one row per `moneyTrail` row: the label, then a bar `div` absolutely positioned at `left%`/`width%` with `bg-ui-tag-green-icon` / `bg-ui-tag-red-icon` / green at 55% opacity, using class `pc-grow origin-left`, then the amount right-aligned and signed.
  - When `topups.missing_fees + withdrawals.missing_fees > 0`, a muted line: `profit.feeFloor`.
- **OwedCard:** title, a "right now" `Badge`, and the subtitle. Three tiles as a `grid` with `gap-px bg-ui-border-base`, like the old Economy grid:
  - `walletCash`, with note `profit.walletNote`;
  - `cards`, with note `profit.cardsNote` and an ⓘ for `profit.cardsHint`;
  - `ifAllCashedOut`, coloured by sign, with an ⓘ for `profit.ifAllHint`.
- **ActivityCard:** title and subtitle, then six rows (label | amount, right, `tabular-nums`). Sell-backs, delivery and referral show a leading "−" visually only where they are money out (sellbacks, referral). Delivery fees and pack sales stay positive.
- **PayoutRateCard:** the existing sortable table via `useTableSort`, with columns pack | price | expected back | payout rate. The rate cell is a 140px meter (`bg-ui-bg-component` track, fill width `min(rtp/150, 1)`, a 1px marker at 66.6% = 100%) plus a `Badge`: red > 100, orange ≥ 95, grey otherwise, `toFixed(1)%`.
- **Loading and errors:** loading uses `LoadingSkeleton` per card; an error shows one `Text` with `profit.loadError` and Retry (`SectionError` from `routes/overview/SectionState`).
- **Root:** `className="pc-dashboard flex flex-col gap-y-3"`, so the settle and grow motion applies; each card gets `pc-settle`.

i18n `profit` (exact English):

```json
"profit": {
  "title": "Profit report",
  "subtitle": "Real money in and out, Malaysia time · {{window}}",
  "subtitleAll": "Real money in and out, Malaysia time · all time",
  "scopeReal": "Real customers",
  "scopeAll": "All groups",
  "scopeAllHint": "Count every account, including other groups and generated accounts.",
  "cashKept": "Cash kept",
  "cashKeptHint": "Top-ups received after gateway fees, minus withdrawals paid (fees included).",
  "vsLast": "vs last period",
  "trail": { "topups": "Top-ups received", "fees": "Gateway fees", "withdrawals": "Withdrawals paid", "kept": "Cash kept" },
  "feeFloor": "{{count}} payments have no fee on file yet, so fees shown are a minimum.",
  "owedTitle": "Still owed to players",
  "owedNow": "right now",
  "owedSubtitle": "What players could still cash out.",
  "walletCash": "Withdrawable wallets",
  "walletNote": "Plus {{bonus}} bonus and {{noTopup}} in never-topped-up accounts, which can't be withdrawn.",
  "cards": "Cards in vaults, at sell-back",
  "cardsNote_one": "{{count}} card, {{delivering}} being shipped",
  "cardsNote_other": "{{count}} cards, {{delivering}} being shipped",
  "cardsHint": "Valued at the 90% sell-back price. Includes free and promo cards.",
  "ifAllCashedOut": "Profit if all cashed out",
  "ifAllHint": "All-time cash kept minus what is still owed. Ignores the period picked above.",
  "movedTitle": "Where the money moved",
  "movedSubtitle": "Inside the site, this period. Paid credit only; promo has its own line.",
  "moved": { "pack_sales": "Pack sales", "sellbacks": "Sell-backs paid", "promo_given": "Promo given", "delivery_fees": "Delivery fees", "referral_commission": "Referral commission paid", "adjustments": "Admin adjustments" },
  "rtpTitle": "Pack payout rate",
  "rtpSubtitle": "Expected value back per open with today's odds and card values. Over 100% means the pack loses money.",
  "pack": "Pack", "price": "Price", "expectedBack": "Expected back", "rate": "Payout rate",
  "empty": "No active packs.",
  "loadError": "Couldn't load the profit report."
}
```

- [ ] Steps: write `money-trail.test.ts` → run (FAIL) → implement `money-trail.ts` → PASS → build the components and page → tsc, eslint and vitest → commit `feat(admin): profit report page (cash view, real customers)`.

### Task 7: Dashboard scope switch

**Files:** Modify `backend/apps/admin/src/routes/overview/page.tsx` and `MoneyFlowCard.tsx`, plus `en.json` (`dashboard.scopeHint`: "Tiles and chart follow this switch. Work queues and latest payments always show everyone.").

**Behaviour:**

- `const [scope, setScope] = useScopeParam()`, then `useStats(range, …, scope)`.
- `ScopeSwitch` from `routes/economy/ScopeSwitch` goes in the header row next to `LiveBadge`, with an ⓘ for `dashboard.scopeHint`.
- `MoneyFlowCard` gets a `scope` prop: `useSettlementReport(granularity, 12, '', scope)`.
- `KpiTiles` and the net cash figure come from the scoped stats with no change in code.

- [ ] Steps: implement → tsc, eslint and vitest → commit `feat(admin): Dashboard real-customer switch`.

### Task 8: Settlement redesign

**Files:**

- Modify: `routes/settlement/page.tsx`
- Replace: `RailCard.tsx` with `GatewayStrip.tsx`
- Split `RegionalFxCard.tsx` into `ExchangeRateCard.tsx` (view) and `FxEditDrawer.tsx` (form)
- Rewrite `ReportCard.tsx`
- Rewrite `AuditCard.tsx` as `AuditFindings.tsx`
- Create `GatewaySwitchDrawer.tsx`
- Create `settlement-rows.ts`, with test `settlement-rows.test.ts`
- Modify `en.json` (settlement additions)
- Modify `scripts/qa-a3pay-ui.mjs` (open the Edit rates drawer before reading `fx-preview-SGD`)

**Pure helper (`settlement-rows.ts`):**

```ts
import type { SettlementPeriod } from '../../lib/admin-rest';
export type ResultRow = {
  period: string;
  inGross: number;
  inCount: number;
  fees: number;
  outGross: number;
  outCount: number;
  net: number;
  gap: number;
  feeFloor: boolean;
  grossFloor: boolean;
};
/** One results-table row: money in/out (gross), both fees together, net cash
 *  = in − fees − out, and the deposit ledger gap (the withdrawal delta is
 *  timing-skewed by design, so it lives in the hover, not the check). */
export const resultRow = (p: SettlementPeriod): ResultRow => ({
  period: p.period,
  inGross: p.deposits.gross,
  inCount: p.deposits.count,
  fees: p.deposits.fee + p.withdrawals.fee,
  outGross: p.withdrawals.gross,
  outCount: p.withdrawals.count,
  net:
    Math.round(
      (p.deposits.gross -
        p.deposits.fee -
        p.withdrawals.fee -
        p.withdrawals.gross) *
        100,
    ) / 100,
  gap: Math.abs(p.delta.deposits) < 0.005 ? 0 : p.delta.deposits,
  feeFloor: p.deposits.missingNet + p.withdrawals.missingNet > 0,
  grossFloor: p.deposits.missingGross > 0,
});
```

Test: one period with deposits gross 350, fee 3.8, count 7; withdrawals gross 50, fee 1, count 1; delta.deposits −26075. Expect `net === 295.2`, `fees === 4.8`, `gap === -26075`. A second case: a delta of 0.004 gives `gap === 0`.

**GatewayStrip (`data-testid="rail-card-<CUR>"`):**

- **Hooks:** `useGatewayBalance(currency)` and `useGatewayAudit(currency)`.
- **Layout:** one `Container p-0` with a grid of tiles, `sm:grid-cols-2 lg:grid-cols-4`, `gap-px bg-ui-border-base`.
  - **Tile 1:** "Gateway" label, the gateway name (`b.label`) and the status `Badge` (existing status logic from RailCard lines 37-45). For RM only, a `Button variant="transparent" size="small"` "Switch gateway…" opens `GatewaySwitchDrawer`.
  - **Tiles 2-3 (or 2-4 for three-wallet gateways):** wallet tiles. The label has an ⓘ `Tooltip` holding the old `settlement.<key>Hint`, and the value is `inCurrency(...)`.
  - **Last tile:** "Gateway check". A ✓ All match `Badge` (green) when `findings_total === 0` and `last_audited_at` is set; a "⚠ N payments differ" `Badge` (orange) when `findings_total > 0`; "Not checked yet" (grey) when it has never run. Beneath: `settlement.checkedAt` with the time, and an ⓘ holding `settlement.checkHint` plus each `history` line (the old `auditHistory` string).
- **Disabled or error states:** the existing `balanceDisabled`, `balanceError` and `balanceWarning` lines render under the grid as one `Text` each, unchanged.

**GatewaySwitchDrawer:**

- `Drawer` with `Drawer.Content`, `Drawer.Header` (`Drawer.Title`, `settlement.gatewayTitle`) and `Drawer.Body`, containing the existing `GatewaySwitch` component moved verbatim from RailCard lines 131-264.
- It takes an `onDone` prop, called from `done()`, so the drawer closes after a successful switch.

**ExchangeRateCard (`data-testid="fx-card-<CUR>"`):**

- **Header:** `Heading` "Exchange rate", the status `Badge` (existing lines 145-155), and a `Button size="small" variant="secondary"` "Edit rates" that opens `FxEditDrawer`.
- **Four tiles:** the existing `Stat` values (lines 158-203), with the hint text shortened:
  - market: source · time;
  - top-up: "per S$1 · −{{pct}}% fee";
  - payout: "per S$1 · +{{pct}}% fee";
  - earned: unchanged.
- **Example line:** when `fx.quote` exists, `t('settlement.fxExample', { currency, credit: floorCents(100*q.depositRate).toFixed(2), paid: floorCents(100/q.payoutRate).toFixed(2) })`.
- The `quote_error` line stays.

**FxEditDrawer:**

- `Drawer` titled `settlement.fxEditTitle`, holding the existing form state and logic (lines 50-132) and fields (lines 210-306) moved verbatim, laid out vertically.
- The preview `Text` keeps `data-testid="fx-preview-<CUR>"`.
- The footer has Cancel and Save, where Save = the existing `submit`. Close on a successful save.

**ReportCard (`data-testid="report-card-<CUR>"`):**

- **Header:** title `settlement.reportTitleMonth` / `reportTitleWeek` ("Results by month" / "Results by week"), subtitle `settlement.reportSubtitleShort` ("Settled payments, Malaysia time." / regional "Settled payments, in RM at the locked rate."), and the Monthly/Weekly toggle as before.
- **Table columns:**

| Column         | Content                                 |
| -------------- | --------------------------------------- |
| Period         |                                         |
| Money in       | gross; line 2 `settlement.topupsCount`  |
| Fees           | `≥` prefix + tooltip when feeFloor      |
| Money out      | gross; line 2 `settlement.payoutsCount` |
| Net cash       | green when > 0                          |
| Ledger check ⓘ |                                         |

- **Ledger check:** `✓ matches` (green text) when gap = 0, else `Badge color="orange"` `settlement.gap` with the signed amount. The ⓘ tooltip is `depositDeltaHint` + " " + `withdrawalDeltaHint`.
- The floor footnote badges stay.

**AuditFindings:**

- Renders nothing unless `findings_total > 0`.
- Otherwise: a `Container p-0` whose first row is an orange-tinted bar (`bg-ui-tag-orange-bg`) holding `settlement.findingsBar` (count) · `settlement.auditLastRun` (when), with a Hide/Show `Button variant="transparent"`. The list is shown by default.
- **Table:**
  - Payment: kind (`f.kind` mapped to Top-up or Payout through `settlement.kind.deposit` / `.withdrawal`, with the reference mono-truncated to 8…6 characters and the full value in `title`);
  - Player (`customer_id` mono);
  - Our status (`StatusBadge` via `paymentStatus` from `lib/dashboard`);
  - Amount;
  - Gateway says (`text-ui-fg-error`).

**Page:**

- Header `Container`: Heading "Settlement", subtitle `settlement.subtitle` = "Gateway money, one tab per currency.", and the existing `Tabs` (unchanged; already pill-like).
- Then `GatewayStrip`, then `ExchangeRateCard` (regional only), then `ReportCard`, then `AuditFindings`.

i18n settlement additions and changes (exact English):

```json
"subtitle": "Gateway money, one tab per currency.",
"switchGateway": "Switch gateway…",
"gatewayLabel": "Gateway",
"gatewayCheck": "Gateway check",
"checkAllMatch": "✓ All match",
"checkDiffers_one": "⚠ {{count}} payment differs",
"checkDiffers_other": "⚠ {{count}} payments differ",
"checkNever": "Not checked yet",
"checkedAt": "checked {{when}}",
"checkHint": "Every settled payment from the last 7 days is re-read at the gateway every hour.",
"fxTitleShort": "Exchange rate",
"fxEdit": "Edit rates",
"fxEditTitle": "Edit {{currency}} exchange rate",
"fxDepositRateShort": "Top-up rate",
"fxPayoutRateShort": "Payout rate",
"fxPerUnitFee": "per {{unit}} · {{sign}}{{pct}}% fee",
"fxExample": "{{currency}} 100 top-up gives RM {{credit}} credit · RM 100 withdrawal sends {{currency}} {{paid}}",
"reportTitleMonth": "Results by month",
"reportTitleWeek": "Results by week",
"reportSubtitleShort": "Settled payments, Malaysia time.",
"reportSubtitleShortRegional": "Settled payments, in RM at the locked rate.",
"moneyIn": "Money in", "fees": "Fees", "moneyOut": "Money out", "netCash": "Net cash",
"ledgerCheck": "Ledger check",
"matches": "matches",
"gap": "{{amount}} gap",
"topupsCount_one": "{{count}} top-up", "topupsCount_other": "{{count}} top-ups",
"payoutsCount_one": "{{count}} payout", "payoutsCount_other": "{{count}} payouts",
"findingsBar_one": "{{count}} payment the gateway disagrees with",
"findingsBar_other": "{{count}} payments the gateway disagrees with",
"hideList": "Hide list", "showList": "Show list",
"payment": "Payment",
"kind": { "deposit": "Top-up", "withdrawal": "Payout" }
```

Then delete keys that are no longer used (`railSubtitleLedger`, `railSubtitleRegional`, `auditSubtitle`, `auditOurDeposits`, `auditOurWithdrawals`, `reportSubtitle`, `reportSubtitleRegional`, `depositsGroup`, `withdrawalsGroup`, `fxSubtitle`) from en.json and zhCN.json, after grepping that nothing reads them.

- [ ] Steps: `settlement-rows.test.ts` (FAIL) → helper (PASS) → components → update `qa-a3pay-ui.mjs` → tsc, eslint and vitest → commit `feat(admin): Settlement redesign (strip, drawers, one results table)`.

### Task 9: Transactions redesign

**Files:**

- Modify `routes/ledger/page.tsx`
- Create `routes/ledger/day-groups.ts` and `day-groups.test.ts`
- Modify `en.json` (ledger additions)

**Pure helper:**

```ts
const MYT_MS = 8 * 3_600_000;
/** MYT calendar day of an instant, 'YYYY-MM-DD'. */
export const mytDay = (iso: string) =>
  new Date(Date.parse(iso) + MYT_MS).toISOString().slice(0, 10);
/** Consecutive rows grouped under their MYT day, order preserved. */
export function groupByDay<T extends { occurred_at: string }>(
  rows: T[],
): { day: string; rows: T[] }[] {
  const out: { day: string; rows: T[] }[] = [];
  for (const r of rows) {
    const day = mytDay(r.occurred_at);
    const last = out[out.length - 1];
    if (last && last.day === day) last.rows.push(r);
    else out.push({ day, rows: [r] });
  }
  return out;
}
```

Test:

- `2026-10-13T15:59:00Z` is MYT day 2026-10-13, and `2026-10-13T16:00:00Z` is 2026-10-14;
- three rows (14th, 14th, 13th) give two groups of 2 and 1;
- the order is kept even when non-monotonic (a sort by type), so the same day can appear twice and is never merged.

**Page:**

- **Filter row in the header:**
  - `Select` for type, with value `type ?? 'all'` and items `TYPES` labelled by `typeLabelKey`; `'all'` maps to undefined;
  - a `DropdownMenu` (Medusa) whose trigger is a `Button variant="secondary" size="small"` showing `t('ledger.anyDate')` or `"{{from}} – {{to}}"`. Its content holds the two existing date `Input`s (`aria-label` kept) and a "Clear" button;
  - then the search `Input`.
- **Table:**
  - header cells are Type (sortable), Player, Time (sortable `occurred_at`), Wallet (right) and Vault (right). `COLUMN_COUNT` becomes 5;
  - each group renders a day row (`Table.Row` with one `Table.Cell colSpan={5}`, class `bg-ui-bg-subtle text-ui-fg-muted txt-compact-xsmall-plus`, formatted `13 Oct 2026` via `toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })` on the day string), then its rows;
  - a row is clickable (`onClick={() => toggle(row.id)}`, `className="cursor-pointer"`, `aria-expanded`), and the expanded payload row behaves as before;
  - **cells:**
    - Type: `Badge` coloured by type (TP green, SP blue, SE purple, OD grey, AD orange, WP purple, WD orange, RF green), with `display_id` on a second line in `font-mono txt-compact-xsmall text-ui-fg-muted`;
    - Player: name or email, with the email on a second line when there's a name;
    - Time: `h:mm a`, in MYT;
    - Wallet and Vault: signed `+RM`/`−RM`, green when > 0, "—" when null or 0.
- `affectSummary` is deleted, and the `ledger.colAffect` and `colDetails` keys go.

i18n: `"subtitle": "Every wallet and vault movement."`, `"anyDate": "Any date"`, `"dateRange": "{{from}} – {{to}}"`, `"clearDates": "Clear"`, `"colTime": "Time"`, `"colWallet": "Wallet"`, `"colVault": "Vault"`, `"typeSelect": "Type"`.

- [ ] Steps: `day-groups.test.ts` (FAIL) → helper (PASS) → page → tsc, eslint and vitest → commit `feat(admin): Transactions redesign (type menu, day groups, amount columns)`.

### Task 10: Players redesign

**Files:** Modify `routes/players/page.tsx` and `en.json` (players additions).

**Header:** title and subtitle ("Every registered player."). On the right:

- a group `Select` with All groups, Default, and every non-default group from `useCustomerGroupsAdmin()` (value = id). Picking one sets `group` state and resets to page 0, and is passed to `usePlayers(page, q, sort, group)`;
- search;
- the `Button size="small"` `players.generate` ("Generate accounts"), which opens `CreatePlayerModal`;
- a `DropdownMenu` trigger `IconButton size="small"` (`EllipsisHorizontal` icon, `aria-label` `players.more`) with one item, `players.exportShort` ("Export logins"), calling `exporter.mutate(undefined)`.

**Table columns:**

1. **Player**, sortable by name: an initials avatar (2 letters from name or email), the name (`text-ui-fg-interactive`, keyboard button as before), and the email on line 2.
2. **Phone:** the phone number plus a green ✓ (`CheckCircleSolid` icon, `title` `players.verifiedYes`) when verified; "—" when there's no phone.
3. **Group:** `Badge size="2xsmall"`, grey for the default name, blue otherwise.
4. **Level:** `LV n`.
5. **Wallet**, sortable.
6. **Vault:** value, with the count muted.
7. **Net deposit**, sortable by contribution: a `Tooltip` with `players.netDepositHint` (topup and withdrawn), red when negative.
8. **Turnover**, sortable by spend.
9. **Joined**, sortable by created_at: the date (`toLocaleDateString` short, MYT), with line 2 = Disabled `StatusBadge` when disabled.
10. **Status:** the `Switch` exactly as today, plus the partner `StatusBadge` as today, but without the Active/Disabled text badge.

Remove the `realName`, `pulls`, `lastSpend`, `topup` and `withdrawn` columns from the list, keeping their i18n keys if any other page uses them (grep).

i18n: `"subtitle": "Every registered player."`, `"player": "Player"`, `"level": "Level"`, `"netDeposit": "Net deposit"`, `"netDepositHint": "Top-ups {{topup}} − withdrawals {{withdrawn}}"`, `"joined": "Joined"`, `"allGroups": "All groups"`, `"groupFilter": "Group"`, `"more": "More actions"`, `"exportShort": "Export logins"`, `"generate": "Generate accounts"`.

- [ ] Steps: implement → tsc, eslint and vitest → commit `feat(admin): Players redesign (9+status columns, group filter, more menu)`.

### Task 11: QA script, verification and review

**Files:** Modify `scripts/qa-admin-vault-p1.mjs` (append a phase 3 section).

- **Profit report:**
  - `/economy` shows "Profit report", "Cash kept", "Still owed to players", "Where the money moved" and "Pack payout rate";
  - the "Real customers" pill is visible;
  - toggling "All groups" adds `scope=all` to the URL and keeps the headings;
  - `range=All time` hides "vs last period".
- **Dashboard:** with `?scope=all`, the switch is checked.
- **Settlement:**
  - the RM tab shows "Gateway check"; "Switch gateway…" opens a dialog with the title "Payment gateway"; Escape closes it;
  - the S$ tab shows `fx-card-SGD` and "Edit rates", which opens a dialog containing `fx-preview-SGD`.
- **Transactions:** picking Type = Referral gives no "Couldn't load" error; the date dropdown opens with two date inputs.
- **Players:** the Group select lists "Default"; the More actions menu shows "Export logins".
- **Screenshots and errors:** light and dark screenshots of all four pages; no page errors other than the documented local-backend skew list (expected empty now).

Run the full gates. Then:

- run the QA script against the branch admin (:7001) with the backend restarted on this branch's code;
- run the `/code-review` skill on the branch diff and fix every Critical or Important finding with a test;
- run the gates again, push, and open a PR stacked on `feat/admin-dashboard-p2`.

- [ ] Commit `test(admin): QA for phase 3 pages`.
