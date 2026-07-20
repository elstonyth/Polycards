# Notification Toasts — PR 1: Backend Producers + Feed Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the three missing notification producers (`delivery_status`, `topup_credited`, `reward_won`), a bulk mark-read endpoint, and a shared copy registry that turns `/notifications` from a list of bare titles into real entries with bodies and deep links.

**Architecture:** Pure decision helpers in `modules/packs/feed-events.ts` carry every "should this notify / what is its idempotency key" rule, exhaustively unit-tested. Three thin route-level wirings consume them. On the storefront, `src/lib/notifications/copy.ts` becomes the single source of truth for how a template renders — consumed by `/notifications` in this PR and by the toast system in PR 2.

**Tech Stack:** Medusa v2 (backend, `corepack yarn`, jest + @swc/jest), Next.js App Router (storefront, `npm`, vitest), TypeScript, Zod 4 (jitless), Tailwind.

**Spec:** `docs/superpowers/specs/2026-07-20-notification-toasts-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **No new dependencies.** Nothing added to any `package.json`.
- **No migrations, no DB schema changes.** `notification_read` and the Notification Module already carry everything needed.
- **No changes to `GET /store/notifications` or `POST /store/notifications/:id/read`.** Both stay byte-identical.
- **Backend `.ts` edits MUST be applied through a Node script run via the Bash tool — never Edit/Write directly.** A global (non-repo) formatter hook rewrites backend double-quotes to single quotes on every Edit/Write, burying a three-line addition inside a whole-file diff. Pattern to use:
  ```bash
  node -e "
  const fs=require('fs');
  const p='backend/packages/api/src/…/file.ts';
  let s=fs.readFileSync(p,'utf8');
  s=s.replace(\"OLD EXACT TEXT\", \"NEW EXACT TEXT\");
  fs.writeFileSync(p,s);
  "
  ```
  Storefront files under `src/` are safe to Edit/Write normally.
- **Package managers:** `npm` at the repo root (storefront), `corepack yarn` inside `backend/`. Never `pnpm`.
- **Backend quote style is single quotes** in `src/api/**` and `src/modules/**`; `src/workflows/**` and some older files use double. Match the file you are editing.
- **A PostToolUse hook type-checks after every `.ts`/`.tsx` edit, and a Stop hook type-checks storefront + backend and blocks finishing on real type errors.** Expect them to run; do not add duplicates.
- **Commit messages** use Conventional Commits and end with:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- **Never commit `.env` files.** A `guard-secrets` hook blocks shell reads of secret files; use PowerShell `Test-Path` / `Copy-Item` when you need to check for or move one.
- **`noUncheckedIndexedAccess` is enabled.** Indexing a `Record<string, T>` — by bracket **or** by dot — yields `T | undefined`, so any property access off a lookup is a type error. Go through an accessor that returns a guaranteed value (e.g. `copyFor(t)` rather than `NOTIFICATION_COPY[t]`). Never paper over it with `!`. Note vitest does not type-check, so this class of error passes the test run and only fails `tsc`.
- **Notification `data` payloads are primitives only** — no HTML, no free-text interpolation of user input (spec §13). Numbers, booleans, strings, and arrays of those.
- **Every producer is non-fatal.** A notification failure must never roll back or fail a committed mutation. Wrap in `try { … } catch { /* non-fatal */ }`.

---

## File Structure

**Backend — created**
- `backend/packages/api/src/modules/packs/feed-events.ts` — pure decision + key-building helpers for all three new producers. No I/O, no container.
- `backend/packages/api/src/modules/packs/__tests__/feed-events.unit.spec.ts` — exhaustive unit coverage of the above.
- `backend/packages/api/src/api/store/notifications/read-all/route.ts` — bulk mark-read.
- `backend/packages/api/integration-tests/http/store-notifications-read-all.spec.ts` — owner-scoping / IDOR coverage.
- `backend/packages/api/src/api/admin/delivery-orders/__tests__/delivery-notify.unit.spec.ts` — route wiring for the delivery producer.
- `backend/packages/api/src/api/store/credits/__tests__/topup-notify.unit.spec.ts` — route wiring for the top-up producer.

**Backend — modified**
- `backend/packages/api/src/modules/packs/notify-feed.ts` — widen `FeedTemplate` 4 → 6.
- `backend/packages/api/src/api/admin/delivery-orders/[id]/route.ts` — `delivery_status` producer.
- `backend/packages/api/src/api/store/credits/topup/route.ts` — `topup_credited` producer.
- `backend/packages/api/src/api/store/daily/draw/route.ts` — `reward_won` producer.
- `backend/packages/api/src/modules/packs/service.ts` — add `draw_day` to `DrawDailyBoxResult` and return it.
- `backend/packages/api/src/api/utils/rate-limit.ts` — `createNotificationReadAllRateLimit`.
- `backend/packages/api/src/api/middlewares.ts` — matcher entry for the new route.

**Storefront — created**
- `src/lib/notifications/copy.ts` — the template registry (title, body, href, action label, icon, variant, toast policy).
- `src/lib/notifications/__tests__/copy.test.ts` — registry coverage.

**Storefront — modified**
- `src/lib/data/schemas.ts` — `MarkAllReadSchema`.
- `src/lib/actions/notifications.ts` — `markAllRead()` server action.
- `src/app/(account)/notifications/NotificationsClient.tsx` — registry-driven rendering + Mark all read. Its props are unchanged, so `page.tsx` needs no edit.

`copy.ts` holds the toast `policy` and `variant` fields even though nothing reads them until PR 2. They live with the copy they govern (spec: "one declarative field beside the copy it governs"), and defining them now means PR 2 adds no fields to a reviewed file.

---

### Task 0: Worktree environment setup

This worktree is bare — no `node_modules`, no `.env`, no built workspace packages. Nothing below runs until this is done. There is no test; the deliverable is a green type-check.

**Files:** none created or modified (installs and untracked env files only).

**Interfaces:**
- Consumes: nothing.
- Produces: a working `corepack yarn test:unit` / `npm run test` / `tsc` environment for every later task.

- [ ] **Step 1: Install storefront dependencies**

Run from the worktree root:

```bash
npm install
```

Expected: completes, creates `node_modules/`. Takes several minutes.

- [ ] **Step 2: Install backend dependencies**

```bash
cd backend && corepack yarn install
```

Expected: completes, creates `backend/node_modules/`.

- [ ] **Step 3: Build the `@acme/odds-math` workspace package**

```bash
cd backend/packages/odds-math && corepack yarn build
```

Expected: creates `backend/packages/odds-math/dist/`. Without this every backend jest run fails with `Cannot find module '@acme/odds-math'`.

- [ ] **Step 4: Copy env files from the main tree**

Use PowerShell — the `guard-secrets` hook blocks shell reads of `.env` files, and `cp` through Bash trips it.

```powershell
$m = 'C:\Users\PC\Desktop\Projects\PixelSlot'
$w = 'C:\Users\PC\Desktop\Projects\PixelSlot\.claude\worktrees\notification-popup-coverage-79825a'
Copy-Item "$m\.env.local" "$w\.env.local"
Copy-Item "$m\backend\packages\api\.env" "$w\backend\packages\api\.env"
```

- [ ] **Step 5: Verify the environment**

```powershell
@(
  "root node_modules: $(Test-Path 'node_modules')",
  "backend node_modules: $(Test-Path 'backend/node_modules')",
  "odds-math dist: $(Test-Path 'backend/packages/odds-math/dist')",
  ".env.local: $(Test-Path '.env.local')",
  "backend .env: $(Test-Path 'backend/packages/api/.env')"
)
docker ps --filter "name=pokenic-postgres" --format "{{.Names}} {{.Status}}"
```

Expected: all five `True`, and `pokenic-postgres` reported `Up`. If the container is not running, start it before any integration test:

```bash
docker start pokenic-postgres
```

- [ ] **Step 6: Confirm both type-checks are green before changing anything**

```bash
npx tsc --noEmit
```
Expected: no errors.

```bash
cd backend/packages/api && node node_modules/typescript/bin/tsc --noEmit
```
Expected: no errors. Use `node node_modules/typescript/bin/tsc`, not a bare `tsc` — a globally-installed TypeScript 7 shadows the pinned 5.9.3 and fails with a spurious TS5102/`baseUrl` error.

No commit — this task creates only untracked artifacts.

---

### Task 1: Feed-event decision helpers

Every "should this notify?" and "what is its idempotency key?" rule for the three new producers, as pure functions. The routes that follow are thin wiring over this.

**Files:**
- Create: `backend/packages/api/src/modules/packs/feed-events.ts`
- Create: `backend/packages/api/src/modules/packs/__tests__/feed-events.unit.spec.ts`
- Modify: `backend/packages/api/src/modules/packs/notify-feed.ts` (the `FeedTemplate` union, lines 3–7)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `shouldNotifyDeliveryStatus(prev: string | null | undefined, next: string | null | undefined): boolean`
  - `deliveryFeedKey(orderId: string, status: string): string`
  - `topupFeedKey(reference: string): string`
  - `shouldNotifyTopup(result: { replayed?: boolean; amount?: number }): boolean`
  - `rewardWonFeedKey(customerId: string, drawDay: string, drawOrdinal: number): string`
  - `shouldNotifyRewardWon(result: { status?: string; prize?: { kind?: string } | null; draw_ordinal?: number; draw_day?: string }): boolean`
  - `FeedTemplate` widened to include `'delivery_status'` and `'topup_credited'`.

- [ ] **Step 1: Write the failing test**

Create `backend/packages/api/src/modules/packs/__tests__/feed-events.unit.spec.ts`:

```ts
// src/modules/packs/__tests__/feed-events.unit.spec.ts
import {
  shouldNotifyDeliveryStatus,
  deliveryFeedKey,
  topupFeedKey,
  shouldNotifyTopup,
  rewardWonFeedKey,
  shouldNotifyRewardWon,
} from '../feed-events';

