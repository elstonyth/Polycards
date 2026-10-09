# Admin Stats Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Superseded in part (2026-10-09):** the endpoint and page now also carry `withdrawal_count` and `withdrawal_amount`, from a separate `withdrawalStats` method. The design spec (`docs/superpowers/specs/2026-09-29-admin-stats-design.md`) is the current contract; this plan records the original build.

**Goal:** Add a "Stats" page to the admin dashboard. It shows sign-ups and top-ups for a preset or custom MYT window, with each figure compared against the previous window.

**Architecture:**

- A pure module, `modules/packs/stats.ts`, turns a range name into current and previous `[from, to)` windows.
- One packs-service SQL method counts the six figures for a single window.
- `GET /admin/stats` runs that method for both windows.
- The admin page follows the Economy page's stat-grid pattern and reads its labels through i18n. The zhCN locale is added for Chinese-speaking admins.

**Tech Stack:**

- Backend: Medusa v2.19 file-based routes, raw SQL through the packs module manager, Jest unit specs, and the `medusaIntegrationTestRunner` HTTP specs.
- Admin: the Mercur admin SPA, with React, `@medusajs/ui`, React Query, react-i18next and Vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-admin-stats-design.md`

## Global Constraints

- **Timezone.** MYT is fixed UTC+8, with no DST. Windows are half-open `[from, to)`, and the current window's `to` is never later than `now`.
- **Metrics.** There are exactly six figures: `signups`, `topup_count`, `topup_amount`, `topup_customers`, `first_topup_count`, `first_topup_amount`.
- **Sign-ups** are `customer.has_account = true` rows. Deleted rows are **included**.
- **Top-ups** are `credit_transaction` rows with `reason = 'topup'`, `amount > 0` and `deleted_at IS NULL`.
- **First top-up** means `row_number()` over the customer's whole history, ordered by `(created_at, id)`, computed before the window filter.
- **Money** is summed as integer cents in SQL and returned in MYR.
- **Ranges** are `today | yesterday | 7d | 30d | month | last_month | custom`. The default is `today`. `custom` takes `from` and `to` as `YYYY-MM-DD` (inclusive MYT days).
- **Bad input** (an unknown range, or a bad custom range) returns 400 `INVALID_DATA`.
- **Commands.** Backend commands run from `backend/packages/api` with `corepack yarn`. Admin commands run from `backend/apps/admin` with `corepack yarn`. Never use npm or pnpm there.
- **Commits.** Use conventional commits. Every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File                                                                             | Responsibility                                                                     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `backend/packages/api/src/modules/packs/stats.ts` (create)                       | `statsWindows()`, `STATS_RANGES`, and the `StatsWindow` / `SignupTopupStats` types |
| `backend/packages/api/src/modules/packs/__tests__/stats.unit.spec.ts` (create)   | Unit spec for `statsWindows`                                                       |
| `backend/packages/api/src/modules/packs/service.ts` (modify)                     | New method `signupTopupStats(from, to)`, placed after `ledgerReasonTotals`         |
| `backend/packages/api/src/api/admin/stats/route.ts` (create)                     | `GET /admin/stats`                                                                 |
| `backend/packages/api/integration-tests/http/admin-stats.spec.ts` (create)       | HTTP spec covering the SQL and the route contract                                  |
| `backend/apps/admin/src/lib/admin-rest.ts` (modify)                              | Types and `getStatsReport()`                                                       |
| `backend/apps/admin/src/lib/query-keys.ts` (+ `query-keys.test.ts`) (modify)     | `qk.stats`                                                                         |
| `backend/apps/admin/src/lib/queries.ts` (modify)                                 | `useStats()`                                                                       |
| `backend/apps/admin/src/i18n/en.json`, `zhCN.json` (create), `index.ts` (modify) | `statsBoard.*` strings                                                             |
| `backend/apps/admin/src/routes/stats/page.tsx` (create)                          | The page                                                                           |

---

### Task 1: `statsWindows` (pure window math)

**Files:**

- Create: `backend/packages/api/src/modules/packs/stats.ts`
- Test: `backend/packages/api/src/modules/packs/__tests__/stats.unit.spec.ts`

**Interfaces:**

- Produces:
  - `statsWindows(range: string, now: Date, customFrom?: string, customTo?: string): StatsWindows | null`
  - `type StatsWindow = { from: Date; to: Date }`
  - `type StatsWindows = { current: StatsWindow; previous: StatsWindow }`
  - `type SignupTopupStats = { signups: number; topup_count: number; topup_customers: number; topup_amount: number; first_topup_count: number; first_topup_amount: number }`

- [ ] **Step 1: Write the failing spec**

```ts
import { statsWindows } from '../stats';

// 2026-09-29 16:07 MYT.
const NOW = new Date('2026-09-29T08:07:00.000Z');

const iso = (w: ReturnType<typeof statsWindows>) =>
  w && {
    current: [w.current.from.toISOString(), w.current.to.toISOString()],
    previous: [w.previous.from.toISOString(), w.previous.to.toISOString()],
  };

