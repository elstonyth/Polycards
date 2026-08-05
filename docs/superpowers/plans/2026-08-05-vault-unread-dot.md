# Vault Tab Unread Dot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a Paper White dot on the Vault tab that signals "something arrived in your vault since you last looked", and clear it when the customer opens `/vault`.

**Architecture:** One new backend read route returns `max(pull.updated_at)` over the caller's `status='vaulted'` pulls — the status filter alone makes arrivals light the dot and self-initiated departures stay silent, so no schema change is needed. The storefront holds last-seen in `localStorage` keyed by customer id, and a small React context (`VaultDotProvider`) fetches once per navigation and feeds both nav renderings.

**Tech Stack:** Medusa v2 (backend routes + module service), Next.js App Router + React 19 (storefront), Tailwind v4, Zod v4 (`z.looseObject`), Vitest (storefront), Jest (backend).

**Spec:** `docs/superpowers/specs/2026-08-05-vault-red-dot-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **TypeScript strict, no `any`.** Named exports, PascalCase components, camelCase utils, 2-space indent. (`AGENTS.md`)
- **Tailwind utility classes, no inline styles.**
- **Dot color is `bg-neutral-50` (Paper White), NOT red.** `DESIGN.md:143` reserves Alarm Red (#f87171) for errors and destructive confirmation only. Inverts to `bg-neutral-950` on the desktop nav's active pill.
- **No animation on the dot.** No pulse, no fade. `DESIGN.md:121` rejects "cheap gacha/casino neon".
- **A global (non-repo) prettier hook rewrites backend `.ts` double quotes to single on every Edit/Write**, burying real changes in whole-file churn AND failing CI `format:check`. For backend files, **write them via a node script through the Bash tool** rather than the Edit/Write tools. Storefront files are unaffected (they already use single quotes).
- **A PostToolUse hook type-checks after every `.ts`/`.tsx` edit, and a Stop hook blocks finishing on real type errors.** Expect typecheck feedback inline; fix before moving on.
- **Do not run `next dev` to verify.** `next.config.ts` sets `output: 'standalone'`. Verify with `npm run build` then `pwsh scripts/serve-standalone.ps1 -Port 4000`.
- **Branch:** work continues on `docs/vault-unread-dot-spec` (already cut from `origin/master`, carries the spec commit `6a87710f`). `master` is branch-protected — never commit to it directly.
- **Commit after every task.** Conventional commits. End messages with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

| file | responsibility |
| --- | --- |
| `backend/packages/api/src/api/store/vault/latest/route.ts` | **new** — the signal. One indexed read, owner-scoped from the token. |
| `backend/packages/api/src/api/store/vault/latest/__tests__/route.unit.spec.ts` | **new** — pins the route contract (owner-scoping, status filter, ordering). |
| `backend/packages/api/src/api/middlewares.ts` | **modify** — +1 matcher entry (auth + read rate limit). |
| `backend/packages/api/integration-tests/http/vault-latest.spec.ts` | **new** — 401, newest-wins, IDOR. |
| `src/lib/vault-dot.ts` | **new** — the only branching logic: storage key + comparison. No React, no I/O, fully testable. |
| `src/lib/__tests__/vault-dot.test.ts` | **new** — table over the above. |
| `src/lib/data/schemas.ts` | **modify** — `+VaultLatestSchema`. |
| `src/lib/actions/vault.ts` | **modify** — `+getVaultLatest()`. |
| `src/components/app-shell/VaultDotProvider.tsx` | **new** — identity-tagged state + TTL-throttled focus refresh. |
| `src/app/layout.tsx` | **modify** — wrap, inside `TopUpProvider`. |
| `src/components/app-shell/TabBar.tsx` | **modify** — dot on the mobile Vault icon. |
| `src/components/app-shell/AppHeader.tsx` | **modify** — dot on the desktop Vault icon, inverted when active. |
| `src/app/(account)/vault/VaultClient.tsx` | **modify** — `markSeen()` effect. |

---

### Task 1: Backend route + middleware matcher

The route and its matcher ship together on purpose: a route without its matcher entry is an **unauthenticated** endpoint that leaks vault activity timing for any customer id. Never land one without the other.

**Files:**
- Create: `backend/packages/api/src/api/store/vault/latest/route.ts`
- Create: `backend/packages/api/src/api/store/vault/latest/__tests__/route.unit.spec.ts`
- Modify: `backend/packages/api/src/api/middlewares.ts` (after the `'/store/vault'` entry, ~line 394-398)

**Interfaces:**
- Consumes: `PacksModuleService.listPulls(filters, config)` and `PACKS_MODULE` — both already used by `src/api/store/vault/route.ts`.
- Produces: `GET /store/vault/latest` → `{ latest_event_at: string | null }` (ISO 8601). Task 4 consumes this shape.

> **Reminder:** write these backend files with a node script through Bash, not Edit/Write — see Global Constraints.

- [ ] **Step 1: Write the failing test**

Create `backend/packages/api/src/api/store/vault/latest/__tests__/route.unit.spec.ts`:

```ts
import { GET as latest } from '../route';