describe('shouldNotifyDeliveryStatus', () => {
  it('notifies on shipped, delivered and canceled', () => {
    expect(shouldNotifyDeliveryStatus('packing', 'shipped')).toBe(true);
    expect(shouldNotifyDeliveryStatus('shipped', 'delivered')).toBe(true);
    expect(shouldNotifyDeliveryStatus('requested', 'canceled')).toBe(true);
  });

  it('does NOT notify on packing — the noisiest operator transition', () => {
    expect(shouldNotifyDeliveryStatus('requested', 'packing')).toBe(false);
  });

  it('does NOT notify on requested — that is the customer own action', () => {
    expect(shouldNotifyDeliveryStatus(null, 'requested')).toBe(false);
  });

  it('does NOT notify when the status did not change', () => {
    // A tracking-only admin update returns the UNCHANGED status from the step,
    // so this guard is what stops a tracking edit from firing a notification.
    expect(shouldNotifyDeliveryStatus('shipped', 'shipped')).toBe(false);
    expect(shouldNotifyDeliveryStatus('delivered', 'delivered')).toBe(false);
  });

  it('does NOT notify on missing or unknown next status', () => {
    expect(shouldNotifyDeliveryStatus('packing', null)).toBe(false);
    expect(shouldNotifyDeliveryStatus('packing', undefined)).toBe(false);
    expect(shouldNotifyDeliveryStatus('packing', '')).toBe(false);
    expect(shouldNotifyDeliveryStatus('packing', 'teleported')).toBe(false);
  });
});

describe('idempotency keys', () => {
  it('delivery key is one per order per status', () => {
    expect(deliveryFeedKey('do_1', 'shipped')).toBe('delivery:do_1:shipped');
    expect(deliveryFeedKey('do_1', 'delivered')).not.toBe(
      deliveryFeedKey('do_1', 'shipped'),
    );
  });

  it('topup key is one per gateway charge reference', () => {
    expect(topupFeedKey('mock_abc')).toBe('topup:mock_abc');
  });

  it('reward key is one per customer per draw', () => {
    expect(rewardWonFeedKey('cus_1', '2026-07-20', 2)).toBe(
      'reward_won:cus_1:2026-07-20:2',
    );
    expect(rewardWonFeedKey('cus_1', '2026-07-20', 3)).not.toBe(
      rewardWonFeedKey('cus_1', '2026-07-20', 2),
    );
  });
});

describe('shouldNotifyTopup', () => {
  it('notifies a real credit', () => {
    expect(shouldNotifyTopup({ replayed: false, amount: 50 })).toBe(true);
  });

  it('does NOT notify a replay — nothing was credited', () => {
    expect(shouldNotifyTopup({ replayed: true, amount: 50 })).toBe(false);
  });

  it('does NOT notify a zero, negative or missing amount', () => {
    expect(shouldNotifyTopup({ replayed: false, amount: 0 })).toBe(false);
    expect(shouldNotifyTopup({ replayed: false, amount: -5 })).toBe(false);
    expect(shouldNotifyTopup({ replayed: false })).toBe(false);
  });
});