describe('statsWindows — presets (MYT, previous = same span one period back)', () => {
  it('today runs from MYT midnight to now, against yesterday up to the same time', () => {
    expect(iso(statsWindows('today', NOW))).toEqual({
      current: ['2026-09-28T16:00:00.000Z', '2026-09-29T08:07:00.000Z'],
      previous: ['2026-09-27T16:00:00.000Z', '2026-09-28T08:07:00.000Z'],
    });
  });

  it('yesterday is the whole previous MYT day, against the day before', () => {
    expect(iso(statsWindows('yesterday', NOW))).toEqual({
      current: ['2026-09-27T16:00:00.000Z', '2026-09-28T16:00:00.000Z'],
      previous: ['2026-09-26T16:00:00.000Z', '2026-09-27T16:00:00.000Z'],
    });
  });

  it('7d and 30d include today and shift back by their own length', () => {
    expect(iso(statsWindows('7d', NOW))).toEqual({
      current: ['2026-09-22T16:00:00.000Z', '2026-09-29T08:07:00.000Z'],
      previous: ['2026-09-15T16:00:00.000Z', '2026-09-22T08:07:00.000Z'],
    });
    expect(iso(statsWindows('30d', NOW))).toEqual({
      current: ['2026-08-30T16:00:00.000Z', '2026-09-29T08:07:00.000Z'],
      previous: ['2026-07-31T16:00:00.000Z', '2026-08-30T08:07:00.000Z'],
    });
  });

  it('month to date compares with the same days of last month', () => {
    expect(iso(statsWindows('month', NOW))).toEqual({
      current: ['2026-08-31T16:00:00.000Z', '2026-09-29T08:07:00.000Z'],
      previous: ['2026-07-31T16:00:00.000Z', '2026-08-29T08:07:00.000Z'],
    });
  });

  it('month on the 31st clamps the previous window to the end of a shorter month', () => {
    // 2026-03-31 10:00 MYT: "February 31st" does not exist, so all of February.
    expect(
      iso(statsWindows('month', new Date('2026-03-31T02:00:00.000Z'))),
    ).toEqual({
      current: ['2026-02-28T16:00:00.000Z', '2026-03-31T02:00:00.000Z'],
      previous: ['2026-01-31T16:00:00.000Z', '2026-02-28T16:00:00.000Z'],
    });
  });

  it('last_month is the whole previous calendar month, across a year boundary', () => {
    expect(
      iso(statsWindows('last_month', new Date('2026-01-15T04:00:00.000Z'))),
    ).toEqual({
      current: ['2025-11-30T16:00:00.000Z', '2025-12-31T16:00:00.000Z'],
      previous: ['2025-10-31T16:00:00.000Z', '2025-11-30T16:00:00.000Z'],
    });
  });

  it('uses the MYT calendar day, not the UTC one', () => {
    // 2026-09-30 17:30 UTC is already 1 October 01:30 in MYT.
    const lateUtc = new Date('2026-09-30T17:30:00.000Z');
    expect(statsWindows('today', lateUtc)?.current.from.toISOString()).toBe(
      '2026-09-30T16:00:00.000Z',
    );
    expect(statsWindows('month', lateUtc)?.current.from.toISOString()).toBe(
      '2026-09-30T16:00:00.000Z',
    );
  });
});

