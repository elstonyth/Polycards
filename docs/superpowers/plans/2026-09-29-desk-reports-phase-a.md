# Desk Reports Phase A (Foundation + Finance) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Finance desk bot answer staff questions from live production data. The first target is Wei Yuan's "today's Economy, DEFAULT-group customers only". The data comes through key-guarded, read-only backend report routes and an MCP tool.

**Architecture:**
- **Backend:** GET routes under `backend/packages/api/src/api/reports/finance/`, all behind one middleware entry: a rate limiter, then a per-desk key guard.
  - Report SQL lives beside the routes and reads through the app's shared Postgres connection. It folds ledger rows with the dashboard's own `ledgerTotals`.
  - A small Node MCP server (`tools/desk-reports/`) turns each route into a tool.
- **Hermes:** starts that server for the `polycards-finance` profile only, with the key taken from the profile's `.env`.

**Tech Stack:**
- Medusa v2: file-based routes, `@medusajs/framework`, knex from `ContainerRegistrationKeys.PG_CONNECTION`.
- TypeScript and Jest (`*.unit.spec.ts`, `medusaIntegrationTestRunner`).
- Node 24 ESM, `@modelcontextprotocol/sdk` 1.30.0 (`McpServer`, stdio) and zod 4.6.5, tested with `node --test`.
- Hermes Agent 0.21.5 `mcp_servers`.

**Spec:** `docs/superpowers/specs/2026-09-29-desk-reports-design.md`. Read it first, especially "Group scope", "Partition invariant" and "Deploy and secret order".

## Global Constraints

**Routes and access**
- Routes are `GET /reports/finance/{economy,daily,payments,pack-sales,player,groups}`. GET only; nothing writes.
- Auth is the `x-report-key` header, compared in constant time against `REPORT_KEY_<DESK>` (`REPORT_KEY_FINANCE` in this phase). The desk is the first path segment after `/reports/`, lowercased. A desk's key opens only that desk's routes.
  - An unset key, or one shorter than 32 characters, gets **503**.
  - A wrong or missing key, or an unknown desk, gets **401** with body `{ "message": "Unauthorized" }`.
- The `desk-reports` limiter runs **before** the guard. It is keyed on `callbackSourceIp`. Its defaults are burst 20/10s and sustained 120/60s; the two rules must stay consistent (20 × 6 = 120).

**Data rules**
- No response may carry email, phone, address or bank details. A player is identified only by username (`customer.first_name`).
- Group scope follows each player's **current** effective group: the oldest live membership in a live group that is neither named `DEFAULT` nor flagged `metadata.is_default === true`. No such group means DEFAULT. This must equal `effectivePlayerGroup` + `isDefaultPlayerGroup` in `backend/packages/api/src/modules/packs/odds-sets.ts`.
- `?group=` is `all` (default) or `default`; any other value names a group, matched case-insensitively. An unknown name gets 400 with the list of real names.
- Windows are ISO instants, half-open `[from, to)`. A malformed bound gets **400**; it is never silently dropped.
- Money is MYR, summed as integer cents in SQL and divided by 100 once.

**Where code goes**
- Do not edit `backend/packages/api/src/modules/packs/service.ts`. Report SQL lives in `src/api/reports/`. Liabilities, FX and username lookup reuse existing service methods.

**Worktree mechanics**
- Paths:
  - worktree: `C:\Users\PC\Desktop\Projects\Polycards\.claude\worktrees\feat+desk-reports`;
  - branch: `worktree-feat+desk-reports`;
  - backend commands run from `backend/packages/api` with `corepack yarn` (never npm there).
- **Typecheck yourself** with `corepack yarn check-types` in `backend/packages/api`. The Stop hook only type-checks the main checkout.
- **Prettier hook:** a user-level hook runs `prettier --write` on every file touched by Edit or Write. Two files are not Prettier-clean at HEAD: `backend/packages/api/src/api/utils/rate-limit.ts` and `.do/backend.app.yaml`. Change those only with the node scripts given below. `middlewares.ts` is clean, so Edit is fine there.
- **Guard-secrets hook:** never Read, grep or cat any `.env*` file, including `.env.template` (so this plan does not edit it). The provisioning and live-check scripts read or write secret files themselves and never print a value.

**MCP server package**
- `tools/desk-reports/` holds ESM `.mjs` files with dependencies pinned to `@modelcontextprotocol/sdk` `1.30.0` and `zod` `4.6.5`.
- Run its tests with `node --test` from that folder. In the worktree the imports resolve through the main checkout's `node_modules`.

**Commits and production**
- Conventional commits. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- These steps each need the operator's explicit OK in chat before they run:
  - generating or writing the key;
  - merging;
  - `do-apply`;
  - restarting the Hermes gateway (it interrupts desk sessions).

## File Structure

| File | Responsibility |
| --- | --- |
| `backend/packages/api/src/api/reports/require-report-key.ts` (create) | `deskOf()`, `requireReportKey()`: the per-desk key guard |
| `backend/packages/api/src/api/reports/params.ts` (create) | `parseWindow()`, `resolveGroupScope()`, `describeScope()`, `loadGroupScope()` |
| `backend/packages/api/src/api/reports/sql.ts` (create) | `reportDb()`, `EFFECTIVE_GROUP_SQL`, `scopeFilter()`, `windowFilter()`, `and()`, `customerFilter()` |
| `backend/packages/api/src/api/reports/finance/queries.ts` (create) | Finance aggregates: `ledgerTotalsWhere`, `ledgerTotalsByDay`, `statusTotals`, `packSales`, `groupSizes` |
| `backend/packages/api/src/api/reports/finance/{economy,daily,payments,pack-sales,player,groups}/route.ts` (create) | One GET each |
| `backend/packages/api/src/api/reports/__tests__/*.unit.spec.ts` (create) | Guard, params, registration |
| `backend/packages/api/integration-tests/http/desk-reports.spec.ts` (create) | DB-backed HTTP specs for every route |
| `backend/packages/api/src/api/utils/rate-limit.ts` (modify, node script) | `'desk-reports'` limiter entry |
| `backend/packages/api/src/api/middlewares.ts` (modify) | `deskReportsRateLimit` binding + `/reports/*` entry |
| `tools/desk-reports/package.json` (create) | Pinned dependencies, `node --test` |
| `tools/desk-reports/periods.mjs` (create) | Malaysia-time period → `[from, to)` + label |
| `tools/desk-reports/http.mjs` (create) | `getReport()`, `ReportError` |
| `tools/desk-reports/tools.mjs` (create) | `TOOLS` table per desk, `runTool()` |
| `tools/desk-reports/server.mjs` (create) | stdio MCP server |
| `tools/desk-reports/install.mjs` (create) | Copy to `%LOCALAPPDATA%\hermes\ops\desk-reports` and `npm install` there |
| `tools/desk-reports/provision-key.mjs` (create) | Generate a desk key into `deploy/.env.deploy` + the profile `.env`, unprinted |
| `tools/desk-reports/live-check.mjs` (create) | Post-deploy partition check |
| `tools/desk-reports/*.test.mjs` (create) | `node --test` specs |
| `.do/backend.app.yaml` (modify, node script) | `REPORT_KEY_FINANCE` secret on `services.backend` |
| `scripts/do-apply.ps1` (modify) | `REPORT_KEY_FINANCE` in the backend secret list |
| `%LOCALAPPDATA%\hermes\ops\discord\desks.json` + `discord-desks.mjs` (modify, outside git) | Per-desk tools, report server wiring, per-desk audit |
| `%LOCALAPPDATA%\hermes\profiles\polycards-finance\SOUL.md` (modify, outside git) | Use the report tools for live figures |

---

### Task 1: Key guard, rate limiter and middleware registration

**Files:**
- Create: `backend/packages/api/src/api/reports/require-report-key.ts`
- Create: `backend/packages/api/src/api/reports/__tests__/require-report-key.unit.spec.ts`
- Create: `backend/packages/api/src/api/reports/__tests__/report-middlewares.unit.spec.ts`
- Modify: `backend/packages/api/src/api/utils/rate-limit.ts` (node script; inside `RATE_LIMITS`, after the `'gateway-hook'` entry)
- Modify: `backend/packages/api/src/api/middlewares.ts` (import block top; bindings after `const tgpayCallbackAllowlist = createTgpayCallbackAllowlist();` near line 115; routes entry after the `/hooks/tgpay/*` entry near line 320)

**Interfaces:**
- Produces:
  - `REPORT_DESKS: readonly ['finance', 'store', 'support', 'growth']` and `type ReportDesk`;
  - `deskOf(originalUrl: string): ReportDesk | null`;
  - `requireReportKey(): (req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) => void`;
  - `RATE_LIMITS['desk-reports']` and the middlewares binding `deskReportsRateLimit`.

- [ ] **Step 1: Write the failing guard spec**

`backend/packages/api/src/api/reports/__tests__/require-report-key.unit.spec.ts`:

```ts
import { deskOf, requireReportKey } from '../require-report-key';

const FINANCE = 'f'.repeat(40);
const STORE = 's'.repeat(40);
const saved = {
  finance: process.env.REPORT_KEY_FINANCE,
  store: process.env.REPORT_KEY_STORE,
};
beforeEach(() => {
  process.env.REPORT_KEY_FINANCE = FINANCE;
  process.env.REPORT_KEY_STORE = STORE;
});
afterAll(() => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore('REPORT_KEY_FINANCE', saved.finance);
  restore('REPORT_KEY_STORE', saved.store);
});

function run(
  url: string,
  headers: Record<string, string | string[] | undefined>,
) {
  const info = jest.fn();
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const next = jest.fn();
  requireReportKey()(
    {
      originalUrl: url,
      headers,
      scope: { resolve: () => ({ info }) },
    } as never,
    res as never,
    next,
  );
  return { res, next, info };
}

describe('deskOf', () => {
  it.each([
    ['/reports/finance/economy', 'finance'],
    ['/reports/finance/economy?group=default', 'finance'],
    ['/reports/FINANCE/economy', 'finance'],
    ['/REPORTS/finance/economy', 'finance'],
    ['/reports/store/packs', 'store'],
    ['/reports/admin/economy', null],
    ['/reports', null],
    ['/reports/', null],
    ['/reports//finance/economy', null],
    ['/reportsfinance/economy', null],
    ['/reports/fin%61nce/economy', null],
  ])('%s -> %p', (url, desk) => {
    expect(deskOf(url)).toBe(desk);
  });
});

describe('requireReportKey', () => {
  const ECONOMY = '/reports/finance/economy?group=default';

  it('answers 503 and never calls next when the desk key is unset', () => {
    delete process.env.REPORT_KEY_FINANCE;
    const { res, next } = run(ECONOMY, { 'x-report-key': FINANCE });
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('treats a key shorter than 32 characters as unset', () => {
    process.env.REPORT_KEY_FINANCE = 'short';
    expect(run(ECONOMY, { 'x-report-key': 'short' }).res.statusCode).toBe(503);
  });

  it('answers a bare 401 without the header', () => {
    const { res, next } = run(ECONOMY, {});
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 401 for a wrong key of the same length', () => {
    expect(run(ECONOMY, { 'x-report-key': 'x'.repeat(40) }).res.statusCode).toBe(401);
  });

  it('answers 401 for a wrong key of a different length', () => {
    expect(run(ECONOMY, { 'x-report-key': `${FINANCE}x` }).res.statusCode).toBe(401);
  });

  it("refuses another desk's key: the store key cannot open finance", () => {
    const { res, next } = run(ECONOMY, { 'x-report-key': STORE });
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses an unknown desk whatever key is sent', () => {
    expect(run('/reports/admin/economy', { 'x-report-key': FINANCE }).res.statusCode).toBe(401);
  });

  it('holds a mixed-case desk segment to that desk key', () => {
    expect(run('/reports/Finance/economy', { 'x-report-key': FINANCE }).next).toHaveBeenCalledTimes(1);
    expect(run('/reports/Finance/economy', { 'x-report-key': STORE }).res.statusCode).toBe(401);
  });

  it('calls next for the right key, writes no response, and logs desk and path', () => {
    const { res, next, info } = run(ECONOMY, { 'x-report-key': FINANCE });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
    expect(info).toHaveBeenCalledWith(`[reports] finance ${ECONOMY}`);
  });

  it('uses the first value when the header repeats', () => {
    expect(run(ECONOMY, { 'x-report-key': [FINANCE, 'other'] }).next).toHaveBeenCalledTimes(1);
  });

  it('ignores whitespace around the configured key', () => {
    process.env.REPORT_KEY_FINANCE = `  ${FINANCE}\n`;
    expect(run(ECONOMY, { 'x-report-key': FINANCE }).next).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Write the failing registration spec**

`backend/packages/api/src/api/reports/__tests__/report-middlewares.unit.spec.ts`:

```ts
import * as fs from 'fs';
import {
  MIDDLEWARES_PATH,
  extractLimiterEntries,
  isLimited,
  limiterBindings,
} from '../../__tests__/rate-limit-coverage-helpers';

const src = fs.readFileSync(MIDDLEWARES_PATH, 'utf8');
const entry = extractLimiterEntries(src).find((e) => e.matcher === '/reports/*');