describe('shouldNotifyRewardWon', () => {
  const drawn = {
    status: 'drawn',
    prize: { kind: 'voucher' },
    draw_ordinal: 1,
    draw_day: '2026-07-20',
  };

  it('notifies a real drawn prize', () => {
    expect(shouldNotifyRewardWon(drawn)).toBe(true);
  });

  it('does NOT notify a "nothing" prize — drawn, but nothing to record', () => {
    expect(
      shouldNotifyRewardWon({ ...drawn, prize: { kind: 'nothing' } }),
    ).toBe(false);
  });

  it('does NOT notify unavailable or capped draws — no reward_draw row exists', () => {
    expect(shouldNotifyRewardWon({ ...drawn, status: 'capped' })).toBe(false);
    expect(shouldNotifyRewardWon({ ...drawn, status: 'unavailable' })).toBe(
      false,
    );
  });

  it('does NOT notify when key material is missing', () => {
    expect(shouldNotifyRewardWon({ ...drawn, prize: null })).toBe(false);
    expect(
      shouldNotifyRewardWon({ ...drawn, draw_ordinal: undefined }),
    ).toBe(false);
    expect(shouldNotifyRewardWon({ ...drawn, draw_day: undefined })).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend/packages/api && corepack yarn test:unit feed-events.unit.spec
```

Expected: FAIL — `Cannot find module '../feed-events'`.

- [ ] **Step 3: Write the implementation**

Create `backend/packages/api/src/modules/packs/feed-events.ts`. This is a NEW file, so Write is safe here — the formatter-hook rule only bites when an edit must land inside existing content.

```ts
// Pure decision + key-building rules for the feed notifications produced by
// routes. No container, no I/O — every branch is unit-testable in isolation,
// which is the whole reason the routes stay thin wiring over this file.

// Which delivery transitions are worth telling a customer about.
//
// 'packing' is deliberately excluded: it is the transition an operator flips
// most casually while working through a queue, so it would be the noisiest and
// least informative of the four. 'requested' is the customer's own action and
// is never news.
const NOTIFIABLE_DELIVERY_STATUSES: readonly string[] = [
  'shipped',
  'delivered',
  'canceled',
];

/**
 * True when a delivery-order status change should produce a feed notification.
 *
 * Both guards are load-bearing:
 *  - the status actually CHANGED. updateDeliveryOrderStep returns the
 *    UNCHANGED status for a tracking-only update, so `next` on its own does
 *    not prove that anything happened.
 *  - the new status is one a customer cares about.
 */
export function shouldNotifyDeliveryStatus(
  prev: string | null | undefined,
  next: string | null | undefined,
): boolean {
  if (!next || next === prev) return false;
  return NOTIFIABLE_DELIVERY_STATUSES.includes(next);
}

/** One notification per order per status — a replayed admin POST dedupes. */
export function deliveryFeedKey(orderId: string, status: string): string {
  return `delivery:${orderId}:${status}`;
}

/** One notification per gateway charge reference. */
export function topupFeedKey(reference: string): string {
  return `topup:${reference}`;
}

/**
 * True when a top-up result represents money that actually arrived.
 *
 * `replayed: true` means the request re-served an already-processed
 * Idempotency-Key — the original row was returned and nothing new was
 * credited, so a second feed row would claim a charge that never happened.
 */
export function shouldNotifyTopup(result: {
  replayed?: boolean;
  amount?: number;
}): boolean {
  return (
    result.replayed !== true &&
    typeof result.amount === 'number' &&
    result.amount > 0
  );
}

/**
 * One notification per customer per draw. Mirrors the anchor drawDailyBox
 * already uses internally for the voucher grant, so the two never disagree
 * about what "the same draw" means.
 */
export function rewardWonFeedKey(
  customerId: string,
  drawDay: string,
  drawOrdinal: number,
): string {
  return `reward_won:${customerId}:${drawDay}:${drawOrdinal}`;
}

/**
 * True when a daily-draw result is worth a feed row.
 *
 * A 'nothing' prize is a normal drawn outcome, but there is no reward to
 * record. 'unavailable' and 'capped' never wrote a reward_draw row at all.
 * The key-material checks keep an incomplete result from producing a
 * malformed idempotency key.
 */
export function shouldNotifyRewardWon(result: {
  status?: string;
  prize?: { kind?: string } | null;
  draw_ordinal?: number;
  draw_day?: string;
}): boolean {
  return (
    result.status === 'drawn' &&
    !!result.prize &&
    result.prize.kind !== 'nothing' &&
    typeof result.draw_ordinal === 'number' &&
    typeof result.draw_day === 'string'
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend/packages/api && corepack yarn test:unit feed-events.unit.spec
```

Expected: PASS — 5 suites, 16 tests.

- [ ] **Step 5: Widen the `FeedTemplate` union**

Apply through a Node script (Global Constraints):

```bash
node -e "
const fs=require('fs');
const p='backend/packages/api/src/modules/packs/notify-feed.ts';
let s=fs.readFileSync(p,'utf8');
const before=\"  | 'voucher_claimed';\";
const after=\"  | 'voucher_claimed'\n  | 'delivery_status'\n  | 'topup_credited';\";
if(!s.includes(before)) throw new Error('anchor not found');
s=s.replace(before, after);
fs.writeFileSync(p,s);
console.log('ok');
"
```

Expected output: `ok`. The union becomes:

```ts
export type FeedTemplate =
  | 'commission_matured'
  | 'vip_level_up'
  | 'reward_won'
  | 'voucher_claimed'
  | 'delivery_status'
  | 'topup_credited';
```

- [ ] **Step 6: Verify the existing notify-feed test still passes and types are clean**

```bash
cd backend/packages/api && corepack yarn test:unit notify-feed.unit.spec && node node_modules/typescript/bin/tsc --noEmit
```

Expected: PASS, then no type errors.

- [ ] **Step 7: Commit**

```bash
git add backend/packages/api/src/modules/packs/feed-events.ts \
        backend/packages/api/src/modules/packs/__tests__/feed-events.unit.spec.ts \
        backend/packages/api/src/modules/packs/notify-feed.ts
git commit -m "$(cat <<'EOF'
feat(notifications): feed-event decision helpers + widen FeedTemplate

Pure rules for the three new producers: which delivery transitions are
worth notifying, which draw results produced a real prize, and the
idempotency key for each. Routes become thin wiring over this.

The changed-status guard is load-bearing: a tracking-only admin update
returns the UNCHANGED status from updateDeliveryOrderStep, so the new
status alone does not prove anything happened.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `delivery_status` producer

**Files:**
- Modify: `backend/packages/api/src/api/admin/delivery-orders/[id]/route.ts` (the `POST` handler, lines 34–47)
- Create: `backend/packages/api/src/api/admin/delivery-orders/__tests__/delivery-notify.unit.spec.ts`

**Interfaces:**
- Consumes: `shouldNotifyDeliveryStatus`, `deliveryFeedKey` (Task 1); `notifyFeed` from `modules/packs/notify-feed`.
- Produces: a `delivery_status` feed notification with `data: { order_id, status, tracking_number }`.

The producer sits in the **admin route**, not in `updateDeliveryOrderWorkflow`. `POST /store/delivery-orders/:id/cancel` calls the same workflow, so a workflow-level producer would notify a customer about their own cancellation. Placing it here makes self-cancel structurally incapable of notifying, with no actor flag to thread.

- [ ] **Step 1: Write the failing test**

Create `backend/packages/api/src/api/admin/delivery-orders/__tests__/delivery-notify.unit.spec.ts`. The workflow is mocked so this covers the route's wiring only — the transition rules themselves are Task 1's.

```ts
// src/api/admin/delivery-orders/__tests__/delivery-notify.unit.spec.ts
import { Modules } from '@medusajs/framework/utils';

const runMock = jest.fn();

jest.mock('../../../../workflows/update-delivery-order', () => ({
  updateDeliveryOrderWorkflow: () => ({ run: runMock }),
}));

// Imported AFTER the mock so the route picks up the mocked workflow.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST } = require('../[id]/route');

type Notif = Record<string, unknown>;

function harness(order: Record<string, unknown> | undefined) {
  const notifications: Notif[] = [];
  const packsService = {
    listDeliveryOrders: async () => (order ? [order] : []),
  };
  const scope = {
    resolve: (key: string) => {
      if (key === Modules.NOTIFICATION) {
        return {
          createNotifications: async (n: Notif) => {
            notifications.push(n);
            return [n];
          },
        };
      }
      return packsService;
    },
  };
  const json = jest.fn();
  return {
    notifications,
    // NOT `body: {}` — coerceDeliveryUpdateBody rejects an empty body with a
    // pre-existing "must provide at least one field" guard, which would fail
    // every test before the route's notification code is even reached. Must
    // not be `tracking_number` either: that would break the first test's
    // "omitted tracking mirrors the previous value" assertion. Inert to every
    // assertion here because the workflow itself is mocked.
    req: { params: { id: 'do_1' }, body: { status: 'shipped' }, scope } as never,
    res: { json } as never,
    json,
  };
}

beforeEach(() => {
  runMock.mockReset();
});

it('notifies the order owner when an admin ships it', async () => {
  runMock.mockResolvedValue({
    result: { order_id: 'do_1', status: 'shipped' },
  });
  const h = harness({
    id: 'do_1',
    customer_id: 'cus_1',
    status: 'packing',
    tracking_number: 'TRK1',
  });

  await POST(h.req, h.res);

  expect(h.notifications).toHaveLength(1);
  expect(h.notifications[0]).toMatchObject({
    receiver_id: 'cus_1',
    channel: 'feed',
    template: 'delivery_status',
    data: { order_id: 'do_1', status: 'shipped', tracking_number: 'TRK1' },
    idempotency_key: 'delivery:do_1:shipped',
  });
  expect(h.json).toHaveBeenCalledWith({
    order_id: 'do_1',
    status: 'shipped',
  });
});

it('does NOT notify a tracking-only update (status unchanged)', async () => {
  runMock.mockResolvedValue({
    result: { order_id: 'do_1', status: 'shipped' },
  });
  const h = harness({
    id: 'do_1',
    customer_id: 'cus_1',
    status: 'shipped',
    tracking_number: null,
  });

  await POST(h.req, h.res);

  expect(h.notifications).toHaveLength(0);
  expect(h.json).toHaveBeenCalled();
});

it('does NOT notify on packing', async () => {
  runMock.mockResolvedValue({
    result: { order_id: 'do_1', status: 'packing' },
  });
  const h = harness({
    id: 'do_1',
    customer_id: 'cus_1',
    status: 'requested',
    tracking_number: null,
  });

  await POST(h.req, h.res);

  expect(h.notifications).toHaveLength(0);
});

it('a notification failure never fails the committed status change', async () => {
  runMock.mockResolvedValue({
    result: { order_id: 'do_1', status: 'delivered' },
  });
  const h = harness({
    id: 'do_1',
    customer_id: 'cus_1',
    status: 'shipped',
    tracking_number: null,
  });
  // Replace the notification module with one that throws.
  const scope = h.req as unknown as { scope: { resolve: (k: string) => unknown } };
  const original = scope.scope.resolve;
  scope.scope.resolve = (key: string) =>
    key === Modules.NOTIFICATION
      ? {
          createNotifications: async () => {
            throw new Error('notification module down');
          },
        }
      : original(key);

  await expect(POST(h.req, h.res)).resolves.toBeUndefined();
  expect(h.json).toHaveBeenCalledWith({
    order_id: 'do_1',
    status: 'delivered',
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend/packages/api && corepack yarn test:unit delivery-notify.unit.spec
```

Expected: FAIL — the first test reports `expect(received).toHaveLength(1)` with `received.length === 0`, because the route does not produce a notification yet.

- [ ] **Step 3: Write the implementation**

Apply through a Node script:

```bash
node -e "
const fs=require('fs');
const p='backend/packages/api/src/api/admin/delivery-orders/[id]/route.ts';
let s=fs.readFileSync(p,'utf8');

const oldImports=\"import { coerceDeliveryUpdateBody } from '../validate';\";
const newImports=\"import { coerceDeliveryUpdateBody } from '../validate';\n\" +
  \"import { notifyFeed } from '../../../../modules/packs/notify-feed';\n\" +
  \"import {\n  shouldNotifyDeliveryStatus,\n  deliveryFeedKey,\n} from '../../../../modules/packs/feed-events';\";
if(!s.includes(oldImports)) throw new Error('import anchor not found');
s=s.replace(oldImports,newImports);

const oldBody=\`  const { id } = req.params;
  const input = coerceDeliveryUpdateBody(req.body);

  const { result } = await updateDeliveryOrderWorkflow(req.scope).run({
    input: { order_id: id, ...input },
  });

  res.json(result);\`;

const newBody=\`  const { id } = req.params;
  const input = coerceDeliveryUpdateBody(req.body);

  // Read BEFORE the workflow. The workflow result carries only
  // { order_id, status }, and a tracking-only update returns the UNCHANGED
  // status — so both the previous status and the owner have to be captured
  // here to decide whether anything notification-worthy happened.
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const [before] = await packs.listDeliveryOrders({ id }, { take: 1 });

  const { result } = await updateDeliveryOrderWorkflow(req.scope).run({
    input: { order_id: id, ...input },
  });

  // The producer lives HERE rather than inside updateDeliveryOrderWorkflow
  // because the customer's own cancel route (POST
  // /store/delivery-orders/:id/cancel) runs the SAME workflow — a
  // workflow-level producer would tell customers about their own
  // cancellations. Non-fatal: the status change is already committed.
  if (before && shouldNotifyDeliveryStatus(before.status, result.status)) {
    try {
      await notifyFeed(req.scope, {
        receiverId: before.customer_id,
        template: 'delivery_status',
        data: {
          order_id: result.order_id,
          status: result.status,
          // Mirrors the step's own nextTracking rule: an omitted
          // tracking_number means "unchanged", not "cleared".
          tracking_number:
            input.tracking_number !== undefined
              ? input.tracking_number
              : (before.tracking_number ?? null),
        },
        idempotencyKey: deliveryFeedKey(result.order_id, result.status),
      });
    } catch {
      // Non-fatal — never fail a committed status change over a notification.
    }
  }

  res.json(result);\`;

if(!s.includes(oldBody)) throw new Error('body anchor not found');
s=s.replace(oldBody,newBody);
fs.writeFileSync(p,s);
console.log('ok');
"
```

Expected output: `ok`. If either anchor throws, re-read the file and adjust the anchor text to match exactly — do not fall back to Edit.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend/packages/api && corepack yarn test:unit delivery-notify.unit.spec
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Type-check**

```bash
cd backend/packages/api && node node_modules/typescript/bin/tsc --noEmit
```

Expected: no errors. If `input.tracking_number` errors because `coerceDeliveryUpdateBody`'s return type does not declare it, widen the local read to `(input as { tracking_number?: string | null }).tracking_number` rather than changing the validator.

- [ ] **Step 6: Commit**

```bash
git add backend/packages/api/src/api/admin/delivery-orders/
git commit -m "$(cat <<'EOF'
feat(notifications): delivery_status producer on the admin route

Fires on shipped/delivered/canceled when the status actually changed.

Placed in the admin route rather than updateDeliveryOrderWorkflow on
purpose: the customer's own cancel route runs the same workflow, so a
workflow-level producer would notify people about their own
cancellations. Route placement makes that structurally impossible
instead of relying on an actor flag.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `topup_credited` producer

**Files:**
- Modify: `backend/packages/api/src/api/store/credits/topup/route.ts` (after the workflow run, lines 42–46)
- Create: `backend/packages/api/src/api/store/credits/__tests__/topup-notify.unit.spec.ts`

**Interfaces:**
- Consumes: `topupFeedKey`, `shouldNotifyTopup` (Task 1); `notifyFeed`.
- Produces: a `topup_credited` feed notification with `data: { amount_myr, reference }`.

The top-up workflow exposes no credit-transaction id — its result is `{ amount, reference, balance, replayed }`. `reference` is the gateway charge handle and is the natural per-charge key. `replayed: true` means nothing was credited, so it must not notify.

- [ ] **Step 1: Write the failing test**

Create `backend/packages/api/src/api/store/credits/__tests__/topup-notify.unit.spec.ts`:

```ts
// src/api/store/credits/__tests__/topup-notify.unit.spec.ts
const runMock = jest.fn();

jest.mock('../../../../workflows/topup-credits', () => ({
  topUpCreditsWorkflow: () => ({ run: runMock }),
}));

// Imported AFTER the mock so the route picks up the mocked workflow.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST } = require('../topup/route');

type Notif = Record<string, unknown>;

function harness() {
  const notifications: Notif[] = [];
  const scope = {
    resolve: () => ({
      createNotifications: async (n: Notif) => {
        notifications.push(n);
        return [n];
      },
    }),
  };
  const json = jest.fn();
  return {
    notifications,
    json,
    req: {
      auth_context: { actor_id: 'cus_1' },
      body: { amount: 50 },
      headers: { 'idempotency-key': 'key-1' },
      scope,
    } as never,
    res: { json } as never,
  };
}

beforeEach(() => {
  runMock.mockReset();
});

it('writes a topup_credited receipt for a real credit', async () => {
  runMock.mockResolvedValue({
    result: { amount: 50, reference: 'mock_abc', balance: 150, replayed: false },
  });
  const h = harness();

  await POST(h.req, h.res);

  expect(h.notifications).toHaveLength(1);
  expect(h.notifications[0]).toMatchObject({
    receiver_id: 'cus_1',
    channel: 'feed',
    template: 'topup_credited',
    data: { amount_myr: 50, reference: 'mock_abc' },
    idempotency_key: 'topup:mock_abc',
  });
});

it('does NOT write a receipt for a replay — nothing was credited', async () => {
  runMock.mockResolvedValue({
    result: { amount: 50, reference: 'mock_abc', balance: 150, replayed: true },
  });
  const h = harness();

  await POST(h.req, h.res);

  expect(h.notifications).toHaveLength(0);
  expect(h.json).toHaveBeenCalled();
});

it('a notification failure never fails a committed top-up', async () => {
  runMock.mockResolvedValue({
    result: { amount: 50, reference: 'mock_abc', balance: 150, replayed: false },
  });
  const h = harness();
  const req = h.req as unknown as { scope: { resolve: () => unknown } };
  req.scope.resolve = () => ({
    createNotifications: async () => {
      throw new Error('notification module down');
    },
  });

  await expect(POST(h.req, h.res)).resolves.toBeUndefined();
  expect(h.json).toHaveBeenCalledWith({
    amount: 50,
    reference: 'mock_abc',
    balance: 150,
    replayed: false,
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend/packages/api && corepack yarn test:unit topup-notify.unit.spec
```

Expected: FAIL — the first test reports `received.length === 0`; the route does not produce a notification yet.

- [ ] **Step 3: Write the implementation**

```bash
node -e "
const fs=require('fs');
const p='backend/packages/api/src/api/store/credits/topup/route.ts';
let s=fs.readFileSync(p,'utf8');

const oldImports=\"import { topUpCreditsWorkflow } from '../../../../workflows/topup-credits';\";
const newImports=\"import { topUpCreditsWorkflow } from '../../../../workflows/topup-credits';\n\" +
  \"import { notifyFeed } from '../../../../modules/packs/notify-feed';\n\" +
  \"import {\n  shouldNotifyTopup,\n  topupFeedKey,\n} from '../../../../modules/packs/feed-events';\";
if(!s.includes(oldImports)) throw new Error('import anchor not found');
s=s.replace(oldImports,newImports);

const oldTail=\`  const { result } = await topUpCreditsWorkflow(req.scope).run({
    input: { customer_id: customerId, amount, idempotency_key },
  });

  res.json(result);\`;

const newTail=\`  const { result } = await topUpCreditsWorkflow(req.scope).run({
    input: { customer_id: customerId, amount, idempotency_key },
  });

  // Feed receipt for the credit. A replay credited NOTHING (it returned the
  // pre-existing row), so it must not produce a second row. Keyed on the
  // gateway charge reference — the workflow exposes no ledger-row id.
  //
  // Toast policy for this template is 'never' on the storefront: the top-up
  // sheet already confirms the charge on the tab that made it. This row is the
  // durable receipt, and it is what a real gateway webhook will reuse when the
  // charge stops being synchronous.
  //
  // Non-fatal: the credit is already committed.
  if (shouldNotifyTopup(result)) {
    try {
      await notifyFeed(req.scope, {
        receiverId: customerId,
        template: 'topup_credited',
        data: { amount_myr: result.amount, reference: result.reference },
        idempotencyKey: topupFeedKey(result.reference),
      });
    } catch {
      // Non-fatal — never fail a committed top-up over a notification.
    }
  }

  res.json(result);\`;

if(!s.includes(oldTail)) throw new Error('tail anchor not found');
s=s.replace(oldTail,newTail);
fs.writeFileSync(p,s);
console.log('ok');
"
```

Expected output: `ok`.

- [ ] **Step 4: Run the test to verify it passes, then confirm the money path is intact**

```bash
cd backend/packages/api && corepack yarn test:unit topup-notify.unit.spec
```

Expected: PASS — 3 tests.

```bash
cd backend/packages/api && corepack yarn test:integration:http credit-topup.spec
```

Expected: PASS. This proves the producer did not break the money path or change the response body. If `pokenic-postgres` is not running, start it first (`docker start pokenic-postgres`).

- [ ] **Step 5: Type-check**

```bash
cd backend/packages/api && node node_modules/typescript/bin/tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/packages/api/src/api/store/credits/
git commit -m "$(cat <<'EOF'
feat(notifications): topup_credited feed receipt

Keyed on the gateway charge reference — the workflow exposes no ledger
row id. Skips replays, which credited nothing.

Toast policy is 'never': the top-up sheet already confirms the charge on
the tab that made it. The row is the durable receipt, and the seam a
real gateway webhook will reuse once the charge stops being synchronous.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `reward_won` producer

`reward_won` has been declared in `FeedTemplate` since the feed shipped and **nothing has ever produced it** — zero rows exist. This task gives it a producer.

The draw route cannot key the notification today: `DrawDailyBoxResult` returns `{ status, prize, draw_ordinal }` with no `draw_day`, and recomputing the UTC date in the route can disagree with the service across a midnight boundary. So the service returns the `drawDay` it already computed.

**Files:**
- Modify: `backend/packages/api/src/modules/packs/service.ts` (`DrawDailyBoxResult` at ~L297–307; the `return` at ~L4243)
- Modify: `backend/packages/api/src/api/store/daily/draw/route.ts`

**Interfaces:**
- Consumes: `shouldNotifyRewardWon`, `rewardWonFeedKey` (Task 1); `notifyFeed`.
- Produces: `DrawDailyBoxResult` gains `draw_day?: string`; a `reward_won` feed notification with `data: { prize_kind, title, amount_myr, draw_ordinal }`.

- [ ] **Step 1: Add `draw_day` to the result type**

```bash
node -e "
const fs=require('fs');
const p='backend/packages/api/src/modules/packs/service.ts';
let s=fs.readFileSync(p,'utf8');

const oldType=\`  draw_ordinal?: number;
};\`;
const newType=\`  draw_ordinal?: number;
  /** UTC yyyy-mm-dd the draw was settled under — the notification key uses
   *  this rather than recomputing the date in the route, which can disagree
   *  across a midnight boundary. */
  draw_day?: string;
};\`;
const i=s.indexOf('export type DrawDailyBoxResult');
if(i<0) throw new Error('DrawDailyBoxResult not found');
const j=s.indexOf(oldType,i);
if(j<0) throw new Error('result type anchor not found');
s=s.slice(0,j)+newType+s.slice(j+oldType.length);

const oldRet=\`      return {
        status: 'drawn',
        prize: resultPrize,
        draw_ordinal: drawOrdinal,
      };\`;
const newRet=\`      return {
        status: 'drawn',
        prize: resultPrize,
        draw_ordinal: drawOrdinal,
        draw_day: drawDay,
      };\`;
if(!s.includes(oldRet)) throw new Error('return anchor not found');
s=s.replace(oldRet,newRet);
fs.writeFileSync(p,s);
console.log('ok');
"
```

Expected output: `ok`.

- [ ] **Step 2: Type-check to confirm the service change is clean**

```bash
cd backend/packages/api && node node_modules/typescript/bin/tsc --noEmit
```

Expected: no errors. `draw_day` is optional, so no existing caller breaks.

- [ ] **Step 3: Write the producer into the draw route**

```bash
node -e "
const fs=require('fs');
const p='backend/packages/api/src/api/store/daily/draw/route.ts';
let s=fs.readFileSync(p,'utf8');

const oldImports=\"import { rewardsRedemptionEnabled } from '../../../../modules/packs/rewards-gate';\";
const newImports=\"import { rewardsRedemptionEnabled } from '../../../../modules/packs/rewards-gate';\n\" +
  \"import { notifyFeed } from '../../../../modules/packs/notify-feed';\n\" +
  \"import {\n  shouldNotifyRewardWon,\n  rewardWonFeedKey,\n} from '../../../../modules/packs/feed-events';\";
if(!s.includes(oldImports)) throw new Error('import anchor not found');
s=s.replace(oldImports,newImports);

const oldTail=\`  // A \\\"nothing\\\" prize is a normal drawn outcome, not a failure — say so in\`;
const newTail=\`  // Feed record of the prize. reward_won has been in FeedTemplate since the
  // feed shipped with no producer at all — this is it. Toast policy is
  // 'never' on the storefront: PrizeReveal is already a full-screen
  // announcement on the tab that drew, so the row is the durable history
  // entry, not a second announcement.
  //
  // Non-fatal: the draw is already committed.
  if (shouldNotifyRewardWon(result)) {
    try {
      await notifyFeed(req.scope, {
        receiverId: customerId,
        template: 'reward_won',
        data: {
          prize_kind: result.prize?.kind ?? '',
          title: result.prize?.title ?? '',
          amount_myr: result.prize?.amount_myr ?? 0,
          draw_ordinal: result.draw_ordinal ?? 0,
        },
        idempotencyKey: rewardWonFeedKey(
          customerId,
          result.draw_day as string,
          result.draw_ordinal as number,
        ),
      });
    } catch {
      // Non-fatal — never fail a committed draw over a notification.
    }
  }

\` + oldTail;

if(!s.includes(oldTail)) throw new Error('tail anchor not found');
s=s.replace(oldTail,newTail);
fs.writeFileSync(p,s);
console.log('ok');
"
```

Expected output: `ok`.

- [ ] **Step 4: Verify the daily-draw integration test still passes**

```bash
cd backend/packages/api && corepack yarn test:integration:http daily
```

Expected: PASS. This exercises the draw path end to end with the producer in place. If no `daily*` spec matches, run the reward suite instead:

```bash
cd backend/packages/api && corepack yarn test:integration:http reward
```

- [ ] **Step 5: Type-check**

```bash
cd backend/packages/api && node node_modules/typescript/bin/tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/packages/api/src/modules/packs/service.ts \
        backend/packages/api/src/api/store/daily/draw/route.ts
git commit -m "$(cat <<'EOF'
feat(notifications): give reward_won a producer

reward_won has been declared in FeedTemplate since the feed shipped and
nothing ever produced it — zero rows exist. The daily draw now writes one.

DrawDailyBoxResult gains draw_day so the route can key the notification
on the same day the service settled under; recomputing the UTC date in
the route can disagree across a midnight boundary.

Toast policy stays 'never' — PrizeReveal is already the announcement.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Bulk mark-read endpoint

The watermark design in PR 2 deliberately leaves `read_at` untouched, so every notification will pop, be seen, and stay unread. Without a bulk clear the badge accumulates permanently and stops being read. The problem is self-inflicted, so it ships with the change that creates it.

Per-id marking cannot be looped from the client: `createNotificationReadRateLimit` allows 20/10s burst, so clearing 50 rows would 429.

**Files:**
- Modify: `backend/packages/api/src/api/utils/rate-limit.ts`
- Create: `backend/packages/api/src/api/store/notifications/read-all/route.ts`
- Modify: `backend/packages/api/src/api/middlewares.ts`
- Create: `backend/packages/api/integration-tests/http/store-notifications-read-all.spec.ts`

**Interfaces:**
- Consumes: `packs.listNotificationReads`, `packs.createNotificationReads` (auto-generated by `MedusaService`); `INotificationModuleService.listNotifications`.
- Produces: `POST /store/notifications/read-all` → `{ marked: number, read_at: string }`.

- [ ] **Step 1: Write the failing integration test**

Create `backend/packages/api/integration-tests/http/store-notifications-read-all.spec.ts`:

```ts
// integration-tests/http/store-notifications-read-all.spec.ts
// TDD: RED first — POST /store/notifications/read-all does not exist yet (404).
// Tests:
//   (auth)     no bearer → 401.
//   (positive) marks every unread row for the caller; unread_count → 0.
//   (idempotent) a second call marks 0 and does not change read_at.
//   (IDOR)     B's rows are untouched by A's read-all.
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { unwrapResponse } from './utils';

jest.setTimeout(120 * 1000);

const PASSWORD = 'read-all-test-password-1';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('POST /store/notifications/read-all', () => {
      let storeHeaders: Record<string, string>;
      let tokenA: string;
      let customerIdA: string;
      let customerIdB: string;

      beforeEach(async () => {
        const container = getContainer();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'read-all-test',
          type: 'publishable',
          created_by: 'read-all-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        const regA = await api.post('/auth/customer/emailpass/register', {
          email: 'read-all-a@test.dev',
          password: PASSWORD,
        });
        await api.post(
          '/store/customers',
          { email: 'read-all-a@test.dev' },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${regA.data.token}`,
            },
          },
        );
        const loginA = await api.post('/auth/customer/emailpass', {
          email: 'read-all-a@test.dev',
          password: PASSWORD,
        });
        tokenA = loginA.data.token;
        customerIdA = JSON.parse(
          Buffer.from(tokenA.split('.')[1], 'base64').toString('utf8'),
        ).actor_id as string;

        const regB = await api.post('/auth/customer/emailpass/register', {
          email: 'read-all-b@test.dev',
          password: PASSWORD,
        });
        await api.post(
          '/store/customers',
          { email: 'read-all-b@test.dev' },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${regB.data.token}`,
            },
          },
        );
        customerIdB = JSON.parse(
          Buffer.from(regB.data.token.split('.')[1], 'base64').toString('utf8'),
        ).actor_id as string;

        // Three unread rows for A, two for B.
        const notif = container.resolve(Modules.NOTIFICATION);
        for (const template of [
          'vip_level_up',
          'commission_matured',
          'delivery_status',
        ]) {
          await notif.createNotifications([
            {
              to: customerIdA,
              receiver_id: customerIdA,
              channel: 'feed',
              template,
              data: {},
            },
          ]);
        }
        for (const template of ['vip_level_up', 'topup_credited']) {
          await notif.createNotifications([
            {
              to: customerIdB,
              receiver_id: customerIdB,
              channel: 'feed',
              template,
              data: {},
            },
          ]);
        }
      });

      const authed = (token: string) => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      it('(auth) returns 401 without a bearer token', async () => {
        const res = await unwrapResponse(
          api.post('/store/notifications/read-all', {}, { headers: storeHeaders }),
        );
        expect(res.status).toBe(401);
      });

      it('(positive) marks every unread row and zeroes unread_count', async () => {
        const before = await unwrapResponse(
          api.get('/store/notifications', { headers: authed(tokenA) }),
        );
        expect(before.data.unread_count).toBe(3);

        const res = await unwrapResponse(
          api.post('/store/notifications/read-all', {}, { headers: authed(tokenA) }),
        );
        expect(res.status).toBe(200);
        expect(res.data.marked).toBe(3);
        expect(res.data.read_at).toBeTruthy();

        const after = await unwrapResponse(
          api.get('/store/notifications', { headers: authed(tokenA) }),
        );
        expect(after.data.unread_count).toBe(0);
        for (const n of after.data.notifications) {
          expect(n.read_at).toBeTruthy();
        }
      });

      it('(idempotent) a second call marks nothing more', async () => {
        await unwrapResponse(
          api.post('/store/notifications/read-all', {}, { headers: authed(tokenA) }),
        );
        const second = await unwrapResponse(
          api.post('/store/notifications/read-all', {}, { headers: authed(tokenA) }),
        );
        expect(second.status).toBe(200);
        expect(second.data.marked).toBe(0);
      });

      it("(IDOR) A's read-all never touches B's rows", async () => {
        await unwrapResponse(
          api.post('/store/notifications/read-all', {}, { headers: authed(tokenA) }),
        );

        const container = getContainer();
        const packs = container.resolve('packs') as {
          listNotificationReads: (
            f: Record<string, unknown>,
            c: Record<string, unknown>,
          ) => Promise<Array<{ customer_id: string }>>;
        };
        const bReads = await packs.listNotificationReads(
          { customer_id: customerIdB },
          { take: 100 },
        );
        expect(bReads).toHaveLength(0);
      });
    });
  },
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend/packages/api && corepack yarn test:integration:http store-notifications-read-all.spec
```

Expected: FAIL — the auth test gets 404 instead of 401 (no route, so no middleware runs).

- [ ] **Step 3: Add the rate-limit tier**

```bash
node -e "
const fs=require('fs');
const p='backend/packages/api/src/api/utils/rate-limit.ts';
let s=fs.readFileSync(p,'utf8');

const anchor=\"export function createNotificationReadRateLimit(): MiddlewareHandler {\";
const i=s.indexOf(anchor);
if(i<0) throw new Error('anchor not found');
// Find the end of that function (its closing brace at column 0 followed by a blank line).
const end=s.indexOf('\n}\n', i);
if(end<0) throw new Error('function end not found');
const insertAt=end+3;

const added=\`
/**
 * The bulk mark-read limiter (POST /store/notifications/read-all). One call
 * clears the whole feed page, so a human needs this only a handful of times a
 * minute — far tighter than the per-id limiter it replaces for bulk work, and
 * deliberately its own tier so a runaway read-all loop cannot eat the per-id
 * budget a normal feed interaction depends on. Env-tunable:
 * NOTIFICATION_READ_ALL_RATE_BURST_LIMIT / _BURST_WINDOW_MS (default 5/10s)
 * NOTIFICATION_READ_ALL_RATE_LIMIT / _WINDOW_MS (default 30/60s)
 */
export function createNotificationReadAllRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'notification-read-all',
    message: 'Too many mark-all-read requests.',
    defaults: {
      burstLimit: 5,
      burstWindowMs: 10_000,
      limit: 30,
      windowMs: 60_000,
    },
  });
}
\`;

s=s.slice(0,insertAt)+added+s.slice(insertAt);
fs.writeFileSync(p,s);
console.log('ok');
"
```

Expected output: `ok`.

- [ ] **Step 4: Create the route**

Create `backend/packages/api/src/api/store/notifications/read-all/route.ts` (new file — Write is safe):

```ts
import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { Modules, MedusaError } from '@medusajs/framework/utils';
import type { INotificationModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';

// POST /store/notifications/read-all
//
// Marks every currently-unread feed notification read for the authenticated
// customer, in one request.
//
// Why this exists: toasts are driven by a client-side watermark and never write
// read_at (so the bell badge and the toast keep answering different questions).
// That means notifications accumulate as unread indefinitely, and the per-id
// limiter (20/10s) makes a client-side loop over 50 rows impossible. This is
// the only way to clear the badge.
//
// Owner-scoping: receiver_id comes ONLY from the verified bearer token, never
// from the body. The write set is derived from that same owner-scoped list, so
// there is no id input to forge.
//
// Idempotent: rows that already have a notification_read entry are skipped, so
// a second call marks 0 and leaves the original timestamps intact.
//
// Auth + rate-limit middleware is registered in src/api/middlewares.ts.
//
// Page size mirrors RECENT_NOTIFICATIONS in the sibling list route: the feed UI
// only ever shows that page, so "mark all read" means "mark all the customer
// can actually see".
const RECENT_NOTIFICATIONS = 50;

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const notif = req.scope.resolve<INotificationModuleService>(
    Modules.NOTIFICATION,
  );
  const notifications = await notif.listNotifications(
    { receiver_id: customerId, channel: 'feed' },
    { take: RECENT_NOTIFICATIONS, order: { created_at: 'DESC' } },
  );

  const now = new Date();
  if (notifications.length === 0) {
    res.json({ marked: 0, read_at: now.toISOString() });
    return;
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const ids = notifications.map((n) => n.id);
  const existing = await packs.listNotificationReads(
    { customer_id: customerId, notification_id: ids },
    { take: ids.length },
  );
  const alreadyRead = new Set(
    existing.map((r: { notification_id: string }) => r.notification_id),
  );

  const toCreate = ids
    .filter((id) => !alreadyRead.has(id))
    .map((id) => ({
      notification_id: id,
      customer_id: customerId,
      read_at: now,
    }));

  if (toCreate.length === 0) {
    res.json({ marked: 0, read_at: now.toISOString() });
    return;
  }

  try {
    await packs.createNotificationReads(toCreate);
  } catch {
    // TOCTOU: a concurrent per-id mark-read may have inserted between the read
    // above and this write, tripping the (notification_id, customer_id) unique
    // index. Re-derive what is actually unread and report that, rather than
    // failing a request whose intent ("leave nothing unread") is satisfied.
    const after = await packs.listNotificationReads(
      { customer_id: customerId, notification_id: ids },
      { take: ids.length },
    );
    res.json({
      marked: Math.max(0, after.length - existing.length),
      read_at: now.toISOString(),
    });
    return;
  }

  res.json({ marked: toCreate.length, read_at: now.toISOString() });
}
```

- [ ] **Step 5: Register the matcher**

The new matcher must come **before** the `'/store/notifications/*/read'` entry is irrelevant (they do not overlap: two segments vs three), but it must be a distinct entry. Insert it directly after the existing feed-list entry:

```bash
node -e "
const fs=require('fs');
const p='backend/packages/api/src/api/middlewares.ts';
let s=fs.readFileSync(p,'utf8');

const oldImport=\"  createNotificationReadRateLimit,\";
const newImport=\"  createNotificationReadAllRateLimit,\n  createNotificationReadRateLimit,\";
if(!s.includes(oldImport)) throw new Error('import anchor not found');
s=s.replace(oldImport,newImport);

const anchor=\`      matcher: '/store/notifications',
      method: 'GET',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },\`;
const added=anchor + \`
    {
      // Bulk mark-read (POST /store/notifications/read-all). The write set is
      // derived from the caller's own owner-scoped feed inside the handler —
      // there is no id input to forge, so this entry is the auth +
      // rate-limit gate only. Its own limiter tier: a runaway read-all loop
      // must not eat the per-id budget normal feed interaction depends on.
      matcher: '/store/notifications/read-all',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        createNotificationReadAllRateLimit(),
      ],
    },\`;
if(!s.includes(anchor)) throw new Error('matcher anchor not found');
s=s.replace(anchor,added);
fs.writeFileSync(p,s);
console.log('ok');
"
```

Expected output: `ok`.

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd backend/packages/api && corepack yarn test:integration:http store-notifications-read-all.spec
```

Expected: PASS — 4 tests.

If the IDOR test fails resolving `'packs'`, replace the resolve line with the typed module key used elsewhere in the suite:

```ts
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
// …
const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
```

- [ ] **Step 7: Confirm the existing notifications suite is unaffected**

```bash
cd backend/packages/api && corepack yarn test:integration:http store-notifications.spec
```

Expected: PASS — the list and per-id routes are untouched.

- [ ] **Step 8: Type-check and commit**

```bash
cd backend/packages/api && node node_modules/typescript/bin/tsc --noEmit
```

Expected: no errors.

```bash
git add backend/packages/api/src/api/utils/rate-limit.ts \
        backend/packages/api/src/api/store/notifications/read-all/ \
        backend/packages/api/src/api/middlewares.ts \
        backend/packages/api/integration-tests/http/store-notifications-read-all.spec.ts
git commit -m "$(cat <<'EOF'
feat(notifications): bulk mark-read endpoint

POST /store/notifications/read-all, owner-scoped, idempotent, on its own
rate-limit tier.

Needed because PR 2's toasts are driven by a client watermark and never
write read_at, so notifications accumulate as unread forever. The per-id
limiter (20/10s) makes a client-side loop over a 50-row page impossible,
so clearing the badge has to be one request.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Storefront copy registry

The single source of truth for how a notification template renders. `/notifications` consumes it in this PR; PR 2's toasts consume the same entries, so a new template is one edit rather than three.

**Files:**
- Create: `src/lib/notifications/copy.ts`
- Create: `src/lib/notifications/__tests__/copy.test.ts`

**Interfaces:**
- Consumes: `lucide-react` icon components (already a dependency), `rm` from `@/lib/format`.
- Produces:
  - `type ToastPolicy = 'always' | 'never'`
  - `type NotificationVariant = 'success' | 'info' | 'reward'`
  - `type NotificationCopy = { icon, variant, policy, title, body, href, action }`
  - `NOTIFICATION_COPY: Record<string, NotificationCopy>`
  - `copyFor(template: string): NotificationCopy`

- [ ] **Step 1: Write the failing test**

Create `src/lib/notifications/__tests__/copy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { NOTIFICATION_COPY, copyFor } from '../copy';

const TEMPLATES = [
  'vip_level_up',
  'commission_matured',
  'delivery_status',
  'reward_won',
  'voucher_claimed',
  'topup_credited',
] as const;

describe('NOTIFICATION_COPY', () => {
  it('covers every template the backend can produce', () => {
    for (const t of TEMPLATES) {
      expect(NOTIFICATION_COPY[t], `missing copy for ${t}`).toBeTruthy();
    }
    // No extras — an orphan entry means a template was renamed or removed.
    expect(Object.keys(NOTIFICATION_COPY).sort()).toEqual([...TEMPLATES].sort());
  });

  it('gives every entry a non-empty title and a valid variant and policy', () => {
    for (const t of TEMPLATES) {
      // Read through copyFor, not the raw index: the repo enables
      // noUncheckedIndexedAccess, and copyFor is what consumers call anyway.
      const c = copyFor(t);
      expect(c.title.length).toBeGreaterThan(0);
      expect(['success', 'info', 'reward']).toContain(c.variant);
      expect(['always', 'never']).toContain(c.policy);
      expect(c.icon).toBeTruthy();
    }
  });

  it('toasts exactly the three templates nothing else announces', () => {
    const always = TEMPLATES.filter((t) => copyFor(t).policy === 'always');
    // voucher_claimed / topup_credited have their own client toast;
    // reward_won has PrizeReveal. Toasting them would double up.
    expect(always.sort()).toEqual(
      ['commission_matured', 'delivery_status', 'vip_level_up'].sort(),
    );
  });

  it('pairs an action label with every href and neither without the other', () => {
    for (const t of TEMPLATES) {
      const c = copyFor(t);
      expect(Boolean(c.href)).toBe(Boolean(c.action));
    }
  });
});

describe('body rendering', () => {
  it('vip_level_up reads naturally for one and for several levels', () => {
    const body = copyFor('vip_level_up').body;
    expect(body({ levels: [23] })).toBe('You reached level 23.');
    expect(body({ levels: [22, 23] })).toBe('You reached levels 22 and 23.');
    expect(body({ levels: [21, 22, 23] })).toBe(
      'You reached levels 21, 22 and 23.',
    );
  });

  it('commission_matured branches on the frozen flag', () => {
    const body = copyFor('commission_matured').body;
    expect(body({ frozen: false })).toBe(
      'Your commission is now available to spend.',
    );
    expect(body({ frozen: true })).toBe(
      'It will be available once your account is unfrozen.',
    );
  });

  it('delivery_status describes each notifiable status', () => {
    const body = copyFor('delivery_status').body;
    expect(body({ status: 'shipped', tracking_number: 'TRK1' })).toBe(
      'Your order is on its way. Tracking: TRK1',
    );
    expect(body({ status: 'shipped', tracking_number: null })).toBe(
      'Your order is on its way.',
    );
    expect(body({ status: 'delivered' })).toBe('Your order was delivered.');
    expect(body({ status: 'canceled' })).toBe(
      'Your delivery was canceled. Contact support if this was unexpected.',
    );
  });

  it('money bodies format as RM', () => {
    expect(copyFor('topup_credited').body({ amount_myr: 50 })).toBe(
      'RM 50.00 added to your balance.',
    );
    expect(copyFor('voucher_claimed').body({ amount_myr: 5, level: 3 })).toBe(
      'RM 5.00 credited from your Level 3 voucher.',
    );
  });

  it('survives null, empty and malformed data without throwing', () => {
    for (const t of TEMPLATES) {
      const body = copyFor(t).body;
      expect(() => body(null)).not.toThrow();
      expect(() => body({})).not.toThrow();
      expect(() => body({ levels: 'nope', amount_myr: 'x' })).not.toThrow();
      // Never undefined: the renderers branch on `body && …`, so an undefined
      // return would render nothing while silently passing a truthiness check
      // that was meant to distinguish "no detail" from "broken payload".
      expect(body(null)).not.toBeUndefined();
      expect(body({ levels: 'nope', amount_myr: 'x' })).not.toBeUndefined();
    }
  });
});

describe('copyFor', () => {
  it('returns the registered entry', () => {
    expect(copyFor('vip_level_up').title).toBe('You leveled up!');
  });

  it('falls back safely for an unknown template rather than throwing', () => {
    const c = copyFor('some_future_template');
    expect(c.title).toBe('some_future_template');
    expect(c.policy).toBe('never');
    expect(c.href).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test -- src/lib/notifications
```

Expected: FAIL — `Failed to resolve import "../copy"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/notifications/copy.ts`:

```ts
import {
  Bell,
  CreditCard,
  Gift,
  Package,
  Sparkles,
  Ticket,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { rm } from '@/lib/format';

/**
 * Whether the notification feed is allowed to raise a toast for a template.
 *
 * 'never' does NOT mean silent — it means something else already announced it
 * on the tab that caused it (a client toast, or PrizeReveal). Toasting again
 * would double up, and de-duplicating by notification id cannot catch that
 * because a client toast has no notification id.
 */
export type ToastPolicy = 'always' | 'never';

export type NotificationVariant = 'success' | 'info' | 'reward';

export type NotificationCopy = {
  icon: LucideIcon;
  variant: NotificationVariant;
  policy: ToastPolicy;
  /** Static — titles never depend on payload data. */
  title: string;
  /** Payload-derived detail line. Returns null when there is nothing to add. */
  body: (data: Record<string, unknown> | null) => string | null;
  /** Where tapping goes, or null when there is nowhere useful. */
  href: string | null;
  /** Visible affordance label. Always set together with href. */
  action: string | null;
};

// --- payload readers ---------------------------------------------------------
// `data` is whatever the backend wrote, parsed through a loose Zod schema, so
// every read is defensive. A malformed payload degrades to a missing detail
// line, never a crash in a toast or a feed row.

function numOf(data: Record<string, unknown> | null, key: string): number | null {
  const v = data?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOf(data: Record<string, unknown> | null, key: string): string | null {
  const v = data?.[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function numsOf(data: Record<string, unknown> | null, key: string): number[] {
  const v = data?.[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
}

/** "23" · "22 and 23" · "21, 22 and 23" — an Oxford-less list, read aloud well. */
function joinNatural(items: (string | number)[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return String(items[0]);
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// --- the registry ------------------------------------------------------------

export const NOTIFICATION_COPY: Record<string, NotificationCopy> = {
  vip_level_up: {
    icon: Sparkles,
    variant: 'reward',
    // Nothing else announces a level-up: the slot machine never mentions it.
    // This is the gap that started the whole feature.
    policy: 'always',
    title: 'You leveled up!',
    body: (data) => {
      const levels = numsOf(data, 'levels');
      if (levels.length === 0) return null;
      return levels.length === 1
        ? `You reached level ${levels[0]}.`
        : `You reached levels ${joinNatural(levels)}.`;
    },
    href: '/vip',
    action: 'View VIP',
  },

  commission_matured: {
    icon: TrendingUp,
    variant: 'success',
    policy: 'always',
    title: 'Commission unlocked',
    body: (data) =>
      data?.frozen === true
        ? 'It will be available once your account is unfrozen.'
        : 'Your commission is now available to spend.',
    href: '/transactions',
    action: 'View ledger',
  },

  delivery_status: {
    icon: Package,
    variant: 'info',
    policy: 'always',
    title: 'Delivery update',
    body: (data) => {
      const status = strOf(data, 'status');
      const tracking = strOf(data, 'tracking_number');
      if (status === 'shipped') {
        return tracking
          ? `Your order is on its way. Tracking: ${tracking}`
          : 'Your order is on its way.';
      }
      if (status === 'delivered') return 'Your order was delivered.';
      if (status === 'canceled') {
        return 'Your delivery was canceled. Contact support if this was unexpected.';
      }
      return null;
    },
    href: '/orders',
    action: 'View orders',
  },

  reward_won: {
    icon: Gift,
    variant: 'reward',
    // PrizeReveal is already a full-screen announcement on the tab that drew.
    policy: 'never',
    title: 'You won a reward!',
    body: (data) => {
      const title = strOf(data, 'title');
      const amount = numOf(data, 'amount_myr');
      if (title) return `You won ${title}.`;
      if (amount && amount > 0) return `You won ${rm(amount)} in credit.`;
      return null;
    },
    href: '/rewards',
    action: 'View rewards',
  },

  voucher_claimed: {
    icon: Ticket,
    variant: 'success',
    // The claim flow raises its own toast on the tab that claimed.
    policy: 'never',
    title: 'Voucher redeemed',
    body: (data) => {
      const amount = numOf(data, 'amount_myr');
      const level = numOf(data, 'level');
      if (amount === null) return null;
      return level
        ? `${rm(amount)} credited from your Level ${level} voucher.`
        : `${rm(amount)} credited to your balance.`;
    },
    href: '/vip',
    action: 'View VIP',
  },

  topup_credited: {
    icon: CreditCard,
    variant: 'success',
    // The top-up sheet confirms the charge on the tab that made it.
    policy: 'never',
    title: 'Top-up complete',
    body: (data) => {
      const amount = numOf(data, 'amount_myr');
      return amount === null ? null : `${rm(amount)} added to your balance.`;
    },
    href: '/transactions',
    action: 'View ledger',
  },
};

/**
 * Copy for a template, with a safe fallback.
 *
 * An unknown template means the backend shipped one the storefront has not
 * learned yet. Showing the raw template name is ugly but honest, and the
 * 'never' policy keeps an unknown payload from raising a toast whose body no
 * one has reviewed.
 */
export function copyFor(template: string): NotificationCopy {
  return (
    NOTIFICATION_COPY[template] ?? {
      icon: Bell,
      variant: 'info',
      policy: 'never',
      title: template,
      body: () => null,
      href: null,
      action: null,
    }
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test -- src/lib/notifications
```

Expected: PASS — 3 suites, 11 tests.

- [ ] **Step 5: Type-check and commit**

```bash
npx tsc --noEmit
```

Expected: no errors.

```bash
git add src/lib/notifications/
git commit -m "$(cat <<'EOF'
feat(notifications): shared template copy registry

One entry per template carrying title, payload-derived body, deep link,
action label, icon, variant and toast policy. /notifications renders from
it in this PR; PR 2's toasts read the same entries, so adding a template
is one edit rather than three.

Payload reads are defensive throughout — a malformed data blob degrades
to a missing detail line, never a crash inside a toast.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `markAllRead` server action

**Files:**
- Modify: `src/lib/data/schemas.ts` (append near the notification schemas at lines 391–411)
- Modify: `src/lib/actions/notifications.ts`

**Interfaces:**
- Consumes: `POST /store/notifications/read-all` (Task 5); `parseOne`, `getAuthToken`, `friendlyError`, `isAuthError`.
- Produces: `markAllRead(): Promise<MarkAllReadResult>` where
  `MarkAllReadResult = { ok: true; marked: number; readAt: string } | { ok: false; error: string; needsAuth?: boolean }`.

- [ ] **Step 1: Add the response schema**

Edit `src/lib/data/schemas.ts` — insert after `MarkReadSchema` (which ends at line 411):

```ts
/** POST /store/notifications/read-all — bulk mark-read response. */
export const MarkAllReadSchema = z.looseObject({
  marked: finite,
  read_at: z.union([z.string(), z.date()]),
});
```

- [ ] **Step 2: Add the server action**

Edit `src/lib/actions/notifications.ts`.

Extend the schema import (currently lines 24–30) to include `MarkAllReadSchema`:

```ts
import {
  parseOne,
  parseList,
  NotificationSchema,
  NotificationsEnvelopeSchema,
  MarkReadSchema,
  MarkAllReadSchema,
} from '@/lib/data/schemas';
```

Add the result type after `MarkReadResult` (line 46):

```ts
export type MarkAllReadResult =
  | { ok: true; marked: number; readAt: string }
  | { ok: false; error: string; needsAuth?: boolean };
```

Append the action at the end of the file:

```ts
/**
 * Marks every unread feed notification read in one request.
 *
 * The per-id endpoint is rate-limited at 20/10s, so clearing a 50-row feed
 * client-side would 429 — this is the only viable way to zero the badge.
 */
export async function markAllRead(): Promise<MarkAllReadResult> {
  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }

  try {
    const raw = await sdk.client.fetch('/store/notifications/read-all', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: {},
    });

    const parsed = parseOne(MarkAllReadSchema, raw);
    if (!parsed) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }

    return {
      ok: true,
      marked: parsed.marked,
      readAt: coerceReadAt(parsed.read_at) ?? new Date().toISOString(),
    };
  } catch (error) {
    logger.error('[notifications] markAllRead failed:', error);
    return {
      ok: false,
      error: friendlyError(error, NOTIF_RULES, NOTIF_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Confirm the existing schema tests still pass**

```bash
npm run test -- src/lib/data
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/data/schemas.ts src/lib/actions/notifications.ts
git commit -m "$(cat <<'EOF'
feat(notifications): markAllRead server action

Wraps POST /store/notifications/read-all. The per-id endpoint is limited
to 20/10s, so clearing a 50-row feed client-side would 429.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Registry-driven notifications page

`/notifications` currently renders `TITLES[n.template] ?? n.template` and a timestamp. `n.data` is fetched and never shown; there are no icons, no bodies, no links, and no way to clear the badge.

**Files:**
- Modify: `src/app/(account)/notifications/NotificationsClient.tsx` (full rewrite)

**Interfaces:**
- Consumes: `copyFor` (Task 6); `markAllRead` (Task 7); `markRead`, `Notification` (existing); `relativeTime`.
- Produces: no new exports and no prop changes — `NotificationsClient` keeps its default export and its single `initial` prop, so `page.tsx` is untouched.

- [ ] **Step 1: Rewrite the client**

Replace the entire contents of `src/app/(account)/notifications/NotificationsClient.tsx`:

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { relativeTime } from '@/lib/format';
import { markRead, markAllRead } from '@/lib/actions/notifications';
import type { Notification } from '@/lib/actions/notifications';
import { copyFor } from '@/lib/notifications/copy';

export default function NotificationsClient({
  initial,
}: {
  initial: Notification[];
}) {
  const [items, setItems] = useState<Notification[]>(initial);
  const [clearing, setClearing] = useState(false);
  const unread = items.filter((n) => !n.readAt).length;

  async function onRead(id: string) {
    // Optimistic — mark read locally immediately.
    setItems((xs) =>
      xs.map((n) =>
        n.id === id ? { ...n, readAt: new Date().toISOString() } : n,
      ),
    );
    const r = await markRead(id);
    if (!r.ok) {
      setItems((xs) => xs.map((n) => (n.id === id ? { ...n, readAt: null } : n)));
    }
  }

  async function onClearAll() {
    // Snapshot for rollback: only the rows this action actually flips.
    const wasUnread = items.filter((n) => !n.readAt).map((n) => n.id);
    if (wasUnread.length === 0) return;
    setClearing(true);
    const now = new Date().toISOString();
    setItems((xs) => xs.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    const r = await markAllRead();
    if (!r.ok) {
      const revert = new Set(wasUnread);
      setItems((xs) =>
        xs.map((n) => (revert.has(n.id) ? { ...n, readAt: null } : n)),
      );
    }
    setClearing(false);
  }

  if (items.length === 0) {
    return <p className="mt-4 text-sm text-white/50">No notifications yet.</p>;
  }

  return (
    <>
      {/* Derived from the rows we already hold — the server's unread_count is
          page-scoped over the same 50 rows, so passing it in would be a second
          source of truth for the same number. */}
      {unread > 0 && (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => void onClearAll()}
            disabled={clearing}
            className="rounded-full border border-white/15 px-3 py-1.5 text-[12px] font-semibold text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
          >
            {clearing ? 'Clearing…' : `Mark all read (${unread})`}
          </button>
        </div>
      )}

      <ul className="mt-3 space-y-2">
        {items.map((n) => {
          const copy = copyFor(n.template);
          const Icon = copy.icon;
          const body = copy.body(n.data);
          const isUnread = !n.readAt;

          const inner = (
            <>
              <span
                aria-hidden
                className={
                  isUnread
                    ? 'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-white'
                    : 'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.04] text-white/50'
                }
              >
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white/90">
                  {copy.title}
                </p>
                {body && (
                  <p className="mt-0.5 text-[13px] leading-snug text-white/55">
                    {body}
                  </p>
                )}
                {copy.href && (
                  <span className="mt-1 inline-block text-[12px] font-semibold text-white/70">
                    {copy.action} →
                  </span>
                )}
              </div>
              <span className="shrink-0 whitespace-nowrap text-[11px] text-white/40">
                {relativeTime(n.createdAt)}
              </span>
            </>
          );

          const shell = isUnread
            ? 'flex w-full items-start gap-3 rounded-xl border border-white/25 bg-white/[0.06] p-3 text-left transition-colors hover:bg-white/10'
            : 'flex w-full items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-left opacity-70 transition-colors hover:opacity-100';

          return (
            <li key={n.id}>
              {copy.href ? (
                // Opening the destination is the read signal — a row you acted
                // on is a row you dealt with.
                <Link
                  href={copy.href}
                  onClick={() => {
                    if (isUnread) void onRead(n.id);
                  }}
                  className={shell}
                >
                  {inner}
                  {isUnread && <span className="sr-only">, unread</span>}
                </Link>
              ) : isUnread ? (
                <button
                  type="button"
                  onClick={() => void onRead(n.id)}
                  className={shell}
                >
                  {inner}
                  <span className="sr-only">, unread — mark as read</span>
                </button>
              ) : (
                <div className={shell}>{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Verify in the browser**

Start the storefront and check the page renders with icons, bodies and links.

```bash
npm run dev
```

Then open `/notifications` while logged in. Expected: each row shows an icon, a title, a body line where the payload supports one, and an action label; a "Mark all read (N)" control appears above the list when anything is unread and disappears once it is clicked.

If there are no notifications to look at, create one directly against the local backend:

```bash
cd backend/packages/api && corepack yarn medusa exec ./src/scripts/seed.ts
```

…or mark an existing feed row unread by deleting its `notification_read` row in `pokenic-postgres`.

- [ ] **Step 4: Run the whole storefront suite**

```bash
npm run test
```

Expected: PASS — no existing test touches these files, and the new registry suite is green.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(account\)/notifications/
git commit -m "$(cat <<'EOF'
feat(notifications): render the feed from the copy registry

/notifications gains per-template icons, payload-derived body lines,
deep links with a visible action label, and Mark all read.

Opening a row's destination marks it read — a row you acted on is a row
you dealt with. Rows without a destination keep the existing
click-to-mark-read button.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Done criteria for PR 1

- [ ] `corepack yarn test:unit` green in `backend/packages/api`.
- [ ] `corepack yarn test:integration:http store-notifications` and `store-notifications-read-all` green.
- [ ] `npm run test` green at the repo root.
- [ ] `npx tsc --noEmit` and `node node_modules/typescript/bin/tsc --noEmit` (backend) both clean.
- [ ] `/notifications` shows icons, bodies, deep links, and a working Mark all read.
- [ ] No `.env`, `node_modules`, or `dist` committed — check `git status` before opening the PR.

Open the PR against `master` (branch-protected, requires the quality + gitleaks checks). Branch: `claude/notification-popup-coverage-79825a`.

PR 1 ships value alone: `/notifications` stops being a list of bare titles. It also seeds the data PR 2 needs — once the three new producers are live, real `delivery_status`, `topup_credited` and `reward_won` rows start accruing, so PR 2's toasts can be verified against genuine rows rather than invented fixtures.