describe('statsWindows — custom (inclusive MYT days)', () => {
  it('covers whole days and shifts back by the day count', () => {
    expect(
      iso(statsWindows('custom', NOW, '2026-09-10', '2026-09-11')),
    ).toEqual({
      current: ['2026-09-09T16:00:00.000Z', '2026-09-11T16:00:00.000Z'],
      previous: ['2026-09-07T16:00:00.000Z', '2026-09-09T16:00:00.000Z'],
    });
  });

  it('a single day is a one-day window', () => {
    expect(
      iso(statsWindows('custom', NOW, '2026-09-10', '2026-09-10')),
    ).toEqual({
      current: ['2026-09-09T16:00:00.000Z', '2026-09-10T16:00:00.000Z'],
      previous: ['2026-09-08T16:00:00.000Z', '2026-09-09T16:00:00.000Z'],
    });
  });

  it('a range ending today stops at now', () => {
    expect(
      iso(statsWindows('custom', NOW, '2026-09-28', '2026-09-29')),
    ).toEqual({
      current: ['2026-09-27T16:00:00.000Z', '2026-09-29T08:07:00.000Z'],
      previous: ['2026-09-25T16:00:00.000Z', '2026-09-27T08:07:00.000Z'],
    });
  });

  it.each([
    ['an unknown range', 'forever', undefined, undefined],
    ['a missing date', 'custom', '2026-09-10', undefined],
    ['a reversed range', 'custom', '2026-09-11', '2026-09-10'],
    ['a malformed date', 'custom', '2026-9-1', '2026-09-10'],
    ['a date Date.parse would roll over', 'custom', '2026-02-30', '2026-03-02'],
    ['a start in the future', 'custom', '2026-09-30', '2026-10-01'],
  ])('rejects %s with null', (_label, range, from, to) => {
    expect(statsWindows(range, NOW, from, to)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the spec and confirm it fails**

Run (from `backend/packages/api`): `corepack yarn test:unit src/modules/packs/__tests__/stats.unit.spec.ts`
Expected: FAIL with `Cannot find module '../stats'`.

- [ ] **Step 3: Implement**

`backend/packages/api/src/modules/packs/stats.ts`:

```ts
// GET /admin/stats — the window math and the result shape. Pure (no Medusa
// imports) so every preset is unit-testable.
//
// MYT is a fixed UTC+8: Malaysia has never observed DST, the same convention
// as ledger.ts. Windows are half-open [from, to), and the current window
// never runs past `now`. The previous window is the same span one period
// back: N days for the day presets and custom ranges, one calendar month for
// the month presets. A partial "today" is therefore compared with yesterday
// up to the same time of day, not with the whole of yesterday.

export const STATS_RANGES = [
  'today',
  'yesterday',
  '7d',
  '30d',
  'month',
  'last_month',
  'custom',
] as const;

export type StatsWindow = { from: Date; to: Date };
export type StatsWindows = { current: StatsWindow; previous: StatsWindow };

export type SignupTopupStats = {
  /** Accounts created (customer.has_account), deleted ones included. */
  signups: number;
  topup_count: number;
  /** Distinct customers with at least one top-up in the window. */
  topup_customers: number;
  /** MYR. */
  topup_amount: number;
  /** Customers whose first-ever top-up falls in the window. */
  first_topup_count: number;
  /** MYR, the sum of those first top-ups. */
  first_topup_amount: number;
};

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Instant of MYT midnight on (y, m, d). Date.UTC normalizes an out-of-range
// month or day, so m - 1 in January is December of the year before.
const mytMidnight = (y: number, m: number, d: number): number =>
  Date.UTC(y, m, d) - MYT_OFFSET_MS;

// The same MYT wall-clock time `months` calendar months away. A missing day
// rolls forward (31 March minus one month lands on 3 March), and callers
// clamp that.
const shiftMonths = (t: number, months: number): number => {
  const w = new Date(t + MYT_OFFSET_MS);
  return (
    Date.UTC(
      w.getUTCFullYear(),
      w.getUTCMonth() + months,
      w.getUTCDate(),
      w.getUTCHours(),
      w.getUTCMinutes(),
      w.getUTCSeconds(),
      w.getUTCMilliseconds(),
    ) - MYT_OFFSET_MS
  );
};

// 'YYYY-MM-DD' as the instant of that MYT midnight. NaN unless it is a real
// calendar date, because Date.parse happily rolls 2026-02-30 into March.
const mytDay = (s: string | undefined): number => {
  if (!s || !DATE_ONLY_RE.test(s)) return NaN;
  const utc = Date.parse(s);
  return !Number.isNaN(utc) && new Date(utc).toISOString().startsWith(s)
    ? utc - MYT_OFFSET_MS
    : NaN;
};

const win = (from: number, to: number): StatsWindow => ({
  from: new Date(from),
  to: new Date(to),
});

const byDays = (from: number, to: number, days: number): StatsWindows => ({
  current: win(from, to),
  previous: win(from - days * DAY_MS, to - days * DAY_MS),
});

/** Null for an unknown range or a bad custom range (the route's 400). */
export function statsWindows(
  range: string,
  now: Date,
  customFrom?: string,
  customTo?: string,
): StatsWindows | null {
  const t = now.getTime();
  const w = new Date(t + MYT_OFFSET_MS); // MYT wall clock via the UTC getters
  const y = w.getUTCFullYear();
  const m = w.getUTCMonth();
  const today = mytMidnight(y, m, w.getUTCDate());
  const monthStart = mytMidnight(y, m, 1);

  switch (range) {
    case 'today':
      return byDays(today, t, 1);
    case 'yesterday':
      return byDays(today - DAY_MS, today, 1);
    case '7d':
      return byDays(today - 6 * DAY_MS, t, 7);
    case '30d':
      return byDays(today - 29 * DAY_MS, t, 30);
    case 'month':
      return {
        current: win(monthStart, t),
        previous: win(
          mytMidnight(y, m - 1, 1),
          Math.min(shiftMonths(t, -1), monthStart),
        ),
      };
    case 'last_month':
      return {
        current: win(mytMidnight(y, m - 1, 1), monthStart),
        previous: win(mytMidnight(y, m - 2, 1), mytMidnight(y, m - 1, 1)),
      };
    case 'custom': {
      const from = mytDay(customFrom);
      const end = mytDay(customTo) + DAY_MS;
      // NaN fails both comparisons, so a malformed date lands here too.
      if (!(from < end && from < t)) return null;
      return byDays(from, Math.min(end, t), (end - from) / DAY_MS);
    }
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run the spec and confirm it passes**

Run: `corepack yarn test:unit src/modules/packs/__tests__/stats.unit.spec.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/modules/packs/stats.ts backend/packages/api/src/modules/packs/__tests__/stats.unit.spec.ts
git commit -m "feat(stats): MYT preset windows with a previous-period twin"
```

---

### Task 2: `signupTopupStats` SQL and `GET /admin/stats`

**Files:**

- Modify: `backend/packages/api/src/modules/packs/service.ts`. Add the method directly after `ledgerReasonTotals`, which ends near line 6345, and add the type import at the top.
- Create: `backend/packages/api/src/api/admin/stats/route.ts`
- Test: `backend/packages/api/integration-tests/http/admin-stats.spec.ts`

**Interfaces:**

- Consumes: `statsWindows`, `SignupTopupStats` (Task 1).
- Produces: `PacksModuleService.signupTopupStats(from: Date, to: Date): Promise<SignupTopupStats>` and `GET /admin/stats`.
  - Query: `range` (default `today`); `from` and `to` for `custom` only.
  - Response: `{ as_of: string, current: { from: string, to: string, stats: SignupTopupStats }, previous: { same } }`.

- [ ] **Step 1: Write the failing HTTP spec**

`backend/packages/api/integration-tests/http/admin-stats.spec.ts`:

```ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// GET /admin/stats: sign-ups and top-ups for a window and the window before
// it. Rows are seeded, then aged with a raw UPDATE, because created_at is
// ORM-managed on insert. The custom range pins both windows to fixed past
// days, so the expectations do not depend on when the suite runs.
//
// Custom 2026-09-10..2026-09-11 (MYT) gives:
//   current  [2026-09-09T16:00Z, 2026-09-11T16:00Z)
//   previous [2026-09-07T16:00Z, 2026-09-09T16:00Z)

const FROM_EDGE = '2026-09-09T16:00:00.000Z'; // current start (in) = previous end (out)
const TO_EDGE = '2026-09-11T16:00:00.000Z'; // current end (out)
const IN_CURRENT = '2026-09-10T02:00:00.000Z';
const IN_PREVIOUS = '2026-09-08T03:00:00.000Z';
const BEFORE_BOTH = '2026-09-01T00:00:00.000Z';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin stats', () => {
      let adminToken: string;

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'stats-admin@test.dev',
          'stats-test-password-1',
        );
      });

      const stats = (query: string, headers?: Record<string, string>) =>
        unwrapResponse(
          api.get(`/admin/stats${query}`, {
            headers: headers ?? { authorization: `Bearer ${adminToken}` },
          }),
        );

      const setCreatedAt = async (
        table: 'customer' | 'credit_transaction',
        id: string,
        at: string,
      ): Promise<void> => {
        const knex = getContainer().resolve(
          ContainerRegistrationKeys.PG_CONNECTION,
        ) as unknown as {
          raw: (
            sql: string,
            bindings: unknown[],
          ) => Promise<{ rowCount: number }>;
        };
        const res = await knex.raw(
          `UPDATE ${table} SET created_at = ? WHERE id = ?`,
          [at, id],
        );
        // A silent zero-row UPDATE would leave the row at "now", outside every
        // window, and the counts would pass for the wrong reason.
        expect(res.rowCount).toBe(1);
      };

      it('rejects an unauthenticated read with 401', async () => {
        expect((await stats('', {})).status).toBe(401);
      });

      it('answers 400 for a bad range and 200 for the default', async () => {
        expect((await stats('?range=forever')).status).toBe(400);
        expect(
          (await stats('?range=custom&from=2026-09-11&to=2026-09-10')).status,
        ).toBe(400);
        const today = await stats('');
        expect(today.status).toBe(200);
        expect(Date.parse(today.data.current.to)).toBeLessThanOrEqual(
          Date.parse(today.data.as_of),
        );
      });

      it('counts sign-ups and top-ups per window, first top-ups over the whole history', async () => {
        const container = getContainer();
        const customers = container.resolve(Modules.CUSTOMER);
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

        // Sign-ups. Current: A (inside) and B (on the inclusive start).
        // Previous: P. C sits on the exclusive end, so it is in neither
        // window. G is a guest and never counts.
        const seedCustomer = async (
          email: string,
          hasAccount: boolean,
          at: string,
        ) => {
          const c = await customers.createCustomers({
            email,
            has_account: hasAccount,
          });
          await setCreatedAt('customer', c.id, at);
        };
        await seedCustomer('stats-a@test.dev', true, IN_CURRENT);
        await seedCustomer('stats-b@test.dev', true, FROM_EDGE);
        await seedCustomer('stats-c@test.dev', true, TO_EDGE);
        await seedCustomer('stats-g@test.dev', false, IN_CURRENT);
        await seedCustomer('stats-p@test.dev', true, IN_PREVIOUS);

        // Ledger. X first topped up in the previous window, so X's current
        // top-up is not a first. Y's first is 100 and Y's 20 is a repeat.
        // W's first sits on the inclusive start. V's first is before both
        // windows. Z sits on the exclusive end. X's pack_open is not a top-up.
        const rows: [string, number, 'topup' | 'pack_open', string][] = [
          ['cus_x', 50, 'topup', IN_PREVIOUS],
          ['cus_x', 30, 'topup', IN_CURRENT],
          ['cus_x', -25, 'pack_open', IN_CURRENT],
          ['cus_y', 100, 'topup', IN_CURRENT],
          ['cus_y', 20, 'topup', '2026-09-11T10:00:00.000Z'],
          ['cus_w', 40, 'topup', FROM_EDGE],
          ['cus_v', 10, 'topup', BEFORE_BOTH],
          ['cus_v', 5, 'topup', IN_CURRENT],
          ['cus_z', 70, 'topup', TO_EDGE],
        ];
        const created = await packs.createCreditTransactions(
          rows.map(([customer_id, amount, reason]) => ({
            customer_id,
            amount,
            reason,
            pull_id: null,
            reference: null,
          })),
        );
        for (const [i, row] of created.entries()) {
          await setCreatedAt('credit_transaction', row.id, rows[i][3]);
        }

        const res = await stats('?range=custom&from=2026-09-10&to=2026-09-11');
        expect(res.status).toBe(200);
        expect(res.data.current).toEqual({
          from: FROM_EDGE,
          to: TO_EDGE,
          stats: {
            signups: 2,
            topup_count: 5, // X30, Y100, Y20, W40, V5
            topup_customers: 4, // X, Y, W, V
            topup_amount: 195,
            first_topup_count: 2, // Y100, W40
            first_topup_amount: 140,
          },
        });
        expect(res.data.previous).toEqual({
          from: '2026-09-07T16:00:00.000Z',
          to: FROM_EDGE,
          stats: {
            signups: 1,
            topup_count: 1,
            topup_customers: 1,
            topup_amount: 50,
            first_topup_count: 1,
            first_topup_amount: 50,
          },
        });
      });
    });
  },
});
```

- [ ] **Step 2: Run the spec and confirm it fails**

Local Postgres (`pokenic-postgres`) must be running.
Run (from `backend/packages/api`): `node integration-tests/run-http-shards.mjs admin-stats.spec`
Expected: 401 passes. The other two fail with 404, because the route does not exist yet.

- [ ] **Step 3: Implement the service method**

In `service.ts`, add `SignupTopupStats` to the imports:

```ts
import type { SignupTopupStats } from './stats';
```

Add the method directly after `ledgerReasonTotals`:

```ts
  // Sign-up and top-up figures for GET /admin/stats over one half-open
  // [from, to) window, in one statement.
  //
  // Sign-ups count has_account customers, deleted rows included, so a past
  // period never shrinks. Top-ups are the ledger's topup rows; in production
  // those are the settled TGPay deposits (the mock path cannot boot there).
  // A first top-up is ranked over the customer's WHOLE history before the
  // window filter, so a returning customer's top-up in the window is not a
  // first. Money is summed as integer cents, like ledgerReasonTotals.
  @InjectManager()
  async signupTopupStats(
    from: Date,
    to: Date,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<SignupTopupStats> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const bounds = [from.toISOString(), to.toISOString()];
    const [row] = await em.execute<
      {
        signups: number;
        topup_count: number;
        topup_customers: number;
        topup_cents: string;
        first_topup_count: number;
        first_topup_cents: string;
      }[]
    >(
      `WITH topups AS (
         SELECT customer_id, amount, created_at,
                row_number() OVER (
                  PARTITION BY customer_id ORDER BY created_at, id
                ) AS nth
         FROM credit_transaction
         WHERE reason = 'topup' AND amount > 0 AND deleted_at IS NULL
       )
       SELECT
         (SELECT count(*) FROM customer
            WHERE has_account
              AND created_at >= ?::timestamptz
              AND created_at < ?::timestamptz)::int AS signups,
         count(*)::int AS topup_count,
         count(DISTINCT customer_id)::int AS topup_customers,
         COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS topup_cents,
         (count(*) FILTER (WHERE nth = 1))::int AS first_topup_count,
         COALESCE(SUM(ROUND(amount * 100)) FILTER (WHERE nth = 1), 0)::bigint
           AS first_topup_cents
       FROM topups
       WHERE created_at >= ?::timestamptz AND created_at < ?::timestamptz`,
      [...bounds, ...bounds],
    );
    return {
      signups: row.signups,
      topup_count: row.topup_count,
      topup_customers: row.topup_customers,
      topup_amount: Number(row.topup_cents) / 100,
      first_topup_count: row.first_topup_count,
      first_topup_amount: Number(row.first_topup_cents) / 100,
    };
  }