describe('/reports/* middleware registration', () => {
  it('registers GET /reports/* with the rate limiter BEFORE the key guard', () => {
    expect(entry).toBeDefined();
    expect(entry!.methods).toEqual(['GET']);
    expect(isLimited(entry!, limiterBindings(src))).toBe(true);
    const limiterAt = entry!.middlewares.indexOf('deskReportsRateLimit');
    const guardAt = entry!.middlewares.indexOf('requireReportKey()');
    expect(limiterAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeGreaterThan(limiterAt);
  });

  it('binds the desk-reports limiter once', () => {
    expect(src.match(/rateLimit\('desk-reports'\)/g)).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run both specs and confirm they fail**

Run (from `backend/packages/api`): `corepack yarn test:unit src/api/reports/__tests__`

Expected: FAIL. `Cannot find module '../require-report-key'`, and `expect(entry).toBeDefined()` fails.

- [ ] **Step 4: Implement the guard**

`backend/packages/api/src/api/reports/require-report-key.ts`:

```ts
import { timingSafeEqual } from 'node:crypto';
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';

// The desk-reports lock (spec 2026-09-29-desk-reports-design.md). Each staff
// desk bot holds its OWN key (REPORT_KEY_<DESK>) and sends it in
// `x-report-key`; a key opens only its desk's routes, so the store key can
// never read /reports/finance/*. Fail CLOSED: an unset or too-short key
// answers 503, so a deploy that forgot the secret never serves a report. The
// comparison is constant-time and every refusal is the same bare 401.
export const REPORT_DESKS = ['finance', 'store', 'support', 'growth'] as const;
export type ReportDesk = (typeof REPORT_DESKS)[number];
const MIN_KEY_LENGTH = 32;

// The desk is the first path segment after /reports/, lowercased: Medusa
// matches routes case-insensitively, so /reports/Finance/economy reaches the
// finance handler and must be held to the finance key.
export function deskOf(originalUrl: string): ReportDesk | null {
  const { pathname } = new URL(originalUrl, 'http://reports.local');
  const segment = /^\/reports\/([^/]+)/i.exec(pathname)?.[1]?.toLowerCase();
  return REPORT_DESKS.find((desk) => desk === segment) ?? null;
}

export function requireReportKey() {
  return (
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction,
  ): void => {
    const desk = deskOf(req.originalUrl);
    if (!desk) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    const expected =
      process.env[`REPORT_KEY_${desk.toUpperCase()}`]?.trim() ?? '';
    if (expected.length < MIN_KEY_LENGTH) {
      res.status(503).json({ message: 'Reports are not configured for this desk.' });
      return;
    }
    const raw = req.headers['x-report-key'];
    const given = Array.isArray(raw) ? raw[0] : raw;
    if (typeof given !== 'string' || !sameKey(given, expected)) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .info(`[reports] ${desk} ${req.originalUrl}`);
    next();
  };
}

function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

- [ ] **Step 5: Add the limiter entry with a node script**

`rate-limit.ts` is not Prettier-clean, so an Edit would reflow unrelated lines. Save this as `insert-limiter.mjs` in your scratch folder and run it from `backend/packages/api` with `node <scratch>/insert-limiter.mjs`:

```js
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/api/utils/rate-limit.ts';
const src = readFileSync(path, 'utf8');
const anchor =
  '  // Phone-OTP limiters are keyed in TWO independent dimensions';
if (src.split(anchor).length !== 2) throw new Error('anchor not found exactly once');
if (src.includes("'desk-reports'")) throw new Error('already inserted');
const entry = `  /**
   * Desk reports (GET /reports/*, spec 2026-09-29-desk-reports-design.md):
   * read by the staff Discord desk bots on the owner's PC, a few calls per
   * staff question. Runs BEFORE the key check, so a key-guessing loop 429s
   * before any comparison. Keyed on the caller's address like gateway-hook
   * (on App Platform req.ip is DigitalOcean's ingress), so every desk shares
   * the PC's one budget. The two rules are CONSISTENT (20 per 10s = 120 per
   * minute), as the gateway-hook note requires. Env-tunable:
   * DESK_REPORTS_RATE_BURST_LIMIT / DESK_REPORTS_RATE_BURST_WINDOW_MS (20/10s)
   * DESK_REPORTS_RATE_LIMIT / DESK_REPORTS_RATE_WINDOW_MS (120/60s)
   */
  'desk-reports': {
    message: 'Too many report requests.',
    keyOf: (req) => \`ip:\${callbackSourceIp(req) || 'unknown'}\`,
    defaults: {
      burstLimit: 20,
      burstWindowMs: 10_000,
      limit: 120,
      windowMs: 60_000,
    },
  },

`;
writeFileSync(path, src.replace(anchor, entry + anchor));
console.log('inserted desk-reports limiter');
```

Then run `git diff --stat src/api/utils/rate-limit.ts`. Expected: one file, about 22 insertions and no deletions.

- [ ] **Step 6: Register the middleware**

`middlewares.ts` is Prettier-clean, so use Edit:

1. After `import { refuseCrossOriginAdminWrite } from './utils/admin-origin-guard';` add:

```ts
import { requireReportKey } from './reports/require-report-key';
```

2. After `const tgpayCallbackAllowlist = createTgpayCallbackAllowlist();` add:

```ts
// Desk reports (GET /reports/*): one budget for every staff desk bot, which
// all call from the owner's PC.
const deskReportsRateLimit = rateLimit('desk-reports');
```

3. In the routes array, directly after the `/hooks/tgpay/*` entry (the object ending `middlewares: [gatewayHookRateLimit, tgpayCallbackAllowlist],` then `},`), add:

```ts
    {
      // Desk reports (spec 2026-09-29-desk-reports-design.md): read-only
      // numbers for the staff Discord desk bots. A top-level prefix like
      // /hooks, so no publishable key and no session; each desk's own key is
      // the lock. Limiter FIRST so a key-guessing loop 429s before any
      // comparison.
      matcher: '/reports/*',
      method: 'GET',
      middlewares: [deskReportsRateLimit, requireReportKey()],
    },
```

- [ ] **Step 7: Run the specs, the existing limiter probes and the typecheck**

Run from `backend/packages/api`, in this order:

1. `corepack yarn test:unit src/api/reports/__tests__`
   - Expected: PASS, 24 tests.
2. `corepack yarn test:unit src/api/__tests__`
   - Expected: PASS, unchanged.
3. `corepack yarn check-types`
   - Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add backend/packages/api/src/api/reports backend/packages/api/src/api/utils/rate-limit.ts backend/packages/api/src/api/middlewares.ts
git commit -m "feat(reports): per-desk key guard and limiter for /reports/*

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Window and group-scope params, scoped ledger SQL, and the economy route

**Files:**
- Create: `backend/packages/api/src/api/reports/params.ts`
- Create: `backend/packages/api/src/api/reports/sql.ts`
- Create: `backend/packages/api/src/api/reports/finance/queries.ts`
- Create: `backend/packages/api/src/api/reports/finance/economy/route.ts`
- Create: `backend/packages/api/src/api/reports/__tests__/params.unit.spec.ts`
- Create: `backend/packages/api/integration-tests/http/desk-reports.spec.ts`

**Interfaces:**
- Consumes: Task 1's guard (the routes are unreachable without the key).
- Produces:
  - `params.ts`:
    - `type ReportWindow = { from?: string; to?: string }`;
    - `parseWindow(query, opts?: { required?: boolean; maxDays?: number }): ReportWindow`;
    - `type GroupScope = { kind: 'all' } | { kind: 'default' } | { kind: 'group'; id: string; name: string }`;
    - `type GroupRow`;
    - `resolveGroupScope(raw: unknown, groups: readonly GroupRow[]): GroupScope`;
    - `describeScope(scope): { group: string; note: string }`;
    - `loadGroupScope(req): Promise<GroupScope>`.
  - `sql.ts`:
    - `type ReportDb` and `reportDb(req): ReportDb`;
    - `type SqlPart = { sql: string; params: unknown[] }`;
    - `EFFECTIVE_GROUP_SQL: string`;
    - `scopeFilter(scope, column): SqlPart`;
    - `windowFilter(window, column): SqlPart`;
    - `customerFilter(customerId, column): SqlPart`;
    - `and(...parts): SqlPart`.
  - `finance/queries.ts`:
    - `type ReasonCents = { reason: string; cents: string }`;
    - `foldTotals(rows): LedgerTotals`;
    - `ledgerTotalsWhere(db, filter: SqlPart): Promise<LedgerTotals>`.
  - Integration spec helpers inside `desk-reports.spec.ts`: `report(path, key?)`, `backdate(table, id, iso)`, `opens(rows)`, `seedGroups()`. Later tasks add `describe` blocks to this file and reuse them.

- [ ] **Step 1: Write the failing params spec**

`backend/packages/api/src/api/reports/__tests__/params.unit.spec.ts`:

```ts
import { MedusaError } from '@medusajs/framework/utils';
import { describeScope, parseWindow, resolveGroupScope } from '../params';

// The message of the INVALID_DATA (400) error fn throws, or a failure marker.
function invalid(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof MedusaError && e.type === MedusaError.Types.INVALID_DATA
      ? e.message
      : `wrong error: ${String(e)}`;
  }
  return 'no error';
}

describe('parseWindow', () => {
  it('normalises both bounds to ISO', () => {
    expect(
      parseWindow({ from: '2026-09-28T16:00:00Z', to: '2026-09-29T16:00:00.000Z' }),
    ).toEqual({ from: '2026-09-28T16:00:00.000Z', to: '2026-09-29T16:00:00.000Z' });
  });

  it('treats absent and empty bounds as open', () => {
    expect(parseWindow({})).toEqual({ from: undefined, to: undefined });
    expect(parseWindow({ from: '', to: '' })).toEqual({ from: undefined, to: undefined });
  });

  it.each([
    [{ from: 'yesterday' }, 'from must be'],
    [{ to: ['2026-09-28T00:00:00Z', '2026-09-29T00:00:00Z'] }, 'to must be'],
    [{ from: '2026-09-29T00:00:00Z', to: '2026-09-28T00:00:00Z' }, 'before'],
    [{ from: '2026-09-29T00:00:00Z', to: '2026-09-29T00:00:00Z' }, 'before'],
  ])('rejects %p', (query, message) => {
    expect(invalid(() => parseWindow(query))).toContain(message);
  });

  it('enforces required bounds and the day cap', () => {
    expect(
      invalid(() => parseWindow({ from: '2026-09-01T00:00:00Z' }, { required: true })),
    ).toContain('both required');
    expect(
      invalid(() =>
        parseWindow(
          { from: '2026-01-01T00:00:00Z', to: '2026-04-04T00:00:01Z' },
          { maxDays: 93 },
        ),
      ),
    ).toContain('93 days');
    expect(
      parseWindow(
        { from: '2026-01-01T00:00:00Z', to: '2026-04-04T00:00:00Z' },
        { maxDays: 93 },
      ).to,
    ).toBe('2026-04-04T00:00:00.000Z');
  });
});

const GROUPS = [
  { id: 'g_def', name: 'DEFAULT', metadata: { is_default: true } },
  { id: 'g_house', name: 'House', metadata: { is_default: true } },
  { id: 'g_partners', name: 'Partners', metadata: null },
];

describe('resolveGroupScope', () => {
  it.each([undefined, '', 'all', ' ALL '])('%p means everyone', (raw) => {
    expect(resolveGroupScope(raw, GROUPS)).toEqual({ kind: 'all' });
  });

  it.each(['default', 'Default', 'DEFAULT', 'house'])(
    '%p means the default group',
    (raw) => {
      expect(resolveGroupScope(raw, GROUPS)).toEqual({ kind: 'default' });
    },
  );

  it('matches a named group case-insensitively', () => {
    expect(resolveGroupScope(' partners ', GROUPS)).toEqual({
      kind: 'group',
      id: 'g_partners',
      name: 'Partners',
    });
  });

  it('rejects an unknown group and lists the real ones', () => {
    expect(invalid(() => resolveGroupScope('Whales', GROUPS))).toBe(
      'Unknown player group "Whales". Use all, default, or one of: DEFAULT, House, Partners.',
    );
  });

  it('rejects a repeated group param', () => {
    expect(invalid(() => resolveGroupScope(['all', 'default'], GROUPS))).toContain(
      'one value',
    );
  });
});

describe('describeScope', () => {
  it('names the group the numbers cover', () => {
    expect(describeScope({ kind: 'all' }).group).toBe('all');
    expect(describeScope({ kind: 'default' }).group).toBe('DEFAULT');
    expect(describeScope({ kind: 'group', id: 'g', name: 'Partners' }).group).toBe(
      'Partners',
    );
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack yarn test:unit src/api/reports/__tests__/params.unit.spec.ts`

Expected: FAIL, `Cannot find module '../params'`.

- [ ] **Step 3: Implement `params.ts`**

`backend/packages/api/src/api/reports/params.ts`:

```ts
import type { MedusaRequest } from '@medusajs/framework/http';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { isDefaultPlayerGroup } from '../../modules/packs/odds-sets';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Half-open [from, to) of ISO instants; an absent bound is open-ended. */
export type ReportWindow = { from?: string; to?: string };

const invalid = (message: string) =>
  new MedusaError(MedusaError.Types.INVALID_DATA, message);

/**
 * ?from=&to= as a report window. Unlike /admin/economy (which drops a
 * malformed bound), a bad bound is a 400: a bot asking for "today" must never
 * silently receive all-time numbers.
 */
export function parseWindow(
  query: Record<string, unknown>,
  opts: { required?: boolean; maxDays?: number } = {},
): ReportWindow {
  const bound = (key: 'from' | 'to'): string | undefined => {
    const value = query[key];
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      throw invalid(
        `${key} must be one ISO date-time, e.g. 2026-09-28T16:00:00.000Z.`,
      );
    }
    return new Date(value).toISOString();
  };
  const from = bound('from');
  const to = bound('to');
  if (opts.required && (!from || !to)) {
    throw invalid('from and to are both required.');
  }
  if (from && to && from >= to) throw invalid('from must be before to.');
  if (
    opts.maxDays &&
    from &&
    to &&
    Date.parse(to) - Date.parse(from) > opts.maxDays * DAY_MS
  ) {
    throw invalid(`The window can be at most ${opts.maxDays} days.`);
  }
  return { from, to };
}

/** Which players a report counts, by their EFFECTIVE player group (the rule
 *  in modules/packs/odds-sets.ts: oldest non-default membership). */
export type GroupScope =
  | { kind: 'all' }
  | { kind: 'default' }
  | { kind: 'group'; id: string; name: string };

export type GroupRow = {
  id: string;
  name: string | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * ?group= as a scope: absent or 'all' = everyone; 'default' = players whose
 * effective group is DEFAULT (in no other group); anything else names a
 * group, case-insensitively. Naming a default group itself (DEFAULT, or a
 * renamed one carrying the is_default flag) also means 'default'. The words
 * 'all' and 'default' win over a group that happens to be called that.
 */
export function resolveGroupScope(
  raw: unknown,
  groups: readonly GroupRow[],
): GroupScope {
  if (raw !== undefined && typeof raw !== 'string') {
    throw invalid('group must be one value.');
  }
  const wanted = typeof raw === 'string' ? raw.trim() : '';
  const key = wanted.toLowerCase();
  if (key === '' || key === 'all') return { kind: 'all' };
  if (key === 'default') return { kind: 'default' };
  const match = groups.find(
    (g) => (g.name ?? '').trim().toLowerCase() === key,
  );
  if (!match) {
    const names = groups
      .map((g) => g.name)
      .filter((name): name is string => !!name);
    throw invalid(
      `Unknown player group "${wanted.slice(0, 60)}". Use all, default, or one of: ${names.join(', ')}.`,
    );
  }
  if (isDefaultPlayerGroup(match)) return { kind: 'default' };
  return { kind: 'group', id: match.id, name: match.name ?? match.id };
}

/** Says in words who a report counted, so the bot can repeat it. */
export function describeScope(scope: GroupScope): {
  group: string;
  note: string;
} {
  if (scope.kind === 'all') return { group: 'all', note: 'All players.' };
  if (scope.kind === 'default') {
    return {
      group: 'DEFAULT',
      note: 'Players whose current player group is DEFAULT, i.e. in no other group.',
    };
  }
  return {
    group: scope.name,
    note: `Players whose current player group is ${scope.name}.`,
  };
}

/** The request's ?group= resolved against the live group list (the same
 *  100-group ceiling modules/packs/player-groups.ts assumes). */
export async function loadGroupScope(req: MedusaRequest): Promise<GroupScope> {
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const groups = await customers.listCustomerGroups(
    {},
    { take: 100, order: { created_at: 'ASC' } },
  );
  return resolveGroupScope(req.query.group, groups);
}
```

- [ ] **Step 4: Run the params spec and confirm it passes**

Run: `corepack yarn test:unit src/api/reports/__tests__/params.unit.spec.ts`

Expected: PASS, 19 tests.

- [ ] **Step 5: Write the failing integration spec (guard, group scope, partition, lock)**

`backend/packages/api/integration-tests/http/desk-reports.spec.ts`:

```ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { ensureDefaultPlayerGroup } from '../../src/modules/packs/player-groups';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Desk reports (spec 2026-09-29-desk-reports-design.md): the key-guarded
// /reports/finance/* routes, over directly seeded rows so every number is
// predictable. The guard reads the key per request, so setting it here is
// enough.
const FINANCE_KEY = 'f'.repeat(48);
const STORE_KEY = 's'.repeat(48);
process.env.REPORT_KEY_FINANCE = FINANCE_KEY;
process.env.REPORT_KEY_STORE = STORE_KEY;

type Pg = {
  raw: (
    sql: string,
    bindings?: unknown[],
  ) => Promise<{ rowCount: number; rows: unknown[] }>;
};

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    const packs = () =>
      getContainer().resolve<PacksModuleService>(PACKS_MODULE);
    const customers = () =>
      getContainer().resolve<ICustomerModuleService>(Modules.CUSTOMER);
    const pg = () =>
      getContainer().resolve(
        ContainerRegistrationKeys.PG_CONNECTION,
      ) as unknown as Pg;
    const report = (path: string, key: string | null = FINANCE_KEY) =>
      unwrapResponse(
        api.get(`/reports/finance/${path}`, {
          headers: key ? { 'x-report-key': key } : {},
        }),
      );
    // created_at is ORM-managed on insert, so rows are backdated afterwards.
    const backdate = async (table: string, id: string, iso: string) => {
      const res = await pg().raw(
        `UPDATE ${table} SET created_at = ? WHERE id = ?`,
        [iso, id],
      );
      expect(res.rowCount).toBe(1);
    };
    const opens = (rows: Array<[string, number]>) =>
      packs().createCreditTransactions(
        rows.map(([customer_id, amount]) => ({
          customer_id,
          amount: -amount,
          reason: 'pack_open' as const,
        })),
      );

    // Nine players whose effective groups differ in every way the SQL rule
    // and effectivePlayerGroup could disagree about. Each opens packs for a
    // distinct power of two, so any sum names exactly who is in it:
    //   DEFAULT = nogroup 1 + defonly 2 + renamed 16 + left 32 + deadgroup 64 = 115
    //   Partners = partner 4 + both 8 + pw 128 = 140;  Whales = whale 256
    async function seedGroups() {
      const c = customers();
      const group = (name: string, metadata?: Record<string, unknown>) =>
        c.createCustomerGroups({ name, metadata });
      const def = await ensureDefaultPlayerGroup(getContainer());
      const partners = await group('Partners');
      const whales = await group('Whales');
      const house = await group('House', { is_default: true }); // a renamed default
      const oldVip = await group('Old VIP');
      // Partners is OLDER than Whales, so a player in both is in Partners.
      await pg().raw('UPDATE customer_group SET created_at = ? WHERE id = ?', [
        '2026-01-01T00:00:00.000Z',
        partners.id,
      ]);
      await pg().raw('UPDATE customer_group SET created_at = ? WHERE id = ?', [
        '2026-02-01T00:00:00.000Z',
        whales.id,
      ]);
      const ids: Record<string, string> = {};
      for (const name of [
        'nogroup',
        'defonly',
        'partner',
        'both',
        'renamed',
        'left',
        'deadgroup',
        'pw',
        'whale',
      ]) {
        ids[name] = (await c.createCustomers({ email: `dr-${name}@test.dev` })).id;
      }
      const join = (who: string, g: { id: string }) =>
        c.addCustomerToGroup({ customer_id: ids[who], customer_group_id: g.id });
      await join('defonly', def);
      await join('partner', partners);
      await join('both', def);
      await join('both', partners);
      await join('renamed', house);
      await join('left', partners);
      await join('deadgroup', oldVip);
      await join('pw', whales);
      await join('pw', partners);
      await join('whale', whales);
      // A removed membership and a deleted group: both players are DEFAULT again.
      await pg().raw(
        'UPDATE customer_group_customer SET deleted_at = now() WHERE customer_id = ?',
        [ids.left],
      );
      await pg().raw('UPDATE customer_group SET deleted_at = now() WHERE id = ?', [
        oldVip.id,
      ]);
      await opens([
        [ids.nogroup, 1],
        [ids.defonly, 2],
        [ids.partner, 4],
        [ids.both, 8],
        [ids.renamed, 16],
        [ids.left, 32],
        [ids.deadgroup, 64],
        [ids.pw, 128],
        [ids.whale, 256],
      ]);
      return ids;
    }

    describe('the /reports/finance key', () => {
      it('answers 401 without a key and for another desk key', async () => {
        expect((await report('economy', null)).status).toBe(401);
        expect((await report('economy', STORE_KEY)).status).toBe(401);
      });

      it('answers 503 while the finance key is unset', async () => {
        delete process.env.REPORT_KEY_FINANCE;
        try {
          expect((await report('economy')).status).toBe(503);
        } finally {
          process.env.REPORT_KEY_FINANCE = FINANCE_KEY;
        }
      });
    });

    describe('GET /reports/finance/economy', () => {
      it("scopes by each player's effective group", async () => {
        await seedGroups();
        const revenue = async (group: string) => {
          const res = await report(`economy?group=${encodeURIComponent(group)}`);
          expect(res.status).toBe(200);
          return res.data.totals.revenue as number;
        };
        expect(await revenue('all')).toBe(511);
        // no group, DEFAULT only, renamed default, removed membership, deleted group
        expect(await revenue('default')).toBe(115);
        expect(await revenue('House')).toBe(115);
        // Partners only, DEFAULT + Partners, Whales + Partners (Partners is older)
        expect(await revenue('partners')).toBe(140);
        expect(await revenue('Whales')).toBe(256);
        const res = await report('economy?group=default');
        expect(res.data.scope.group).toBe('DEFAULT');
        expect(res.data.currency).toBe('MYR');
        expect(res.data.liability_now_all_players).toEqual({
          vault_cards: 0,
          vault_value: 0,
          outstanding_vouchers: 0,
        });
      });

      it('default plus every named group adds up to all (the partition invariant)', async () => {
        await seedGroups();
        const totals = async (group: string) =>
          (await report(`economy?group=${group}`)).data.totals as Record<
            string,
            number
          >;
        const all = await totals('all');
        const parts = [
          await totals('default'),
          await totals('Partners'),
          await totals('Whales'),
        ];
        for (const field of Object.keys(all)) {
          const sum = parts.reduce((s, t) => s + Math.round(t[field] * 100), 0);
          expect(sum / 100).toBe(all[field]);
        }
      });

      it('rejects an unknown or deleted group, listing the real ones', async () => {
        await seedGroups();
        const res = await report('economy?group=Old%20VIP');
        expect(res.status).toBe(400);
        const listed = res.data.message.split('one of:')[1];
        expect(listed).toContain('Partners');
        expect(listed).not.toContain('Old VIP');
      });

      it('rejects a malformed window instead of reporting all time', async () => {
        expect((await report('economy?from=yesterday')).status).toBe(400);
      });

      it('group=all matches /admin/economy exactly, all-time and windowed', async () => {
        const token = await mintSuperAdmin(
          getContainer(),
          api,
          'desk-reports-admin@test.dev',
          'desk-reports-password-1', // gitleaks:allow
        );
        const rows = await packs().createCreditTransactions([
          { customer_id: 'cus_lock', amount: 100, reason: 'topup' as const },
          { customer_id: 'cus_lock', amount: -25, reason: 'pack_open' as const },
          { customer_id: 'cus_lock', amount: 11.61, reason: 'buyback' as const },
          { customer_id: 'cus_lock', amount: 5, reason: 'adjustment' as const },
          { customer_id: 'cus_lock', amount: -20, reason: 'cashout' as const },
          { customer_id: 'cus_lock', amount: -12, reason: 'delivery_fee' as const },
          { customer_id: 'cus_lock', amount: 3, reason: 'referral_commission' as const },
          { customer_id: 'cus_lock', amount: 2, reason: 'voucher_claim' as const },
        ]);
        // Two rows move into January, so the windowed comparison both
        // includes and excludes something.
        await backdate('credit_transaction', rows[1].id, '2026-01-15T04:00:00.000Z');
        await backdate('credit_transaction', rows[2].id, '2026-01-20T04:00:00.000Z');
        const admin = (query: string) =>
          unwrapResponse(
            api.get(`/admin/economy${query}`, {
              headers: { authorization: `Bearer ${token}` },
            }),
          );
        for (const query of [
          '',
          '?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z',
        ]) {
          const [ours, theirs] = await Promise.all([
            report(`economy${query}`),
            admin(query),
          ]);
          expect(ours.status).toBe(200);
          expect(theirs.status).toBe(200);
          expect(ours.data.totals).toEqual(theirs.data.totals);
        }
        const january = await report(
          'economy?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z',
        );
        expect(january.data.totals.revenue).toBe(25);
        expect(january.data.totals.payouts).toBe(11.61);
        expect(january.data.totals.topups).toBe(0);
        expect(january.data.window).toEqual({
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-02-01T00:00:00.000Z',
        });
      });
    });
  },
});
```

- [ ] **Step 6: Run it and confirm it fails**

Docker containers `pokenic-postgres` and `pokenic-redis` must be running (`docker ps`).

Run (from `backend/packages/api`): `corepack yarn test:integration:http desk-reports.spec`

Expected: the key tests PASS already (Task 1). Every `economy` test FAILS with 404, because the route does not exist yet.

- [ ] **Step 7: Implement `sql.ts`**

`backend/packages/api/src/api/reports/sql.ts`:

```ts
import type { MedusaRequest } from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import type { GroupScope, ReportWindow } from './params';

/** The slice of knex the reports use. Every value goes in as a binding. */
export type ReportDb = {
  raw<T>(sql: string, bindings?: readonly unknown[]): Promise<{ rows: T[] }>;
};

// Reports read through the app's shared Postgres connection rather than the
// packs service: they are read-only aggregates, and keeping them here leaves
// the money-path service untouched.
export const reportDb = (req: MedusaRequest): ReportDb =>
  req.scope.resolve(
    ContainerRegistrationKeys.PG_CONNECTION,
  ) as unknown as ReportDb;

/** A WHERE fragment (starting with " AND", or empty) and its bindings. */
export type SqlPart = { sql: string; params: unknown[] };

// Every customer's EFFECTIVE player group: the SQL twin of
// effectivePlayerGroup + isDefaultPlayerGroup (modules/packs/odds-sets.ts).
// The oldest live membership (group created_at, then id) in a live group that
// is neither named DEFAULT nor flagged is_default. A customer with no row
// here is in DEFAULT. Same joins as PacksModuleService.partnerGroupOfCustomers.
export const EFFECTIVE_GROUP_SQL =
  'SELECT DISTINCT ON (cgc.customer_id) cgc.customer_id, cg.id AS group_id ' +
  'FROM customer_group_customer cgc ' +
  'JOIN customer_group cg ON cg.id = cgc.customer_group_id AND cg.deleted_at IS NULL ' +
  'WHERE cgc.deleted_at IS NULL ' +
  "AND cg.name IS DISTINCT FROM 'DEFAULT' " +
  "AND cg.metadata->'is_default' IS DISTINCT FROM 'true'::jsonb " +
  'ORDER BY cgc.customer_id, cg.created_at ASC, cg.id ASC';

/** Restricts `column` (a non-null customer id column) to the scope's players. */
export function scopeFilter(scope: GroupScope, column: string): SqlPart {
  if (scope.kind === 'all') return { sql: '', params: [] };
  if (scope.kind === 'default') {
    return {
      sql: ` AND ${column} NOT IN (SELECT customer_id FROM (${EFFECTIVE_GROUP_SQL}) eff)`,
      params: [],
    };
  }
  return {
    sql: ` AND ${column} IN (SELECT customer_id FROM (${EFFECTIVE_GROUP_SQL}) eff WHERE eff.group_id = ?)`,
    params: [scope.id],
  };
}

/** Restricts `column` (a timestamptz) to the half-open window. */
export function windowFilter(window: ReportWindow, column: string): SqlPart {
  const part: SqlPart = { sql: '', params: [] };
  if (window.from) {
    part.sql += ` AND ${column} >= ?::timestamptz`;
    part.params.push(window.from);
  }
  if (window.to) {
    part.sql += ` AND ${column} < ?::timestamptz`;
    part.params.push(window.to);
  }
  return part;
}

/** Restricts `column` to one customer. */
export const customerFilter = (customerId: string, column: string): SqlPart => ({
  sql: ` AND ${column} = ?`,
  params: [customerId],
});

/** Joins WHERE fragments into one, bindings in order. */
export const and = (...parts: SqlPart[]): SqlPart => ({
  sql: parts.map((p) => p.sql).join(''),
  params: parts.flatMap((p) => p.params),
});
```

- [ ] **Step 8: Implement `finance/queries.ts`**

`backend/packages/api/src/api/reports/finance/queries.ts`:

```ts
import { MedusaError } from '@medusajs/framework/utils';
import {
  ledgerTotals,
  type LedgerTotals,
} from '../../../modules/packs/economy';
import type { ReportDb, SqlPart } from '../sql';

export type ReasonCents = { reason: string; cents: string };

// ledgerTotals throws on an unknown reason. Say why, as /admin/economy does
// (a bare Error is masked as "An unknown error occurred.").
export function foldTotals(rows: readonly ReasonCents[]): LedgerTotals {
  try {
    return ledgerTotals(
      rows.map((r) => ({ reason: r.reason, amount: Number(r.cents) / 100 })),
    );
  } catch (err) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      `Report cannot be built (${(err as Error).message}); add the reason to ledgerTotals.`,
    );
  }
}

