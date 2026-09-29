# Marketing Data Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, key-protected `/marketing/*` feed to the Polycards backend that returns exactly the data the marketing publisher needs: new sign-ups, the weekly challenge state, the week's tasks, and revealed Legendary/Immortal pulls.

**Architecture:** Four GET route handlers under `backend/packages/api/src/api/marketing/`, guarded by one middleware entry in `middlewares.ts` (a new `marketing-feed` rate limiter, then a constant-time `x-marketing-key` check). The routes reuse the existing service reads (challenge week bounds/pool/stages/payouts, task definitions, cards, packs, FX, disabled players). One new service query pages revealed apex pulls by a `(revealed_at, id)` cursor, applying the same gates as the Telegram apex post.

**Tech Stack:** Medusa v2 (file-based API routes, `@medusajs/framework`), TypeScript, Postgres raw SQL via the packs service manager, Jest unit specs (`*.unit.spec.ts`), and the `medusaIntegrationTestRunner` HTTP integration specs.

**Spec:** `docs/superpowers/specs/2026-09-29-marketing-automation-design.md` (build order step 1, "Marketing data feed in the backend"). Read its "Part 1: Marketing data feed" and "The five automations" sections first.

## Global Constraints

- Routes: `GET /marketing/signups`, `GET /marketing/challenge`, `GET /marketing/tasks`, `GET /marketing/pulls`. GET only; no writes.
- Auth header `x-marketing-key`, compared in constant time against env `MARKETING_FEED_KEY`. An unset key, or one shorter than 32 characters, answers **503**. A wrong or missing key answers **401** with body `{ "message": "Unauthorized" }` and nothing else.
- Rate limiter runs **before** the key check. It is keyed on the caller's address through `callbackSourceIp` (`req.ip` is App Platform's ingress).
- No customer contact data leaves the backend: never email, phone or customer id. Names come from `publicProfileFields(customer, seedOf(customerId)).name`, the source the leaderboard and the Telegram caption use.
- Administratively disabled players (`packs.disabledCustomerIds`) are excluded from every list.
- Apex pulls: tiers **Immortal and Legendary** only, only **revealed** pulls (`revealed_at` set), sources in Telegram's `EXCLUDED_SOURCES` excluded, tier per (pack, card) from `pack_odds`, card value via `displayMarketPrice` (the storefront price).
- Pulls window: default **6 hours**, clamped to 1..24. Sign-ups window: default **72 hours**, clamped to 1..168.
- Task week: Monday 00:00 MYT (`taskWeekFor`). Challenge week: `challenge_settings` via `challengeWeekBounds`.
- Commits: conventional commits. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Backend commands run from `backend/packages/api` with `corepack yarn` (never npm/pnpm there).

## File Structure

| File | Responsibility |
| --- | --- |
| `backend/packages/api/src/api/marketing/require-marketing-key.ts` (create) | The key-check middleware factory `requireMarketingKey()` |
| `backend/packages/api/src/api/marketing/pull-cursor.ts` (create) | Encode and decode the opaque `(revealed_at, id)` cursor |
| `backend/packages/api/src/api/marketing/query-params.ts` (create) | `intParam()`: clamp integer query params |
| `backend/packages/api/src/api/marketing/pulls/route.ts` (create) | `GET /marketing/pulls` |
| `backend/packages/api/src/api/marketing/signups/route.ts` (create) | `GET /marketing/signups` |
| `backend/packages/api/src/api/marketing/challenge/route.ts` (create) | `GET /marketing/challenge` |
| `backend/packages/api/src/api/marketing/tasks/route.ts` (create) | `GET /marketing/tasks` |
| `backend/packages/api/src/api/marketing/__tests__/*.unit.spec.ts` (create) | Unit specs for the files above |
| `backend/packages/api/src/api/utils/rate-limit.ts` (modify) | Add the `'marketing-feed'` entry to `RATE_LIMITS` |
| `backend/packages/api/src/api/middlewares.ts` (modify) | Bind `marketingFeedRateLimit`; register the `/marketing/*` entry |
| `backend/packages/api/src/modules/packs/service.ts` (modify) | Add `marketingApexPullRows` next to `recentPullRows` |
| `backend/packages/api/src/modules/packs/telegram.ts` (modify) | Export `EXCLUDED_SOURCES` so the feed shares Telegram's gate |
| `backend/packages/api/integration-tests/http/marketing-feed.spec.ts` (create) | DB-backed specs: the SQL gates and the HTTP contract |
| `backend/packages/api/.env.template` (modify) | Document `MARKETING_FEED_KEY` |
| `.do/backend.app.yaml` (modify) | Declare the `MARKETING_FEED_KEY` secret on `services.backend` |

---

### Task 1: Key guard, rate limiter and middleware registration

**Files:**
- Create: `backend/packages/api/src/api/marketing/require-marketing-key.ts`
- Create: `backend/packages/api/src/api/marketing/__tests__/require-marketing-key.unit.spec.ts`
- Create: `backend/packages/api/src/api/marketing/__tests__/marketing-middlewares.unit.spec.ts`
- Modify: `backend/packages/api/src/api/utils/rate-limit.ts` (inside `export const RATE_LIMITS = {`, after the `'gateway-hook'` entry that ends near line 1007)
- Modify: `backend/packages/api/src/api/middlewares.ts` (bindings near line 113; routes array next to the `/hooks/tgpay/*` entry near line 317)
- Modify: `backend/packages/api/.env.template` (after the Telegram block ending at line 232)
- Modify: `.do/backend.app.yaml` (`services:` → `- name: backend` → `envs:`, lines 489–492)

**Interfaces:**
- Produces: `requireMarketingKey(): (req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) => void`, the `RATE_LIMITS['marketing-feed']` limiter, and the middlewares binding `marketingFeedRateLimit`.

- [ ] **Step 1: Write the failing key-guard spec**

`backend/packages/api/src/api/marketing/__tests__/require-marketing-key.unit.spec.ts`:

```ts
import { requireMarketingKey } from '../require-marketing-key';

const KEY = 'k'.repeat(40);
const ORIGINAL = process.env.MARKETING_FEED_KEY;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MARKETING_FEED_KEY;
  else process.env.MARKETING_FEED_KEY = ORIGINAL;
});

function run(headers: Record<string, string | string[] | undefined>) {
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
  requireMarketingKey()({ headers } as never, res as never, next);
  return { res, next };
}

describe('requireMarketingKey', () => {
  it('answers 503 and never calls next when MARKETING_FEED_KEY is unset', () => {
    delete process.env.MARKETING_FEED_KEY;
    const { res, next } = run({ 'x-marketing-key': KEY });
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('treats a configured key shorter than 32 characters as unset', () => {
    process.env.MARKETING_FEED_KEY = 'short';
    const { res, next } = run({ 'x-marketing-key': 'short' });
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('answers a bare 401 without the header', () => {
    process.env.MARKETING_FEED_KEY = KEY;
    const { res, next } = run({});
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 401 for a wrong key of the same length', () => {
    process.env.MARKETING_FEED_KEY = KEY;
    const { res, next } = run({ 'x-marketing-key': 'x'.repeat(40) });
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 401 for a wrong key of a different length', () => {
    process.env.MARKETING_FEED_KEY = KEY;
    const { res } = run({ 'x-marketing-key': `${KEY}extra` });
    expect(res.statusCode).toBe(401);
  });

  it('calls next for the right key and writes no response', () => {
    process.env.MARKETING_FEED_KEY = KEY;
    const { res, next } = run({ 'x-marketing-key': KEY });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });

  it('uses the first value when the header repeats', () => {
    process.env.MARKETING_FEED_KEY = KEY;
    const { next } = run({ 'x-marketing-key': [KEY, 'other'] });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('ignores whitespace around the configured key', () => {
    process.env.MARKETING_FEED_KEY = `  ${KEY}\n`;
    const { next } = run({ 'x-marketing-key': KEY });
    expect(next).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Write the failing registration spec**

`backend/packages/api/src/api/marketing/__tests__/marketing-middlewares.unit.spec.ts`:

```ts
import * as fs from 'fs';
import {
  MIDDLEWARES_PATH,
  extractLimiterEntries,
  isLimited,
  limiterBindings,
} from '../../__tests__/rate-limit-coverage-helpers';

const src = fs.readFileSync(MIDDLEWARES_PATH, 'utf8');
const entry = extractLimiterEntries(src).find(
  (e) => e.matcher === '/marketing/*',
);