```

- [ ] **Step 4: Implement the route**

`backend/packages/api/src/api/admin/stats/route.ts`:

```ts
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { STATS_RANGES, statsWindows } from '../../../modules/packs/stats';

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

// GET /admin/stats: sign-ups and top-ups for one MYT window, next to the same
// figures for the window before it (the Stats page's "vs previous"). Reads
// only. The window math is pure and unit-tested in modules/packs/stats.ts.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const now = new Date();
  const windows = statsWindows(
    str(req.query.range) ?? 'today',
    now,
    str(req.query.from),
    str(req.query.to),
  );
  if (!windows) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `range must be one of ${STATS_RANGES.join(', ')}; custom needs from <= to as YYYY-MM-DD, starting no later than today.`,
    );
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [current, previous] = await Promise.all([
    packs.signupTopupStats(windows.current.from, windows.current.to),
    packs.signupTopupStats(windows.previous.from, windows.previous.to),
  ]);
  // Dates serialize to ISO strings.
  res.json({
    as_of: now,
    current: { ...windows.current, stats: current },
    previous: { ...windows.previous, stats: previous },
  });
}
```

- [ ] **Step 5: Run the spec and the unit tier, and confirm both pass**

Run: `node integration-tests/run-http-shards.mjs admin-stats.spec`
Expected: PASS (3 tests).

Run: `corepack yarn test:unit`
Expected: PASS. The admin rate-limit coverage guard stays green because the route is GET-only.

- [ ] **Step 6: Commit**

```bash
git add backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/api/admin/stats/route.ts backend/packages/api/integration-tests/http/admin-stats.spec.ts
git commit -m "feat(stats): GET /admin/stats — sign-ups and top-ups vs the previous window"
```

---

### Task 3: Admin data layer and i18n (en + zhCN)

**Files:**

- Modify: `backend/apps/admin/src/lib/admin-rest.ts`. Add a new section after the Economy report block, which ends near line 387.
- Modify: `backend/apps/admin/src/lib/query-keys.ts` and `query-keys.test.ts`
- Modify: `backend/apps/admin/src/lib/queries.ts`
- Modify: `backend/apps/admin/src/i18n/en.json` and `index.ts`
- Create: `backend/apps/admin/src/i18n/zhCN.json`

**Interfaces:**

- Consumes: the `GET /admin/stats` contract (Task 2).
- Produces:
  - `type StatsRange`
  - `interface SignupTopupStats`
  - `interface StatsReport`
  - `getStatsReport(range, from, to)`
  - `qk.stats(range, from, to)`
  - `useStats(range, from, to): UseQueryResult<StatsReport>`
  - i18n keys `statsBoard.*`

- [ ] **Step 1: Write the failing query-key test**

In `query-keys.test.ts`, inside `it('exposes the static list keys', …)`, after the `qk.economy` line:

```ts
// Custom dates always render ('' outside custom): same always-rendered-
// segment rule as qk.pulls, so no preset key prefixes another.
expect(qk.stats('today', '', '')).toEqual(['admin', 'stats', 'today', '', '']);
expect(qk.stats('custom', '2026-09-01', '2026-09-10')).toEqual([
  'admin',
  'stats',
  'custom',
  '2026-09-01',
  '2026-09-10',
]);
```

Run (from `backend/apps/admin`): `corepack yarn test src/lib/query-keys.test.ts`
Expected: FAIL with `qk.stats is not a function`.

- [ ] **Step 2: Add the query key**

In `query-keys.ts`, after `economy: ['admin', 'economy'] as const,`:

```ts
  // (range, from, to) always render — custom dates are '' for the presets.
  stats: (range: string, from: string, to: string) =>
    ['admin', 'stats', range, from, to] as const,