// The route's whole job is: read the caller's own newest vault-visible pull.
// This spec pins the three things that make it correct — the customer id comes
// from the verified token (never params/query), the status filter is present
// (it is what keeps sell-backs and ship-outs from lighting the dot), and an
// empty vault answers null rather than omitting the key.
const mkRes = () => {
  const out: { body?: unknown } = {};
  return { res: { json: (b: unknown) => (out.body = b) } as never, out };
};

const listPulls = jest.fn();

const mkReq = (customerId = 'cus_1') => ({
  auth_context: { actor_id: customerId },
  query: {},
  params: {},
  scope: { resolve: () => ({ listPulls }) },
});

beforeEach(() => {
  listPulls.mockReset().mockResolvedValue([]);
});

describe('GET /store/vault/latest', () => {
  it("reads only the caller's own vaulted pulls, newest first, one row", async () => {
    const { res, out } = mkRes();

    await latest(mkReq('cus_me') as never, res);

    expect(listPulls).toHaveBeenCalledWith(
      { customer_id: 'cus_me', status: 'vaulted' },
      { order: { updated_at: 'DESC' }, take: 1 },
    );
    expect(out.body).toEqual({ latest_event_at: null });
  });

  it('returns the newest row updated_at when the vault is not empty', async () => {
    const when = new Date('2026-08-05T10:00:00.000Z');
    listPulls.mockResolvedValue([{ id: 'pull_1', updated_at: when }]);
    const { res, out } = mkRes();

    await latest(mkReq() as never, res);

    expect(out.body).toEqual({ latest_event_at: when });
  });

  it('ignores a customer id supplied in params or query (IDOR)', async () => {
    const req = {
      ...mkReq('cus_me'),
      params: { customer_id: 'cus_victim' },
      query: { customer_id: 'cus_victim' },
    };
    const { res } = mkRes();

    await latest(req as never, res);

    expect(listPulls).toHaveBeenCalledWith(
      expect.objectContaining({ customer_id: 'cus_me' }),
      expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules \
  node node_modules/jest/bin/jest.js --runInBand --forceExit src/api/store/vault/latest
```

Expected: FAIL — `Cannot find module '../route'`.

- [ ] **Step 3: Write the route**

Create `backend/packages/api/src/api/store/vault/latest/route.ts`:

```ts
import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';

// GET /store/vault/latest — the newest vault-visible event for the caller.
//
// Feeds the Vault tab's unread dot: the client compares this stamp against its
// own last-seen value and shows a dot when this one is newer. Deliberately NOT
// folded into GET /store/vault — the dot is read from every page, and must not
// pay for a 500-item vault list.
//
// The `status: 'vaulted'` filter is the whole design. Events that should light
// the dot (a new pull, a canceled delivery returning its cards) bump
// updated_at on a row INSIDE the filter; departures the customer initiated
// themselves (ship-out → 'delivering', sell-back → 'bought_back') bump a row
// that has just left it, so they stay silent. No extra column, no workflow
// edits. See docs/superpowers/specs/2026-08-05-vault-red-dot-design.md.
//
// AUTH: matcher registered in src/api/middlewares.ts with authenticate(); the
// customer id comes ONLY from the verified token, so a caller can never probe
// another customer's vault activity.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);

  // No new index needed: IDX_pull_customer_id_rolled_at seeks on customer_id,
  // and VAULT_LIMIT caps a customer at 500 rows, so the residual sort is trivial.
  const [newest] = await packs.listPulls(
    { customer_id: req.auth_context.actor_id, status: 'vaulted' },
    { order: { updated_at: 'DESC' }, take: 1 },
  );

  res.json({ latest_event_at: newest?.updated_at ?? null });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules \
  node node_modules/jest/bin/jest.js --runInBand --forceExit src/api/store/vault/latest
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Register the matcher**

In `backend/packages/api/src/api/middlewares.ts`, immediately **after** the existing `'/store/vault'` entry:

```ts
    {
      // The customer's vault list (GET /store/vault).
      matcher: '/store/vault',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
```

insert:

```ts
    {
      // Vault unread-dot signal (GET /store/vault/latest). A separate entry
      // because the matcher above is EXACT — the same reason
      // '/store/vault/buyback-batch' needed its own. Shares the read budget
      // with vault/credits/vip/notifications: it is a one-row indexed read,
      // and the client throttles itself to one call per 30s per session.
      matcher: '/store/vault/latest',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
```

No collision with `'/store/vault/*/buyback'` or `'/store/vault/*/showcase'` — two path segments vs three.

- [ ] **Step 6: Type-check the backend**

```bash
cd backend/packages/api && node node_modules/typescript/bin/tsc --noEmit
```

Expected: no errors. (Call the local `tsc` binary directly — a globally installed TypeScript 7 shadows the pinned 5.9.3 and fails with a spurious TS5102/baseUrl error.)

- [ ] **Step 7: Commit**

```bash
git add backend/packages/api/src/api/store/vault/latest backend/packages/api/src/api/middlewares.ts
git commit -m "feat(vault): add GET /store/vault/latest, the unread-dot signal

max(pull.updated_at) over the caller's status='vaulted' pulls. The status
filter is the design: arrivals bump a row inside it, self-initiated
departures bump one that just left, so sell-backs and ship-outs stay silent.

Matcher gets its own middlewares.ts entry — '/store/vault' is exact.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Backend integration test (auth + IDOR)

Task 1's unit spec pins the handler in isolation; it cannot prove the matcher is wired. This task proves the endpoint is actually authenticated and actually owner-scoped over HTTP.

**Files:**
- Create: `backend/packages/api/integration-tests/http/vault-latest.spec.ts`

**Interfaces:**
- Consumes: `GET /store/vault/latest` from Task 1; `mintSuperAdmin`, `unwrapResponse` from `./utils`; `PacksModuleService.createPulls`.
- Produces: nothing consumed downstream.

> Requires the `pokenic-postgres` Docker container to be running.

- [ ] **Step 1: Write the test**

Create `backend/packages/api/integration-tests/http/vault-latest.spec.ts`:

```ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'vl-test-password-1';
const OLD = new Date('2026-08-01T00:00:00.000Z');
const NEW = new Date('2026-08-04T00:00:00.000Z');

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /store/vault/latest — the unread-dot signal', () => {
      let storeHeaders: Record<string, string>;
      let packs: PacksModuleService;

      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'vault-latest-test',
          type: 'publishable',
          created_by: 'vault-latest-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        packs = container.resolve<PacksModuleService>(PACKS_MODULE);
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      // The register JWT carries actor_id: '' until POST /store/customers links
      // it, so log in AGAIN after linking — otherwise the customer id below is
      // empty and every owner-scoping assertion passes vacuously.
      const registerCustomer = async (
        email: string,
      ): Promise<{ token: string; id: string }> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        await api.post(
          '/store/customers',
          { email },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        const login = await api.post('/auth/customer/emailpass', {
          email,
          password: PASSWORD,
        });
        const token = login.data.token;
        const me = await unwrapResponse(
          api.get('/store/customers/me', { headers: authed(token) }),
        );
        const id = me.data.customer.id as string;
        expect(id).toBeTruthy();
        return { token, id };
      };

      it('rejects unauthenticated access with 401', async () => {
        const res = await unwrapResponse(
          api.get('/store/vault/latest', { headers: storeHeaders }),
        );
        expect(res.status).toBe(401);
      });

      it('answers null for an empty vault', async () => {
        const { token } = await registerCustomer('vl-empty@test.dev');

        const res = await api.get('/store/vault/latest', {
          headers: authed(token),
        });

        expect(res.status).toBe(200);
        expect(res.data.latest_event_at).toBeNull();
      });

      // NOTE: freshly created rows all carry ~the same updated_at, so this case
      // deliberately does NOT assert which row won — ordering is pinned by the
      // route unit spec instead. What it proves here is owner-scoping and the
      // status filter, which are the things only a real HTTP round trip can show.
      it("never exposes another customer's rows, and ignores bought_back", async () => {
        const a = await registerCustomer('vl-a@test.dev');
        const b = await registerCustomer('vl-b@test.dev');

        await packs.createPulls([
          {
            customer_id: a.id,
            pack_id: 'vl-pack',
            card_id: 'vl-card-old',
            rolled_at: OLD,
            status: 'vaulted',
          },
          {
            customer_id: a.id,
            pack_id: 'vl-pack',
            card_id: 'vl-card-new',
            rolled_at: NEW,
            status: 'vaulted',
          },
          // B's ONLY pull, already sold back. B's expected null therefore proves
          // two things at once: A's vaulted rows are invisible to B (IDOR), and
          // a sell-back does not light B's own dot (the status filter).
          {
            customer_id: b.id,
            pack_id: 'vl-pack',
            card_id: 'vl-card-sold',
            rolled_at: NEW,
            status: 'bought_back',
          },
        ]);

        const resA = await api.get('/store/vault/latest', {
          headers: authed(a.token),
        });
        expect(resA.status).toBe(200);
        expect(resA.data.latest_event_at).not.toBeNull();

        const resB = await api.get('/store/vault/latest', {
          headers: authed(b.token),
        });
        expect(resB.status).toBe(200);
        expect(resB.data.latest_event_at).toBeNull();
      });

      it('goes quiet when the only vaulted pull leaves for delivery', async () => {
        const c = await registerCustomer('vl-ship@test.dev');

        const [pull] = await packs.createPulls([
          {
            customer_id: c.id,
            pack_id: 'vl-pack',
            card_id: 'vl-card-ship',
            rolled_at: OLD,
            status: 'vaulted',
          },
        ]);
        expect(
          (await api.get('/store/vault/latest', { headers: authed(c.token) }))
            .data.latest_event_at,
        ).not.toBeNull();

        await packs.updatePulls([{ id: pull.id, status: 'delivering' }]);

        const after = await api.get('/store/vault/latest', {
          headers: authed(c.token),
        });
        expect(after.data.latest_event_at).toBeNull();
      });
    });
  },
});
```

- [ ] **Step 2: Run the test**

```bash
cd backend/packages/api && node integration-tests/run-http-shards.mjs vault-latest.spec
```

Expected: PASS, 4 tests. If it fails with a `TRUNCATE` deadlock, that is a known flake — rerun before investigating.

**If the 401 test fails with 200**, the matcher from Task 1 Step 5 is missing or misplaced. Fix that, do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add backend/packages/api/integration-tests/http/vault-latest.spec.ts
git commit -m "test(vault): cover /store/vault/latest auth, IDOR, and status filter

Proves over HTTP what the unit spec cannot: the matcher is wired (401 when
unauthenticated), one customer never sees another's pulls, and a card leaving
for delivery goes quiet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Storefront pure logic

This is the only part of the feature with branches, so it is the only part that gets a unit test. It lives outside the provider precisely so it is testable without React or `localStorage`.

**Files:**
- Create: `src/lib/vault-dot.ts`
- Create: `src/lib/__tests__/vault-dot.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `seenKey(customerId: string): string` and `shouldShowDot(latestAt: string | null, seenAt: string | null): boolean`. Task 5 consumes both.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/vault-dot.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { seenKey, shouldShowDot } from '@/lib/vault-dot';