describe('/marketing/* middleware registration', () => {
  it('registers GET /marketing/* with the rate limiter BEFORE the key guard', () => {
    expect(entry).toBeDefined();
    expect(entry!.methods).toEqual(['GET']);
    expect(isLimited(entry!, limiterBindings(src))).toBe(true);
    const limiterAt = entry!.middlewares.indexOf('marketingFeedRateLimit');
    const guardAt = entry!.middlewares.indexOf('requireMarketingKey()');
    expect(limiterAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeGreaterThan(limiterAt);
  });

  it('binds the marketing-feed limiter once', () => {
    expect(src.match(/rateLimit\('marketing-feed'\)/g)).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run both specs and confirm they fail**

Run (from `backend/packages/api`): `corepack yarn test:unit src/api/marketing/__tests__/require-marketing-key.unit.spec.ts src/api/marketing/__tests__/marketing-middlewares.unit.spec.ts`

Expected: FAIL. `Cannot find module '../require-marketing-key'`, and `expect(entry).toBeDefined()` fails.

- [ ] **Step 4: Implement the guard**

`backend/packages/api/src/api/marketing/require-marketing-key.ts`:

```ts
import { timingSafeEqual } from 'node:crypto';
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';

// The marketing feed's lock (spec 2026-09-29, marketing automation): one
// shared key, presented by the owner's marketing publisher in
// `x-marketing-key`. Fail CLOSED: an unset or too-short MARKETING_FEED_KEY
// answers 503, so a deploy that forgot the secret never serves the feed open.
// The comparison is constant-time, and a wrong key gets the same bare 401
// whatever was wrong with it.
const MIN_KEY_LENGTH = 32;

export function requireMarketingKey() {
  return (
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction,
  ): void => {
    const expected = process.env.MARKETING_FEED_KEY?.trim() ?? '';
    if (expected.length < MIN_KEY_LENGTH) {
      res.status(503).json({ message: 'Marketing feed is not configured.' });
      return;
    }
    const raw = req.headers['x-marketing-key'];
    const given = Array.isArray(raw) ? raw[0] : raw;
    if (typeof given !== 'string' || !sameKey(given, expected)) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    next();
  };
}

function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

- [ ] **Step 5: Add the limiter entry**

In `backend/packages/api/src/api/utils/rate-limit.ts`, inside `RATE_LIMITS`, directly after the closing `},` of the `'gateway-hook'` entry, add:

```ts
  /**
   * The marketing feed (GET /marketing/*): read by ONE caller, the owner's
   * marketing publisher and its Hermes jobs, a few requests a minute (the slab
   * poller once a minute, the challenge watcher every 10 minutes). Runs BEFORE
   * the key check so a key-guessing loop is throttled before any comparison.
   * Keyed on the caller's address like gateway-hook: on App Platform req.ip
   * is DigitalOcean's ingress, not the caller. Env-tunable:
   * MARKETING_FEED_RATE_BURST_LIMIT / _BURST_WINDOW_MS (default 20/10s)
   * MARKETING_FEED_RATE_LIMIT / _WINDOW_MS (default 120/60s)
   */
  'marketing-feed': {
    message: 'Too many requests.',
    keyOf: (req) => `ip:${callbackSourceIp(req) || 'unknown'}`,
    defaults: {
      burstLimit: 20,
      burstWindowMs: 10_000,
      limit: 120,
      windowMs: 60_000,
    },
  },
```

(`callbackSourceIp` is already imported at the top of `rate-limit.ts`: `import { callbackSourceIp } from './payer-ip';`.)

- [ ] **Step 6: Register the middleware**

In `backend/packages/api/src/api/middlewares.ts`:

1. Add to the imports at the top of the file:

```ts
import { requireMarketingKey } from './marketing/require-marketing-key';
```

2. Directly under `const gatewayHookRateLimit = rateLimit('gateway-hook');` (line 113), add:

```ts
// The marketing feed's one limiter instance: one caller (the owner's
// marketing publisher), one budget.
const marketingFeedRateLimit = rateLimit('marketing-feed');
```

3. In the routes array, directly after the `/hooks/tgpay/*` entry (the object that ends with `middlewares: [gatewayHookRateLimit, tgpayCallbackAllowlist],` and `},`), add:

```ts
    {
      // Marketing feed (spec 2026-09-29): read-only data for the owner's
      // marketing publisher. A top-level prefix like /hooks, so there is no
      // publishable key and no session; the shared key is the only lock.
      // Limiter FIRST so a key-guessing loop 429s before any comparison.
      matcher: '/marketing/*',
      method: 'GET',
      middlewares: [marketingFeedRateLimit, requireMarketingKey()],
    },
```

- [ ] **Step 7: Document the secret**

Append to `backend/packages/api/.env.template`, after the Telegram block:

```
# ── Marketing feed (GET /marketing/*, read by the owner's marketing publisher)
# Shared key the publisher sends in x-marketing-key. Unset or shorter than 32
# characters = the feed answers 503 (off). Generate with: openssl rand -hex 32
MARKETING_FEED_KEY=
```

In `.do/backend.app.yaml`, under `services:` → `- name: backend` → `envs:`, after the `MEDUSA_WORKER_MODE` entry (lines 490–492), add:

```yaml
      # Marketing feed key (GET /marketing/*). Web service only: the worker
      # serves no HTTP. Unset = the feed answers 503.
      - key: MARKETING_FEED_KEY
        scope: RUN_TIME
        type: SECRET
        value: __SECRET__MARKETING_FEED_KEY__
```

- [ ] **Step 8: Run the specs and confirm they pass**

Run: `corepack yarn test:unit src/api/marketing/__tests__/require-marketing-key.unit.spec.ts src/api/marketing/__tests__/marketing-middlewares.unit.spec.ts`

Expected: PASS (10 tests).

Also run the existing limiter probes: `corepack yarn test:unit src/api/__tests__`

Expected: PASS, unchanged.

- [ ] **Step 9: Commit**

```bash
git add backend/packages/api/src/api/marketing backend/packages/api/src/api/utils/rate-limit.ts backend/packages/api/src/api/middlewares.ts backend/packages/api/.env.template .do/backend.app.yaml
git commit -m "feat(marketing): guard /marketing/* with a shared key and its own limiter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pull cursor and the apex-pull query

**Files:**
- Create: `backend/packages/api/src/api/marketing/pull-cursor.ts`
- Create: `backend/packages/api/src/api/marketing/__tests__/pull-cursor.unit.spec.ts`
- Modify: `backend/packages/api/src/modules/packs/telegram.ts:40` (export `EXCLUDED_SOURCES`)
- Modify: `backend/packages/api/src/modules/packs/service.ts` (new method directly after `recentPullRows`, which ends near line 6018)
- Create: `backend/packages/api/integration-tests/http/marketing-feed.spec.ts`

**Interfaces:**
- Produces:
  - `interface PullCursor { revealedAt: Date; id: string }`
  - `encodePullCursor(c: PullCursor): string`
  - `decodePullCursor(raw: unknown): PullCursor | null`
  - `export const EXCLUDED_SOURCES: readonly string[]` from `modules/packs/telegram.ts`
  - `PacksModuleService.marketingApexPullRows(opts: { revealedSince: Date; rolledSince: Date; after: PullCursor | null; tiers: readonly Rarity[]; excludedSources: readonly string[]; limit: number }): Promise<{ id: string; customer_id: string | null; pack_id: string; card_id: string; revealed_at: string | Date }[]>`

- [ ] **Step 1: Write the failing cursor spec**

`backend/packages/api/src/api/marketing/__tests__/pull-cursor.unit.spec.ts`:

```ts
import { decodePullCursor, encodePullCursor } from '../pull-cursor';

const cursor = {
  revealedAt: new Date('2026-09-29T07:15:02.123Z'),
  id: 'pull_01JABCDEF',
};
const b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('pull cursor', () => {
  it('round-trips', () => {
    expect(decodePullCursor(encodePullCursor(cursor))).toEqual(cursor);
  });

  it('is URL-safe', () => {
    expect(encodePullCursor(cursor)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    undefined,
    '',
    42,
    '!!!',
    b64('no-separator'),
    b64('not-a-date|pull_1'),
    b64('2026-09-29T07:15:02.123Z|'),
    b64('2026-09-29T07:15:02.123Z|pull 1; drop'),
  ])('rejects %p', (raw) => {
    expect(decodePullCursor(raw)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack yarn test:unit src/api/marketing/__tests__/pull-cursor.unit.spec.ts`

Expected: FAIL with `Cannot find module '../pull-cursor'`.

- [ ] **Step 3: Implement the cursor**

`backend/packages/api/src/api/marketing/pull-cursor.ts`:

```ts
// Opaque cursor for GET /marketing/pulls: the (revealed_at, id) of the last
// pull the caller has seen. base64url so it survives a query string; the id
// charset check keeps anything odd out of the SQL parameters.
export interface PullCursor {
  revealedAt: Date;
  id: string;
}

export function encodePullCursor(c: PullCursor): string {
  return Buffer.from(`${c.revealedAt.toISOString()}|${c.id}`).toString(
    'base64url',
  );
}

export function decodePullCursor(raw: unknown): PullCursor | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const bar = text.indexOf('|');
  if (bar <= 0) return null;
  const revealedAt = new Date(text.slice(0, bar));
  const id = text.slice(bar + 1);
  if (Number.isNaN(revealedAt.getTime())) return null;
  if (!/^[A-Za-z0-9_]+$/.test(id)) return null;
  return { revealedAt, id };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `corepack yarn test:unit src/api/marketing/__tests__/pull-cursor.unit.spec.ts`

Expected: PASS (10 tests).

- [ ] **Step 5: Write the failing integration spec for the query**

`backend/packages/api/integration-tests/http/marketing-feed.spec.ts`:

```ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { EXCLUDED_SOURCES } from '../../src/modules/packs/telegram';

jest.setTimeout(240 * 1000);

const PACK = 'mk-pack';
const IMMORTAL = 'mk-immortal';
const LEGENDARY = 'mk-legendary';
const RARE = 'mk-rare';
const HOUR_MS = 60 * 60 * 1000;
const TIERS = ['Immortal', 'Legendary'] as const;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    const packs = () =>
      getContainer().resolve<PacksModuleService>(PACKS_MODULE);

    async function seedCatalog() {
      await packs().createPacks([
        {
          slug: PACK,
          title: 'MK Pack',
          category: 'pokemon',
          price: 10,
          image: '/p.webp',
        },
      ]);
      await packs().createCards([
        { handle: IMMORTAL, name: 'Imm', set: 'S', grader: 'PSA', grade: '10', market_value: 100, image: '/i.webp', slab_image: '/i-slab.webp' },
        { handle: LEGENDARY, name: 'Leg', set: 'S', grader: 'PSA', grade: '9', market_value: 50, image: '/l.webp' },
        { handle: RARE, name: 'Rar', set: 'S', grader: 'PSA', grade: '8', market_value: 5, image: '/r.webp' },
      ]);
      await packs().createPackOdds([
        { pack_id: PACK, card_id: IMMORTAL, weight: 1, locked: false, rarity: 'Immortal' as const },
        { pack_id: PACK, card_id: LEGENDARY, weight: 10, locked: false, rarity: 'Legendary' as const },
        { pack_id: PACK, card_id: RARE, weight: 100, locked: false, rarity: 'Rare' as const },
      ]);
    }

    describe('PacksModuleService.marketingApexPullRows', () => {
      beforeEach(seedCatalog);

      it('returns revealed Immortal/Legendary pulls, oldest first, with every Telegram gate applied', async () => {
        const now = Date.now();
        const at = (minsAgo: number) => new Date(now - minsAgo * 60_000);
        await packs().createPulls([
          // kept: revealed apex pulls from a pack open and a free pack
          { customer_id: 'cus_a', pack_id: PACK, card_id: IMMORTAL, rolled_at: at(30), revealed_at: at(30), source: 'pack' },
          { customer_id: 'cus_b', pack_id: PACK, card_id: LEGENDARY, rolled_at: at(20), revealed_at: at(20), source: 'free' },
          // dropped: never revealed
          { customer_id: 'cus_c', pack_id: PACK, card_id: IMMORTAL, rolled_at: at(10), source: 'pack' },
          // dropped: below the tier bar
          { customer_id: 'cus_d', pack_id: PACK, card_id: RARE, rolled_at: at(10), revealed_at: at(10), source: 'pack' },
          // dropped: reward-source pull (a private vault prize)
          { customer_id: 'cus_e', pack_id: PACK, card_id: IMMORTAL, rolled_at: at(10), revealed_at: at(10), source: 'reward' },
          // dropped: revealed before the window
          { customer_id: 'cus_f', pack_id: PACK, card_id: LEGENDARY, rolled_at: at(8 * 60), revealed_at: at(8 * 60), source: 'pack' },
        ] as Parameters<PacksModuleService['createPulls']>[0]);

        const revealedSince = new Date(now - 6 * HOUR_MS);
        const rows = await packs().marketingApexPullRows({
          revealedSince,
          rolledSince: new Date(revealedSince.getTime() - HOUR_MS),
          after: null,
          tiers: TIERS,
          excludedSources: EXCLUDED_SOURCES,
          limit: 50,
        });
        expect(rows.map((r) => r.customer_id)).toEqual(['cus_a', 'cus_b']);
      });

      it('pages forward from a cursor without repeating the cursor row', async () => {
        const now = Date.now();
        const at = (minsAgo: number) => new Date(now - minsAgo * 60_000);
        await packs().createPulls([
          { customer_id: 'cus_1', pack_id: PACK, card_id: IMMORTAL, rolled_at: at(3), revealed_at: at(3), source: 'pack' },
          { customer_id: 'cus_2', pack_id: PACK, card_id: IMMORTAL, rolled_at: at(2), revealed_at: at(2), source: 'pack' },
          { customer_id: 'cus_3', pack_id: PACK, card_id: IMMORTAL, rolled_at: at(1), revealed_at: at(1), source: 'pack' },
        ] as Parameters<PacksModuleService['createPulls']>[0]);
        const base = {
          revealedSince: new Date(now - HOUR_MS),
          rolledSince: new Date(now - 2 * HOUR_MS),
          tiers: TIERS,
          excludedSources: EXCLUDED_SOURCES,
        };
        const first = await packs().marketingApexPullRows({ ...base, after: null, limit: 2 });
        expect(first.map((r) => r.customer_id)).toEqual(['cus_1', 'cus_2']);
        const last = first[first.length - 1];
        const rest = await packs().marketingApexPullRows({
          ...base,
          after: { revealedAt: new Date(last.revealed_at), id: last.id },
          limit: 2,
        });
        expect(rest.map((r) => r.customer_id)).toEqual(['cus_3']);
      });
    });
  },
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run (from `backend/packages/api`, Postgres and Redis containers up): `corepack yarn test:integration:http marketing-feed.spec`

Expected: FAIL at compile time. `EXCLUDED_SOURCES` is not exported from `telegram.ts`, and `marketingApexPullRows` does not exist on `PacksModuleService`.

- [ ] **Step 7: Export the Telegram source gate**

In `backend/packages/api/src/modules/packs/telegram.ts`, change line 40 from:

```ts
const EXCLUDED_SOURCES: readonly string[] = ['reward'];
```

to:

```ts
// Exported: GET /marketing/pulls applies the same source gate, so the social
// Stories and the Telegram channel can never disagree about a pull.
export const EXCLUDED_SOURCES: readonly string[] = ['reward'];
```

- [ ] **Step 8: Add the service query**

In `backend/packages/api/src/modules/packs/service.ts`, directly after the closing `}` of `recentPullRows`, add:

```ts
  // Apex pulls for the marketing feed (GET /marketing/pulls, spec
  // 2026-09-29): REVEALED pulls of the given tiers, oldest first after a
  // (revealed_at, id) cursor, so the marketing publisher pages forward with no
  // gaps and no repeats. The gates mirror the Telegram apex post
  // (telegram.ts): the flip is the moment (revealed_at set), `excludedSources`
  // is telegram.ts's EXCLUDED_SOURCES, and the tier is per (pack, card)
  // through pack_odds. Disabled players are dropped by the caller (a display
  // rule, not a ledger one). `rolledSince` bounds the scan on
  // IDX_pull_rolled_at: a reveal follows its roll by seconds, so the caller
  // passes its reveal window minus a margin. The cursor compares at
  // millisecond precision because the cursor itself carries a JS Date.
  @InjectManager()
  async marketingApexPullRows(
    opts: {
      revealedSince: Date;
      rolledSince: Date;
      after: { revealedAt: Date; id: string } | null;
      tiers: readonly Rarity[];
      excludedSources: readonly string[];
      limit: number;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<
    {
      id: string;
      customer_id: string | null;
      pack_id: string;
      card_id: string;
      revealed_at: string | Date;
    }[]
  > {
    if (opts.tiers.length === 0) return [];
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const params: unknown[] = [opts.rolledSince, opts.revealedSince];
    let where =
      'p.deleted_at IS NULL AND p.revealed_at IS NOT NULL ' +
      'AND p.rolled_at >= ? AND p.revealed_at >= ? ' +
      'AND EXISTS (SELECT 1 FROM pack_odds o WHERE o.pack_id = p.pack_id ' +
      '  AND o.card_id = p.card_id AND o.deleted_at IS NULL ' +
      '  AND o.rarity IN (' +
      opts.tiers.map(() => '?').join(', ') +
      '))';
    params.push(...opts.tiers);
    if (opts.excludedSources.length > 0) {
      where +=
        ' AND p.source NOT IN (' +
        opts.excludedSources.map(() => '?').join(', ') +
        ')';
      params.push(...opts.excludedSources);
    }
    if (opts.after) {
      where += " AND (date_trunc('milliseconds', p.revealed_at), p.id) > (?, ?)";
      params.push(opts.after.revealedAt, opts.after.id);
    }
    params.push(opts.limit);
    return await em.execute(
      'SELECT p.id, p.customer_id, p.pack_id, p.card_id, p.revealed_at ' +
        '  FROM pull p WHERE ' +
        where +
        " ORDER BY date_trunc('milliseconds', p.revealed_at) ASC, p.id ASC LIMIT ?",
      params,
    );
  }
```

- [ ] **Step 9: Run the integration spec and confirm it passes**

Run: `corepack yarn test:integration:http marketing-feed.spec`

Expected: PASS (2 tests).

- [ ] **Step 10: Commit**

```bash
git add backend/packages/api/src/api/marketing/pull-cursor.ts backend/packages/api/src/api/marketing/__tests__/pull-cursor.unit.spec.ts backend/packages/api/src/modules/packs/telegram.ts backend/packages/api/src/modules/packs/service.ts backend/packages/api/integration-tests/http/marketing-feed.spec.ts
git commit -m "feat(marketing): page revealed apex pulls by cursor with the Telegram gates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: GET /marketing/pulls

**Files:**
- Create: `backend/packages/api/src/api/marketing/query-params.ts`
- Create: `backend/packages/api/src/api/marketing/pulls/route.ts`
- Create: `backend/packages/api/src/api/marketing/__tests__/pulls-route.unit.spec.ts`
- Modify: `backend/packages/api/src/api/marketing/__tests__/marketing-middlewares.unit.spec.ts` (add the route coverage test)

**Interfaces:**
- Consumes: `decodePullCursor`, `encodePullCursor`, `PullCursor` (Task 2); `EXCLUDED_SOURCES` (Task 2); `PacksModuleService.marketingApexPullRows` (Task 2).
- Produces:
  - `intParam(raw: unknown, fallback: number, min: number, max: number): number`
  - `GET /marketing/pulls?hours=&after=` returning `{ pulls: MarketingPull[]; next: string | null }`, where `MarketingPull = { pull_id: string; revealed_at: string; tier: 'Immortal' | 'Legendary'; name: string; profile_handle: string | null; card: { name: string; handle: string; grade: string; set: string; image: string }; pack: { slug: string; title: string | null }; value_myr: number }`

- [ ] **Step 1: Write the failing route spec**

`backend/packages/api/src/api/marketing/__tests__/pulls-route.unit.spec.ts`:

```ts
import { GET } from '../pulls/route';
import { decodePullCursor, encodePullCursor } from '../pull-cursor';
import { displayMarketPrice } from '../../../modules/packs/pricing';
import { EXCLUDED_SOURCES } from '../../../modules/packs/telegram';
import { publicProfileFields, seedOf } from '../../../utils/profile-handle';

const HOUR_MS = 60 * 60 * 1000;
const T1 = '2026-09-29T07:00:00.000Z';
const T2 = '2026-09-29T07:05:00.000Z';

function harness(opts: {
  rows?: unknown[];
  disabled?: string[];
  query?: Record<string, unknown>;
} = {}) {
  const packs = {
    marketingApexPullRows: jest.fn().mockResolvedValue(opts.rows ?? []),
    listPackOdds: jest.fn().mockResolvedValue([
      { pack_id: 'gold', card_id: 'zard-10', rarity: 'Immortal' },
      { pack_id: 'gold', card_id: 'pika-9', rarity: 'Legendary' },
    ]),
    listCards: jest.fn().mockResolvedValue([
      { handle: 'zard-10', name: 'Charizard', grader: 'PSA', grade: '10', set: 'Base', image: '/z.png', slab_image: '/z-slab.png', market_value: 100, market_multiplier: 1.2 },
      { handle: 'pika-9', name: 'Pikachu', grader: 'PSA', grade: '9', set: 'Jungle', image: '/p.png', slab_image: null, market_value: 20, market_multiplier: 1.2 },
    ]),
    listPacks: jest.fn().mockResolvedValue([{ slug: 'gold', title: 'Gold Pack' }]),
    disabledCustomerIds: jest.fn().mockResolvedValue(new Set(opts.disabled ?? [])),
    listFxRates: jest.fn().mockResolvedValue([{ rate: 4.5, manual_override: false }]),
  };
  const customers = {
    listCustomers: jest.fn().mockResolvedValue([
      { id: 'cus_ali', first_name: 'Ali', metadata: null },
      { id: 'cus_bob', first_name: 'Bob', metadata: null },
    ]),
  };
  const req = {
    query: opts.query ?? {},
    scope: { resolve: (k: string) => (k === 'customer' ? customers : packs) },
  } as never;
  const res = {
    statusCode: 200,
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
  return { packs, customers, req, res };
}

const rowA = { id: 'pull_a', customer_id: 'cus_ali', pack_id: 'gold', card_id: 'zard-10', revealed_at: T1 };
const rowB = { id: 'pull_b', customer_id: 'cus_bob', pack_id: 'gold', card_id: 'pika-9', revealed_at: T2 };

describe('GET /marketing/pulls', () => {
  it('returns named, tiered pulls with the slab as the image and the storefront price', async () => {
    const h = harness({ rows: [rowA, rowB] });
    await GET(h.req, h.res as never);
    const body = h.res.body as { pulls: unknown[]; next: string };
    expect(body.pulls).toEqual([
      {
        pull_id: 'pull_a',
        revealed_at: T1,
        tier: 'Immortal',
        name: 'Ali',
        profile_handle: publicProfileFields({ first_name: 'Ali' }, seedOf('cus_ali')).handle,
        card: { name: 'Charizard', handle: 'zard-10', grade: 'PSA 10', set: 'Base', image: '/z-slab.png' },
        pack: { slug: 'gold', title: 'Gold Pack' },
        value_myr: displayMarketPrice(100, 4.5, 1.2),
      },
      {
        pull_id: 'pull_b',
        revealed_at: T2,
        tier: 'Legendary',
        name: 'Bob',
        profile_handle: publicProfileFields({ first_name: 'Bob' }, seedOf('cus_bob')).handle,
        card: { name: 'Pikachu', handle: 'pika-9', grade: 'PSA 9', set: 'Jungle', image: '/p.png' },
        pack: { slug: 'gold', title: 'Gold Pack' },
        value_myr: displayMarketPrice(20, 4.5, 1.2),
      },
    ]);
    expect(decodePullCursor(body.next)).toEqual({ revealedAt: new Date(T2), id: 'pull_b' });
  });

  it('asks the service for a 6-hour reveal window, both apex tiers and the Telegram source gate', async () => {
    const h = harness();
    const before = Date.now();
    await GET(h.req, h.res as never);
    const arg = h.packs.marketingApexPullRows.mock.calls[0][0];
    expect(arg.tiers).toEqual(['Immortal', 'Legendary']);
    expect(arg.excludedSources).toBe(EXCLUDED_SOURCES);
    expect(arg.limit).toBe(50);
    expect(arg.after).toBeNull();
    expect(Math.abs(arg.revealedSince.getTime() - (before - 6 * HOUR_MS))).toBeLessThan(5_000);
    expect(arg.revealedSince.getTime() - arg.rolledSince.getTime()).toBe(HOUR_MS);
  });

  it.each([
    ['100', 24],
    ['0', 1],
    ['abc', 6],
    ['12', 12],
  ])('clamps ?hours=%s to %d', async (raw, hours) => {
    const h = harness({ query: { hours: raw } });
    const before = Date.now();
    await GET(h.req, h.res as never);
    const arg = h.packs.marketingApexPullRows.mock.calls[0][0];
    expect(Math.abs(arg.revealedSince.getTime() - (before - hours * HOUR_MS))).toBeLessThan(5_000);
  });

  it('drops a disabled player but still moves the cursor past their pull', async () => {
    const h = harness({ rows: [rowA, rowB], disabled: ['cus_bob'] });
    await GET(h.req, h.res as never);
    const body = h.res.body as { pulls: { pull_id: string }[]; next: string };
    expect(body.pulls.map((p) => p.pull_id)).toEqual(['pull_a']);
    expect(decodePullCursor(body.next)).toEqual({ revealedAt: new Date(T2), id: 'pull_b' });
  });

  it('passes a valid cursor through and echoes it back when nothing is new', async () => {
    const after = encodePullCursor({ revealedAt: new Date(T1), id: 'pull_a' });
    const h = harness({ query: { after } });
    await GET(h.req, h.res as never);
    expect(h.packs.marketingApexPullRows.mock.calls[0][0].after).toEqual({
      revealedAt: new Date(T1),
      id: 'pull_a',
    });
    expect(h.res.body).toEqual({ pulls: [], next: after });
  });

  it('answers 400 for a malformed cursor and never queries', async () => {
    const h = harness({ query: { after: 'garbage' } });
    await GET(h.req, h.res as never);
    expect(h.res.statusCode).toBe(400);
    expect(h.packs.marketingApexPullRows).not.toHaveBeenCalled();
  });

  it('answers next: null when there is no cursor and nothing new', async () => {
    const h = harness();
    await GET(h.req, h.res as never);
    expect(h.res.body).toEqual({ pulls: [], next: null });
  });
});
```

- [ ] **Step 2: Add the route-coverage test to the registration spec**

In `backend/packages/api/src/api/marketing/__tests__/marketing-middlewares.unit.spec.ts`, replace the import block with:

```ts
import * as fs from 'fs';
import * as path from 'path';
import {
  API_ROOT,
  MIDDLEWARES_PATH,
  collectRouteFiles,
  extractLimiterEntries,
  isLimited,
  limiterBindings,
  matcherToRegExp,
  mutationMethodsOf,
  routeFileToUrl,
} from '../../__tests__/rate-limit-coverage-helpers';
```

and add this test inside the `describe` block:

```ts
  it('covers every route under src/api/marketing, and none of them writes', () => {
    const routes = collectRouteFiles(path.join(API_ROOT, 'marketing'));
    expect(routes.length).toBeGreaterThan(0);
    const re = matcherToRegExp(entry!.matcher);
    for (const rel of routes) {
      expect(re.test(routeFileToUrl(rel))).toBe(true);
      const text = fs.readFileSync(path.join(API_ROOT, rel), 'utf8');
      expect(mutationMethodsOf(text)).toEqual([]);
    }
  });
```

- [ ] **Step 3: Run both specs and confirm they fail**

Run: `corepack yarn test:unit src/api/marketing/__tests__/pulls-route.unit.spec.ts src/api/marketing/__tests__/marketing-middlewares.unit.spec.ts`

Expected: FAIL. `Cannot find module '../pulls/route'`, and `routes.length` is 0.

- [ ] **Step 4: Implement the query-param helper**

`backend/packages/api/src/api/marketing/query-params.ts`:

```ts
/** An integer query param clamped to [min, max]; anything unparseable is
 *  `fallback`. The feed's windows come from the caller, so they are bounded
 *  here rather than trusted. */
export function intParam(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
```

- [ ] **Step 5: Implement the route**

`backend/packages/api/src/api/marketing/pulls/route.ts`:

```ts
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../modules/packs/service';
import { PACKS_MODULE } from '../../../modules/packs';
import { cardByHandle, makeRarityOf } from '../../../modules/packs/card-view';
import { toMoney } from '../../../modules/packs/money';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRate,
} from '../../../modules/packs/pricing';
import { EXCLUDED_SOURCES } from '../../../modules/packs/telegram';
import { publicProfileFields, seedOf } from '../../../utils/profile-handle';
import { decodePullCursor, encodePullCursor } from '../pull-cursor';
import { intParam } from '../query-params';

// GET /marketing/pulls?hours=6&after=<cursor> — revealed Legendary and
// Immortal pulls for the marketing publisher's congrats-slab Stories (spec
// 2026-09-29), oldest first after the cursor. Same gates as the Telegram apex
// post: the reveal is the moment, reward-source pulls never go public, the
// tier is per (pack, card), and a disabled player is dropped. `next` always
// moves past every pull fetched, including a dropped one, so a hidden pull is
// never fetched twice. Names come from publicProfileFields (never email/id);
// value_myr is the storefront price.
const TIERS = ['Immortal', 'Legendary'] as const;
const PAGE = 50;
const HOUR_MS = 60 * 60 * 1000;
// A reveal follows its roll by seconds; an hour of slack keeps the rolled_at
// index bound safe without scanning history.
const ROLL_SLACK_MS = HOUR_MS;

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const hours = intParam(req.query.hours, 6, 1, 24);
  const after = decodePullCursor(req.query.after);
  if (req.query.after !== undefined && !after) {
    res.status(400).json({ message: 'Invalid cursor.' });
    return;
  }
  const revealedSince = new Date(Date.now() - hours * HOUR_MS);

  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const rows = await packs.marketingApexPullRows({
    revealedSince,
    rolledSince: new Date(revealedSince.getTime() - ROLL_SLACK_MS),
    after,
    tiers: TIERS,
    excludedSources: EXCLUDED_SOURCES,
    limit: PAGE,
  });

  const last = rows[rows.length - 1];
  const next = last
    ? encodePullCursor({ revealedAt: new Date(last.revealed_at), id: last.id })
    : after
      ? encodePullCursor(after)
      : null;
  if (rows.length === 0) {
    res.json({ pulls: [], next });
    return;
  }

  const customerIds = [
    ...new Set(rows.map((r) => r.customer_id).filter((id): id is string => !!id)),
  ];
  const handles = [...new Set(rows.map((r) => r.card_id))];
  const packSlugs = [...new Set(rows.map((r) => r.pack_id))];
  const customerService = req.scope.resolve(Modules.CUSTOMER);
  const [disabled, customers, cards, oddsRows, packRows, fxRate] =
    await Promise.all([
      packs.disabledCustomerIds(customerIds),
      customerIds.length
        ? customerService.listCustomers(
            { id: customerIds },
            { take: customerIds.length },
          )
        : Promise.resolve([]),
      packs.listCards({ handle: handles }, { take: handles.length }),
      packs.listPackOdds({ card_id: handles }, { take: 1000 }),
      packs.listPacks({ slug: packSlugs }, { take: packSlugs.length }),
      resolveFxRate(packs),
    ]);
  const byCustomer = new Map(customers.map((c) => [c.id, c]));
  const byHandle = cardByHandle(cards);
  const rarityOf = makeRarityOf(
    oddsRows.filter(
      (o): o is typeof o & { card_id: string } => o.card_id != null,
    ),
  );
  const packBySlug = new Map(packRows.map((p) => [p.slug, p]));

  const pulls = rows
    .filter((r) => !r.customer_id || !disabled.has(r.customer_id))
    .map((r) => {
      const card = byHandle.get(r.card_id);
      if (!card) return null; // card removed since the roll: nothing to show
      const profile = publicProfileFields(
        r.customer_id ? byCustomer.get(r.customer_id) : undefined,
        seedOf(r.customer_id ?? r.id),
      );
      return {
        pull_id: r.id,
        revealed_at: new Date(r.revealed_at).toISOString(),
        tier: rarityOf(r.pack_id, r.card_id),
        name: profile.name,
        profile_handle: profile.handle,
        card: {
          name: card.name,
          handle: card.handle,
          grade: [card.grader, card.grade].filter((s) => s?.trim()).join(' '),
          set: card.set ?? '',
          image: card.slab_image ?? card.image,
        },
        pack: {
          slug: r.pack_id,
          title: packBySlug.get(r.pack_id)?.title ?? null,
        },
        value_myr: displayMarketPrice(
          toMoney(card.market_value),
          fxRate,
          Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
        ),
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  res.json({ pulls, next });
}
```

- [ ] **Step 6: Run the specs and confirm they pass**

Run: `corepack yarn test:unit src/api/marketing/__tests__`

Expected: PASS (all marketing unit specs).

If TypeScript rejects a field on the mocked `cards` (for example `grader` missing from the `cardByHandle` row type), read `cardByHandle` in `modules/packs/card-view.ts` and use the card fields it returns. Do not cast them away.

- [ ] **Step 7: Commit**

```bash
git add backend/packages/api/src/api/marketing
git commit -m "feat(marketing): GET /marketing/pulls for congrats-slab Stories

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: GET /marketing/signups

**Files:**
- Create: `backend/packages/api/src/api/marketing/signups/route.ts`
- Create: `backend/packages/api/src/api/marketing/__tests__/signups-route.unit.spec.ts`

**Interfaces:**
- Consumes: `intParam` (Task 3).
- Produces: `GET /marketing/signups?hours=` returning `{ hours: number; from: string; to: string; count: number }`.

- [ ] **Step 1: Write the failing spec**

`backend/packages/api/src/api/marketing/__tests__/signups-route.unit.spec.ts`:

```ts
import { GET } from '../signups/route';

const HOUR_MS = 60 * 60 * 1000;

function harness(count: number, query: Record<string, unknown> = {}) {
  const customers = {
    listAndCountCustomers: jest.fn().mockResolvedValue([[], count]),
  };
  const req = { query, scope: { resolve: () => customers } } as never;
  const res = {
    body: undefined as unknown,
    json(body: unknown) {
      this.body = body;
    },
  };
  return { customers, req, res };
}

describe('GET /marketing/signups', () => {
  it('counts registered customers created in the last 72 hours by default', async () => {
    const h = harness(318);
    await GET(h.req, h.res as never);
    const [filter, config] = h.customers.listAndCountCustomers.mock.calls[0];
    expect(filter.has_account).toBe(true);
    const from: Date = filter.created_at.$gte;
    const to: Date = filter.created_at.$lt;
    expect(to.getTime() - from.getTime()).toBe(72 * HOUR_MS);
    expect(config).toEqual({ take: 1, select: ['id'] });
    expect(h.res.body).toEqual({
      hours: 72,
      from: from.toISOString(),
      to: to.toISOString(),
      count: 318,
    });
  });

  it.each([
    ['500', 168],
    ['0', 1],
    ['24', 24],
    ['x', 72],
  ])('clamps ?hours=%s to %d', async (raw, hours) => {
    const h = harness(5, { hours: raw });
    await GET(h.req, h.res as never);
    expect((h.res.body as { hours: number }).hours).toBe(hours);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack yarn test:unit src/api/marketing/__tests__/signups-route.unit.spec.ts`

Expected: FAIL with `Cannot find module '../signups/route'`.

- [ ] **Step 3: Implement the route**

`backend/packages/api/src/api/marketing/signups/route.ts`:

```ts
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import { intParam } from '../query-params';

// GET /marketing/signups?hours=72 — how many registered accounts
// (has_account) were created in the window ending now. The sign-up post shows
// this exact number (spec 2026-09-29: real counts only, never marked up). A
// count, never rows: no customer data leaves this route.
const HOUR_MS = 60 * 60 * 1000;

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const hours = intParam(req.query.hours, 72, 1, 168);
  const to = new Date();
  const from = new Date(to.getTime() - hours * HOUR_MS);
  const customers = req.scope.resolve(Modules.CUSTOMER);
  const [, count] = await customers.listAndCountCustomers(
    { has_account: true, created_at: { $gte: from, $lt: to } },
    { take: 1, select: ['id'] },
  );
  res.json({ hours, from: from.toISOString(), to: to.toISOString(), count });
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `corepack yarn test:unit src/api/marketing/__tests__/signups-route.unit.spec.ts`

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/api/marketing/signups backend/packages/api/src/api/marketing/__tests__/signups-route.unit.spec.ts
git commit -m "feat(marketing): GET /marketing/signups with the real sign-up count

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: GET /marketing/challenge

**Files:**
- Create: `backend/packages/api/src/api/marketing/challenge/route.ts`
- Create: `backend/packages/api/src/api/marketing/__tests__/challenge-route.unit.spec.ts`

**Interfaces:**
- Produces: `GET /marketing/challenge` returning:

```ts
{
  week: { startUtc: string; endUtc: string };
  poolMyr: number;
  stages: {
    stageNumber: number;
    thresholdMyr: number;
    unlocked: boolean;
    progressPct: number; // floor(pool / threshold * 100), capped at 100
    prizes: { rank: 1 | 2 | 3; card: PrizeCard | null; credits: number }[];
    creditsRanks4to10: number;
  }[];
  nextStage: { stageNumber: number; thresholdMyr: number; remainingMyr: number; progressPct: number } | null;
  lastWeek: {
    startUtc: string;
    settled: boolean;
    winners: { rank: number; name: string; cards: PrizeCard[]; credits: number }[];
  };
}
// PrizeCard = { name: string; handle: string; image: string }
```

- [ ] **Step 1: Write the failing spec**

`backend/packages/api/src/api/marketing/__tests__/challenge-route.unit.spec.ts`:

```ts
import { GET } from '../challenge/route';

const CURRENT = {
  startUtc: new Date('2026-09-27T16:00:00.000Z'),
  endUtc: new Date('2026-10-04T16:00:00.000Z'),
};
const PREVIOUS = {
  startUtc: new Date('2026-09-20T16:00:00.000Z'),
  endUtc: new Date('2026-09-27T16:00:00.000Z'),
};
const HOUR_MS = 60 * 60 * 1000;

function harness(opts: { pool?: number; payouts?: unknown[] } = {}) {
  const packs = {
    challengeSettings: jest.fn().mockResolvedValue({
      timezone: 'Asia/Kuala_Lumpur',
      reset_day: 1,
      reset_hour: 0,
    }),
    challengeWeekBounds: jest.fn(async (o: { weeksBack?: number }) =>
      o.weeksBack === 1 ? PREVIOUS : CURRENT,
    ),
    challengeWeekPool: jest.fn().mockResolvedValue(opts.pool ?? 800),
    listChallengeStages: jest.fn().mockResolvedValue([
      {
        stage_number: 2,
        threshold_myr: 2000,
        rank_rewards: [
          { rank: 1, card_id: 'card_b', credits: 0 },
          { rank: 4, card_id: null, credits: 50 },
        ],
      },
      {
        stage_number: 1,
        threshold_myr: 1000,
        rank_rewards: [
          { rank: 1, card_id: 'card_a', credits: 0 },
          { rank: 2, card_id: 'card_b', credits: 0 },
          { rank: 3, card_id: null, credits: 100 },
          { rank: 4, card_id: null, credits: 30 },
          { rank: 10, card_id: null, credits: 10 },
        ],
      },
    ]),
    listCards: jest.fn().mockResolvedValue([
      { id: 'card_a', name: 'Charizard', handle: 'zard-10', image: '/a.png', slab_image: '/a-slab.png' },
      { id: 'card_b', name: 'Mew', handle: 'mew-10', image: '/b.png', slab_image: null },
    ]),
    listChallengePayouts: jest.fn().mockResolvedValue(
      opts.payouts ?? [
        { customer_id: 'cus_1', rank: 1, kind: 'card', card_id: 'card_a', credits: 0, status: 'granted' },
        { customer_id: 'cus_2', rank: 2, kind: 'card', card_id: 'card_b', credits: 0, status: 'skipped_no_stock' },
        { customer_id: 'cus_3', rank: 3, kind: 'credits', card_id: '', credits: 100, status: 'granted' },
        { customer_id: 'cus_4', rank: 4, kind: 'credits', card_id: '', credits: 30, status: 'granted' },
      ],
    ),
    disabledCustomerIds: jest.fn().mockResolvedValue(new Set(['cus_3'])),
  };
  const customers = {
    listCustomers: jest.fn().mockResolvedValue([
      { id: 'cus_1', first_name: 'Ali', metadata: null },
      { id: 'cus_2', first_name: 'Bob', metadata: null },
    ]),
  };
  const req = {
    scope: { resolve: (k: string) => (k === 'customer' ? customers : packs) },
  } as never;
  const res = {
    body: undefined as unknown,
    json(body: unknown) {
      this.body = body;
    },
  };
  return { packs, req, res };
}

const CHARIZARD = { name: 'Charizard', handle: 'zard-10', image: '/a-slab.png' };
const MEW = { name: 'Mew', handle: 'mew-10', image: '/b.png' };

afterEach(() => jest.useRealTimers());

describe('GET /marketing/challenge', () => {
  it('reports the week, the pool, each stage with its top-3 prizes, the next stage, and last week', async () => {
    jest.useFakeTimers().setSystemTime(new Date(CURRENT.startUtc.getTime() + 10 * HOUR_MS));
    const h = harness();
    await GET(h.req, h.res as never);
    expect(h.res.body).toEqual({
      week: { startUtc: CURRENT.startUtc.toISOString(), endUtc: CURRENT.endUtc.toISOString() },
      poolMyr: 800,
      stages: [
        {
          stageNumber: 1,
          thresholdMyr: 1000,
          unlocked: false,
          progressPct: 80,
          prizes: [
            { rank: 1, card: CHARIZARD, credits: 0 },
            { rank: 2, card: MEW, credits: 0 },
            { rank: 3, card: null, credits: 100 },
          ],
          creditsRanks4to10: 40,
        },
        {
          stageNumber: 2,
          thresholdMyr: 2000,
          unlocked: false,
          progressPct: 40,
          prizes: [{ rank: 1, card: MEW, credits: 0 }],
          creditsRanks4to10: 50,
        },
      ],
      nextStage: { stageNumber: 1, thresholdMyr: 1000, remainingMyr: 200, progressPct: 80 },
      lastWeek: {
        startUtc: PREVIOUS.startUtc.toISOString(),
        settled: true,
        winners: [
          { rank: 1, name: 'Ali', cards: [CHARIZARD], credits: 0 },
          { rank: 2, name: 'Bob', cards: [], credits: 0 },
        ],
      },
    });
    expect(h.packs.listChallengePayouts).toHaveBeenCalledWith(
      { week_start: PREVIOUS.startUtc },
      { take: 1000 },
    );
  });

  it('floors progress so 79.95% never reads as 80%', async () => {
    const h = harness({ pool: 799.5 });
    await GET(h.req, h.res as never);
    const body = h.res.body as { stages: { progressPct: number }[] };
    expect(body.stages[0].progressPct).toBe(79);
  });

  it('marks every stage unlocked and has no next stage once the pool clears them all', async () => {
    const h = harness({ pool: 2500 });
    await GET(h.req, h.res as never);
    const body = h.res.body as {
      stages: { unlocked: boolean; progressPct: number }[];
      nextStage: unknown;
    };
    expect(body.stages.map((s) => [s.unlocked, s.progressPct])).toEqual([
      [true, 100],
      [true, 100],
    ]);
    expect(body.nextStage).toBeNull();
  });

  it('is not settled in the first 2 hours of a week with no payout rows yet', async () => {
    jest.useFakeTimers().setSystemTime(new Date(CURRENT.startUtc.getTime() + 30 * 60_000));
    const h = harness({ payouts: [] });
    await GET(h.req, h.res as never);
    expect((h.res.body as { lastWeek: { settled: boolean } }).lastWeek.settled).toBe(false);
  });

  it('counts a week with no winners as settled after 2 hours', async () => {
    jest.useFakeTimers().setSystemTime(new Date(CURRENT.startUtc.getTime() + 3 * HOUR_MS));
    const h = harness({ payouts: [] });
    await GET(h.req, h.res as never);
    expect((h.res.body as { lastWeek: { settled: boolean; winners: unknown[] } }).lastWeek).toEqual({
      startUtc: PREVIOUS.startUtc.toISOString(),
      settled: true,
      winners: [],
    });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack yarn test:unit src/api/marketing/__tests__/challenge-route.unit.spec.ts`

Expected: FAIL with `Cannot find module '../challenge/route'`.

- [ ] **Step 3: Implement the route**

`backend/packages/api/src/api/marketing/challenge/route.ts`:

```ts
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../modules/packs/service';
import { PACKS_MODULE } from '../../../modules/packs';
import type { ChallengeRankReward } from '../../../modules/packs/challenge-validate';
import { publicProfileFields, seedOf } from '../../../utils/profile-handle';

// GET /marketing/challenge — the Weekly Pulled Value Challenge as the
// marketing posts need it (spec 2026-09-29): this week's pool and stages with
// their top-3 prizes, the next locked stage (for the 80% post), and last
// week's settled top 3 (for the new-week post). Week bounds come from
// challengeWeekBounds, the same CTE settlement uses. `settled` is true once
// last week has payout rows OR two hours have passed since this week began
// (the settle job is hourly), so a week with no winners never blocks the
// new-week post. Disabled players are dropped; names via publicProfileFields.
type PrizeCard = { name: string; handle: string; image: string };

const SETTLE_GRACE_MS = 2 * 60 * 60 * 1000;
const TOP_PRIZE_RANKS = 3;

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const customerService = req.scope.resolve(Modules.CUSTOMER);

  const settings = await packs.challengeSettings();
  const week = {
    timezone: settings.timezone,
    resetDay: settings.reset_day,
    resetHour: settings.reset_hour,
  };
  const [current, previous, poolMyr, stageRows] = await Promise.all([
    packs.challengeWeekBounds(week),
    packs.challengeWeekBounds({ ...week, weeksBack: 1 }),
    packs.challengeWeekPool(week),
    packs.listChallengeStages(
      {},
      { select: ['stage_number', 'threshold_myr', 'rank_rewards'], take: 1000 },
    ),
  ]);
  const payouts = await packs.listChallengePayouts(
    { week_start: previous.startUtc },
    { take: 1000 },
  );

  const stagesRaw = stageRows
    .map((r) => ({
      stageNumber: r.stage_number,
      thresholdMyr: Number(r.threshold_myr),
      rewards: ((r.rank_rewards as unknown as ChallengeRankReward[]) ?? [])
        .slice()
        .sort((a, b) => a.rank - b.rank),
    }))
    .sort((a, b) => a.stageNumber - b.stageNumber);

  const cardIds = [
    ...new Set([
      ...stagesRaw.flatMap((s) =>
        s.rewards
          .map((x) => x.card_id)
          .filter((id): id is string => Boolean(id)),
      ),
      ...payouts
        .filter((p) => p.kind === 'card' && p.card_id)
        .map((p) => p.card_id),
    ]),
  ];
  const cardRows = cardIds.length
    ? await packs.listCards(
        { id: cardIds },
        {
          select: ['id', 'name', 'handle', 'image', 'slab_image'],
          take: cardIds.length,
        },
      )
    : [];
  const cardById = new Map<string, PrizeCard>(
    cardRows.map((c) => [
      c.id,
      { name: c.name, handle: c.handle, image: c.slab_image ?? c.image },
    ]),
  );

  const stages = stagesRaw.map((s) => ({
    stageNumber: s.stageNumber,
    thresholdMyr: s.thresholdMyr,
    unlocked: poolMyr >= s.thresholdMyr,
    progressPct: pct(poolMyr, s.thresholdMyr),
    prizes: s.rewards
      .filter((x) => x.rank <= TOP_PRIZE_RANKS)
      .map((x) => ({
        rank: x.rank,
        card: x.card_id ? (cardById.get(x.card_id) ?? null) : null,
        credits: Number(x.credits ?? 0),
      })),
    creditsRanks4to10: s.rewards
      .filter((x) => x.rank > TOP_PRIZE_RANKS)
      .reduce((sum, x) => sum + Number(x.credits ?? 0), 0),
  }));
  const locked = stages.find((s) => !s.unlocked);
  const nextStage = locked
    ? {
        stageNumber: locked.stageNumber,
        thresholdMyr: locked.thresholdMyr,
        remainingMyr: Math.round((locked.thresholdMyr - poolMyr) * 100) / 100,
        progressPct: locked.progressPct,
      }
    : null;

  // Last week's top 3, from the settled payout rows. A card counts only when
  // it was GRANTED (skipped_no_stock was never handed over).
  const top = payouts.filter((p) => p.rank <= TOP_PRIZE_RANKS);
  const winnerIds = [...new Set(top.map((p) => p.customer_id))];
  const [disabled, customers] = await Promise.all([
    packs.disabledCustomerIds(winnerIds),
    winnerIds.length
      ? customerService.listCustomers(
          { id: winnerIds },
          { take: winnerIds.length },
        )
      : Promise.resolve([]),
  ]);
  const byCustomer = new Map(customers.map((c) => [c.id, c]));
  const byRank = new Map<
    number,
    { customerId: string; cards: PrizeCard[]; credits: number }
  >();
  for (const p of top) {
    if (disabled.has(p.customer_id)) continue;
    const entry = byRank.get(p.rank) ?? {
      customerId: p.customer_id,
      cards: [],
      credits: 0,
    };
    if (p.status === 'granted') {
      if (p.kind === 'card') {
        const card = cardById.get(p.card_id);
        if (card) entry.cards.push(card);
      } else {
        entry.credits += Number(p.credits ?? 0);
      }
    }
    byRank.set(p.rank, entry);
  }
  const winners = [...byRank.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rank, w]) => ({
      rank,
      name: publicProfileFields(byCustomer.get(w.customerId), seedOf(w.customerId))
        .name,
      cards: w.cards,
      credits: w.credits,
    }));

  res.json({
    week: {
      startUtc: current.startUtc.toISOString(),
      endUtc: current.endUtc.toISOString(),
    },
    poolMyr,
    stages,
    nextStage,
    lastWeek: {
      startUtc: previous.startUtc.toISOString(),
      settled:
        payouts.length > 0 ||
        Date.now() - current.startUtc.getTime() >= SETTLE_GRACE_MS,
      winners,
    },
  });
}

function pct(pool: number, threshold: number): number {
  if (threshold <= 0) return 100;
  return Math.min(100, Math.floor((pool / threshold) * 100));
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `corepack yarn test:unit src/api/marketing/__tests__/challenge-route.unit.spec.ts`

Expected: PASS (5 tests).

If TypeScript reports that `listChallengePayouts` rows type `credits` as a BigNumber, keep the `Number(...)` wrap already in the code. Do not change the model.

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/api/marketing/challenge backend/packages/api/src/api/marketing/__tests__/challenge-route.unit.spec.ts
git commit -m "feat(marketing): GET /marketing/challenge with stages, next stage and last week's winners

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: GET /marketing/tasks

**Files:**
- Create: `backend/packages/api/src/api/marketing/tasks/route.ts`
- Create: `backend/packages/api/src/api/marketing/__tests__/tasks-route.unit.spec.ts`

**Interfaces:**
- Consumes: `taskWeekFor(at: Date): { startUtc: Date; endUtcExcl: Date }` from `modules/packs/referral.ts`; `TaskReward` from `modules/packs/tasks.ts`.
- Produces: `GET /marketing/tasks?week=next|current` (default `next`) returning:

```ts
{
  week: { startUtc: string; endUtcExcl: string };
  tasks: {
    id: string;
    title: string;
    reward:
      | { type: 'credit'; amountMyr: number }
      | { type: 'pack'; packTitle: string | null }
      | { type: 'card'; cardName: string | null; image: string | null };
    startsAt: string | null;
    endsAt: string | null;
  }[];
}
```

- [ ] **Step 1: Write the failing spec**

`backend/packages/api/src/api/marketing/__tests__/tasks-route.unit.spec.ts`:

```ts
import { GET } from '../tasks/route';

// Friday 2 Oct 2026, 17:00 MYT. Current task week: Mon 28 Sep 00:00 MYT
// (2026-09-27T16:00Z). Next task week: Mon 5 Oct 00:00 MYT (2026-10-04T16:00Z).
const NOW = new Date('2026-10-02T09:00:00.000Z');
const NEXT_START = '2026-10-04T16:00:00.000Z';
const NEXT_END = '2026-10-11T16:00:00.000Z';
const CURRENT_START = '2026-09-27T16:00:00.000Z';

const defs = [
  { id: 't1', kind: 'weekly', title: 'Open 5 packs', reward: { type: 'credit', amount_myr: 5 }, starts_at: null, ends_at: null, sort: 0 },
  { id: 't2', kind: 'weekly', title: 'Check in 7 days', reward: { type: 'pack', pack_id: 'gold' }, starts_at: new Date(NEXT_START), ends_at: null, sort: 1 },
  { id: 't3', kind: 'weekly', title: 'Pull a Legendary', reward: { type: 'card', card_handle: 'zard-10' }, starts_at: null, ends_at: new Date(NEXT_START), sort: 2 },
];

function harness(query: Record<string, unknown> = {}) {
  const packs = {
    listTaskDefinitions: jest.fn().mockResolvedValue(defs),
    listPacks: jest.fn().mockResolvedValue([{ slug: 'gold', title: 'Gold Pack' }]),
    listCards: jest.fn().mockResolvedValue([
      { handle: 'zard-10', name: 'Charizard', image: '/z.png', slab_image: '/z-slab.png' },
    ]),
  };
  const req = { query, scope: { resolve: () => packs } } as never;
  const res = {
    statusCode: 200,
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
  return { packs, req, res };
}

beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
afterEach(() => jest.useRealTimers());

describe('GET /marketing/tasks', () => {
  it("defaults to NEXT week: the always-on task plus the one starting then, with rewards resolved", async () => {
    const h = harness();
    await GET(h.req, h.res as never);
    expect(h.packs.listTaskDefinitions).toHaveBeenCalledWith(
      { kind: 'weekly', active: true },
      { order: { sort: 'ASC' }, take: 500 },
    );
    expect(h.res.body).toEqual({
      week: { startUtc: NEXT_START, endUtcExcl: NEXT_END },
      tasks: [
        { id: 't1', title: 'Open 5 packs', reward: { type: 'credit', amountMyr: 5 }, startsAt: null, endsAt: null },
        { id: 't2', title: 'Check in 7 days', reward: { type: 'pack', packTitle: 'Gold Pack' }, startsAt: NEXT_START, endsAt: null },
      ],
    });
  });

  it('?week=current returns the tasks running now, including one that ends before next week', async () => {
    const h = harness({ week: 'current' });
    await GET(h.req, h.res as never);
    const body = h.res.body as {
      week: { startUtc: string };
      tasks: { id: string; reward: unknown }[];
    };
    expect(body.week.startUtc).toBe(CURRENT_START);
    expect(body.tasks.map((t) => t.id)).toEqual(['t1', 't3']);
    expect(body.tasks[1].reward).toEqual({
      type: 'card',
      cardName: 'Charizard',
      image: '/z-slab.png',
    });
  });

  it('answers 400 for an unknown ?week', async () => {
    const h = harness({ week: 'someday' });
    await GET(h.req, h.res as never);
    expect(h.res.statusCode).toBe(400);
    expect(h.packs.listTaskDefinitions).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `corepack yarn test:unit src/api/marketing/__tests__/tasks-route.unit.spec.ts`

Expected: FAIL with `Cannot find module '../tasks/route'`.

- [ ] **Step 3: Implement the route**

`backend/packages/api/src/api/marketing/tasks/route.ts`:

```ts
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import PacksModuleService from '../../../modules/packs/service';
import { PACKS_MODULE } from '../../../modules/packs';
import { taskWeekFor } from '../../../modules/packs/referral';
import type { TaskReward } from '../../../modules/packs/tasks';

// GET /marketing/tasks?week=next|current — the weekly tasks that run in that
// task week (Monday 00:00 MYT, taskWeekFor), for the Friday "tasks ready?"
// check and the Monday tasks post (spec 2026-09-29). A task runs in the week
// when it is active and its optional [starts_at, ends_at) window overlaps the
// week; null ends mean open-ended. Rewards are resolved to what a post can
// show: the credit amount, the pack's title, or the card's name and slab art.
type Week = { startUtc: Date; endUtcExcl: Date };

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const which = req.query.week ?? 'next';
  if (which !== 'next' && which !== 'current') {
    res.status(400).json({ message: "week must be 'next' or 'current'." });
    return;
  }
  const current = taskWeekFor(new Date());
  const week: Week =
    which === 'current' ? current : taskWeekFor(current.endUtcExcl);

  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const defs = await packs.listTaskDefinitions(
    { kind: 'weekly', active: true },
    { order: { sort: 'ASC' }, take: 500 },
  );
  const running = defs.filter((d) => overlaps(d, week));

  const rewards = running.map((d) => d.reward as unknown as TaskReward);
  const packSlugs = [
    ...new Set(
      rewards.flatMap((r) => (r.type === 'pack' ? [r.pack_id] : [])),
    ),
  ];
  const cardHandles = [
    ...new Set(
      rewards.flatMap((r) => (r.type === 'card' ? [r.card_handle] : [])),
    ),
  ];
  const [packRows, cardRows] = await Promise.all([
    packSlugs.length
      ? packs.listPacks({ slug: packSlugs }, { take: packSlugs.length })
      : Promise.resolve([]),
    cardHandles.length
      ? packs.listCards({ handle: cardHandles }, { take: cardHandles.length })
      : Promise.resolve([]),
  ]);
  const packTitle = new Map(packRows.map((p) => [p.slug, p.title]));
  const cardByHandle = new Map(cardRows.map((c) => [c.handle, c]));

  res.json({
    week: {
      startUtc: week.startUtc.toISOString(),
      endUtcExcl: week.endUtcExcl.toISOString(),
    },
    tasks: running.map((d) => {
      const r = d.reward as unknown as TaskReward;
      const card = r.type === 'card' ? cardByHandle.get(r.card_handle) : null;
      return {
        id: d.id,
        title: d.title,
        reward:
          r.type === 'credit'
            ? { type: 'credit' as const, amountMyr: Number(r.amount_myr) }
            : r.type === 'pack'
              ? { type: 'pack' as const, packTitle: packTitle.get(r.pack_id) ?? null }
              : {
                  type: 'card' as const,
                  cardName: card?.name ?? null,
                  image: card ? (card.slab_image ?? card.image) : null,
                },
        startsAt: d.starts_at ? new Date(d.starts_at).toISOString() : null,
        endsAt: d.ends_at ? new Date(d.ends_at).toISOString() : null,
      };
    }),
  });
}

function overlaps(
  d: { starts_at: Date | string | null; ends_at: Date | string | null },
  week: Week,
): boolean {
  const startsBeforeEnd =
    d.starts_at == null ||
    new Date(d.starts_at).getTime() < week.endUtcExcl.getTime();
  const endsAfterStart =
    d.ends_at == null ||
    new Date(d.ends_at).getTime() > week.startUtc.getTime();
  return startsBeforeEnd && endsAfterStart;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `corepack yarn test:unit src/api/marketing/__tests__/tasks-route.unit.spec.ts`

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/api/marketing/tasks backend/packages/api/src/api/marketing/__tests__/tasks-route.unit.spec.ts
git commit -m "feat(marketing): GET /marketing/tasks for the Friday check and Monday post

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: HTTP integration: auth and live data through the real stack

**Files:**
- Modify: `backend/packages/api/integration-tests/http/marketing-feed.spec.ts` (created in Task 2)

**Interfaces:**
- Consumes: every route from Tasks 3–6 and the middleware from Task 1.

- [ ] **Step 1: Add the failing HTTP specs**

1. In `marketing-feed.spec.ts`, add these imports under the existing ones:

```ts
import { Modules } from '@medusajs/framework/utils';
import { unwrapResponse } from './utils';
```

2. Change the runner's `testSuite: ({ getContainer }) => {` to `testSuite: ({ api, getContainer }) => {`.

3. Add this `describe` block after the existing one, inside `testSuite`:

```ts
    describe('GET /marketing/* over HTTP', () => {
      const KEY = 'm'.repeat(48);
      const ORIGINAL = process.env.MARKETING_FEED_KEY;
      const withKey = (key = KEY) => ({ headers: { 'x-marketing-key': key } });

      beforeEach(async () => {
        process.env.MARKETING_FEED_KEY = KEY;
        await seedCatalog();
      });
      afterAll(() => {
        if (ORIGINAL === undefined) delete process.env.MARKETING_FEED_KEY;
        else process.env.MARKETING_FEED_KEY = ORIGINAL;
      });

      it('401s without the key or with a wrong one, and 503s when the feed is unconfigured', async () => {
        expect((await unwrapResponse(api.get('/marketing/signups'))).status).toBe(401);
        expect(
          (await unwrapResponse(api.get('/marketing/signups', withKey('w'.repeat(48))))).status,
        ).toBe(401);
        delete process.env.MARKETING_FEED_KEY;
        expect(
          (await unwrapResponse(api.get('/marketing/signups', withKey()))).status,
        ).toBe(503);
      });

      it('counts registered sign-ups in the window', async () => {
        const customers = getContainer().resolve(Modules.CUSTOMER);
        await customers.createCustomers([
          { email: 'mk-a@test.dev', has_account: true },
          { email: 'mk-b@test.dev', has_account: true },
          { email: 'mk-guest@test.dev', has_account: false },
        ]);
        const res = await unwrapResponse(api.get('/marketing/signups?hours=1', withKey()));
        expect(res.status).toBe(200);
        expect(res.data.count).toBe(2);
      });

      it('serves a revealed Immortal pull with a public name, and hides a disabled player', async () => {
        const customers = getContainer().resolve(Modules.CUSTOMER);
        const [ali, bob] = await customers.createCustomers([
          { email: 'mk-ali@test.dev', first_name: 'Ali', has_account: true },
          { email: 'mk-bob@test.dev', first_name: 'Bob', has_account: true },
        ]);
        const now = new Date();
        await packs().createPulls([
          { customer_id: ali.id, pack_id: PACK, card_id: IMMORTAL, rolled_at: now, revealed_at: now, source: 'pack' },
          { customer_id: bob.id, pack_id: PACK, card_id: IMMORTAL, rolled_at: now, revealed_at: now, source: 'pack' },
        ] as Parameters<PacksModuleService['createPulls']>[0]);
        await packs().setAccountDisabled({
          customerId: bob.id,
          adminId: 'user_mk_admin',
          disabled: true,
          reason: 'test disable',
        });

        const res = await unwrapResponse(api.get('/marketing/pulls', withKey()));
        expect(res.status).toBe(200);
        expect(res.data.pulls).toHaveLength(1);
        expect(res.data.pulls[0]).toMatchObject({
          tier: 'Immortal',
          name: 'Ali',
          card: { handle: IMMORTAL, image: '/i-slab.webp', grade: 'PSA 10' },
          pack: { slug: PACK, title: 'MK Pack' },
        });
        expect(JSON.stringify(res.data)).not.toContain('mk-ali@test.dev');
        expect(JSON.stringify(res.data)).not.toContain(ali.id);
        expect(typeof res.data.next).toBe('string');

        const again = await unwrapResponse(
          api.get(`/marketing/pulls?after=${res.data.next}`, withKey()),
        );
        expect(again.data.pulls).toEqual([]);
      });

      it('serves the challenge and tasks payloads', async () => {
        const challenge = await unwrapResponse(api.get('/marketing/challenge', withKey()));
        expect(challenge.status).toBe(200);
        expect(challenge.data).toHaveProperty('week.startUtc');
        expect(challenge.data).toHaveProperty('lastWeek.settled');
        const tasks = await unwrapResponse(api.get('/marketing/tasks?week=current', withKey()));
        expect(tasks.status).toBe(200);
        expect(Array.isArray(tasks.data.tasks)).toBe(true);
      });
    });
```

- [ ] **Step 2: Run the integration spec**

Run: `corepack yarn test:integration:http marketing-feed.spec`

Expected: PASS (6 tests). If a new test fails, fix the route, not the test, unless the test contradicts the Global Constraints.

If `api.get('/marketing/...')` answers 404 for every route, confirm the route files are named `route.ts` under `src/api/marketing/<name>/`. Then restart the runner; Medusa scans routes at boot.

- [ ] **Step 3: Commit**

```bash
git add backend/packages/api/integration-tests/http/marketing-feed.spec.ts
git commit -m "test(marketing): prove the feed's key, gates and payloads through HTTP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Full verification and pull request

**Files:** none new.

- [ ] **Step 1: Type-check the backend**

Run (from `backend/packages/api`): `corepack yarn tsc --noEmit -p .`

Expected: no errors.

- [ ] **Step 2: Run the whole unit tier**

Run: `corepack yarn test:unit`

Expected: PASS. The limiter coverage probes in `src/api/__tests__` must still pass.

- [ ] **Step 3: Run the integration shard with the new spec plus its neighbours**

Run: `corepack yarn test:integration:http marketing-feed.spec challenge.spec leaderboard.spec`

Expected: PASS. `challenge.spec` and `leaderboard.spec` are the closest existing readers of the same tables.

- [ ] **Step 4: Push and open the pull request**

```bash
git push -u origin HEAD
gh pr create --title "feat(marketing): read-only /marketing/* data feed" --body "$(cat <<'EOF'
Build step 1 of docs/superpowers/specs/2026-09-29-marketing-automation-design.md.

Adds four key-protected GET routes the marketing publisher reads:
- /marketing/signups: real count of registered sign-ups in a window (default 72h)
- /marketing/challenge: pool, stages with top-3 prizes, next locked stage, last week's settled top 3
- /marketing/tasks: weekly tasks running in the current or next task week, rewards resolved
- /marketing/pulls: revealed Legendary/Immortal pulls after a cursor, with the Telegram apex gates

Security: a constant-time x-marketing-key check (503 when MARKETING_FEED_KEY is unset or shorter than 32 characters), a dedicated rate limiter keyed on the caller IP and run before the key check, and no email, phone or customer id in any response. Disabled players are excluded everywhere.

Deploy note: set the MARKETING_FEED_KEY secret on services.backend in App Platform before merging; without it the feed answers 503.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: the PR URL is printed. The deploy waits for the operator: the `MARKETING_FEED_KEY` secret has to be set in App Platform first.