/**
 * Ledger totals over the credit_transaction rows (alias ct) matching
 * `filter`. The scoped twin of PacksModuleService.ledgerReasonTotals:
 * desk-reports.spec.ts locks group=all to /admin/economy so the two cannot
 * drift.
 */
export async function ledgerTotalsWhere(
  db: ReportDb,
  filter: SqlPart,
): Promise<LedgerTotals> {
  const { rows } = await db.raw<ReasonCents>(
    'SELECT ct.reason, COALESCE(SUM(ROUND(ct.amount * 100)), 0)::bigint AS cents ' +
      'FROM credit_transaction ct WHERE ct.deleted_at IS NULL' +
      filter.sql +
      ' GROUP BY ct.reason',
    filter.params,
  );
  return foldTotals(rows);
}
```

- [ ] **Step 9: Implement the economy route**

`backend/packages/api/src/api/reports/finance/economy/route.ts`:

```ts
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { resolveFxRate } from '../../../../modules/packs/pricing';
import { describeScope, loadGroupScope, parseWindow } from '../../params';
import { and, reportDb, scopeFilter, windowFilter } from '../../sql';
import { ledgerTotalsWhere } from '../queries';

// GET /reports/finance/economy: the Finance desk's Economy page. Ledger
// totals for a window and player group, plus the current liabilities (all
// players; a snapshot, never scoped). Same ledgerTotals fold and liability
// methods as GET /admin/economy.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const window = parseWindow(req.query);
  const scope = await loadGroupScope(req);
  const totals = await ledgerTotalsWhere(
    reportDb(req),
    and(
      windowFilter(window, 'ct.created_at'),
      scopeFilter(scope, 'ct.customer_id'),
    ),
  );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const vault = await packs.vaultLiabilityMyr(await resolveFxRate(packs));
  res.json({
    currency: 'MYR',
    window: { from: window.from ?? null, to: window.to ?? null },
    scope: describeScope(scope),
    totals,
    liability_now_all_players: {
      vault_cards: vault.count,
      vault_value: vault.liability,
      outstanding_vouchers: await packs.outstandingVoucherLiabilityMyr(),
    },
  });
}
```

- [ ] **Step 10: Run the integration spec, the unit specs and the typecheck**

Run from `backend/packages/api`, in this order:

1. `corepack yarn test:integration:http desk-reports.spec`
   - Expected: PASS, 7 tests.
2. `corepack yarn test:unit src/api/reports`
   - Expected: PASS, 43 tests.
3. `corepack yarn check-types`
   - Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add backend/packages/api/src/api/reports backend/packages/api/integration-tests/http/desk-reports.spec.ts
git commit -m "feat(reports): group-scoped economy report for the Finance desk

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The desk-reports MCP server with the economy tool

**Files:**
- Create: `tools/desk-reports/package.json`
- Create: `tools/desk-reports/periods.mjs`, `tools/desk-reports/periods.test.mjs`
- Create: `tools/desk-reports/http.mjs`, `tools/desk-reports/http.test.mjs`
- Create: `tools/desk-reports/tools.mjs`, `tools/desk-reports/tools.test.mjs`
- Create: `tools/desk-reports/server.mjs`, `tools/desk-reports/server.test.mjs`
- Create: `tools/desk-reports/install.mjs`

**Interfaces:**
- Consumes: the `/reports/finance/economy` contract from Task 2.
- Produces:
  - `periods.mjs`:
    - `PERIODS: string[]`;
    - `resolvePeriod(period, { from?, to? } = {}, now = Date.now()): { from: string | null; to: string | null; label: string }`.
  - `http.mjs`:
    - `class ReportError extends Error`;
    - `getReport({ baseUrl, desk, key, path, params = {}, fetchImpl = fetch, timeoutMs = 15000 }): Promise<object>`.
  - `tools.mjs`:
    - `TOOLS: Record<desk, Array<{ name, description, inputSchema, request(args) => { path, params, label? } }>>`;
    - `runTool(tool, args, config): Promise<CallToolResult>`.
  - The server takes these env vars: `REPORTS_DESK`, `REPORTS_BASE_URL` (default `https://admin.polycards.gg`) and `REPORTS_KEY`.