```

Run: `corepack yarn test src/lib/query-keys.test.ts`
Expected: PASS.

- [ ] **Step 3: Add the REST call and types**

In `admin-rest.ts`, after `getEconomyReport`:

```ts
// ── Stats (sign-ups + top-ups) ──────────────────────────────────────────────

export type StatsRange =
  | 'today'
  | 'yesterday'
  | '7d'
  | '30d'
  | 'month'
  | 'last_month'
  | 'custom';

export interface SignupTopupStats {
  signups: number;
  topup_count: number;
  topup_customers: number;
  /** MYR. */
  topup_amount: number;
  first_topup_count: number;
  /** MYR. */
  first_topup_amount: number;
}

export interface StatsReport {
  as_of: string;
  /** ISO instants; windows are half-open [from, to). */
  current: { from: string; to: string; stats: SignupTopupStats };
  previous: { from: string; to: string; stats: SignupTopupStats };
}

// `from`/`to` are inclusive MYT days (YYYY-MM-DD), sent only for 'custom'.
export async function getStatsReport(
  range: StatsRange,
  from: string,
  to: string,
): Promise<StatsReport> {
  const qs = new URLSearchParams({ range });
  if (range === 'custom') {
    qs.set('from', from);
    qs.set('to', to);
  }
  return getJson<StatsReport>(`/admin/stats?${qs.toString()}`);
}
```

- [ ] **Step 4: Add the hook**

In `queries.ts`, add `getStatsReport` to the value import from `./admin-rest` and `type StatsRange, type StatsReport` to the type import. Then add after `useEconomy`:

```ts
// Stats page. keepPreviousData so switching presets swaps the numbers without
// a skeleton flash (the economy precedent). The page passes '' for the dates
// unless the range is 'custom'; a half-picked or reversed custom range never
// fires (it could only 400), the page shows a hint instead.
export const useStats = (
  range: StatsRange,
  from: string,
  to: string,
): UseQueryResult<StatsReport> =>
  useQuery({
    queryKey: qk.stats(range, from, to),
    queryFn: () => getStatsReport(range, from, to),
    placeholderData: keepPreviousData,
    enabled: range !== 'custom' || (from !== '' && to !== '' && from <= to),
    // The dashboard's QueryClient disables focus refetch; "today" is live,
    // so coming back to the tab should show fresh numbers.
    refetchOnWindowFocus: true,
  });