const OLD = '2026-08-01T00:00:00.000Z';
const NEW = '2026-08-04T00:00:00.000Z';

describe('seenKey', () => {
  test('namespaces the key by customer id', () => {
    expect(seenKey('cus_a')).toBe('polycards.vault_seen_at:cus_a');
  });

  test('gives two customers different keys', () => {
    // TopUpProvider's balance leak was exactly this failure: an untagged value
    // handed account B whatever account A had left behind.
    expect(seenKey('cus_a')).not.toBe(seenKey('cus_b'));
  });
});

describe('shouldShowDot', () => {
  test('shows when there is an event and no stamp yet', () => {
    expect(shouldShowDot(NEW, null)).toBe(true);
  });

  test('hides when the stamp matches the newest event', () => {
    expect(shouldShowDot(NEW, NEW)).toBe(false);
  });

  test('shows when the stamp is older than the newest event', () => {
    expect(shouldShowDot(NEW, OLD)).toBe(true);
  });

  test('hides when the stamp is ahead of the newest event (clock skew)', () => {
    expect(shouldShowDot(OLD, NEW)).toBe(false);
  });

  test('hides when the vault is empty', () => {
    expect(shouldShowDot(null, OLD)).toBe(false);
    expect(shouldShowDot(null, null)).toBe(false);
  });

  test('shows on an unparseable stamp — degrade toward showing', () => {
    // A corrupt stamp costs one extra tab tap and self-heals on the next visit.
    // Hiding instead would silently swallow real arrivals forever.
    expect(shouldShowDot(NEW, 'not-a-date')).toBe(true);
  });

  test('hides on an unparseable event — never show a dot we cannot justify', () => {
    expect(shouldShowDot('not-a-date', null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/lib/__tests__/vault-dot.test.ts
```

Expected: FAIL — cannot resolve `@/lib/vault-dot`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/vault-dot.ts`:

```ts
// Pure logic for the Vault tab's unread dot. Deliberately outside
// VaultDotProvider: this is the only branching part of the feature, and it is
// testable here without React, a DOM, or localStorage.

/**
 * localStorage key holding a customer's last-seen vault stamp.
 *
 * ALWAYS keyed by customer id. TopUpProvider carries the scar in its own
 * comment — "on logout→login as a different account, an untagged balance
 * briefly leaked the previous user's amount" — and an untagged vault stamp
 * fails the same way, handing account B account A's cleared dot.
 */
export function seenKey(customerId: string): string {
  return `polycards.vault_seen_at:${customerId}`;
}

/**
 * True when the vault holds something the customer has not seen.
 *
 * Both arguments are ISO 8601 strings or null. The two degradation directions
 * are chosen, not accidental:
 *   - unparseable/absent STAMP → show. Costs one extra tab tap, self-heals on
 *     the next visit; hiding would swallow real arrivals forever.
 *   - unparseable/absent EVENT → hide. Never show a dot we cannot justify.
 *
 * A stamp AHEAD of the newest event (clock skew, a stale write) shows nothing:
 * the comparison is strictly `>`.
 */
export function shouldShowDot(
  latestAt: string | null,
  seenAt: string | null,
): boolean {
  if (!latestAt) return false;
  const latest = Date.parse(latestAt);
  if (Number.isNaN(latest)) return false;

  if (!seenAt) return true;
  const seen = Date.parse(seenAt);
  if (Number.isNaN(seen)) return true;

  return latest > seen;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/lib/__tests__/vault-dot.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/vault-dot.ts src/lib/__tests__/vault-dot.test.ts
git commit -m "feat(vault): add the unread-dot comparison and storage key

Keyed by customer id so a logout/login never inherits another account's
cleared dot. Unparseable stamp degrades toward showing; unparseable event
degrades toward hiding.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Storefront data access

**Files:**
- Modify: `src/lib/data/schemas.ts` (beside `BalanceSchema`, ~line 241)
- Modify: `src/lib/actions/vault.ts` (after `getCreditBalance`, ~line 110)

**Interfaces:**
- Consumes: `GET /store/vault/latest` from Task 1; `parseOne`, `sdk`, `logger`, `getAuthToken` — all already imported at the top of `vault.ts`.
- Produces: `getVaultLatest(): Promise<string | null>`. Task 5 consumes it.

- [ ] **Step 1: Add the schema**

In `src/lib/data/schemas.ts`, immediately after `export const BalanceSchema = z.looseObject({ balance: finite });`:

```ts
/** GET /store/vault/latest — the newest vault-visible event (unread-dot signal).
 *  null when the vault is empty; the client renders no dot for null. */
export const VaultLatestSchema = z.looseObject({
  latest_event_at: z.string().nullable(),
});
```

- [ ] **Step 2: Add `VaultLatestSchema` to the import block in `vault.ts`**

The file already imports from `@/lib/data/schemas`. Add `VaultLatestSchema` to that existing import list — do not add a second import statement.

- [ ] **Step 3: Add the action**

In `src/lib/actions/vault.ts`, immediately after `getCreditBalance`:

```ts
// The newest vault-visible event for the caller — the Vault tab's unread-dot
// signal. Deliberately not folded into getVault(): the dot is read from every
// page, and must not pay for a 500-item vault list. Null = logged out, empty
// vault, or a failed read; callers render no dot rather than a wrong one.
export async function getVaultLatest(): Promise<string | null> {
  const token = await getAuthToken();
  if (!token) return null;
  try {
    const parsed = parseOne(
      VaultLatestSchema,
      await sdk.client.fetch('/store/vault/latest', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      }),
    );
    return parsed?.latest_event_at ?? null;
  } catch (error) {
    logger.error('[vault] latest-event read failed:', error);
    return null;
  }
}
```

- [ ] **Step 4: Type-check**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/data/schemas.ts src/lib/actions/vault.ts
git commit -m "feat(vault): add getVaultLatest, the storefront read for the unread dot

Separate from getVault so the per-page dot read does not pay for a 500-item
vault list. Degrades to null on any failure — same contract as
getCreditBalance beside it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: VaultDotProvider + layout wiring

The provider exists because **two** components need the same state. Without it, `TabBar` and `AppHeader` would each fetch on every navigation and double the request cost.

**Files:**
- Create: `src/components/app-shell/VaultDotProvider.tsx`
- Modify: `src/app/layout.tsx:90-102`

**Interfaces:**
- Consumes: `getVaultLatest()` (Task 4), `seenKey`/`shouldShowDot` (Task 3), `useAuth()` from `@/components/auth/AuthProvider`.
- Produces: `useVaultDot(): { latestAt: string | null; show: boolean; markSeen: () => void }`. Tasks 6 and 7 consume it.

- [ ] **Step 1: Write the provider**

Create `src/components/app-shell/VaultDotProvider.tsx`:

```tsx
'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getVaultLatest } from '@/lib/actions/vault';
import { useAuth } from '@/components/auth/AuthProvider';
import { seenKey, shouldShowDot } from '@/lib/vault-dot';

type VaultDotContextValue = {
  /** Newest vault event, ISO. Null while loading, logged out, or empty. */
  latestAt: string | null;
  /** True when the vault holds something unseen. Always false before mount. */
  show: boolean;
  /** Mark everything up to `latestAt` seen. No-op until `latestAt` resolves. */
  markSeen: () => void;
};

const VaultDotContext = createContext<VaultDotContextValue | null>(null);

export function useVaultDot(): VaultDotContextValue {
  const ctx = useContext(VaultDotContext);
  if (!ctx) throw new Error('useVaultDot must be used within VaultDotProvider');
  return ctx;
}

// Focus refetches are throttled to one per this window per session. The
// 2026-07-07 incident was a sustained store-read ceiling from exactly this kind
// of chrome fan-out; a full page load is never throttled, only focus events.
const REFETCH_TTL_MS = 30_000;

function readStamp(customerId: string): string | null {
  try {
    return window.localStorage.getItem(seenKey(customerId));
  } catch {
    // Safari private mode throws on access. No stamp → the dot shows, which is
    // the harmless direction.
    return null;
  }
}

function writeStamp(customerId: string, at: string): void {
  try {
    window.localStorage.setItem(seenKey(customerId), at);
  } catch {
    // Storage unavailable — the dot stays lit for this session. Not worth
    // surfacing to the customer over a nav hint.
  }
}

/**
 * Holds the Vault tab's unread-dot state. Separate from TopUpProvider (which
 * owns money) because this is a nav hint with its own refresh cadence.
 *
 * State is stored WITH the customer id it was fetched for and only renders when
 * that id still matches — the same defence TopUpProvider added after an
 * untagged balance leaked the previous user's amount across a logout→login.
 */
export function VaultDotProvider({ children }: { children: ReactNode }) {
  const { customer } = useAuth();
  const [state, setState] = useState<{
    forId: string;
    latestAt: string | null;
    seenAt: string | null;
  } | null>(null);
  const lastFetchRef = useRef(0);

  const refresh = useCallback(async (forId: string) => {
    lastFetchRef.current = Date.now();
    const latestAt = await getVaultLatest();
    setState((prev) => ({
      forId,
      latestAt,
      // Keep an in-session markSeen; only consult storage on the first load for
      // this identity, so a refresh can't resurrect a dot already cleared.
      seenAt: prev?.forId === forId ? prev.seenAt : readStamp(forId),
    }));
  }, []);

  // Fetch on login / account switch; drop state on logout so a signed-out shell
  // never renders the previous account's dot. setState only ever runs in a
  // promise callback, never synchronously in the effect.
  useEffect(() => {
    if (!customer) {
      setState(null);
      return;
    }
    let cancelled = false;
    void getVaultLatest().then((latestAt) => {
      if (cancelled) return;
      lastFetchRef.current = Date.now();
      setState({ forId: customer.id, latestAt, seenAt: readStamp(customer.id) });
    });
    return () => {
      cancelled = true;
    };
  }, [customer]);

  // Refresh when the tab regains focus, throttled — mirrors NotificationBell's
  // cadence without its unthrottled refetch.
  useEffect(() => {
    if (!customer) return;
    const forId = customer.id;
    const onFocus = () => {
      if (Date.now() - lastFetchRef.current < REFETCH_TTL_MS) return;
      void refresh(forId);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [customer, refresh]);

  const markSeen = useCallback(() => {
    setState((prev) => {
      if (!prev?.latestAt) return prev;
      writeStamp(prev.forId, prev.latestAt);
      return { ...prev, seenAt: prev.latestAt };
    });
  }, []);

  // Cross-identity state derives away rather than rendering. Also covers SSR
  // and the pre-fetch beat: `state` is null there, so `show` is false and no
  // dot is emitted before mount (localStorage does not exist server-side, and
  // rendering one earlier would be a hydration mismatch).
  const live = customer && state?.forId === customer.id ? state : null;

  return (
    <VaultDotContext.Provider
      value={{
        latestAt: live?.latestAt ?? null,
        show: live ? shouldShowDot(live.latestAt, live.seenAt) : false,
        markSeen,
      }}
    >
      {children}
    </VaultDotContext.Provider>
  );
}
```

- [ ] **Step 2: Wire it into the layout**

In `src/app/layout.tsx`, add the import beside the existing `TopUpProvider` import:

```tsx
import { VaultDotProvider } from '@/components/app-shell/VaultDotProvider';
```

Then wrap the shell — `VaultDotProvider` goes **inside** `TopUpProvider` (it depends on nothing TopUp owns, but both sit under `AuthProvider`, and keeping the money provider outermost preserves the existing nesting):

```tsx
        <AuthProvider>
          <TopUpProvider>
            <VaultDotProvider>
              <SkipLink />
              <AppHeader />
              <main id="main" className="flex-1 pb-12 lg:pb-8">
                {children}
              </main>
              {/* Footer carries the TabBar clearance (pb-28) on phones. */}
              <SiteFooter />
              <TabBar />
              <CookieConsent />
            </VaultDotProvider>
          </TopUpProvider>
        </AuthProvider>
```

- [ ] **Step 3: Type-check**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/app-shell/VaultDotProvider.tsx src/app/layout.tsx
git commit -m "feat(vault): add VaultDotProvider for the Vault tab unread dot

One fetch per navigation shared by both nav renderings instead of one each.
State is tagged with the customer it was fetched for and derives away on a
mismatch, so a logout/login can never render the previous account's dot.
Focus refetches throttled to 30s.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Render the dot

Both nav renderings read the same `tabs.ts` list, so the dot is matched on `tab.href === '/vault'` rather than adding a field to the `Tab` type — the dot is dynamic state, not tab configuration.

**Files:**
- Modify: `src/components/app-shell/TabBar.tsx` (icon at ~lines 52-56)
- Modify: `src/components/app-shell/AppHeader.tsx` (icon at ~line 77)

**Interfaces:**
- Consumes: `useVaultDot()` (Task 5).
- Produces: nothing consumed downstream.

- [ ] **Step 1: Add the dot to `TabBar`**

Add the import:

```tsx
import { useVaultDot } from './VaultDotProvider';
```

Inside the component, beside the existing `useAuth()` call:

```tsx
  const { show: vaultDot } = useVaultDot();
```

Inside the `TABS.map` callback, beside the existing `const active` / `const Icon`:

```tsx
          const dot = vaultDot && tab.href === '/vault';
```

On the `<Link>`, add an accessible name — a color-only signal is invisible to
screen readers, the same reason `NotificationBell` spells out its count:

```tsx
              aria-label={dot ? `${tab.label}, new items` : undefined}
```

Replace the bare `<Icon ... />` with a positioning wrapper:

```tsx
              <span className="relative inline-flex">
                <Icon
                  className={cn('h-6 w-6', active && 'scale-105')}
                  strokeWidth={active ? 2.25 : 2}
                  aria-hidden
                />
                {dot && (
                  <span
                    aria-hidden
                    className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-neutral-50"
                  />
                )}
              </span>
```

`TabBar`'s active state only changes the icon *color* (`text-neutral-50` on a
dark bar), so Paper White stays visible and no inversion is needed here.

- [ ] **Step 2: Add the dot to `AppHeader`**

Add the import:

```tsx
import { useVaultDot } from './VaultDotProvider';
```

Beside the existing `useTopUp()` call:

```tsx
  const { show: vaultDot } = useVaultDot();
```

Inside the desktop nav's `TABS.map` callback:

```tsx
              const dot = vaultDot && tab.href === '/vault';
```

On the `<Link>`:

```tsx
                  aria-label={dot ? `${tab.label}, new items` : undefined}
```

Replace `<Icon className="h-4 w-4" aria-hidden />` with:

```tsx
                  <span className="relative inline-flex">
                    <Icon className="h-4 w-4" aria-hidden />
                    {dot && (
                      // The active pill is bg-neutral-50, so Paper White would
                      // vanish on it. Normally moot (being on /vault clears the
                      // dot), but reachable: a pull can land while the customer
                      // sits on the page and the next focus refresh relights it.
                      <span
                        aria-hidden
                        className={cn(
                          'absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full',
                          active ? 'bg-neutral-950' : 'bg-neutral-50',
                        )}
                      />
                    )}
                  </span>
```

- [ ] **Step 3: Type-check and build**

```bash
npm run typecheck && npm run build
```

Expected: both clean. If the build dies with `Cannot read properties of undefined (reading 'length')` immediately after starting, that is a stale `.next` — stop any running standalone server, `rm -rf .next`, rebuild.

- [ ] **Step 4: Verify visually on the production build**

```bash
pwsh scripts/serve-standalone.ps1 -Port 4000
```

Log in, confirm the dot renders on the Vault tab (mobile width) and in the
desktop nav. **Do not verify on `next dev`** — it serves images slowly on this
machine and makes a correct build look broken.

- [ ] **Step 5: Commit**

```bash
git add src/components/app-shell/TabBar.tsx src/components/app-shell/AppHeader.tsx
git commit -m "feat(vault): render the unread dot on both Vault nav surfaces

Paper White per DESIGN.md's Signal Rule — Alarm Red is reserved for errors and
destructive confirmation, and 'new cards' is the opposite of danger. Inverts to
neutral-950 on the desktop active pill, where white would vanish. The Vault
link takes an aria-label when lit, since a colour-only signal is invisible to
screen readers.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Clear the dot on the Vault page

**Files:**
- Modify: `src/app/(account)/vault/VaultClient.tsx` (imports at ~line 3-31; a new effect beside the existing ones)

**Interfaces:**
- Consumes: `useVaultDot()` (Task 5). `useEffect` is already imported at line 3.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Add the import**

Beside the existing `import { useTopUp } from '@/components/app-shell/TopUpProvider';`:

```tsx
import { useVaultDot } from '@/components/app-shell/VaultDotProvider';
```

- [ ] **Step 2: Add the effect**

Inside `VaultClient`, beside the other hooks:

```tsx
  // Opening the vault marks everything seen. Keyed on `latestAt` rather than
  // bare mount for two reasons: reaching this page before the provider's fetch
  // resolves would otherwise stamp nothing, and a pull landing DURING the visit
  // clears itself on the next focus refresh instead of leaving a dot behind for
  // cards the customer is looking at right now.
  const { latestAt, markSeen } = useVaultDot();
  useEffect(() => {
    if (latestAt) markSeen();
  }, [latestAt, markSeen]);
```

`markSeen()` writes `seenAt` but leaves `latestAt` untouched, so this effect
cannot re-trigger itself.

- [ ] **Step 3: Type-check and build**

```bash
npm run typecheck && npm run build
```

Expected: both clean.

- [ ] **Step 4: Verify the full loop on the production build**

```bash
pwsh scripts/serve-standalone.ps1 -Port 4000
```

Sequence to confirm:
1. Logged in with a non-empty vault and no stored stamp → dot is lit.
2. Open `/vault` → dot clears.
3. Navigate away and back → dot stays dark.
4. Open a pack (`bronze-pack` is the only spinnable pack locally; the demo spin needs `?demo=1`) → dot lights again.
5. Sell a card back from the vault → dot stays dark.

Check `localStorage` in devtools: the key must read
`polycards.vault_seen_at:cus_...`, not a bare `polycards.vault_seen_at`.

- [ ] **Step 5: Run the whole storefront suite**

```bash
npm test
```

Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(account)/vault/VaultClient.tsx"
git commit -m "feat(vault): clear the unread dot when the vault is opened

Keyed on the provider's latestAt rather than bare mount, so reaching the page
before the fetch resolves still stamps, and a pull landing mid-visit clears
itself instead of leaving a dot for cards on screen.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.**

| spec requirement | task |
| --- | --- |
| `max(pull.updated_at)` over `status='vaulted'` | 1 |
| own middlewares.ts matcher entry | 1 |
| no new index | 1 (documented in the route comment) |
| owner-scoped from token / IDOR | 1 (unit), 2 (HTTP) |
| `localStorage` keyed by customer id | 3 (`seenKey`), 5 (`readStamp`/`writeStamp`) |
| `markSeen()` writes the fetched `latest_event_at`, not `Date.now()` | 5 (`markSeen`), 7 (effect keyed on `latestAt`) |
| 30s TTL, in-memory ref, full loads never throttled | 5 (`REFETCH_TTL_MS`, `lastFetchRef`) |
| fetch failure → dot hidden | 4 (`getVaultLatest` returns null), 3 (`shouldShowDot(null, …)` is false) |
| `localStorage` throws → treated as no stamp | 5 (`readStamp` catch) |
| SSR → `show=false` until mounted | 5 (`live` derives null when `state` is null) |
| clock skew → no dot | 3 (strict `>`, tested) |
| logout → login as another account | 3 (key), 5 (tagging + `setState(null)`) |
| Paper White, active-pill inversion | 6 |
| 8px, no animation | 6 (`h-2 w-2`, no transition classes) |
| screen-reader label | 6 (`aria-label` on the Link, `aria-hidden` on the span) |
| unit / route-unit / integration tests | 3 / 1 / 2 |
| no new E2E | — deliberate, recorded in the spec |

No gaps.

**Placeholder scan.** No TBD/TODO, no "add appropriate error handling", no "similar to Task N". Every code step carries real code; every test step carries a real command and an expected result.

**Type consistency.** `latest_event_at` is the wire name in Tasks 1, 2, 4. `latestAt` is the client name in Tasks 4, 5, 6, 7. `seenKey`/`shouldShowDot` are spelled identically in Tasks 3 and 5. `useVaultDot` returns `{ latestAt, show, markSeen }` in Task 5 and is destructured consistently in Tasks 6 (`{ show: vaultDot }`) and 7 (`{ latestAt, markSeen }`).

## Post-review amendments (PR #375)

All seven tasks landed exactly as written. These changes came out of CI and the
automated reviewers afterwards, and are recorded here so the plan does not drift
from what shipped:

- **`VaultDotProvider` drops the `setState(null)` logout branch.** React
  Compiler's `react-hooks/set-state-in-effect` rejects a synchronous setState in
  an effect body and CI's `quality` job failed on it. The write was redundant
  anyway — `live` already derives to null when `customer` is null. The QA
  harness gained a logout case, since that derivation is now load-bearing.
- **The mount effect stamps `lastFetchRef` before the await, not after.** A
  focus event landing during a slow first fetch would otherwise see a zero
  timestamp, pass the TTL check, and fire a duplicate request.
- **The route sets `Cache-Control: no-store`,** asserted in both the unit and
  integration specs. Note that no other `/store` route in this backend sets a
  cache directive — this is the local fix, not the codebase-wide one.
- **The QA harness reads the publishable key from the environment first,** with
  the local env file as fallback, and reports an unreachable backend as a
  sentence instead of a bare `TypeError: fetch failed`.

## Known deviations from the spec's file list

The spec listed 8 storefront files; this plan touches the same 8. The spec's `src/lib/data/schemas.ts` and `src/lib/actions/vault.ts` changes are folded into a single task (Task 4) because they are one deliverable — a schema with no caller is not independently reviewable.