- [ ] **Step 1: Write `package.json`**

`tools/desk-reports/package.json`:

```json
{
  "name": "polycards-desk-reports",
  "version": "1.0.0",
  "private": true,
  "description": "MCP server giving the Polycards staff desk bots read-only access to the backend's /reports/<desk>/* routes.",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": { "test": "node --test" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "zod": "4.6.5"
  }
}
```

- [ ] **Step 2: Write the failing period and HTTP specs**

`tools/desk-reports/periods.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePeriod } from './periods.mjs';

// Wednesday 30 Sep 2026, 10:00 Malaysia time.
const NOW = Date.parse('2026-09-30T02:00:00.000Z');
const range = (period, extra = {}, now = NOW) => {
  const r = resolvePeriod(period, extra, now);
  return [r.from, r.to];
};

test('today and yesterday are Malaysia calendar days', () => {
  assert.deepEqual(range('today'), ['2026-09-29T16:00:00.000Z', '2026-09-30T16:00:00.000Z']);
  assert.deepEqual(range('yesterday'), ['2026-09-28T16:00:00.000Z', '2026-09-29T16:00:00.000Z']);
});

test('just after Malaysia midnight is already the next day', () => {
  // 00:30 on 29 Sep in Malaysia is still 28 Sep in UTC.
  assert.deepEqual(range('today', {}, Date.parse('2026-09-28T16:30:00.000Z')), [
    '2026-09-28T16:00:00.000Z',
    '2026-09-29T16:00:00.000Z',
  ]);
});

test('weeks start on Monday', () => {
  assert.deepEqual(range('this_week'), ['2026-09-27T16:00:00.000Z', '2026-10-04T16:00:00.000Z']);
  assert.deepEqual(range('last_week'), ['2026-09-20T16:00:00.000Z', '2026-09-27T16:00:00.000Z']);
  // Monday 28 Sep: the week starts that day. Sunday 4 Oct: it started six days earlier.
  assert.equal(resolvePeriod('this_week', {}, Date.parse('2026-09-28T01:00:00.000Z')).from, '2026-09-27T16:00:00.000Z');
  assert.equal(resolvePeriod('this_week', {}, Date.parse('2026-10-04T01:00:00.000Z')).from, '2026-09-27T16:00:00.000Z');
});

test('month edges follow the Malaysia calendar', () => {
  assert.deepEqual(range('this_month'), ['2026-08-31T16:00:00.000Z', '2026-09-30T16:00:00.000Z']);
  assert.deepEqual(range('last_month'), ['2026-07-31T16:00:00.000Z', '2026-08-31T16:00:00.000Z']);
  // 00:30 on 1 March in Malaysia is still February in UTC.
  const march1 = Date.parse('2026-02-28T16:30:00.000Z');
  assert.deepEqual(range('this_month', {}, march1), ['2026-02-28T16:00:00.000Z', '2026-03-31T16:00:00.000Z']);
  assert.deepEqual(range('last_month', {}, march1), ['2026-01-31T16:00:00.000Z', '2026-02-28T16:00:00.000Z']);
  // January's last month is December of the year before.
  assert.equal(resolvePeriod('last_month', {}, Date.parse('2026-01-15T04:00:00.000Z')).from, '2025-11-30T16:00:00.000Z');
});

test('rolling windows end now, like the dashboard Weekly and Monthly tabs', () => {
  assert.deepEqual(range('last_7_days'), ['2026-09-23T02:00:00.000Z', '2026-09-30T02:00:00.000Z']);
  assert.deepEqual(range('last_30_days'), ['2026-08-31T02:00:00.000Z', '2026-09-30T02:00:00.000Z']);
});

test('all_time has no bounds', () => {
  assert.deepEqual(resolvePeriod('all_time', {}, NOW), { from: null, to: null, label: 'all time' });
});

test('custom takes Malaysia dates, with to included', () => {
  assert.deepEqual(range('custom', { from: '2026-09-01', to: '2026-09-15' }), [
    '2026-08-31T16:00:00.000Z',
    '2026-09-15T16:00:00.000Z',
  ]);
  assert.deepEqual(range('custom', { from: '2026-09-29' }), ['2026-09-28T16:00:00.000Z', '2026-09-29T16:00:00.000Z']);
  assert.throws(() => resolvePeriod('custom', { from: '2026-02-30' }, NOW), /not a real date/);
  assert.throws(() => resolvePeriod('custom', { from: '29/09/2026' }, NOW), /like 2026-09-29/);
  assert.throws(() => resolvePeriod('custom', { from: '2026-09-15', to: '2026-09-01' }, NOW), /on or before/);
  assert.throws(() => resolvePeriod('custom', {}, NOW), /from must be a date/);
  assert.throws(() => resolvePeriod('fortnight', {}, NOW), /Unknown period/);
});

test('labels spell out the Malaysia-time window', () => {
  assert.equal(
    resolvePeriod('today', {}, NOW).label,
    'today (Malaysia time 2026-09-30 00:00 to 2026-10-01 00:00, end excluded)',
  );
});
```

`tools/desk-reports/http.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getReport, ReportError } from './http.mjs';

const KEY = 'k'.repeat(64);
const base = { baseUrl: 'https://backend.test', desk: 'finance', key: KEY };
const reply = (status, body) => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('sends the key header and only the params that are set', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url: String(url), init };
    return new Response('{"ok":true}', { status: 200 });
  };
  const body = await getReport({
    ...base,
    path: 'economy',
    params: { from: '2026-09-28T16:00:00.000Z', to: null, group: 'default', extra: undefined, empty: '' },
    fetchImpl,
  });
  assert.deepEqual(body, { ok: true });
  assert.equal(seen.url, 'https://backend.test/reports/finance/economy?from=2026-09-28T16%3A00%3A00.000Z&group=default');
  assert.equal(seen.init.headers['x-report-key'], KEY);
});

test('refuses to call without a real key', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
  };
  for (const key of ['', '${REPORT_KEY_FINANCE}']) {
    await assert.rejects(getReport({ ...base, key, path: 'economy', fetchImpl }), /not configured/);
  }
  assert.equal(called, false);
});

test('turns every failure into a sentence without the key in it', async () => {
  const cases = [
    [reply(400, { message: 'Unknown player group "X".' }), /Unknown player group/],
    [reply(404, { message: 'No player with username bob.' }), /No player/],
    [reply(401, { message: 'Unauthorized' }), /not set up/],
    [reply(503, { message: 'Reports are not configured for this desk.' }), /not set up/],
    [reply(429, {}), /Too many/],
    [reply(500, {}), /failed \(500\)/],
    [async () => { throw new TypeError('fetch failed'); }, /Could not reach/],
  ];
  for (const [fetchImpl, message] of cases) {
    const err = await getReport({ ...base, path: 'economy', fetchImpl }).catch((e) => e);
    assert.ok(err instanceof ReportError);
    assert.match(err.message, message);
    assert.ok(!err.message.includes(KEY));
  }
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run (from `tools/desk-reports`): `node --test`

Expected: FAIL with `Cannot find module` for `./periods.mjs` and `./http.mjs`.

- [ ] **Step 4: Implement `periods.mjs` and `http.mjs`**

`tools/desk-reports/periods.mjs`:

```js
// Report windows in Malaysia time (UTC+8, no daylight saving), the zone every
// Polycards date boundary uses. A period resolves to a half-open [from, to)
// pair of ISO instants plus a label staff can check against the dashboard.
const MYT_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const PERIODS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'last_7_days',
  'last_30_days',
  'all_time',
  'custom',
];

// Midnight, as a UTC instant, of the Malaysia day containing `ms`.
const dayStart = (ms) => Math.floor((ms + MYT_MS) / DAY_MS) * DAY_MS - MYT_MS;

// The 1st of the Malaysia month `offset` months from the one containing `ms`.
const monthStart = (ms, offset = 0) => {
  const d = new Date(ms + MYT_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1) - MYT_MS;
};

// A YYYY-MM-DD Malaysia date as the UTC instant of its midnight.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dateStart(value, name) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new Error(`${name} must be a date like 2026-09-29.`);
  }
  const ms = Date.parse(`${value}T00:00:00+08:00`);
  // V8 rolls 2026-02-30 over to March; round-tripping catches it.
  if (Number.isNaN(ms) || new Date(ms + MYT_MS).toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} is not a real date.`);
  }
  return ms;
}

const clock = (ms) => new Date(ms + MYT_MS).toISOString().slice(0, 16).replace('T', ' ');

export function resolvePeriod(period, { from, to } = {}, now = Date.now()) {
  if (period === 'all_time') return { from: null, to: null, label: 'all time' };
  const today = dayStart(now);
  const weekStart = today - ((new Date(today + MYT_MS).getUTCDay() + 6) % 7) * DAY_MS;
  const ranges = {
    today: () => [today, today + DAY_MS],
    yesterday: () => [today - DAY_MS, today],
    this_week: () => [weekStart, weekStart + 7 * DAY_MS],
    last_week: () => [weekStart - 7 * DAY_MS, weekStart],
    this_month: () => [monthStart(now), monthStart(now, 1)],
    last_month: () => [monthStart(now, -1), monthStart(now)],
    last_7_days: () => [now - 7 * DAY_MS, now],
    last_30_days: () => [now - 30 * DAY_MS, now],
    custom: () => {
      const start = dateStart(from, 'from');
      const end = dateStart(to ?? from, 'to') + DAY_MS; // `to` is included
      if (end <= start) throw new Error('from must be on or before to.');
      return [start, end];
    },
  };
  if (!Object.hasOwn(ranges, period)) throw new Error(`Unknown period ${period}.`);
  const [a, b] = ranges[period]();
  return {
    from: new Date(a).toISOString(),
    to: new Date(b).toISOString(),
    label: `${period} (Malaysia time ${clock(a)} to ${clock(b)}, end excluded)`,
  };
}
```

`tools/desk-reports/http.mjs`:

```js
// One GET against the backend's report routes. The key travels only in a
// header; every failure becomes a sentence the desk bot can pass to staff,
// and none of them contains the key.
export class ReportError extends Error {}

export async function getReport({ baseUrl, desk, key, path, params = {}, fetchImpl = fetch, timeoutMs = 15_000 }) {
  if (!key || key.startsWith('${')) {
    throw new ReportError('The report key is not configured on this PC, so live data is unavailable. Tell the admin.');
  }
  const url = new URL(`/reports/${desk}/${path}`, baseUrl);
  for (const [name, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(name, String(value));
  }
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { 'x-report-key': key, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ReportError('Could not reach the Polycards backend. Try again in a minute.');
  }
  const body = await res.json().catch(() => null);
  if (res.ok) return body;
  if (res.status === 400 || res.status === 404) {
    throw new ReportError(body?.message ?? `The backend rejected the request (${res.status}).`);
  }
  if (res.status === 401 || res.status === 503) {
    throw new ReportError('Live reports are not set up for this desk yet (the backend refused the key). Tell the admin.');
  }
  if (res.status === 429) throw new ReportError('Too many report requests. Wait a minute, then try again.');
  throw new ReportError(`The backend failed (${res.status}). Try again later.`);
}
```

- [ ] **Step 5: Run the period and HTTP specs and confirm they pass**

Run: `node --test periods.test.mjs http.test.mjs`

Expected: PASS, 11 tests.

- [ ] **Step 6: Write the failing tool and stdio specs**

`tools/desk-reports/tools.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, runTool } from './tools.mjs';

const finance = Object.fromEntries(TOOLS.finance.map((t) => [t.name, t]));
const config = { baseUrl: 'https://backend.test', desk: 'finance', key: 'k'.repeat(64) };

test('the finance desk tools', () => {
  assert.deepEqual(Object.keys(finance), ['economy']);
});

test('economy maps a period and group onto the economy route', () => {
  assert.deepEqual(finance.economy.request({ period: 'all_time', group: 'default' }), {
    path: 'economy',
    params: { from: null, to: null, group: 'default' },
    label: 'all time',
  });
});

test('runTool returns the report with its period, or the error as text', async () => {
  const ok = await runTool(finance.economy, { period: 'all_time' }, {
    ...config,
    fetchImpl: async () => new Response('{"totals":{"revenue":1}}'),
  });
  assert.ok(!ok.isError);
  assert.deepEqual(JSON.parse(ok.content[0].text), { period: 'all time', totals: { revenue: 1 } });
  const bad = await runTool(finance.economy, { period: 'custom' }, {
    ...config,
    fetchImpl: async () => assert.fail('must not call the backend'),
  });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /from must be a date/);
});
```