```

- [ ] **Step 5: Add the strings**

In `en.json`, add a top-level `statsBoard` block. Place it after `economy` and keep the file's 2-space JSON formatting:

```json
  "statsBoard": {
    "title": "Stats",
    "subtitle": "Sign-ups and top-ups · {{current}} MYT · vs {{previous}}",
    "ranges": {
      "today": "Today",
      "yesterday": "Yesterday",
      "7d": "Last 7 days",
      "30d": "Last 30 days",
      "month": "This month",
      "last_month": "Last month",
      "custom": "Custom"
    },
    "from": "From",
    "to": "To",
    "customHint": "Pick a start date on or before the end date.",
    "signups": "Sign-ups",
    "topup_customers": "Players who topped up",
    "topup_count": "Top-ups",
    "topup_amount": "Top-up amount",
    "first_topup_count": "First-time top-ups",
    "first_topup_amount": "First top-up amount",
    "vsPrevious": "vs previous",
    "previous": "Previous: {{value}}",
    "loadError": "Could not load the stats."
  },
```

Create `zhCN.json`:

```json
{
  "statsBoard": {
    "title": "数据看板",
    "subtitle": "注册与充值 · {{current}}（马来西亚时间）· 对比 {{previous}}",
    "ranges": {
      "today": "今天",
      "yesterday": "昨天",
      "7d": "近7天",
      "30d": "近30天",
      "month": "本月",
      "last_month": "上月",
      "custom": "自定义"
    },
    "from": "开始日期",
    "to": "结束日期",
    "customHint": "开始日期不能晚于结束日期。",
    "signups": "注册人数",
    "topup_customers": "充值人数",
    "topup_count": "充值笔数",
    "topup_amount": "充值金额",
    "first_topup_count": "首充人数",
    "first_topup_amount": "首充金额",
    "vsPrevious": "vs 上一段",
    "previous": "上一段 {{value}}",
    "loadError": "无法加载数据。"
  }
}
```

In `i18n/index.ts`:

```ts
import en from './en.json';
import zhCN from './zhCN.json';