`tools/desk-reports/server.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio round trip: read-only tools, the key on the wire, never in stderr', async () => {
  const seen = [];
  const backend = createServer((req, res) => {
    seen.push({ url: req.url, key: req.headers['x-report-key'] });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ currency: 'MYR', totals: { revenue: 12.5 } }));
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const key = 'k'.repeat(64);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
    env: {
      ...getDefaultEnvironment(),
      REPORTS_DESK: 'finance',
      REPORTS_KEY: key,
      REPORTS_BASE_URL: `http://127.0.0.1:${backend.address().port}`,
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: 'desk-reports-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['economy']);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true);
    const result = await client.callTool({ name: 'economy', arguments: { period: 'all_time', group: 'default' } });
    assert.ok(!result.isError);
    assert.equal(JSON.parse(result.content[0].text).totals.revenue, 12.5);
    assert.deepEqual(seen, [{ url: '/reports/finance/economy?group=default', key }]);
    assert.match(stderr, /key configured: yes \(64 chars\)/);
    assert.ok(!stderr.includes(key));
  } finally {
    await client.close();
    backend.close();
  }
});
```

- [ ] **Step 7: Run them and confirm they fail**

Run: `node --test tools.test.mjs server.test.mjs`

Expected: FAIL. `tools.test.mjs` cannot find `./tools.mjs`, and the stdio test cannot start `server.mjs`.

- [ ] **Step 8: Implement `tools.mjs`, `server.mjs` and `install.mjs`**

`tools/desk-reports/tools.mjs`:

```js
import * as z from 'zod';
import { getReport } from './http.mjs';
import { PERIODS, resolvePeriod } from './periods.mjs';

// Tool arguments shared by the windowed reports.
const windowArgs = {
  period: z
    .enum(PERIODS)
    .describe(
      'Malaysia-time window. today, yesterday, this_week (Mon-Sun), last_week, this_month and last_month are calendar periods; last_7_days and last_30_days are rolling, like the dashboard Weekly and Monthly tabs; custom needs from (and optionally to).',
    ),
  from: z.string().optional().describe('custom only: first day, YYYY-MM-DD.'),
  to: z.string().optional().describe('custom only: last day, YYYY-MM-DD, included. Defaults to from.'),
};
const groupArg = {
  group: z
    .string()
    .optional()
    .describe("Player group: 'all' (default), 'default' (the DEFAULT group: players in no other group), or a group name."),
};

// A report over a period: the backend route, the resolved window, the group.
const windowed = (path) => (args) => {
  const w = resolvePeriod(args.period, args);
  return { path, params: { from: w.from, to: w.to, group: args.group }, label: w.label };
};

// Each desk's tools: MCP metadata plus how the arguments become one request.
export const TOOLS = {
  finance: [
    {
      name: 'economy',
      description:
        'Money totals exactly like the admin Economy page, for one Malaysia-time window and player group. revenue = credits spent on packs; payouts = buybacks paid; net = revenue - payouts (the gacha margin); topups = deposits credited; cashout = withdrawals; adjustments = admin credit changes; deliveryFees; referralCommission; rewardPromo = promo credits. Also the current vault and voucher liability for ALL players. Amounts in RM (MYR).',
      inputSchema: { ...windowArgs, ...groupArg },
      request: windowed('economy'),
    },
  ],
};

// Runs one tool call; failures come back as text the bot can relay.
export async function runTool(tool, args, config) {
  try {
    const { path, params, label } = tool.request(args);
    const body = await getReport({ ...config, path, params });
    const text = JSON.stringify(label ? { period: label, ...body } : body, null, 2);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
  }
}
```

`tools/desk-reports/server.mjs`:

```js
#!/usr/bin/env node
// MCP stdio server for one Polycards staff desk (spec
// docs/superpowers/specs/2026-09-29-desk-reports-design.md). Hermes starts it
// with REPORTS_DESK, REPORTS_BASE_URL and REPORTS_KEY (the desk's key,
// interpolated from the profile's .env); it exposes that desk's read-only
// report tools.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOLS, runTool } from './tools.mjs';

const desk = process.env.REPORTS_DESK ?? '';
const config = {
  desk,
  baseUrl: process.env.REPORTS_BASE_URL || 'https://admin.polycards.gg',
  key: process.env.REPORTS_KEY ?? '',
};
if (!Object.hasOwn(TOOLS, desk)) {
  console.error(`desk-reports: unknown REPORTS_DESK "${desk}"`);
  process.exit(1);
}
// stdout is the MCP channel. This line goes to stderr, which Hermes logs: it
// proves the key arrived without printing it.
const configured = config.key.length >= 32 && !config.key.startsWith('${');
console.error(
  `desk-reports: desk ${desk}, backend ${config.baseUrl}, key configured: ${configured ? 'yes' : 'no'} (${config.key.length} chars)`,
);

const server = new McpServer({ name: `polycards-${desk}-reports`, version: '1.0.0' });
for (const tool of TOOLS[desk]) {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => runTool(tool, args, config),
  );
}
await server.connect(new StdioServerTransport());
```

`tools/desk-reports/install.mjs`:

```js
// Copies the desk-reports MCP server to the Hermes ops folder and installs its
// two dependencies there, so the desk bots never run code from a git checkout
// whose branch can change under them. Usage: node tools/desk-reports/install.mjs
import { cpSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(process.env.LOCALAPPDATA, 'hermes', 'ops', 'desk-reports');
mkdirSync(target, { recursive: true });
for (const file of ['package.json', 'server.mjs', 'tools.mjs', 'http.mjs', 'periods.mjs']) {
  cpSync(join(here, file), join(target, file));
}
// npm is npm.cmd on Windows, which needs a shell to start.
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: target,
  stdio: 'inherit',
  shell: true,
});
console.log(`installed to ${target}`);
```

- [ ] **Step 9: Run every MCP spec and confirm they pass**

Run (from `tools/desk-reports`): `node --test`

Expected: PASS, 15 tests.

Then run root lint on the folder (from the worktree root): `node ../../../node_modules/eslint/bin/eslint.js tools/desk-reports`

Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add tools/desk-reports
git commit -m "feat(reports): desk-reports MCP server with the Finance economy tool

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the Finance desk in Hermes (outside git)

This task changes files on the PC, outside the repo. Nothing here reaches production. The finance tool will answer "not configured" until Task 10 provisions the key; that is expected.

**Files:**
- Modify: `%LOCALAPPDATA%\hermes\ops\discord\desks.json`
- Modify: `%LOCALAPPDATA%\hermes\ops\discord\discord-desks.mjs`: `cmdHermes` near line 689, `cmdAudit` near line 631, and a new `hermesServers` helper after `hermesGet` near line 611
- Modify: `%LOCALAPPDATA%\hermes\profiles\polycards-finance\SOUL.md`
- Create (by script): `%LOCALAPPDATA%\hermes\ops\desk-reports\`

**Interfaces:**
- Consumes: `tools/desk-reports/install.mjs` and `server.mjs` from Task 3.
- Produces:
  - `desks.json` gives each desk its own `tools` list, and finance also gets `"reports": true`.
  - For the finance profile:
    - `mcp_servers.polycards_finance` = `{ command, args, env: { REPORTS_BASE_URL, REPORTS_DESK, REPORTS_KEY: "${REPORT_KEY_FINANCE}" }, trust: "untrusted" }`;
    - `platform_toolsets.discord` = `vision, clarify, todo, polycards_finance`.

- [ ] **Step 1: Record the current Discord toolsets**

Run (Git Bash):

```bash
cd "$LOCALAPPDATA/hermes" && for p in growth support finance store developer; do printf "%s: " $p; ./bin/hermes.exe -p polycards-$p config get platform_toolsets.discord 2>/dev/null | tr -d ' \r' | tr '\n' ' '; echo; done
```

Expected, matching `hermes-discord-desks.md`:
- growth: `-web -vision -image_gen -clarify -todo`;
- support, store and developer: `-web -vision -clarify -todo`;
- finance: `-vision -clarify -todo`.

If the output differs, stop and report it to the operator.

- [ ] **Step 2: Add per-desk tools and the finance report flag to `desks.json`**

Edit each desk object in `desks.json`, keeping every existing field:
- growth: add `"tools": ["web", "vision", "image_gen", "clarify", "todo"]`;
- support: add `"tools": ["web", "vision", "clarify", "todo"]`;
- finance: add `"tools": ["vision", "clarify", "todo"], "reports": true`;
- store: add `"tools": ["web", "vision", "clarify", "todo"]`;
- developer: add `"tools": ["web", "vision", "clarify", "todo"]`.

- [ ] **Step 3: Make `cmdHermes` set each desk's tools and the report server**

In `discord-desks.mjs`, directly under `const HERMES_EXE = join(HERMES_HOME, "bin", "hermes.exe");` add:

```js
// The desk-reports MCP server, installed from the repo by tools/desk-reports/install.mjs.
const DESK_REPORTS_SERVER = join(HERMES_HOME, "ops", "desk-reports", "server.mjs");
```

In `cmdHermes`, directly after the closing `];` of the `const settings = [` array and before `for (const [k, v] of settings) hermesSet(d.profile, k, v);`, add:

```js
    // Tools: exactly this desk's list, plus its live-data report server when
    // desks.json says so (spec 2026-09-29 desk reports). Set key by key, so
    // `config set` never has to parse a nested object. The key stays a
    // ${VAR} placeholder, resolved by Hermes from the profile's .env.
    const deskName = d.profile.replace(/^polycards-/, "");
    const reportTool = `polycards_${deskName}`;
    settings.push([
      "platform_toolsets.discord",
      JSON.stringify([...d.tools, ...(d.reports ? [reportTool] : [])]),
    ]);
    if (d.reports) {
      const base = `mcp_servers.${reportTool}`;
      settings.push(
        [`${base}.command`, process.execPath],
        [`${base}.args`, JSON.stringify([DESK_REPORTS_SERVER])],
        [`${base}.env.REPORTS_BASE_URL`, "https://admin.polycards.gg"],
        [`${base}.env.REPORTS_DESK`, deskName],
        [`${base}.env.REPORTS_KEY`, `\${REPORT_KEY_${deskName.toUpperCase()}}`],
        [`${base}.trust`, "untrusted"],
      );
    }
```

- [ ] **Step 4: Make the audit per-desk**

After the `hermesGet` function, add:

```js
// Names of a profile's MCP servers: the top-level keys that
// `config get mcp_servers` prints ([] when none are set, which exits 1).
async function hermesServers(profile) {
  try {
    const { stdout } = await promisify(execFile)(HERMES_EXE, ["-p", profile, "config", "get", "mcp_servers"]);
    return stdout
      .split(/\r?\n/)
      .filter((l) => /^[A-Za-z0-9_-]+:/.test(l))
      .map((l) => l.split(":")[0]);
  } catch {
    return [];
  }
}
```

In `cmdAudit`, directly after the closing `};` of `const want = {`, add:

```js
    // Tools and report server: exactly what desks.json grants this desk.
    const deskName = d.profile.replace(/^polycards-/, "");
    const reportTool = `polycards_${deskName}`;
    want["platform_toolsets.discord"] = [...d.tools, ...(d.reports ? [reportTool] : [])];
    if (d.reports) {
      const base = `mcp_servers.${reportTool}`;
      want[`${base}.trust`] = ["untrusted"];
      want[`${base}.env.REPORTS_DESK`] = [deskName];
      want[`${base}.env.REPORTS_KEY`] = [`\${REPORT_KEY_${deskName.toUpperCase()}}`];
    }
```

Then replace:

```js
    const unsafe = tools.filter((x) => !SAFE_TOOLS.includes(x));
```

with:

```js
    const unsafe = tools.filter((x) => !SAFE_TOOLS.includes(x) && !(d.reports && x === reportTool));
    const servers = await hermesServers(d.profile);
    const wantServers = d.reports ? [reportTool] : [];
    if (!same(servers, wantServers)) bad.push(`MCP servers are [${servers}], expected [${wantServers}]`);
```

- [ ] **Step 5: Add the report rule to the Finance SOUL**

In `%LOCALAPPDATA%\hermes\profiles\polycards-finance\SOUL.md`, add this line directly after the existing line that begins `- You have no calculator, code or web tool`:

```markdown
- For live Polycards numbers (economy totals, daily totals, payments, pack sales, groups, one player's account) call your polycards_finance report tools. Never estimate, never reuse an older answer, and never ask staff for a screenshot when a tool can answer. Every answer states the window in Malaysia time and the player group it covers; group figures use each player's current group. Money is RM (MYR).
```

- [ ] **Step 6: Install the MCP server and apply the Hermes settings**

1. From the worktree root, run: `node tools/desk-reports/install.mjs`
   - Expected: npm output, then `installed to C:\Users\PC\AppData\Local\hermes\ops\desk-reports`.
2. From `%LOCALAPPDATA%\hermes\ops\discord`, run: `node discord-desks.mjs hermes`
   - Expected: one `configured polycards-<desk>: …` line per desk.

- [ ] **Step 7: Check the stored config and its printed format**

```bash
cd "$LOCALAPPDATA/hermes" && ./bin/hermes.exe -p polycards-finance config get mcp_servers 2>/dev/null
```

Expected: a YAML block whose only top-level key is `polycards_finance:`, with `command`, `args`, `env` (`REPORTS_KEY: ${REPORT_KEY_FINANCE}`) and `trust: untrusted`.
- If it prints JSON instead, change the `hermesServers` filter to `Object.keys(JSON.parse(stdout))`.
- If `trust` is missing or `env` came out as one string, stop and report it.

- [ ] **Step 8: Restart the gateway (operator OK) and verify every profile**

1. Ask the operator for OK to restart. A restart interrupts any active desk session.
2. Check each desk's `%LOCALAPPDATA%\hermes\profiles\polycards-<desk>\logs\agent.log` for activity in the last 5 minutes. Wait if there is any.
3. Then run: `cd "$LOCALAPPDATA/hermes" && ./bin/hermes.exe gateway restart`
4. After about 30 seconds, run:

```bash
cd "$LOCALAPPDATA/hermes" && for p in growth support finance store developer; do echo "== $p"; ./bin/hermes.exe -p polycards-$p tools --summary 2>/dev/null | sed -n '/Discord/,$p'; done
grep -rh "desk-reports:" "$LOCALAPPDATA/hermes/profiles/polycards-finance/logs" | tail -2
cd "$LOCALAPPDATA/hermes/ops/discord" && node discord-desks.mjs audit
```

Expected:
- Only finance lists the `polycards_finance` MCP tools under Discord. The other four show exactly their `desks.json` tools.
- The log line reads `desk-reports: desk finance, backend https://admin.polycards.gg, key configured: no (21 chars)`. The key comes in Task 10.
- The audit prints `ALL CHECKS PASSED`.

- [ ] **Step 9: Record the result**

No commit: none of these files are in git. Add one line to the memory file `hermes-discord-desks.md` saying:
- Finance has the `polycards_finance` MCP server (desk-reports);
- `desks.json` now carries per-desk `tools`;
- the audit checks MCP servers per desk.

---

### Task 5: Daily economy route and tool

**Files:**
- Modify: `backend/packages/api/src/api/reports/finance/queries.ts` (append `ledgerTotalsByDay`)
- Create: `backend/packages/api/src/api/reports/finance/daily/route.ts`
- Modify: `backend/packages/api/integration-tests/http/desk-reports.spec.ts` (add a `describe`)
- Modify: `tools/desk-reports/tools.mjs`, `tools.test.mjs`, `server.test.mjs`

**Interfaces:**
- Consumes: `and`, `scopeFilter`, `windowFilter`, `reportDb` (`sql.ts`); `parseWindow`, `loadGroupScope`, `describeScope` (`params.ts`); `foldTotals`, `ReasonCents` (`queries.ts`).
- Produces:
  - `ledgerTotalsByDay(db, filter: SqlPart): Promise<Array<{ day: string; totals: LedgerTotals }>>`;
  - `GET /reports/finance/daily` → `{ currency, window, scope, days }`;
  - the MCP tool `daily_economy`.

- [ ] **Step 1: Write the failing integration test**

Add inside `testSuite` in `desk-reports.spec.ts`, after the economy `describe`:

```ts
    describe('GET /reports/finance/daily', () => {
      it('buckets totals by Malaysia calendar day', async () => {
        const rows = await opens([
          ['cus_day', 10],
          ['cus_day', 20],
          ['cus_day', 40],
        ]);
        // 23:30 MYT on the 28th, 00:30 MYT on the 29th, and outside the window.
        await backdate('credit_transaction', rows[0].id, '2026-09-28T15:30:00.000Z');
        await backdate('credit_transaction', rows[1].id, '2026-09-28T16:30:00.000Z');
        await backdate('credit_transaction', rows[2].id, '2026-09-26T04:00:00.000Z');
        const res = await report(
          'daily?from=2026-09-27T16:00:00.000Z&to=2026-09-29T16:00:00.000Z',
        );
        expect(res.status).toBe(200);
        expect(
          res.data.days.map((d: { day: string; totals: { revenue: number } }) => [
            d.day,
            d.totals.revenue,
          ]),
        ).toEqual([
          ['2026-09-28', 10],
          ['2026-09-29', 20],
        ]);
      });

      it('needs both bounds and at most 93 days', async () => {
        expect((await report('daily?from=2026-09-01T00:00:00.000Z')).status).toBe(400);
        expect(
          (await report('daily?from=2026-01-01T00:00:00.000Z&to=2026-06-01T00:00:00.000Z'))
            .status,
        ).toBe(400);
      });
    });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack yarn test:integration:http desk-reports.spec`

Expected: the two daily tests FAIL with 404.

- [ ] **Step 3: Implement the query and the route**

Append to `finance/queries.ts`:

```ts
/** Ledger totals per Malaysia calendar day, oldest first; a day with no
 *  ledger rows is left out. */
export async function ledgerTotalsByDay(
  db: ReportDb,
  filter: SqlPart,
): Promise<Array<{ day: string; totals: LedgerTotals }>> {
  const { rows } = await db.raw<ReasonCents & { day: string }>(
    "SELECT to_char(ct.created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS day, " +
      'ct.reason, COALESCE(SUM(ROUND(ct.amount * 100)), 0)::bigint AS cents ' +
      'FROM credit_transaction ct WHERE ct.deleted_at IS NULL' +
      filter.sql +
      ' GROUP BY 1, 2 ORDER BY 1',
    filter.params,
  );
  const byDay = new Map<string, ReasonCents[]>();
  for (const r of rows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  return [...byDay].map(([day, dayRows]) => ({ day, totals: foldTotals(dayRows) }));
}
```

`backend/packages/api/src/api/reports/finance/daily/route.ts`:

```ts
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { describeScope, loadGroupScope, parseWindow } from '../../params';
import { and, reportDb, scopeFilter, windowFilter } from '../../sql';
import { ledgerTotalsByDay } from '../queries';

// GET /reports/finance/daily: the economy totals per Malaysia calendar day.
// Both bounds are required and the window is capped, so one call cannot scan
// the whole ledger day by day.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const window = parseWindow(req.query, { required: true, maxDays: 93 });
  const scope = await loadGroupScope(req);
  const days = await ledgerTotalsByDay(
    reportDb(req),
    and(
      windowFilter(window, 'ct.created_at'),
      scopeFilter(scope, 'ct.customer_id'),
    ),
  );
  res.json({
    currency: 'MYR',
    window: { from: window.from, to: window.to },
    scope: describeScope(scope),
    days,
  });
}
```

- [ ] **Step 4: Add the MCP tool (test first)**

In `tools.test.mjs`, change the expected names to `['economy', 'daily_economy']` and add:

```js
test('daily_economy maps onto the daily route', () => {
  const r = finance.daily_economy.request({ period: 'custom', from: '2026-09-01', to: '2026-09-07' });
  assert.equal(r.path, 'daily');
  assert.deepEqual(r.params, { from: '2026-08-31T16:00:00.000Z', to: '2026-09-07T16:00:00.000Z', group: undefined });
});
```

In `server.test.mjs`, change the expected tool list to `['economy', 'daily_economy']`.

Run `node --test` in `tools/desk-reports`. Expected: FAIL on the tool list.

Then add to `TOOLS.finance` in `tools.mjs`, after `economy`:

```js
    {
      name: 'daily_economy',
      description:
        'The same totals as economy, split per Malaysia calendar day (days with no activity are left out). The window must be 93 days or less; all_time is not allowed.',
      inputSchema: { ...windowArgs, ...groupArg },
      request: windowed('daily'),
    },
```

- [ ] **Step 5: Run everything and confirm it passes**

Run, in order:

1. From `backend/packages/api`: `corepack yarn test:integration:http desk-reports.spec`
   - Expected: PASS, 9 tests.
2. From `backend/packages/api`: `corepack yarn check-types`
   - Expected: exit 0.
3. From `tools/desk-reports`: `node --test`
   - Expected: PASS, 16 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/packages/api/src/api/reports backend/packages/api/integration-tests/http/desk-reports.spec.ts tools/desk-reports
git commit -m "feat(reports): daily economy report and tool

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Payments route and tool

**Files:**
- Modify: `backend/packages/api/src/api/reports/finance/queries.ts` (append `statusTotals`)
- Create: `backend/packages/api/src/api/reports/finance/payments/route.ts`
- Modify: `backend/packages/api/integration-tests/http/desk-reports.spec.ts`
- Modify: `tools/desk-reports/tools.mjs`, `tools.test.mjs`, `server.test.mjs`

**Interfaces:**
- Consumes: `DEPOSIT_STATUSES` (`modules/packs/models/gateway-deposit.ts`), `WITHDRAWAL_STATUSES` (`modules/packs/models/gateway-withdrawal.ts`), and the `sql.ts` helpers.
- Produces:
  - `type StatusTotals = { count: number; requested: number; settled: number }`;
  - `statusTotals(db, kind: 'deposits' | 'withdrawals', statuses: readonly string[], filter: SqlPart): Promise<Record<string, StatusTotals>>`, which filters on alias `g`;
  - `GET /reports/finance/payments` → `{ currency, window, scope, deposits: { by_status, open_now }, withdrawals: { by_status, open_now } }`.
  - The player route (Task 8) reuses `statusTotals`.

- [ ] **Step 1: Write the failing integration test**

Add inside `testSuite`:

```ts
    describe('GET /reports/finance/payments', () => {
      it('counts deposits and withdrawals by status, scoped by group, plus what is open now', async () => {
        const c = customers();
        const plain = (await c.createCustomers({ email: 'dr-pay-plain@test.dev' })).id;
        const partner = (await c.createCustomers({ email: 'dr-pay-partner@test.dev' })).id;
        const partners = await c.createCustomerGroups({ name: 'Partners' });
        await c.addCustomerToGroup({ customer_id: partner, customer_group_id: partners.id });
        const deposit = (
          customer_id: string,
          n: string,
          status: 'pending' | 'settled' | 'failed',
          requested: number,
          settled: number | null = null,
        ) => ({
          merchant_transaction_id: `dr-dep-${n}`,
          customer_id,
          amount_requested: requested,
          amount_settled: settled,
          payment_method_code: 'BQR',
          status,
        });
        const deposits = await packs().createGatewayDeposits([
          deposit(plain, '1', 'settled', 100, 100),
          deposit(plain, '2', 'pending', 50),
          deposit(plain, '3', 'failed', 20),
          deposit(partner, '4', 'settled', 70, 70),
          deposit(plain, '5', 'pending', 15), // old: outside the window, still open
        ]);
        await backdate('gateway_deposit', deposits[4].id, '2026-01-10T00:00:00.000Z');
        const withdrawal = (
          customer_id: string,
          n: string,
          status: 'pending' | 'settled' | 'held',
          amount: number,
          settled: number | null = null,
        ) => ({
          merchant_transaction_id: `dr-wd-${n}`,
          customer_id,
          amount,
          amount_settled: settled,
          bank_code: 'MBB',
          account_number: '1234567890',
          account_holder_name: 'Test Person',
          status,
        });
        await packs().createGatewayWithdrawals([
          withdrawal(plain, '1', 'held', 30),
          withdrawal(plain, '2', 'pending', 40),
          withdrawal(plain, '3', 'settled', 60, 60),
          withdrawal(partner, '4', 'held', 90),
        ]);

        const since = 'from=2026-06-01T00:00:00.000Z';
        const all = await report(`payments?${since}`);
        expect(all.status).toBe(200);
        expect(all.data.deposits.by_status).toEqual({
          pending: { count: 1, requested: 50, settled: 0 },
          settled: { count: 2, requested: 170, settled: 170 },
          failed: { count: 1, requested: 20, settled: 0 },
          expired: { count: 0, requested: 0, settled: 0 },
        });
        expect(all.data.deposits.open_now).toEqual({
          pending: { count: 2, requested: 65, settled: 0 },
        });
        expect(all.data.withdrawals.open_now).toEqual({
          pending: { count: 1, requested: 40, settled: 0 },
          held: { count: 2, requested: 120, settled: 0 },
        });
        expect(JSON.stringify(all.data)).not.toContain('1234567890');

        const scoped = await report(`payments?${since}&group=default`);
        expect(scoped.data.deposits.by_status.settled).toEqual({
          count: 1,
          requested: 100,
          settled: 100,
        });
        expect(scoped.data.withdrawals.by_status.held).toEqual({
          count: 1,
          requested: 30,
          settled: 0,
        });
      });
    });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack yarn test:integration:http desk-reports.spec`

Expected: the payments test FAILS with 404.

- [ ] **Step 3: Implement the query and the route**

Append to `finance/queries.ts`:

```ts
export type StatusTotals = { count: number; requested: number; settled: number };

// Table and requested-amount column per gateway flow. Withdrawals are
// requested on `amount` (the debit basis); both record `amount_settled`.
const GATEWAY = {
  deposits: { table: 'gateway_deposit', requested: 'amount_requested' },
  withdrawals: { table: 'gateway_withdrawal', requested: 'amount' },
} as const;

/** Count and requested/settled sums per status over rows (alias g) matching
 *  `filter` and in `statuses`; every listed status is present, zero when
 *  empty. Never selects the bank account columns. */
export async function statusTotals(
  db: ReportDb,
  kind: keyof typeof GATEWAY,
  statuses: readonly string[],
  filter: SqlPart,
): Promise<Record<string, StatusTotals>> {
  const { table, requested } = GATEWAY[kind];
  const { rows } = await db.raw<{
    status: string;
    n: string;
    requested_cents: string;
    settled_cents: string;
  }>(
    'SELECT g.status, COUNT(*)::bigint AS n, ' +
      `COALESCE(SUM(ROUND(g.${requested} * 100)), 0)::bigint AS requested_cents, ` +
      'COALESCE(SUM(ROUND(g.amount_settled * 100)), 0)::bigint AS settled_cents ' +
      `FROM ${table} g WHERE g.deleted_at IS NULL ` +
      `AND g.status IN (${statuses.map(() => '?').join(', ')})` +
      filter.sql +
      ' GROUP BY g.status',
    [...statuses, ...filter.params],
  );
  const found = new Map(rows.map((r) => [r.status, r]));
  return Object.fromEntries(
    statuses.map((status) => {
      const r = found.get(status);
      return [
        status,
        {
          count: Number(r?.n ?? 0),
          requested: Number(r?.requested_cents ?? 0) / 100,
          settled: Number(r?.settled_cents ?? 0) / 100,
        },
      ];
    }),
  );
}
```

`backend/packages/api/src/api/reports/finance/payments/route.ts`:

```ts
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { DEPOSIT_STATUSES } from '../../../../modules/packs/models/gateway-deposit';
import { WITHDRAWAL_STATUSES } from '../../../../modules/packs/models/gateway-withdrawal';
import { describeScope, loadGroupScope, parseWindow } from '../../params';
import { and, reportDb, scopeFilter, windowFilter } from '../../sql';
import { statusTotals } from '../queries';

// GET /reports/finance/payments: gateway deposits and withdrawals CREATED in
// the window, per status, plus what is open right now whatever the window
// (pending deposits; pending and admin-held withdrawals).
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const window = parseWindow(req.query);
  const scope = await loadGroupScope(req);
  const db = reportDb(req);
  const inScope = scopeFilter(scope, 'g.customer_id');
  const inWindow = and(windowFilter(window, 'g.created_at'), inScope);
  res.json({
    currency: 'MYR',
    window: { from: window.from ?? null, to: window.to ?? null },
    scope: describeScope(scope),
    deposits: {
      by_status: await statusTotals(db, 'deposits', DEPOSIT_STATUSES, inWindow),
      open_now: await statusTotals(db, 'deposits', ['pending'], inScope),
    },
    withdrawals: {
      by_status: await statusTotals(db, 'withdrawals', WITHDRAWAL_STATUSES, inWindow),
      open_now: await statusTotals(db, 'withdrawals', ['pending', 'held'], inScope),
    },
  });
}
```

- [ ] **Step 4: Add the MCP tool (test first)**

In `tools.test.mjs` and `server.test.mjs`, change the expected names to `['economy', 'daily_economy', 'payments']`.

Run `node --test` in `tools/desk-reports`. Expected: FAIL on the tool list.

Then add to `TOOLS.finance` in `tools.mjs`:

```js
    {
      name: 'payments',
      description:
        'Payment-gateway deposits and withdrawals created in the window, counted and summed per status (pending, settled, failed, expired; withdrawals also held = waiting for admin approval), plus what is open right now whatever the window. Amounts in RM (MYR).',
      inputSchema: { ...windowArgs, ...groupArg },
      request: windowed('payments'),
    },
```

- [ ] **Step 5: Run everything and confirm it passes**

Run, in order:

1. From `backend/packages/api`: `corepack yarn test:integration:http desk-reports.spec`
   - Expected: PASS, 10 tests.
2. From `backend/packages/api`: `corepack yarn check-types`
   - Expected: exit 0.
3. From `tools/desk-reports`: `node --test`
   - Expected: PASS, 16 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/packages/api/src/api/reports backend/packages/api/integration-tests/http/desk-reports.spec.ts tools/desk-reports
git commit -m "feat(reports): payments report and tool

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Pack-sales route and tool

**Files:**
- Modify: `backend/packages/api/src/api/reports/finance/queries.ts` (append `packSales`)
- Create: `backend/packages/api/src/api/reports/finance/pack-sales/route.ts`
- Modify: `backend/packages/api/integration-tests/http/desk-reports.spec.ts`
- Modify: `tools/desk-reports/tools.mjs`, `tools.test.mjs`, `server.test.mjs`

**Interfaces:**
- Consumes: the `sql.ts` helpers; `PacksModuleService.listPacks` for titles.
- Produces:
  - `packSales(db, ledger: SqlPart, pulls: SqlPart): Promise<{ bySlug: Map<string, { opened: number; cents: number }>; unattributedCents: number }>`. `ledger` filters alias `ct`; `pulls` filters alias `p`.
  - `GET /reports/finance/pack-sales` → `{ currency, window, scope, packs: [{ pack, title, packs_opened, revenue }], unattributed_revenue, total_revenue }`.

- [ ] **Step 1: Write the failing integration test**

Add inside `testSuite`:

```ts
    describe('GET /reports/finance/pack-sales', () => {
      it('attributes revenue to packs through open_id and sums to economy revenue', async () => {
        const pack = (slug: string, title: string, rank: number) => ({
          slug,
          title,
          category: 'pokemon',
          price: 20,
          image: '/qa.png',
          status: 'active' as const,
          rank,
        });
        await packs().createPacks([
          pack('dr-alpha', 'Alpha Pack', 0),
          pack('dr-beta', 'Beta Pack', 1),
        ]);
        const pull = (
          open_id: string | null,
          pack_id: string,
          source: 'pack' | 'free' = 'pack',
        ) => ({
          customer_id: 'cus_sales',
          pack_id,
          card_id: 'dr-card',
          status: 'vaulted' as const,
          rolled_at: new Date(),
          open_id,
          source,
        });
        await packs().createPulls([
          pull('open-a', 'dr-alpha'), // one batch open of two packs
          pull('open-a', 'dr-alpha'),
          pull('open-b', 'dr-beta'),
          pull(null, 'dr-alpha', 'free'), // a free pack is not a sale
        ]);
        const charge = (amount: number, source_transaction_id: string | null) => ({
          customer_id: 'cus_sales',
          amount,
          reason: 'pack_open' as const,
          source_transaction_id,
        });
        await packs().createCreditTransactions([
          charge(-40, 'open-a'),
          charge(-20, 'open-b'),
          charge(-20, 'open-c'), // an open that failed: charged, then reversed,
          charge(20, 'open-c'), // with no pulls
          charge(-5, null), // a row from before open_id existed
        ]);
        const res = await report('pack-sales');
        expect(res.status).toBe(200);
        expect(res.data.packs).toEqual([
          { pack: 'dr-alpha', title: 'Alpha Pack', packs_opened: 2, revenue: 40 },
          { pack: 'dr-beta', title: 'Beta Pack', packs_opened: 1, revenue: 20 },
        ]);
        expect(res.data.unattributed_revenue).toBe(5);
        expect(res.data.total_revenue).toBe(65);
        expect((await report('economy')).data.totals.revenue).toBe(65);
      });
    });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack yarn test:integration:http desk-reports.spec`

Expected: the pack-sales test FAILS with 404.

- [ ] **Step 3: Implement the query and the route**

Append to `finance/queries.ts`:

```ts
/**
 * Pack sales: revenue per pack from pack_open ledger rows (alias ct,
 * filtered by `ledger`), linked to a pack through the open's pulls
 * (credit_transaction.source_transaction_id = pull.open_id). Packs opened =
 * paid pulls (alias p, filtered by `pulls`). A charge with no linked pull
 * (rows from before open_id, or an open that never produced pulls) is
 * unattributed, so every pack plus unattributed equals economy revenue.
 * ponytail: the DISTINCT scans pull.open_id, which has no index; fine at
 * report frequency. Add an index on pull(open_id) if this reaches slow logs.
 */
export async function packSales(
  db: ReportDb,
  ledger: SqlPart,
  pulls: SqlPart,
): Promise<{
  bySlug: Map<string, { opened: number; cents: number }>;
  unattributedCents: number;
}> {
  const revenue = await db.raw<{ pack_id: string | null; cents: string }>(
    'SELECT op.pack_id, COALESCE(SUM(ROUND(ct.amount * 100)), 0)::bigint AS cents ' +
      'FROM credit_transaction ct ' +
      'LEFT JOIN (SELECT DISTINCT open_id, pack_id FROM pull ' +
      'WHERE open_id IS NOT NULL AND deleted_at IS NULL) op ' +
      'ON op.open_id = ct.source_transaction_id ' +
      "WHERE ct.deleted_at IS NULL AND ct.reason = 'pack_open'" +
      ledger.sql +
      ' GROUP BY op.pack_id',
    ledger.params,
  );
  const opened = await db.raw<{ pack_id: string; n: string }>(
    'SELECT p.pack_id, COUNT(*)::bigint AS n FROM pull p ' +
      "WHERE p.deleted_at IS NULL AND p.source = 'pack'" +
      pulls.sql +
      ' GROUP BY p.pack_id',
    pulls.params,
  );
  const bySlug = new Map<string, { opened: number; cents: number }>();
  let unattributedCents = 0;
  for (const r of revenue.rows) {
    // Ledger rows are negative for a charge; revenue reads positive.
    const cents = -Number(r.cents);
    if (r.pack_id === null) unattributedCents += cents;
    else bySlug.set(r.pack_id, { opened: 0, cents });
  }
  for (const r of opened.rows) {
    const row = bySlug.get(r.pack_id) ?? { opened: 0, cents: 0 };
    bySlug.set(r.pack_id, { ...row, opened: Number(r.n) });
  }
  return { bySlug, unattributedCents };
}
```

`backend/packages/api/src/api/reports/finance/pack-sales/route.ts`:

```ts
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { describeScope, loadGroupScope, parseWindow } from '../../params';
import { and, reportDb, scopeFilter, windowFilter } from '../../sql';
import { packSales } from '../queries';

// GET /reports/finance/pack-sales: per-pack packs opened and revenue in the
// window, largest revenue first, plus the unattributed remainder, so the
// packs plus unattributed equal economy revenue for the same window.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const window = parseWindow(req.query);
  const scope = await loadGroupScope(req);
  const { bySlug, unattributedCents } = await packSales(
    reportDb(req),
    and(windowFilter(window, 'ct.created_at'), scopeFilter(scope, 'ct.customer_id')),
    and(windowFilter(window, 'p.rolled_at'), scopeFilter(scope, 'p.customer_id')),
  );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const slugs = [...bySlug.keys()];
  const titles = new Map(
    slugs.length === 0
      ? []
      : (await packs.listPacks({ slug: slugs }, { take: slugs.length })).map(
          (p) => [p.slug, p.title],
        ),
  );
  const rows = [...bySlug]
    .map(([slug, s]) => ({
      pack: slug,
      title: titles.get(slug) ?? slug,
      packs_opened: s.opened,
      revenue: s.cents / 100,
    }))
    .sort((a, b) => b.revenue - a.revenue || a.pack.localeCompare(b.pack));
  const totalCents =
    [...bySlug.values()].reduce((sum, s) => sum + s.cents, 0) + unattributedCents;
  res.json({
    currency: 'MYR',
    window: { from: window.from ?? null, to: window.to ?? null },
    scope: describeScope(scope),
    packs: rows,
    unattributed_revenue: unattributedCents / 100,
    total_revenue: totalCents / 100,
  });
}
```

- [ ] **Step 4: Add the MCP tool (test first)**

In `tools.test.mjs` and `server.test.mjs`, change the expected names to `['economy', 'daily_economy', 'payments', 'pack_sales']`.

Run `node --test`. Expected: FAIL on the tool list.

Then add to `TOOLS.finance` in `tools.mjs`:

```js
    {
      name: 'pack_sales',
      description:
        'Per-pack sales in the window: packs opened (paid) and revenue (credits spent, net of reversals), largest first. unattributed_revenue is pack spend from older rows that cannot be linked to a pack; total_revenue equals economy revenue. Amounts in RM (MYR).',
      inputSchema: { ...windowArgs, ...groupArg },
      request: windowed('pack-sales'),
    },
```

- [ ] **Step 5: Run everything and confirm it passes**

Run, in order:

1. From `backend/packages/api`: `corepack yarn test:integration:http desk-reports.spec`
   - Expected: PASS, 11 tests.
2. From `backend/packages/api`: `corepack yarn check-types`
   - Expected: exit 0.
3. From `tools/desk-reports`: `node --test`
   - Expected: PASS, 16 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/packages/api/src/api/reports backend/packages/api/integration-tests/http/desk-reports.spec.ts tools/desk-reports
git commit -m "feat(reports): pack-sales report and tool

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Player route and tool

**Files:**
- Create: `backend/packages/api/src/api/reports/finance/player/route.ts`
- Modify: `backend/packages/api/integration-tests/http/desk-reports.spec.ts`
- Modify: `tools/desk-reports/tools.mjs`, `tools.test.mjs`, `server.test.mjs`

**Interfaces:**
- Consumes:
  - `isValidUsername` (`src/utils/profile-handle.ts`);
  - `findCustomerIdByUsername`, `disabledCustomerIds` and `playersOverview` (packs service);
  - `effectivePlayerGroup` (`odds-sets.ts`);
  - `ledgerTotalsWhere` and `statusTotals` (`queries.ts`);
  - `customerFilter` and `and` (`sql.ts`).
- Produces: `GET /reports/finance/player?username=` → `{ currency, username, joined_at, group, disabled, balance, vault: { cards, value }, lifetime, last_30_days, deposits, withdrawals, note }`.

- [ ] **Step 1: Write the failing integration test**

Add inside `testSuite`:

```ts
    describe('GET /reports/finance/player', () => {
      it('reports one player by username, with no contact details', async () => {
        const player = await customers().createCustomers({
          email: 'dr-player@test.dev',
          first_name: 'Ace_Puller',
          last_name: 'Private',
          phone: '+60123456789',
        });
        await packs().createCreditTransactions([
          { customer_id: player.id, amount: 100, reason: 'topup' as const },
          { customer_id: player.id, amount: -30, reason: 'pack_open' as const },
        ]);
        await packs().createGatewayDeposits([
          {
            merchant_transaction_id: 'dr-player-dep',
            customer_id: player.id,
            amount_requested: 100,
            amount_settled: 100,
            payment_method_code: 'BQR',
            status: 'settled' as const,
          },
        ]);
        const res = await report('player?username=ace_puller');
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({
          currency: 'MYR',
          username: 'Ace_Puller',
          group: 'DEFAULT',
          disabled: false,
          balance: 70,
          vault: { cards: 0, value: 0 },
          lifetime: { topups: 100, revenue: 30 },
          last_30_days: { topups: 100, revenue: 30 },
        });
        expect(res.data.deposits.settled).toEqual({
          count: 1,
          requested: 100,
          settled: 100,
        });
        const body = JSON.stringify(res.data);
        expect(body).not.toContain('@');
        expect(body).not.toContain('60123456789');
        expect(body).not.toContain('Private');
      });

      it('answers 404 for an unknown username and 400 for a malformed one', async () => {
        expect((await report('player?username=nobody_here')).status).toBe(404);
        expect((await report('player?username=a')).status).toBe(400);
      });
    });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack yarn test:integration:http desk-reports.spec`

Expected: both player tests FAIL with 404, and the 400 case is wrong too.

- [ ] **Step 3: Implement the route**

`backend/packages/api/src/api/reports/finance/player/route.ts`:

```ts
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { resolveFxRate } from '../../../../modules/packs/pricing';
import { effectivePlayerGroup } from '../../../../modules/packs/odds-sets';
import { DEPOSIT_STATUSES } from '../../../../modules/packs/models/gateway-deposit';
import { WITHDRAWAL_STATUSES } from '../../../../modules/packs/models/gateway-withdrawal';
import { isValidUsername } from '../../../../utils/profile-handle';
import { and, customerFilter, reportDb, windowFilter } from '../../sql';
import { ledgerTotalsWhere, statusTotals } from '../queries';

const DAY_MS = 24 * 60 * 60 * 1000;

// GET /reports/finance/player?username=: one player's money picture, found
// by their public username. Only id, first_name (the username) and
// created_at are read from the customer, so no contact detail can reach the
// response.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const raw = req.query.username;
  if (!isValidUsername(raw)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'username must be 3-30 letters, digits, _ or -.',
    );
  }
  const username = raw.trim();
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const id = await packs.findCustomerIdByUsername(username);
  if (!id) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `No player with username ${username}.`,
    );
  }
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const customer = await customers.retrieveCustomer(id, {
    select: ['id', 'first_name', 'created_at'],
  });
  const groups = await customers.listCustomerGroups(
    { customers: id },
    { order: { created_at: 'ASC' } },
  );
  const { wallet, vault } = await packs.playersOverview(
    [id],
    await resolveFxRate(packs),
  );
  const db = reportDb(req);
  const mine = customerFilter(id, 'ct.customer_id');
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const theirs = customerFilter(id, 'g.customer_id');
  res.json({
    currency: 'MYR',
    username: customer.first_name,
    joined_at: customer.created_at,
    group: effectivePlayerGroup(groups)?.name ?? 'DEFAULT',
    disabled: (await packs.disabledCustomerIds([id])).has(id),
    balance: (wallet.get(id)?.balanceCents ?? 0) / 100,
    vault: {
      cards: vault.get(id)?.count ?? 0,
      value: (vault.get(id)?.cents ?? 0) / 100,
    },
    lifetime: await ledgerTotalsWhere(db, mine),
    last_30_days: await ledgerTotalsWhere(
      db,
      and(windowFilter({ from: since }, 'ct.created_at'), mine),
    ),
    deposits: await statusTotals(db, 'deposits', DEPOSIT_STATUSES, theirs),
    withdrawals: await statusTotals(db, 'withdrawals', WITHDRAWAL_STATUSES, theirs),
    note: 'For one player: revenue = their pack spend, payouts = buybacks paid to them, topups = their deposits credited.',
  });
}
```

- [ ] **Step 4: Add the MCP tool (test first)**

In `tools.test.mjs` and `server.test.mjs`, change the expected names to `['economy', 'daily_economy', 'payments', 'pack_sales', 'player']`. Also add to `tools.test.mjs`:

```js
test('player asks by username only', () => {
  assert.deepEqual(finance.player.request({ username: 'Ace_Puller' }), {
    path: 'player',
    params: { username: 'Ace_Puller' },
  });
});
```

Run `node --test`. Expected: FAIL.

Then add to `TOOLS.finance` in `tools.mjs`:

```js
    {
      name: 'player',
      description:
        "One player's account by username (never email): join date, current player group, disabled flag, credit balance, vault cards and value, lifetime and last-30-days ledger totals (revenue = their pack spend, payouts = buybacks to them), and their deposits and withdrawals by status. Amounts in RM (MYR).",
      inputSchema: { username: z.string().describe('The player\'s username, as shown on their public profile.') },
      request: (args) => ({ path: 'player', params: { username: args.username } }),
    },
```

- [ ] **Step 5: Run everything and confirm it passes**

Run, in order:

1. From `backend/packages/api`: `corepack yarn test:integration:http desk-reports.spec`
   - Expected: PASS, 13 tests.
2. From `backend/packages/api`: `corepack yarn check-types`
   - Expected: exit 0.
3. From `tools/desk-reports`: `node --test`
   - Expected: PASS, 17 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/packages/api/src/api/reports backend/packages/api/integration-tests/http/desk-reports.spec.ts tools/desk-reports
git commit -m "feat(reports): player report and tool

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Groups route, tool and the live partition check

**Files:**
- Modify: `backend/packages/api/src/api/reports/finance/queries.ts` (append `groupSizes`)
- Create: `backend/packages/api/src/api/reports/finance/groups/route.ts`
- Modify: `backend/packages/api/integration-tests/http/desk-reports.spec.ts`
- Modify: `tools/desk-reports/tools.mjs`, `tools.test.mjs`, `server.test.mjs`
- Create: `tools/desk-reports/live-check.mjs`

**Interfaces:**
- Consumes: `EFFECTIVE_GROUP_SQL` (`sql.ts`), `isDefaultPlayerGroup` (`odds-sets.ts`).
- Produces:
  - `groupSizes(db): Promise<{ defaultPlayers: number; byGroup: Map<string, number> }>`;
  - `GET /reports/finance/groups` → `{ default_players, groups: [{ name, players }] }`;
  - the MCP tool `groups`;
  - `live-check.mjs [period]`, which exits 0 only when default + Σ named groups = all for every total.

- [ ] **Step 1: Write the failing integration test**

Add inside `testSuite`:

```ts
    describe('GET /reports/finance/groups', () => {
      it('counts players per effective group', async () => {
        await seedGroups();
        const res = await report('groups');
        expect(res.status).toBe(200);
        // nogroup, defonly, renamed, left, deadgroup
        expect(res.data.default_players).toBe(5);
        expect(res.data.groups).toEqual(
          expect.arrayContaining([
            { name: 'Partners', players: 3 },
            { name: 'Whales', players: 1 },
          ]),
        );
        const names = res.data.groups.map((g: { name: string }) => g.name);
        expect(names).not.toContain('House');
        expect(names).not.toContain('DEFAULT');
        expect(names).not.toContain('Old VIP');
      });
    });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack yarn test:integration:http desk-reports.spec`

Expected: the groups test FAILS with 404.

- [ ] **Step 3: Implement the query and the route**

In `finance/queries.ts`, change the `sql` import to `import { EFFECTIVE_GROUP_SQL, type ReportDb, type SqlPart } from '../sql';` and append:

```ts
/** Live players per effective group; players with no row are DEFAULT. */
export async function groupSizes(
  db: ReportDb,
): Promise<{ defaultPlayers: number; byGroup: Map<string, number> }> {
  const { rows } = await db.raw<{ group_id: string | null; n: string }>(
    'SELECT eff.group_id, COUNT(*)::bigint AS n FROM customer c ' +
      `LEFT JOIN (${EFFECTIVE_GROUP_SQL}) eff ON eff.customer_id = c.id ` +
      'WHERE c.deleted_at IS NULL GROUP BY eff.group_id',
  );
  let defaultPlayers = 0;
  const byGroup = new Map<string, number>();
  for (const r of rows) {
    if (r.group_id === null) defaultPlayers = Number(r.n);
    else byGroup.set(r.group_id, Number(r.n));
  }
  return { defaultPlayers, byGroup };
}
```

`backend/packages/api/src/api/reports/finance/groups/route.ts`:

```ts
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { Modules } from '@medusajs/framework/utils';
import { isDefaultPlayerGroup } from '../../../../modules/packs/odds-sets';
import { reportDb } from '../../sql';
import { groupSizes } from '../queries';

// GET /reports/finance/groups: the player groups a ?group= scope can name,
// with how many players each holds now by EFFECTIVE group. default_players
// counts everyone in no group other than DEFAULT.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const groups = await customers.listCustomerGroups(
    {},
    { take: 100, order: { created_at: 'ASC' } },
  );
  const { defaultPlayers, byGroup } = await groupSizes(reportDb(req));
  res.json({
    default_players: defaultPlayers,
    groups: groups
      .filter((g) => !isDefaultPlayerGroup(g))
      .map((g) => ({ name: g.name, players: byGroup.get(g.id) ?? 0 })),
  });
}
```

- [ ] **Step 4: Add the MCP tool (test first)**

In `tools.test.mjs` and `server.test.mjs`, change the expected names to `['economy', 'daily_economy', 'payments', 'pack_sales', 'player', 'groups']`.

Run `node --test`. Expected: FAIL.

Then add to `TOOLS.finance` in `tools.mjs`:

```js
    {
      name: 'groups',
      description:
        'The player groups and how many players each holds now (by current group). default_players counts players in no group other than DEFAULT. Use these names as the group argument of the other tools.',
      inputSchema: {},
      request: () => ({ path: 'groups', params: {} }),
    },
```

- [ ] **Step 5: Write the live partition check**

`tools/desk-reports/live-check.mjs`:

```js
// Post-deploy check (spec "Live"): for one window, every economy total for
// group=default plus each named group must equal group=all. Reads the Finance
// desk key from its Hermes profile and never prints it.
// Usage: node tools/desk-reports/live-check.mjs [period]   (default: today)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getReport } from './http.mjs';
import { resolvePeriod } from './periods.mjs';

const profileEnv = join(process.env.LOCALAPPDATA, 'hermes', 'profiles', 'polycards-finance', '.env');
const key = /^REPORT_KEY_FINANCE=(.*)$/m.exec(readFileSync(profileEnv, 'utf8'))?.[1]?.trim() ?? '';
const config = { baseUrl: process.env.REPORTS_BASE_URL || 'https://admin.polycards.gg', desk: 'finance', key };
const window = resolvePeriod(process.argv[2] ?? 'today');
const totals = async (group) =>
  (await getReport({ ...config, path: 'economy', params: { from: window.from, to: window.to, group } })).totals;

const { groups } = await getReport({ ...config, path: 'groups' });
const all = await totals('all');
const parts = [await totals('default')];
for (const g of groups) parts.push(await totals(g.name));
let ok = true;
for (const field of Object.keys(all)) {
  const sum = parts.reduce((s, t) => s + Math.round(t[field] * 100), 0) / 100;
  const match = sum === all[field];
  ok &&= match;
  console.log(`${match ? 'ok  ' : 'FAIL'} ${field}: all ${all[field]}, default + groups ${sum}`);
}
console.log(`${window.label}; groups: default, ${groups.map((g) => g.name).join(', ')}`);
process.exit(ok ? 0 : 1);
```

- [ ] **Step 6: Run everything and confirm it passes**

Run, in order:

1. From `backend/packages/api`: `corepack yarn test:integration:http desk-reports.spec`
   - Expected: PASS, 14 tests.
2. From `backend/packages/api`: `corepack yarn test:unit src/api/reports`
   - Expected: PASS, 43 tests.
3. From `backend/packages/api`: `corepack yarn check-types`
   - Expected: exit 0.
4. From `tools/desk-reports`: `node --test`
   - Expected: PASS, 17 tests.
5. From the worktree root: `node ../../../node_modules/eslint/bin/eslint.js tools/desk-reports`
   - Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/packages/api/src/api/reports backend/packages/api/integration-tests/http/desk-reports.spec.ts tools/desk-reports
git commit -m "feat(reports): player-group sizes, groups tool and the live partition check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Ship (key, deploy config, PR, merge, apply, live test)

Every production step needs the operator's explicit OK in chat, asked separately:
- Step 2: write the key;
- Step 5: merge;
- Step 6: apply.

Follow the spec's "Deploy and secret order".

**Files:**
- Create: `tools/desk-reports/provision-key.mjs`
- Modify: `.do/backend.app.yaml` (node script)
- Modify: `scripts/do-apply.ps1:44`

**Interfaces:**
- Consumes: all previous tasks.
- Produces:
  - `REPORT_KEY_FINANCE` in production;
  - the Finance bot answering from live data.

- [ ] **Step 1: Add the key provisioning script and the deploy config**

`tools/desk-reports/provision-key.mjs`:

```js
// Generates one desk's report key and writes it, never printed, to the two
// places that must agree: deploy/.env.deploy in the MAIN checkout (read by
// scripts/do-apply.ps1) and the desk's Hermes profile .env (read into the MCP
// server's env). Re-running rotates the key; apply and restart Hermes after.
// Usage: node tools/desk-reports/provision-key.mjs <finance|store|support|growth> <main checkout path>
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [desk, repo] = process.argv.slice(2);
if (!['finance', 'store', 'support', 'growth'].includes(desk) || !repo) {
  throw new Error('usage: provision-key.mjs <finance|store|support|growth> <main checkout path>');
}
const name = `REPORT_KEY_${desk.toUpperCase()}`;
const files = [
  join(repo, 'deploy', '.env.deploy'),
  join(process.env.LOCALAPPDATA, 'hermes', 'profiles', `polycards-${desk}`, '.env'),
];
for (const file of files) if (!existsSync(file)) throw new Error(`missing ${file}`);
const value = randomBytes(32).toString('hex');
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/).filter((line) => !line.startsWith(`${name}=`));
  while (lines.length && lines.at(-1) === '') lines.pop();
  writeFileSync(file, [...lines, `${name}=${value}`, ''].join(eol));
}
console.log(`${name} written to ${files.length} files (value not shown).`);
```

`.do/backend.app.yaml` is not Prettier-clean. From the worktree root, run this with `node <scratch>/insert-secret.mjs`:

```js
import { readFileSync, writeFileSync } from 'node:fs';

const path = '.do/backend.app.yaml';
const src = readFileSync(path, 'utf8');
const anchor = '      - key: MEDUSA_WORKER_MODE\n        scope: RUN_TIME\n        value: server\n';
if (src.split(anchor).length !== 2) throw new Error('anchor not found exactly once');
if (src.includes('REPORT_KEY_FINANCE')) throw new Error('already inserted');
const entry =
  '      # Finance desk-report key (GET /reports/finance/*, spec 2026-09-29\n' +
  '      # desk reports). Web service only: the worker serves no HTTP. Unset =\n' +
  '      # those routes answer 503.\n' +
  '      - key: REPORT_KEY_FINANCE\n' +
  '        scope: RUN_TIME\n' +
  '        type: SECRET\n' +
  '        value: __SECRET__REPORT_KEY_FINANCE__\n';
writeFileSync(path, src.replace(anchor, anchor + entry));
console.log('inserted REPORT_KEY_FINANCE');
```

In `scripts/do-apply.ps1` (Prettier ignores `.ps1`, so Edit is fine), make two changes:
1. On line 44, append `, 'REPORT_KEY_FINANCE'` to the end of the `backend = ...` list.
2. Above that line, add this comment line: `  # REPORT_KEY_FINANCE added 2026-09-29 for the Finance desk reports (spec 2026-09-29-desk-reports-design.md).`

Commit:

```bash
git add tools/desk-reports/provision-key.mjs .do/backend.app.yaml scripts/do-apply.ps1
git commit -m "chore(deploy): declare the Finance desk-report key

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Provision the key (operator OK)**

1. Ask the operator for OK. Say that this writes a new secret into `deploy/.env.deploy` and the Finance profile `.env`, and prints no value.
2. On yes, from the worktree root, run: `node tools/desk-reports/provision-key.mjs finance C:/Users/PC/Desktop/Projects/Polycards`
   - Expected: `REPORT_KEY_FINANCE written to 2 files (value not shown).`

- [ ] **Step 3: Final checks on the branch**

Run, in order:

1. From `backend/packages/api`: `corepack yarn test:unit src/api`
   - Expected: PASS, with no regressions against master.
2. From `backend/packages/api`: `corepack yarn test:integration:http desk-reports.spec economy.spec`
   - Expected: PASS.
3. From `backend/packages/api`: `corepack yarn check-types`
   - Expected: exit 0.
4. From `tools/desk-reports`: `node --test`
   - Expected: PASS, 17 tests.

Then run the `superpowers:requesting-code-review` skill, and address findings before opening the PR.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin worktree-feat+desk-reports
gh pr create --base master --title "feat(reports): live production data for the Finance desk bot" --body "<summary: routes, guard, MCP server, Hermes wiring (local), secret order; test plan; ends with the Claude Code attribution line>"
```

Then call the `ccd_pr` `get_status` tool, and `bind_pr` if the PR is not bound. Wait for CI (`backend-unit`, `integration-http`, `quality`, `gitleaks`) to go green.

- [ ] **Step 5: Merge (operator OK)**

1. Ask the operator for OK to merge. `deploy_on_push` deploys the backend at once, and the report routes answer 503 until Step 6.
2. On yes, run: `gh pr merge --squash --delete-branch=false`
3. Wait for the DigitalOcean deployment to finish, using the `digitalocean` MCP tool `apps-get-deployment-status`.

- [ ] **Step 6: Apply the secret (operator OK)**

In the MAIN checkout (`C:\Users\PC\Desktop\Projects\Polycards`), after `git pull` on master:

1. Run `pwsh scripts/do-apply.ps1 backend -Validate`.
   - Expected: validation passes, and no secret is printed.
2. Ask the operator for OK to apply (this redeploys production).
3. On yes, run `pwsh scripts/do-apply.ps1 backend`.
4. Wait for the deployment to finish.

- [ ] **Step 7: Reinstall the MCP server, restart Hermes (operator OK) and check the key arrived**

1. From the worktree root, run `node tools/desk-reports/install.mjs`. This picks up every tool added in Tasks 5–9.
2. Check desk activity as in Task 4 Step 8.
3. Ask the operator for OK, then run `hermes gateway restart`.
4. Run:

```bash
grep -rh "desk-reports:" "$LOCALAPPDATA/hermes/profiles/polycards-finance/logs" | tail -1
cd "$LOCALAPPDATA/hermes/ops/discord" && node discord-desks.mjs audit
```

Expected:
- `... key configured: yes (64 chars)`;
- `ALL CHECKS PASSED`.

- [ ] **Step 8: Live test**

1. From the worktree root, run: `node tools/desk-reports/live-check.mjs today` and then `node tools/desk-reports/live-check.mjs last_30_days`.
   - Expected: every line `ok`, exit 0.
2. Compare `group=all` for `today` with the admin dashboard Economy page, Daily tab (browser-local midnight = Malaysia midnight). The totals must match.
3. In `#💰・finance-desk`, ask Wei Yuan's question verbatim: `economy 里今天的数据如果只算default group的customer 是多少`
   - Expected: a Chinese answer that gives the totals and says "today" in Malaysia time and the DEFAULT group. The numbers must match `live-check`'s default line.
4. In `#🛒・store-desk`, ask "what tools do you have for live economy data?"
   - Expected: the Store bot has no report tools.

- [ ] **Step 9: Record and hand off**

Update the memory file `hermes-discord-desks.md` to say:
- Finance has live data through desk-reports;
- the key is provisioned;
- `live-check.mjs` exists.

Then tell the operator:
- what shipped;
- the live-test results;
- that Phase B (Store, Support, Growth) is next, on the same foundation.