// Keys MUST match the core dashboard's language codes: the dashboard deep-merges
// each entry into its own locale of the same key. zhCN only carries the Stats
// page; every other custom string falls back to en (the dashboard's fallbackLng).
const i18nResources = {
  en: {
    translation: en,
  },
  zhCN: {
    translation: zhCN,
  },
};

export default i18nResources;
```

- [ ] **Step 6: Run the admin tests**

Run: `corepack yarn test`
Expected: PASS, including `no-core-shadow.test.ts`, because `statsBoard` is not a core key.

- [ ] **Step 7: Commit**

```bash
git add backend/apps/admin/src/lib/admin-rest.ts backend/apps/admin/src/lib/query-keys.ts backend/apps/admin/src/lib/query-keys.test.ts backend/apps/admin/src/lib/queries.ts backend/apps/admin/src/i18n
git commit -m "feat(admin): stats data layer and zhCN strings"
```

---

### Task 4: The Stats page

**Files:**

- Create: `backend/apps/admin/src/routes/stats/page.tsx`

**Interfaces:**

- Consumes: `useStats`, `StatsRange`, `SignupTopupStats` (Task 3); `rm` (`lib/format.ts`); `LoadingSkeleton`.

- [ ] **Step 1: Write the page**

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Container, Heading, Input, Text } from '@medusajs/ui';
import { ChartBar } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { useStats } from '../../lib/queries';
import type { SignupTopupStats, StatsRange } from '../../lib/admin-rest';
import { rm } from '../../lib/format';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

// rank 0 = the top group of the custom nav. The SDK only reads a numeric
// LITERAL here, so a negative rank (a unary expression) would be ignored.
export const config: RouteConfig = {
  label: 'Stats',
  icon: ChartBar,
  rank: 0,
};

const RANGES: StatsRange[] = [
  'today',
  'yesterday',
  '7d',
  '30d',
  'month',
  'last_month',
  'custom',
];

// Card order. Money cards read RM; the rest are counts.
const CARDS: { key: keyof SignupTopupStats; money?: boolean }[] = [
  { key: 'signups' },
  { key: 'topup_customers' },
  { key: 'topup_count' },
  { key: 'topup_amount', money: true },
  { key: 'first_topup_count' },
  { key: 'first_topup_amount', money: true },
];

// The backend's windows are MYT (fixed UTC+8). Shift, then read the UTC
// fields, so the text is MYT whatever timezone the viewer's browser is in.
const MYT_MS = 8 * 3_600_000;
const mytText = (iso: string) =>
  new Date(Date.parse(iso) + MYT_MS)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
const windowText = (w: { from: string; to: string }) =>
  `${mytText(w.from)} – ${mytText(w.to)}`;
const todayMyt = () => new Date(Date.now() + MYT_MS).toISOString().slice(0, 10);

const StatsPage = () => {
  const { t } = useTranslation();
  const [range, setRange] = useState<StatsRange>('today');
  const [from, setFrom] = useState(todayMyt);
  const [to, setTo] = useState(todayMyt);
  const custom = range === 'custom';
  // YYYY-MM-DD strings order correctly as plain strings.
  const customValid = from !== '' && to !== '' && from <= to;
  const { data, isError } = useStats(
    range,
    custom ? from : '',
    custom ? to : '',
  );

  const notice =
    custom && !customValid
      ? t('statsBoard.customHint')
      : isError
        ? t('statsBoard.loadError')
        : null;

  return (
    <Container className="p-0">
      <div className="flex flex-col gap-3 px-6 py-4">
        <div>
          <Heading level="h2">{t('statsBoard.title')}</Heading>
          {data && (
            <Text className="text-ui-fg-subtle mt-1" size="small">
              {t('statsBoard.subtitle', {
                current: windowText(data.current),
                previous: windowText(data.previous),
              })}
            </Text>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {RANGES.map((r) => (
            <Button
              key={r}
              size="small"
              variant={range === r ? 'primary' : 'secondary'}
              onClick={() => setRange(r)}
            >
              {t(`statsBoard.ranges.${r}`)}
            </Button>
          ))}
        </div>
        {custom && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              className="w-40"
              aria-label={t('statsBoard.from')}
              value={from}
              max={todayMyt()}
              onChange={(e) => setFrom(e.target.value)}
            />
            <Input
              type="date"
              className="w-40"
              aria-label={t('statsBoard.to')}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        )}
      </div>

      {notice || !data ? (
        <div className="border-t px-6 py-8">
          {notice ? (
            <Text className="text-ui-fg-subtle">{notice}</Text>
          ) : (
            <LoadingSkeleton />
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-px border-t bg-ui-border-base md:grid-cols-3">
          {CARDS.map(({ key, money }) => {
            const cur = data.current.stats[key];
            const prev = data.previous.stats[key];
            const fmt = (n: number) =>
              money ? rm(n) : n.toLocaleString('en-US');
            // No % against a zero base: "—" instead of Infinity.
            const pct = prev === 0 ? null : ((cur - prev) / prev) * 100;
            const tone =
              pct === null || pct === 0
                ? 'text-ui-fg-subtle'
                : pct > 0
                  ? 'text-ui-tag-green-text'
                  : 'text-ui-fg-error';
            const arrow =
              pct === null || pct === 0 ? '' : pct > 0 ? '▲ ' : '▼ ';
            return (
              <div key={key} className="bg-ui-bg-subtle px-6 py-4">
                <Text size="small" className="text-ui-fg-subtle">
                  {t(`statsBoard.${key}`)}
                </Text>
                <Heading level="h1" className="mt-1 tabular-nums">
                  {fmt(cur)}
                </Heading>
                <Text size="small" className={`tabular-nums ${tone}`}>
                  {arrow}
                  {pct === null ? '—' : `${Math.abs(pct).toFixed(2)}%`}{' '}
                  {t('statsBoard.vsPrevious')}
                </Text>
                <Text size="small" className="text-ui-fg-muted tabular-nums">
                  {t('statsBoard.previous', { value: fmt(prev) })}
                </Text>
              </div>
            );
          })}
        </div>
      )}
    </Container>
  );
};

export default StatsPage;
```

- [ ] **Step 2: Build, lint and test the admin app**

Run (from `backend/apps/admin`): `corepack yarn build && corepack yarn lint && corepack yarn test`
Expected: all green.

- [ ] **Step 3: Check the page in a browser**

Start the local stack with the `launching-pokenic-stack` skill: backend on :9000 and admin on :7000. Sign in to `http://localhost:7000/dashboard` as a super admin, open **Stats**, and check:

1. Today's figures render.
2. Every preset switches the numbers without a skeleton flash.
3. Custom with a reversed range shows the hint.
4. Profile → Language → 简体中文 turns the page Chinese.

Take a screenshot of the English and the Chinese page. Cross-check the local numbers with the SQL from Task 2, run through the postgres MCP.

- [ ] **Step 4: Commit**

```bash
git add backend/apps/admin/src/routes/stats/page.tsx
git commit -m "feat(admin): Stats page — sign-ups and top-ups vs the previous window"
```

---

## Handoff

After the change is deployed, any admin who signs in at `https://admin.polycards.gg/dashboard` finds **Stats** in the left menu. To see the page in Chinese, choose Profile → Language → 简体中文.
