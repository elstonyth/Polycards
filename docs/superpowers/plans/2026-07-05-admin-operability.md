# Admin Operability Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the vetted admin-operability gaps from the 2026-07-05 audit: pagination + search on admin lists, human-readable pulls ledger with links, unsaved-edit guard on the daily-box editor, success feedback on money/account actions, an FX-rate control surface with audit trail, a rewards-settings UI, and a small polish bundle.

**Architecture:** Monorepo. Medusa/Mercur backend at `backend/packages/api` (routes under `src/api/admin/**`, one `PacksModuleService` at `src/modules/packs/service.ts`). Admin dashboard is a Vite React SPA at `backend/apps/admin` (pages under `src/routes/**`, data layer = `src/lib/admin-rest.ts` fetch wrappers + `src/lib/packs-api.ts` typed facade + `src/lib/queries.ts` React Query hooks + `src/lib/query-keys.ts` registry). Every task reuses an existing in-repo pattern; no new dependencies; exactly one new DB migration (Task 9).

**Tech Stack:** TypeScript, Medusa v2 (MikroORM), React 18, TanStack Query, @medusajs/ui, vitest (admin app), jest (backend).

**Spec:** `docs/superpowers/specs/2026-07-05-admin-operability-design.md` (committed `6613aee`). Base commit at plan time: `6613aee`.

## Global Constraints

- Package managers: **npm at repo root, `corepack yarn` inside `backend/`**. If `corepack yarn …` exits 127 (fresh worktree), fall back to node-direct: `node backend/node_modules/jest/bin/jest.js …` / `node backend/node_modules/vitest/vitest.mjs …`.
- Backend jest MUST run **per-file** (`--runTestsByPath`) — running the whole suite OOMs.
- A PostToolUse hook type-checks after every `.ts`/`.tsx` edit and a Stop hook re-type-checks storefront + backend; a task is not done while either fails.
- All admin money displays use the existing `rm()` formatter from `backend/apps/admin/src/lib/format` (MYR). Never introduce `$`/USD display.
- New admin-page UI copy is **hardcoded English** (the deliveries and daily-rewards pages set this convention). Do NOT add i18n keys.
- The admin route pages have a known baseline eslint violation (`react-refresh/only-export-components`) — do not fix or worsen it.
- Commits: conventional-commit style, end body with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Do not touch: storefront (`src/` at repo root), payment/topup gates (`ALLOW_MOCK_TOPUP`, `REWARDS_REDEMPTION_ENABLED`), pack odds math, `plans/001-008` subject areas.
- If executing in a worktree, create it via the superpowers:using-git-worktrees skill and run `npm install` + `cd backend && corepack yarn` before building.

---

## Phase 1 — Quick wins

### Task 1: Daily-box editor unsaved-edit guard

The bug: `handleTierChange` (`backend/apps/admin/src/routes/daily-rewards/page.tsx:518-526`) unconditionally clears all edit state when the operator clicks another tier button — one misclick silently discards a full prize-table edit. Only the copy-from-tier path warns, and its `isDirty` flag (`:516`) is coarse (`seededFrom !== undefined` — true the moment data loads).

**Files:**
- Create: `backend/apps/admin/src/routes/daily-rewards/box-snapshot.ts`
- Create: `backend/apps/admin/src/routes/daily-rewards/box-snapshot.spec.ts`
- Modify: `backend/apps/admin/src/routes/daily-rewards/page.tsx` (BoxesTab `:486-526`, `copyFromTier` `:601-616`, `DailyRewardsPage` tab buttons `:81-111`)

**Interfaces:**
- Consumes: `EditRow` (already defined in `page.tsx:49-57`), `DailyBoxEditorDTO` from `../../lib/admin-rest`.
- Produces: `snapshotOf(s: BoxBufferState): string` — deterministic JSON of the editable buffer, ignoring `localId`. Task 11 relies on the boxes tab exposing dirtiness through the `dirtyRef` prop added here.

- [ ] **Step 1: Write the failing test**

```ts
// backend/apps/admin/src/routes/daily-rewards/box-snapshot.spec.ts
import { describe, expect, test } from 'vitest';
import { snapshotOf, type BoxBufferState } from './box-snapshot';

const base: BoxBufferState = {
  name: 'Tier A',
  enabled: true,
  drawsPerDay: '1',
  rows: [
    { kind: 'credit', amountInput: '5', productHandle: null, qtyInput: '1', locked: false, pctInput: '0' },
  ],
};

describe('snapshotOf', () => {
  test('equal buffers produce equal snapshots regardless of localId', () => {
    const a = snapshotOf(base);
    const b = snapshotOf({ ...base, rows: base.rows.map((r) => ({ ...r })) });
    expect(a).toBe(b);
  });

  test('an edited amount changes the snapshot', () => {
    const edited = { ...base, rows: [{ ...base.rows[0], amountInput: '10' }] };
    expect(snapshotOf(edited)).not.toBe(snapshotOf(base));
  });

  test('toggling enabled changes the snapshot', () => {
    expect(snapshotOf({ ...base, enabled: false })).not.toBe(snapshotOf(base));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/apps/admin`): `corepack yarn vitest run src/routes/daily-rewards/box-snapshot.spec.ts`
Expected: FAIL — cannot resolve `./box-snapshot`.

- [ ] **Step 3: Write the helper**

```ts
// backend/apps/admin/src/routes/daily-rewards/box-snapshot.ts
// Deterministic fingerprint of the box editor buffer, used to detect unsaved
// edits before a tier/tab switch discards them. localId is excluded on purpose
// (it is regenerated on every seed).
export interface BoxBufferState {
  name: string;
  enabled: boolean;
  drawsPerDay: string;
  rows: Array<{
    kind: string;
    amountInput: string;
    productHandle: string | null;
    qtyInput: string;
    locked: boolean;
    pctInput: string;
  }>;
}

export const snapshotOf = (s: BoxBufferState): string =>
  JSON.stringify({
    name: s.name,
    enabled: s.enabled,
    draws: s.drawsPerDay,
    rows: s.rows.map((r) => ({
      kind: r.kind,
      amount: r.amountInput,
      product: r.productHandle,
      qty: r.qtyInput,
      locked: r.locked,
      pct: r.pctInput,
    })),
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn vitest run src/routes/daily-rewards/box-snapshot.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the guard into BoxesTab**

In `page.tsx`, import the helper at the top with the other local imports:

```ts
import { snapshotOf } from './box-snapshot';
```

In `BoxesTab` (current body at `:486`), add a `serverSnap` state next to `seededFrom` and set it inside the existing render-seed block (`:505-511`):

```tsx
  const [serverSnap, setServerSnap] = useState('');
  if (data && data !== seededFrom) {
    setSeededFrom(data);
    setName(data.box.name);
    setEnabled(data.box.enabled);
    setDrawsPerDay(String(data.box.draws_per_day));
    setRows(data.prizes.map(rowFromPrize));
    setServerSnap(
      snapshotOf({
        name: data.box.name,
        enabled: data.box.enabled,
        drawsPerDay: String(data.box.draws_per_day),
        rows: data.prizes.map(rowFromPrize),
      }),
    );
  }
```

Replace the coarse flag block (`:513-516`) — delete the old `ponytail:` comment and `const isDirty = seededFrom !== undefined;` — with:

```tsx
  // True only when the buffer actually differs from the last server snapshot.
  const hasUnsavedEdits =
    seededFrom !== undefined &&
    snapshotOf({ name, enabled, drawsPerDay, rows }) !== serverSnap;
```

Guard `handleTierChange` (`:518`):

```tsx
  const handleTierChange = (nextTier: string) => {
    if (nextTier === tier) return;
    if (
      hasUnsavedEdits &&
      !window.confirm(
        `Discard unsaved changes to tier ${tier.toUpperCase()}?`,
      )
    )
      return;
    setTier(nextTier);
    setSeededFrom(undefined);
    setRows([]);
    setName('');
    setEnabled(false);
    setDrawsPerDay('1');
    setReason('');
  };
```

In `copyFromTier` (`:603`), replace the condition `if (isDirty && rows.length > 0) {` with `if (hasUnsavedEdits) {` (the confirm text stays).

- [ ] **Step 6: Guard the Boxes → Vouchers tab switch**

`DailyRewardsPage` (`:81-111`) owns the tab buttons but `BoxesTab` owns the dirty state — bridge with a ref. In `DailyRewardsPage`:

```tsx
const DailyRewardsPage = () => {
  const [tab, setTab] = useState<'boxes' | 'vouchers'>('boxes');
  const boxesDirty = useRef(false);
  const switchTab = (next: 'boxes' | 'vouchers') => {
    if (
      tab === 'boxes' &&
      next !== 'boxes' &&
      boxesDirty.current &&
      !window.confirm('Discard unsaved box changes?')
    )
      return;
    setTab(next);
  };
```

Change both tab buttons' `onClick` to `() => switchTab('boxes')` / `() => switchTab('vouchers')`, and render `{tab === 'boxes' ? <BoxesTab dirtyRef={boxesDirty} /> : <VouchersTab />}`. Add `useRef` to the existing `react` import. In `BoxesTab`, accept and update the ref (assignment during render is fine for a ref):

```tsx
const BoxesTab = ({ dirtyRef }: { dirtyRef: MutableRefObject<boolean> }) => {
  ...
  dirtyRef.current = hasUnsavedEdits; // place directly after the hasUnsavedEdits declaration
```

Import `type MutableRefObject` from `react`.

- [ ] **Step 7: Verify + manual smoke**

Run: `corepack yarn vitest run src/routes/daily-rewards/box-snapshot.spec.ts` → PASS. Type check is enforced by the edit hook. Manual smoke (if a dev stack is running): edit a prize amount on tier A, click tier B → confirm dialog appears; cancel keeps the edit; without edits, tier switch is silent.

- [ ] **Step 8: Commit**

```bash
git add backend/apps/admin/src/routes/daily-rewards/box-snapshot.ts backend/apps/admin/src/routes/daily-rewards/box-snapshot.spec.ts backend/apps/admin/src/routes/daily-rewards/page.tsx
git commit -m "fix(admin): daily-box editor warns before discarding unsaved edits

Real dirty-tracking (server-snapshot compare) replaces the coarse
seeded-once flag; tier switch and Boxes->Vouchers tab switch now confirm.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Success toasts on customer-360 account/commission actions

The five account/commission hooks toast on **error only** (`backend/apps/admin/src/lib/queries.ts:301-380`); `customers/[id]/page.tsx:101-132` closes the modal then fire-and-forgets `.mutate()`, so a freeze or commission reversal completes with no explicit confirmation. The support page's credit-adjust already awaits + toasts locally — leave it alone (adding a toast inside the shared credit hook would double-toast there).

**Files:**
- Modify: `backend/apps/admin/src/lib/queries.ts:301-380` (five hooks)
- Modify: `backend/apps/admin/src/routes/customers/[id]/page.tsx:113-123` (`applyAdjustCredits` only)

**Interfaces:**
- Consumes: `toast` from `@medusajs/ui` (already imported in `queries.ts` — verify; if absent add `import { toast } from '@medusajs/ui';`).
- Produces: no signature changes — hooks keep their exact current signatures.

- [ ] **Step 1: Add success toasts to the five hooks**

In `queries.ts`, add one `toast.success(...)` line as the FIRST line of each existing `onSuccess`:

| Hook (current location) | Toast text |
|---|---|
| `useFreezeCustomer` (`:306`) | `toast.success('Customer frozen');` |
| `useUnfreezeCustomer` (`:320`) | `toast.success('Customer unfrozen');` |
| `useReverseCommission` (`:337`) | `toast.success('Commission reversed');` |
| `useSuspendCommission` (`:355`) | `toast.success('Commission suspended');` |
| `useUnsuspendCommission` (onSuccess at `:373`) | `toast.success('Commission unsuspended');` |

Example (freeze — the other four are identical in shape):

```ts
    onSuccess: (_data, vars) => {
      toast.success('Customer frozen');
      qc.invalidateQueries({ queryKey: qk.customerGacha(vars.id) });
      qc.invalidateQueries({ queryKey: qk.customerAuditKey(vars.id) });
      qc.invalidateQueries({ queryKey: qk.referralTreeKey(vars.id) });
    },
```

- [ ] **Step 2: Per-call success toast for the 360 credit adjust**

In `customers/[id]/page.tsx` `applyAdjustCredits` (`:113-123`), change the final line from `adjustCredits.mutate({ id: customerId, amount, note: creditNote });` to:

```tsx
    adjustCredits.mutate(
      { id: customerId, amount, note: creditNote },
      { onSuccess: () => toast.success('Credits adjusted') },
    );
```

(`toast` is already imported in this file — it is used at `:117`.)

- [ ] **Step 3: Verify**

Type check passes via the edit hook. Manual smoke: freeze a test customer → "Customer frozen" toast + frozen badge; support-page credit adjust still shows exactly ONE toast.

- [ ] **Step 4: Commit**

```bash
git add backend/apps/admin/src/lib/queries.ts "backend/apps/admin/src/routes/customers/[id]/page.tsx"
git commit -m "feat(admin): success toasts on freeze/commission/credit actions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Deliveries — client pre-gate for shipped-without-tracking

The backend already rejects `shipped` without tracking (`backend/packages/api/src/modules/packs/delivery.ts:62` returns `tracking_required`; enforced at `backend/packages/api/src/workflows/steps/update-delivery-order.ts:93`). The UI lets the operator hit that server error; mirror the rule client-side. **No backend change in this task.**

**Files:**
- Modify: `backend/apps/admin/src/routes/deliveries/page.tsx` (`:56-69` save, `:185-188` Save button, `:221-230` tracking input)

- [ ] **Step 1: Compute the gate**

In `DeliveriesPage`, directly after the `save` function (`:69`), add:

```tsx
  // Mirrors delivery.ts checkTransition: moving TO shipped requires tracking.
  const trackingRequired =
    detail !== null &&
    nextStatus === 'shipped' &&
    detail.status !== 'shipped' &&
    tracking.trim() === '';
```

- [ ] **Step 2: Gate the Save button + show the hint**

Change the Save button (`:185`) to:

```tsx
              <Button
                size="small"
                onClick={save}
                isLoading={update.isPending}
                disabled={trackingRequired}
              >
                Save
              </Button>
```

Under the tracking `<Input>` (`:225-229`), inside the same flex column div, add:

```tsx
                  {trackingRequired && (
                    <Text size="small" className="text-ui-fg-error">
                      Tracking number required to mark shipped.
                    </Text>
                  )}
```

- [ ] **Step 3: Verify + commit**

Type check via hook. Manual smoke: open a `packing` order, select `shipped`, empty tracking → Save disabled + red hint; type a tracking number → enabled.

```bash
git add backend/apps/admin/src/routes/deliveries/page.tsx
git commit -m "feat(admin): disable Save when marking shipped without tracking

Client-side mirror of the backend tracking_required transition rule.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Phase 2 — List infrastructure

### Task 4: Shared Pager component

No admin list has pagination controls today. Build one tiny shared component; Tasks 5, 6, 7 consume it.

**Files:**
- Create: `backend/apps/admin/src/components/Pager.tsx`

**Interfaces:**
- Produces: `Pager({ page, onPage, pageSize, count, total }: { page: number; onPage: (p: number) => void; pageSize: number; count: number; total: number | null })` — `count` = rows on the current page, `total` = server total when known (null → fall back to "full page ⇒ maybe more").

- [ ] **Step 1: Write the component**

```tsx
// backend/apps/admin/src/components/Pager.tsx
import { Button, Text } from '@medusajs/ui';

// Offset pager for admin tables. total=null means the server did not report
// one; in that case "Next" stays enabled while the current page is full.
export const Pager = ({
  page,
  onPage,
  pageSize,
  count,
  total,
}: {
  page: number;
  onPage: (p: number) => void;
  pageSize: number;
  count: number;
  total: number | null;
}) => {
  const from = count === 0 ? 0 : page * pageSize + 1;
  const to = page * pageSize + count;
  const hasMore =
    total !== null ? (page + 1) * pageSize < total : count === pageSize;
  return (
    <div className="flex items-center justify-between border-t px-6 py-3">
      <Text size="small" className="text-ui-fg-subtle tabular-nums">
        {total !== null
          ? `${from}–${to} of ${total.toLocaleString('en-US')}`
          : `${from}–${to}`}
      </Text>
      <div className="flex gap-2">
        <Button
          size="small"
          variant="secondary"
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
        >
          Prev
        </Button>
        <Button
          size="small"
          variant="secondary"
          disabled={!hasMore}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Verify + commit**

Type check via hook (component is consumed starting Task 5 — an unused export is fine for one commit).

```bash
git add backend/apps/admin/src/components/Pager.tsx
git commit -m "feat(admin): shared offset Pager component

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Pulls ledger — server pagination, true total, pack titles, customer links

Backend `backend/packages/api/src/api/admin/pulls/route.ts` hard-caps the ledger at 50 (`LEDGER_LIMIT`, `:19`) with no params, and `total` (`:133`) is silently capped by the 5000-row rollup window. Rows carry `pack_id` UUIDs only (`:115`). UI (`backend/apps/admin/src/routes/pulls/page.tsx:116`) renders the raw UUID and nothing links anywhere.

**Files:**
- Modify: `backend/packages/api/src/api/admin/pulls/route.ts`
- Create: `backend/packages/api/src/api/admin/pulls/__tests__/pagination.spec.ts`
- Modify: `backend/apps/admin/src/lib/packs-api.ts` (`PullRow`/`PullsResponse` `:150-187`, remove dead `pulls` facade entry `:223-225`)
- Modify: `backend/apps/admin/src/lib/admin-rest.ts` (new `getPulls`)
- Modify: `backend/apps/admin/src/lib/query-keys.ts` (`pulls` key gains page)
- Modify: `backend/apps/admin/src/lib/queries.ts` (`usePulls` `:81-82`)
- Modify: `backend/apps/admin/src/routes/pulls/page.tsx`

**Interfaces:**
- Produces (backend): `GET /admin/pulls?limit=&offset=` → `{ total: number; offset: number; limit: number; pulls: PullRow[]; topCards; topRarities }` where each `PullRow` gains `pack_title: string | null`. `total` = true `listAndCountPulls` count. Defaults limit 50, max 100 (`parsePaginationParams` opts).
- Produces (frontend): `getPulls(page = 0, limit = 50): Promise<PullsResponse>`; `usePulls(page: number)`; `qk.pulls(page)` + `qk.pullsKey` prefix.

- [ ] **Step 1: Write the failing backend test**

Mirror the stub style of the existing specs in `backend/packages/api/src/api/admin/packs/__tests__/` (open one first; if they use a materially different harness — e.g. medusa integration runner — adapt this file to that harness, keeping the same assertions).

```ts
// backend/packages/api/src/api/admin/pulls/__tests__/pagination.spec.ts
import { GET } from '../route';

const mkRes = () => {
  const out: { body?: any; status?: number } = {};
  return {
    res: {
      json: (b: any) => {
        out.body = b;
      },
      status: (s: number) => {
        out.status = s;
        return { json: (b: any) => (out.body = b) };
      },
    } as any,
    out,
  };
};

const pull = (i: number) => ({
  id: `pull_${i}`,
  rolled_at: new Date(2026, 0, i + 1),
  customer_id: 'cus_1',
  pack_id: 'pack_1',
  card_id: 'card-a',
  status: 'vaulted',
  buyback_amount: null,
});

function mkScope(totalPulls: number) {
  const all = Array.from({ length: totalPulls }, (_, i) => pull(i));
  const packs = {
    listPulls: async (_f: any, o: any) => all.slice(0, o?.take ?? all.length),
    listAndCountPulls: async (_f: any, o: any) => [
      all.slice(o?.skip ?? 0, (o?.skip ?? 0) + (o?.take ?? 50)),
      all.length,
    ],
    listCards: async () => [
      { handle: 'card-a', name: 'Card A', market_value: 10, image: 'x.png' },
    ],
    listPackOdds: async () => [],
    listPacks: async () => [{ id: 'pack_1', title: 'Starter Pack' }],
    listFxRates: async () => [],
  };
  return {
    resolve: (key: string) =>
      typeof key === 'string' && key.toLowerCase().includes('customer')
        ? { listCustomers: async () => [{ id: 'cus_1', email: 'a@b.c' }] }
        : packs,
  };
}

describe('GET /admin/pulls pagination', () => {
  it('returns the true total and honors offset/limit', async () => {
    const { res, out } = mkRes();
    await GET(
      { scope: mkScope(120), query: { limit: '50', offset: '50' } } as any,
      res,
    );
    expect(out.body.total).toBe(120);
    expect(out.body.offset).toBe(50);
    expect(out.body.limit).toBe(50);
    expect(out.body.pulls).toHaveLength(50);
  });

  it('joins the pack title onto ledger rows', async () => {
    const { res, out } = mkRes();
    await GET({ scope: mkScope(3), query: {} } as any, res);
    expect(out.body.pulls[0].pack_title).toBe('Starter Pack');
  });

  it('rejects limit above 100', async () => {
    const { res } = mkRes();
    await expect(
      GET({ scope: mkScope(1), query: { limit: '500' } } as any, res),
    ).rejects.toThrow(/limit/);
  });
});
```

NOTE on the `resolve` stub: the route resolves the customer module via the `Modules.CUSTOMER` registration key — the `includes('customer')` match covers it; if it still misses, log the key and match exactly.

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/packages/api`): `corepack yarn jest --runTestsByPath src/api/admin/pulls/__tests__/pagination.spec.ts`
Expected: FAIL — `total` is the window length, `pack_title`/`offset` undefined, no limit rejection.

- [ ] **Step 3: Implement the route changes**

In `backend/packages/api/src/api/admin/pulls/route.ts`:

1. Add import: `import { parsePaginationParams } from "../../../utils/pagination";`
2. Replace the constant block (`:19-20`) with just `const ROLLUP_WINDOW = 5000;` (delete `LEDGER_LIMIT`).
3. At the top of `GET` (after `fx` is resolved, `:29`), parse params:

```ts
  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 50, maxLimit: 100 },
  );
```

4. Fetch the ledger page + true total alongside the rollup window (replace `:31-34`):

```ts
  const allPulls = await packs.listPulls(
    {},
    { order: { rolled_at: "DESC" }, take: ROLLUP_WINDOW }
  );
  const [ledger, total] = await packs.listAndCountPulls(
    {},
    { order: { rolled_at: "DESC" }, skip: offset, take: limit }
  );
```

5. The card/odds lookups (`:36-50`) must also cover ledger rows outside the rollup window — change the handle-source line to:

```ts
  const handles = [...new Set([...allPulls, ...ledger].map((p) => p.card_id))];
```

6. Delete the old slice line `const ledger = allPulls.slice(0, LEDGER_LIMIT);` (`:96`).
7. Before the `pulls` mapping (`:108`), join pack titles:

```ts
  const packIds = [...new Set(ledger.map((p) => p.pack_id))];
  const packRows = packIds.length
    ? await packs.listPacks({ id: packIds }, { take: packIds.length })
    : [];
  const packTitleById = new Map(packRows.map((pk: any) => [pk.id, pk.title]));
```

8. In the mapped ledger row (`:110-130`), directly under `pack_id: p.pack_id,` add:

```ts
      pack_title: packTitleById.get(p.pack_id) ?? null,
```

9. Replace the response line (`:133`) with:

```ts
  res.json({ total, offset, limit, pulls, topCards, topRarities });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn jest --runTestsByPath src/api/admin/pulls/__tests__/pagination.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Frontend data layer**

`backend/apps/admin/src/lib/packs-api.ts`:
- In the `PullRow` interface (top-level fields around `:150-166`), add `pack_title: string | null;` next to the existing `pack_id` field.
- In `PullsResponse` (`:182-187`), add `offset: number;` and `limit: number;`
- Delete the dead facade entry (`:223-225`): the `pulls: { query: () => Promise<PullsResponse>; };` block inside `PacksApi['admin']`.

`backend/apps/admin/src/lib/admin-rest.ts` — add near the other GET wrappers:

```ts
import type { PullsResponse } from './packs-api';

export const getPulls = (page = 0, limit = 50) =>
  getJson<PullsResponse>(`/admin/pulls?limit=${limit}&offset=${page * limit}`);
```

(If a type-only import from `./packs-api` creates a cycle — packs-api does not import admin-rest today, so it should not — inline the response type instead.)

`backend/apps/admin/src/lib/query-keys.ts` — replace `pulls: ['admin', 'pulls'] as const,` (`:8`) with:

```ts
  pulls: (page: number) => ['admin', 'pulls', page] as const,
  // 2-segment prefix — invalidates ALL pages of the pull ledger in one call
  pullsKey: ['admin', 'pulls'] as const,
```

Then run `grep -rn "qk.pulls" backend/apps/admin/src` and fix every reference: invalidation call sites use `qk.pullsKey`; the query key becomes `qk.pulls(page)`.

`backend/apps/admin/src/lib/queries.ts` — replace `usePulls` (`:81-82`) with:

```ts
export const usePulls = (page = 0): UseQueryResult<PullsResponse> =>
  useQuery({ queryKey: qk.pulls(page), queryFn: () => getPulls(page) });
```

Add `getPulls` to the `./admin-rest` import list; remove `packsApi.admin.pulls` usage.

- [ ] **Step 6: Page UI**

`backend/apps/admin/src/routes/pulls/page.tsx`:
- Imports: add `useState` from `react`, `useNavigate` from `react-router-dom`, `Pager` from `../../components/Pager`.
- In the component: `const [page, setPage] = useState(0);` `const navigate = useNavigate();` `const { data, isError } = usePulls(page);`
- Pack cell (`:116`): replace `{p.pack_id}` with `{p.pack_title ?? p.pack_id.slice(0, 8)}`.
- Customer cell (`:115`): replace with a link when a customer exists:

```tsx
                  <Table.Cell className="text-ui-fg-subtle">
                    {p.customer_id ? (
                      <button
                        type="button"
                        className="text-ui-fg-interactive hover:underline"
                        onClick={() => navigate(`/customers/${p.customer_id}`)}
                      >
                        {p.customer_email ?? p.customer_id.slice(0, 8)}
                      </button>
                    ) : (
                      t("pulls.anon")
                    )}
                  </Table.Cell>
```

- After the `</Table>` closing tag (`:130`), inside the same Container:

```tsx
        {data && (
          <Pager
            page={page}
            onPage={setPage}
            pageSize={data.limit}
            count={data.pulls.length}
            total={data.total}
          />
        )}
```

- [ ] **Step 7: Verify + commit**

Backend test PASS (Step 4); type check via hooks; manual smoke: "1–50 of N" renders, Next pages back in time, pack titles show, customer click lands on the 360 page.

```bash
git add backend/packages/api/src/api/admin/pulls backend/apps/admin/src/lib/packs-api.ts backend/apps/admin/src/lib/admin-rest.ts backend/apps/admin/src/lib/query-keys.ts backend/apps/admin/src/lib/queries.ts backend/apps/admin/src/routes/pulls/page.tsx
git commit -m "feat(admin): paginated pull ledger with true total, pack titles, customer links

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Delivery orders — pagination

Backend caps at 500 with no params (`backend/packages/api/src/api/admin/delivery-orders/route.ts:8,:22`); orders beyond 500 are unreachable.

**Files:**
- Modify: `backend/packages/api/src/api/admin/delivery-orders/route.ts`
- Create: `backend/packages/api/src/api/admin/delivery-orders/__tests__/pagination.spec.ts`
- Modify: `backend/apps/admin/src/lib/admin-rest.ts` (`listDeliveryOrders` `:428-436`)
- Modify: `backend/apps/admin/src/lib/query-keys.ts` (`deliveryOrders` `:26-27`)
- Modify: `backend/apps/admin/src/lib/queries.ts` (`useDeliveryOrders` `:145-151`; delivery-update invalidation)
- Modify: `backend/apps/admin/src/routes/deliveries/page.tsx`

**Interfaces:**
- Produces (backend): `GET /admin/delivery-orders?status=&limit=&offset=` → `{ orders, total, offset, limit }` (defaults 50, max 100).
- Produces (frontend): `listDeliveryOrders(status, page)` → `DeliveryOrdersPage { orders; total; offset; limit }`; `useDeliveryOrders(status, page)`; `qk.deliveryOrders(status, page)` + `qk.deliveryOrdersKey` prefix.

- [ ] **Step 1: Failing test** (same stub style as Task 5)

```ts
// backend/packages/api/src/api/admin/delivery-orders/__tests__/pagination.spec.ts
jest.mock('../../../../modules/packs/delivery-view', () => ({
  serializeDeliveryOrders: async (_p: any, orders: any[]) =>
    orders.map((o) => ({ ...o, items: [], tracking_number: null })),
}));

import { GET } from '../route';

const mkRes = () => {
  const out: { body?: any } = {};
  return { res: { json: (b: any) => (out.body = b) } as any, out };
};

const order = (i: number) => ({
  id: `dord_${i}`,
  customer_id: 'cus_1',
  status: 'requested',
  created_at: new Date(2026, 0, i + 1),
});

function mkScope(totalOrders: number) {
  const all = Array.from({ length: totalOrders }, (_, i) => order(i));
  const packs = {
    listAndCountDeliveryOrders: async (_f: any, o: any) => [
      all.slice(o?.skip ?? 0, (o?.skip ?? 0) + (o?.take ?? 50)),
      all.length,
    ],
  };
  return {
    resolve: (key: string) =>
      typeof key === 'string' && key.toLowerCase().includes('customer')
        ? { listCustomers: async () => [{ id: 'cus_1', email: 'a@b.c' }] }
        : packs,
  };
}

describe('GET /admin/delivery-orders pagination', () => {
  it('returns total/offset/limit and slices', async () => {
    const { res, out } = mkRes();
    await GET(
      { scope: mkScope(120), query: { limit: '50', offset: '100' } } as any,
      res,
    );
    expect(out.body.total).toBe(120);
    expect(out.body.orders).toHaveLength(20);
    expect(out.body.offset).toBe(100);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `corepack yarn jest --runTestsByPath src/api/admin/delivery-orders/__tests__/pagination.spec.ts` → FAIL.

- [ ] **Step 3: Implement route**

In `delivery-orders/route.ts`: delete `const LIMIT = 500;` (`:8`); add `import { parsePaginationParams } from '../../../utils/pagination';`; inside `GET`, after the status filter (`:18`), replace the `listDeliveryOrders` call (`:20-23`) with:

```ts
  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 50, maxLimit: 100 },
  );

  const [orders, total] = await packs.listAndCountDeliveryOrders(filter, {
    order: { created_at: 'DESC' },
    skip: offset,
    take: limit,
  });
```

Response (`:37-42`) becomes:

```ts
  res.json({
    total,
    offset,
    limit,
    orders: serialized.map((o) => ({
      ...o,
      customer_email: emailById.get(o.customer_id) ?? null,
    })),
  });
```

- [ ] **Step 4: Run to verify PASS** — same command, expected PASS (1 test).

- [ ] **Step 5: Frontend**

`admin-rest.ts` — replace `listDeliveryOrders` (`:428-436`) with:

```ts
export interface DeliveryOrdersPage {
  orders: AdminDeliveryOrder[];
  total: number;
  offset: number;
  limit: number;
}

export async function listDeliveryOrders(
  status?: DeliveryStatus,
  page = 0,
  limit = 50,
): Promise<DeliveryOrdersPage> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(page * limit),
  });
  if (status) params.set('status', status);
  return getJson<DeliveryOrdersPage>(`/admin/delivery-orders?${params}`);
}
```

`query-keys.ts` — replace `deliveryOrders` (`:26-27`) with:

```ts
  deliveryOrders: (status: string | undefined, page: number) =>
    ['admin', 'delivery-orders', status ?? 'all', page] as const,
  // 2-segment prefix — invalidates ALL delivery-order pages/filters in one call
  deliveryOrdersKey: ['admin', 'delivery-orders'] as const,
```

`queries.ts` — replace `useDeliveryOrders` (`:145-151`) with:

```ts
export const useDeliveryOrders = (
  status?: DeliveryStatus,
  page = 0,
): UseQueryResult<DeliveryOrdersPage> =>
  useQuery({
    queryKey: qk.deliveryOrders(status, page),
    queryFn: () => listDeliveryOrders(status, page),
  });
```

Import `DeliveryOrdersPage` from `./admin-rest`. Then `grep -n "qk.deliveryOrders" backend/apps/admin/src/lib/queries.ts` and switch the delivery-update mutation's invalidation to `qk.deliveryOrdersKey`.

`deliveries/page.tsx` — add `const [page, setPage] = useState(0);`; change the query line (`:44`) to `const { data, isError } = useDeliveryOrders(filter, page);` with `const orders = data?.orders ?? null;`; in the Select `onValueChange` (`:82-84`) call `setPage(0);` before `setFilter(...)`; after the closing `</Table>` (`:166`) add:

```tsx
      {data && (
        <Pager
          page={page}
          onPage={setPage}
          pageSize={data.limit}
          count={data.orders.length}
          total={data.total}
        />
      )}
```

Import `Pager` from `../../components/Pager`.

- [ ] **Step 6: Commit**

```bash
git add backend/packages/api/src/api/admin/delivery-orders backend/apps/admin/src/lib/admin-rest.ts backend/apps/admin/src/lib/query-keys.ts backend/apps/admin/src/lib/queries.ts backend/apps/admin/src/routes/deliveries/page.tsx
git commit -m "feat(admin): paginated delivery orders (was hard-capped at 500)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Customer history endpoints + support-page paging

`customers/[id]/gacha` caps `transactions` and `pulls` at RECENT=50 with no paging — history beyond that is unreachable from the UI. Add two paginated read routes cloned from the audit route shape (`backend/packages/api/src/api/admin/customers/[id]/audit/route.ts:6-14`) and page the two support-page tables. The compound gacha route is untouched.

**Files:**
- Create: `backend/packages/api/src/api/admin/customers/[id]/transactions/route.ts`
- Create: `backend/packages/api/src/api/admin/customers/[id]/pulls/route.ts`
- Create: `backend/packages/api/src/api/admin/customers/[id]/__tests__/history-pagination.spec.ts`
- Modify: `backend/apps/admin/src/lib/admin-rest.ts` (two wrappers after `getCustomerGacha` `:147-151`)
- Modify: `backend/apps/admin/src/lib/query-keys.ts`, `backend/apps/admin/src/lib/queries.ts`
- Modify: `backend/apps/admin/src/routes/support/page.tsx` (ledger `:284-328`, pulls `:330-395`)

**Interfaces:**
- Produces (backend): `GET /admin/customers/:id/transactions?limit=&offset=` → `{ items: SupportTransaction[]; total: number }`; `GET /admin/customers/:id/pulls?limit=&offset=` → `{ items: SupportPull[]; total: number }` — item shapes identical to the fields inside `CustomerGacha` (`admin-rest.ts:108-128`). Defaults limit 25, max 100.
- Produces (frontend): `getCustomerTransactions(id, page, limit=25)`, `getCustomerPulls(id, page, limit=25)`, `useCustomerTransactions(id, page)`, `useCustomerPulls(id, page)`, keys `customerTransactions(id, page)` / `customerPulls(id, page)` + `…Key(id)` prefixes.

- [ ] **Step 1: Failing test**

```ts
// backend/packages/api/src/api/admin/customers/[id]/__tests__/history-pagination.spec.ts
import { GET as getTransactions } from '../transactions/route';
import { GET as getPulls } from '../pulls/route';

const mkRes = () => {
  const out: { body?: any } = {};
  return { res: { json: (b: any) => (out.body = b) } as any, out };
};

const tx = (i: number) => ({
  id: `ctx_${i}`,
  amount: -5,
  reason: 'pack_open',
  reference: null,
  created_at: new Date(2026, 0, i + 1),
});
const pull = (i: number) => ({
  id: `pull_${i}`,
  pack_id: 'pack_1',
  card_id: 'card-a',
  rolled_at: new Date(2026, 0, i + 1),
  status: 'vaulted',
  buyback_amount: null,
});

function mkScope() {
  const txs = Array.from({ length: 60 }, (_, i) => tx(i));
  const pulls = Array.from({ length: 60 }, (_, i) => pull(i));
  return {
    resolve: () => ({
      listAndCountCreditTransactions: async (_f: any, o: any) => [
        txs.slice(o?.skip ?? 0, (o?.skip ?? 0) + (o?.take ?? 25)),
        txs.length,
      ],
      listAndCountPulls: async (_f: any, o: any) => [
        pulls.slice(o?.skip ?? 0, (o?.skip ?? 0) + (o?.take ?? 25)),
        pulls.length,
      ],
      listCards: async () => [
        { handle: 'card-a', name: 'Card A', market_value: 10, image: 'x.png' },
      ],
      listFxRates: async () => [],
    }),
  };
}

describe('customer history pagination', () => {
  it('transactions: pages and reports total', async () => {
    const { res, out } = mkRes();
    await getTransactions(
      {
        scope: mkScope(),
        params: { id: 'cus_1' },
        query: { limit: '25', offset: '25' },
      } as any,
      res,
    );
    expect(out.body.total).toBe(60);
    expect(out.body.items).toHaveLength(25);
  });

  it('pulls: pages, reports total, joins card', async () => {
    const { res, out } = mkRes();
    await getPulls(
      { scope: mkScope(), params: { id: 'cus_1' }, query: {} } as any,
      res,
    );
    expect(out.body.total).toBe(60);
    expect(out.body.items[0].card?.name).toBe('Card A');
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `corepack yarn jest --runTestsByPath "src/api/admin/customers/[id]/__tests__/history-pagination.spec.ts"` → FAIL (modules missing).

- [ ] **Step 3: Implement the two routes**

Open `backend/packages/api/src/api/admin/customers/[id]/gacha/route.ts` first and copy its exact transaction/pull field mapping so shapes match `SupportTransaction`/`SupportPull` byte-for-byte. Implementations:

```ts
// backend/packages/api/src/api/admin/customers/[id]/transactions/route.ts
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { parsePaginationParams } from '../../../../../utils/pagination';

// GET /admin/customers/:id/transactions — paginated credit ledger for the
// support view. Same row shape as the gacha route's `transactions` slice.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 25, maxLimit: 100 },
  );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [rows, total] = await packs.listAndCountCreditTransactions(
    { customer_id: id },
    { order: { created_at: 'DESC' }, skip: offset, take: limit },
  );
  res.json({
    total,
    items: rows.map((t: any) => ({
      id: t.id,
      amount: Number(t.amount),
      reason: t.reason,
      reference: t.reference ?? null,
      created_at: t.created_at,
    })),
  });
}
```

```ts
// backend/packages/api/src/api/admin/customers/[id]/pulls/route.ts
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { parsePaginationParams } from '../../../../../utils/pagination';
import {
  resolveFxRate,
  displayMarketPrice,
} from '../../../../../modules/packs/pricing';

// GET /admin/customers/:id/pulls — paginated pull history for the support
// view. Same row shape as the gacha route's `pulls` slice.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 25, maxLimit: 100 },
  );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const fx = await resolveFxRate(packs);
  const [rows, total] = await packs.listAndCountPulls(
    { customer_id: id },
    { order: { rolled_at: 'DESC' }, skip: offset, take: limit },
  );
  const handles = [...new Set(rows.map((p: any) => p.card_id))];
  const cards = handles.length
    ? await packs.listCards({ handle: handles }, { take: handles.length })
    : [];
  const cardByHandle = new Map(cards.map((c: any) => [c.handle, c]));
  res.json({
    total,
    items: rows.map((p: any) => {
      const card = cardByHandle.get(p.card_id);
      return {
        id: p.id,
        pack_id: p.pack_id,
        rolled_at: p.rolled_at,
        status: p.status,
        buyback_amount:
          p.buyback_amount === null ? null : Number(p.buyback_amount),
        card: card
          ? {
              handle: card.handle,
              name: card.name,
              market_value: displayMarketPrice(
                Number(card.market_value),
                fx,
                1,
              ),
              image: card.image,
            }
          : null,
      };
    }),
  });
}
```

If the gacha route's field mapping differs from the above (e.g. amount scaling through a sen/MYR converter), match the gacha route — it is the source of truth for these shapes. If `listAndCountCreditTransactions` does not exist on the service (model name differs), STOP and check the model registration list in `service.ts` (~`:267` area) for the credit-transaction model's exact name, then use its generated `listAndCount<Name>` variant.

- [ ] **Step 4: Run to verify PASS** — same command as Step 2, expected PASS (2 tests).

- [ ] **Step 5: Frontend wrappers, keys, hooks**

`admin-rest.ts` (after `getCustomerGacha`):

```ts
export const getCustomerTransactions = (id: string, page = 0, limit = 25) =>
  getJson<{ items: SupportTransaction[]; total: number }>(
    `/admin/customers/${encodeURIComponent(id)}/transactions?limit=${limit}&offset=${page * limit}`,
  );

export const getCustomerPulls = (id: string, page = 0, limit = 25) =>
  getJson<{ items: SupportPull[]; total: number }>(
    `/admin/customers/${encodeURIComponent(id)}/pulls?limit=${limit}&offset=${page * limit}`,
  );
```

`query-keys.ts` (next to `customerAudit`):

```ts
  customerTransactions: (id: string, page: number) =>
    ['admin', 'customer', id, 'transactions', page] as const,
  customerTransactionsKey: (id: string) =>
    ['admin', 'customer', id, 'transactions'] as const,
  customerPulls: (id: string, page: number) =>
    ['admin', 'customer', id, 'pulls', page] as const,
  customerPullsKey: (id: string) =>
    ['admin', 'customer', id, 'pulls'] as const,
```

`queries.ts` (next to `useCustomerAudit`):

```ts
export const useCustomerTransactions = (
  id: string | null,
  page = 0,
): UseQueryResult<{ items: SupportTransaction[]; total: number }> =>
  useQuery({
    queryKey: qk.customerTransactions(id ?? '', page),
    queryFn: () => getCustomerTransactions(id!, page),
    enabled: !!id,
  });

export const useCustomerPulls = (
  id: string | null,
  page = 0,
): UseQueryResult<{ items: SupportPull[]; total: number }> =>
  useQuery({
    queryKey: qk.customerPulls(id ?? '', page),
    queryFn: () => getCustomerPulls(id!, page),
    enabled: !!id,
  });
```

Import `SupportTransaction`, `SupportPull`, `getCustomerTransactions`, `getCustomerPulls` from `./admin-rest`. Also add to the credit-adjust hook's `onSuccess` (the mutation directly above `useFreezeCustomer`, onSuccess at `:293`): `qc.invalidateQueries({ queryKey: qk.customerTransactionsKey(vars.id) });` so an adjustment refreshes the paged ledger.

- [ ] **Step 6: Support page paging**

In `support/page.tsx`: find the variable passed to `useCustomerGacha(...)` (grep `useCustomerGacha(` — reuse that id variable, call it `selectedId` below). Add near it:

```tsx
  const [txPage, setTxPage] = useState(0);
  const [pullPage, setPullPage] = useState(0);
  const txHistory = useCustomerTransactions(selectedId, txPage);
  const pullHistory = useCustomerPulls(selectedId, pullPage);
```

Reset both pages to 0 wherever the selected customer changes. Then:
- Ledger section (`:288-327`): `const txRows = txHistory.data?.items ?? view.transactions;` — map over `txRows` instead of `view.transactions` (both empty-state check `:288` and body `:307`); after `</Table>` (`:326`) insert `<Pager page={txPage} onPage={setTxPage} pageSize={25} count={txRows.length} total={txHistory.data?.total ?? null} />`.
- Pulls section (`:334-394`): same treatment with `pullHistory`/`pullPage` (`const pullRows = pullHistory.data?.items ?? view.pulls;`).
- Import `Pager`, `useCustomerTransactions`, `useCustomerPulls`.

- [ ] **Step 7: Commit**

```bash
git add "backend/packages/api/src/api/admin/customers/[id]/transactions" "backend/packages/api/src/api/admin/customers/[id]/pulls" "backend/packages/api/src/api/admin/customers/[id]/__tests__" backend/apps/admin/src/lib backend/apps/admin/src/routes/support/page.tsx
git commit -m "feat(admin): paginated per-customer transaction + pull history

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Cards & packs — search, sort, counts

Neither list has search/filter/sort (`cards/page.tsx:246-337`, `packs/page.tsx:264-367`); both fetch wholesale, so filtering is client-side.

**Files:**
- Modify: `backend/apps/admin/src/routes/cards/page.tsx`
- Modify: `backend/apps/admin/src/routes/packs/page.tsx`

- [ ] **Step 1: Cards — filter + sort state**

In the cards page component's state block add:

```tsx
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{
    key: 'name' | 'value' | 'stock';
    dir: 1 | -1;
  } | null>(null);
```

Before the `return`, derive visible rows (`cards` is the fetched array with `null` = loading — keep that semantics):

```tsx
  const visible = (cards ?? [])
    .filter((c) => {
      const needle = q.trim().toLowerCase();
      if (!needle) return true;
      return (
        c.name.toLowerCase().includes(needle) ||
        c.handle.toLowerCase().includes(needle)
      );
    })
    .sort((a, b) => {
      if (!sort) return 0;
      const pick = (c: typeof a) =>
        sort.key === 'name'
          ? c.name.toLowerCase()
          : sort.key === 'value'
            ? (c.priceBreakdown.marketMyr ?? 0)
            : (c.stock ?? Number.POSITIVE_INFINITY);
      const va = pick(a);
      const vb = pick(b);
      return va < vb ? -sort.dir : va > vb ? sort.dir : 0;
    });
```

Switch the body loop (`:267`) from `cards.map` to `visible.map`.

- [ ] **Step 2: Cards — search input, count, clickable headers**

In the header row div holding title + Register button (ends `:229`), add before the Register button:

```tsx
        <Input
          className="w-56"
          placeholder="Search name or handle…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
```

(add `Input` to the `@medusajs/ui` import if missing). Under `GachaPipelineHint` (`:231`):

```tsx
      {cards !== null && (
        <Text size="small" className="text-ui-fg-subtle px-6 pb-2">
          {q.trim()
            ? `${visible.length} of ${cards.length} cards`
            : `${cards.length} cards`}
        </Text>
      )}
```

Sortable headers — local helper above the `return`:

```tsx
  const sortHeader = (key: 'name' | 'value' | 'stock', label: string) => (
    <button
      type="button"
      className="inline-flex items-center gap-1 hover:text-ui-fg-base"
      onClick={() =>
        setSort((s) =>
          s?.key === key
            ? { key, dir: s.dir === 1 ? -1 : 1 }
            : { key, dir: 1 },
        )
      }
    >
      {label}
      {sort?.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
    </button>
  );
```

Replace the three header cell contents: card (`:249`) → `{sortHeader('name', t('cards.list.card'))}`, value (`:252`) → `{sortHeader('value', t('cards.list.value'))}`, stock (`:258`) → `{sortHeader('stock', t('cards.list.stock'))}`.

- [ ] **Step 3: Packs — filter + counts, arrows disabled while filtered**

In the packs page component add:

```tsx
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'draft' | 'active'>(
    'all',
  );
  const filtering = q.trim() !== '' || statusFilter !== 'all';
```

Derive from the existing `rows` array (mapped at `:278`):

```tsx
  const visibleRows = rows.filter((p) => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false;
    const needle = q.trim().toLowerCase();
    return !needle || p.title.toLowerCase().includes(needle);
  });
```

Map over `visibleRows` (`:278`). In the page header (next to the Create button) add the same `Input` as cards plus a status `Select` (copy the deliveries-filter Select markup, `deliveries/page.tsx:80-97`, options All statuses/draft/active wired to `statusFilter`). Add a count line under the header: `` {filtering ? `${visibleRows.length} of ${rows.length} packs` : `${rows.length} packs`} `` in the same `Text` pattern as cards.

Reorder arrows assume the full per-category group is visible — while filtering, positions lie, so extend both `IconButton` `disabled` props (`:296`, `:308`): `disabled={filtering || pos <= 0 || updatePack.isPending}` and `disabled={filtering || pos >= group.length - 1 || updatePack.isPending}`.

- [ ] **Step 4: Verify + commit**

Type check via hooks. Manual smoke: cards search narrows live with "N of M cards"; Value header toggles ↑/↓; packs status filter hides reorder arrows while active.

```bash
git add backend/apps/admin/src/routes/cards/page.tsx backend/apps/admin/src/routes/packs/page.tsx
git commit -m "feat(admin): search/sort/counts on cards list, search/status filter on packs list

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Phase 3 — Control surfaces

### Task 9: FX override — audited service method, history endpoint, migration

The FX POST route writes directly via `packs.updateFxRates` (`backend/packages/api/src/api/admin/pricing/fx/route.ts:81-94`) — no audit row, and the `admin_action_audit` CHECK constraints don't even allow an fx entity (`Migration20260625060000.ts:18,:25` list `customer, commission, rewards_settings, credit, reward_pool` / their actions). A rate change reprices the whole catalog with no record.

**Files:**
- Create: `backend/packages/api/src/modules/packs/migrations/Migration20260706000000.ts`
- Modify: `backend/packages/api/src/modules/packs/service.ts` (new `editFxOverride` method — place it directly after `setManualFreeze`, which ends near `:1500`)
- Modify: `backend/packages/api/src/api/admin/pricing/fx/route.ts` (POST body gains required `reason`; delegate to the service)
- Create: `backend/packages/api/src/api/admin/pricing/fx/history/route.ts`
- Create: `backend/packages/api/src/api/admin/pricing/__tests__/fx-audit.spec.ts`

**Interfaces:**
- Produces: `PacksModuleService.editFxOverride(input: { manualOverride: boolean; manualRate: number | null; adminId: string; reason: string }): Promise<{ effective: number }>` — upsert + audit row in ONE transaction.
- Produces: `GET /admin/pricing/fx/history` → `{ changes: Array<{ at: string; admin_id: string; before: unknown; after: unknown; reason: string | null }> }` (last 10).
- `POST /admin/pricing/fx` body becomes `{ manual_override: boolean; manual_rate?: number | null; reason: string }` (reason 1–500 chars, validated with the existing `reqReason` from `../rewards-settings/validate`).

- [ ] **Step 1: Migration (CHECK widen, refuse-guard down)**

Copy the exact structure of `backend/packages/api/src/modules/packs/migrations/Migration20260625060000.ts` (it did the same widen for `reward_pool`). New file:

```ts
// backend/packages/api/src/modules/packs/migrations/Migration20260706000000.ts
import { Migration } from '@mikro-orm/migrations';

// Widen admin_action_audit CHECKs to admit FX-rate override edits:
//   entity_type += 'fx', action += 'edit_fx_rate'.
export class Migration20260706000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE "admin_action_audit" DROP CONSTRAINT IF EXISTS "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `ALTER TABLE "admin_action_audit" ADD CONSTRAINT "admin_action_audit_entity_type_check" CHECK ("entity_type" IN ('customer','commission','rewards_settings','credit','reward_pool','fx'));`,
    );
    this.addSql(
      `ALTER TABLE "admin_action_audit" DROP CONSTRAINT IF EXISTS "admin_action_audit_action_check";`,
    );
    this.addSql(
      `ALTER TABLE "admin_action_audit" ADD CONSTRAINT "admin_action_audit_action_check" CHECK ("action" IN ('freeze','unfreeze','reverse_commission','suspend_commission','unsuspend_commission','adjust_credit','edit_rewards_settings','edit_reward_pool','edit_fx_rate'));`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM "admin_action_audit" WHERE entity_type = 'fx' OR action = 'edit_fx_rate') THEN
        RAISE EXCEPTION 'refusing to narrow admin_action_audit: fx/edit_fx_rate rows exist';
      END IF;
    END $$;`);
    this.addSql(
      `ALTER TABLE "admin_action_audit" DROP CONSTRAINT IF EXISTS "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `ALTER TABLE "admin_action_audit" ADD CONSTRAINT "admin_action_audit_entity_type_check" CHECK ("entity_type" IN ('customer','commission','rewards_settings','credit','reward_pool'));`,
    );
    this.addSql(
      `ALTER TABLE "admin_action_audit" DROP CONSTRAINT IF EXISTS "admin_action_audit_action_check";`,
    );
    this.addSql(
      `ALTER TABLE "admin_action_audit" ADD CONSTRAINT "admin_action_audit_action_check" CHECK ("action" IN ('freeze','unfreeze','reverse_commission','suspend_commission','unsuspend_commission','adjust_credit','edit_rewards_settings','edit_reward_pool'));`,
    );
  }
}
```

Cross-check the exact constraint value lists against `Migration20260625060000.ts` before committing — the down() must restore exactly what that migration's up() created. Also check `models/admin-action-audit.ts` — if the model file itself declares inline CHECK expressions listing the allowed values, add `'fx'`/`'edit_fx_rate'` there too so a fresh-DB snapshot matches.

- [ ] **Step 2: Failing service/route test**

```ts
// backend/packages/api/src/api/admin/pricing/__tests__/fx-audit.spec.ts
import { POST } from '../fx/route';
import { GET as history } from '../fx/history/route';

const mkRes = () => {
  const out: { body?: any } = {};
  return { res: { json: (b: any) => (out.body = b) } as any, out };
};

describe('FX override audit', () => {
  it('POST delegates to editFxOverride with adminId + reason', async () => {
    const calls: any[] = [];
    const scope = {
      resolve: () => ({
        editFxOverride: async (input: any) => {
          calls.push(input);
          return { effective: 4.9 };
        },
      }),
    };
    const { res, out } = mkRes();
    await POST(
      {
        scope,
        auth_context: { actor_id: 'admin_1' },
        body: { manual_override: true, manual_rate: 4.9, reason: 'rate drift' },
      } as any,
      res,
    );
    expect(calls[0]).toMatchObject({
      manualOverride: true,
      manualRate: 4.9,
      adminId: 'admin_1',
      reason: 'rate drift',
    });
    expect(out.body.effective).toBe(4.9);
  });

  it('POST rejects a missing reason', async () => {
    const scope = { resolve: () => ({ editFxOverride: async () => ({}) }) };
    const { res } = mkRes();
    await expect(
      POST(
        {
          scope,
          auth_context: { actor_id: 'admin_1' },
          body: { manual_override: false },
        } as any,
        res,
      ),
    ).rejects.toThrow(/reason/i);
  });

  it('history returns mapped audit rows', async () => {
    const scope = {
      resolve: () => ({
        listAdminActionAudits: async () => [
          {
            created_at: new Date('2026-07-06'),
            admin_id: 'admin_1',
            before: { manual_override: false, manual_rate: null },
            after: { manual_override: true, manual_rate: 4.9 },
            reason: 'rate drift',
          },
        ],
      }),
    };
    const { res, out } = mkRes();
    await history({ scope } as any, res);
    expect(out.body.changes).toHaveLength(1);
    expect(out.body.changes[0].admin_id).toBe('admin_1');
  });
});
```

- [ ] **Step 3: Run to verify FAIL** — `corepack yarn jest --runTestsByPath src/api/admin/pricing/__tests__/fx-audit.spec.ts` → FAIL (no history module, POST doesn't delegate).

- [ ] **Step 4: Service method**

In `service.ts`, directly after `setManualFreeze` ends (search for the method's closing brace; it starts at `:1448`), add — mirroring its `@InjectTransactionManager` + before/after + `createAdminActionAudits` shape (see the existing audit-write call at `:1495` for the exact row fields used):

```ts
  // FX manual-override edit + audit row in the same transaction. The audit row
  // is the only record of who repriced the catalog — never split these writes.
  @InjectTransactionManager()
  async editFxOverride(
    input: {
      manualOverride: boolean;
      manualRate: number | null;
      adminId: string;
      reason: string;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ effective: number }> {
    const [row] = await this.listFxRates(
      { pair: 'USD_MYR' },
      { take: 1 },
      sharedContext,
    );
    const before = row
      ? {
          manual_override: row.manual_override,
          manual_rate: row.manual_rate != null ? Number(row.manual_rate) : null,
        }
      : null;

    if (row) {
      await this.updateFxRates(
        [
          {
            id: row.id,
            manual_override: input.manualOverride,
            manual_rate: input.manualRate,
          },
        ],
        sharedContext,
      );
    } else {
      await this.createFxRates(
        [
          {
            pair: 'USD_MYR',
            rate: DEFAULT_USD_MYR,
            source: 'manual',
            manual_override: input.manualOverride,
            manual_rate: input.manualRate,
          },
        ],
        sharedContext,
      );
    }

    await this.createAdminActionAudits(
      [
        {
          admin_id: input.adminId,
          entity_type: 'fx',
          entity_id: 'USD_MYR',
          action: 'edit_fx_rate',
          before,
          after: {
            manual_override: input.manualOverride,
            manual_rate: input.manualRate,
          },
          reason: input.reason,
        },
      ],
      sharedContext,
    );

    const [fresh] = await this.listFxRates(
      { pair: 'USD_MYR' },
      { take: 1 },
      sharedContext,
    );
    return { effective: effectiveRate(fresh ?? null) };
  }
```

Imports: `DEFAULT_USD_MYR` and `effectiveRate` come from `./pricing` — add to the existing pricing import in `service.ts` (it already imports `resolveFxRate` from there, `:7871` observation). `InjectTransactionManager`, `MedusaContext`, `Context` are already imported (used by `setManualFreeze`). Match the exact field names of the audit-create call at `:1495` — if that call wraps values (e.g. JSON stringify), do the same.

- [ ] **Step 5: Route changes**

`pricing/fx/route.ts` POST (`:70-98`): add imports `import { reqReason } from '../../rewards-settings/validate';` and keep the existing body validators. Replace the body of `POST` after validation with delegation:

```ts
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = req.body as Body;
  const manual_override = requireBoolean(body.manual_override, "manual_override");
  const manual_rate = requirePositiveNumberOrNull(body.manual_rate, "manual_rate");
  if (manual_override && manual_rate == null) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "'manual_rate' is required when 'manual_override' is true.",
    );
  }
  const reason = reqReason(req.body);
  const adminId = req.auth_context.actor_id;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const packs: any = req.scope.resolve(PACKS_MODULE);
  res.json(
    await packs.editFxOverride({
      manualOverride: manual_override,
      manualRate: manual_rate,
      adminId,
      reason,
    }),
  );
}
```

(The `loadRow` helper stays for GET; remove it from POST usage.)

New `pricing/fx/history/route.ts`:

```ts
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { PACKS_MODULE } from "../../../../../modules/packs";

// GET /admin/pricing/fx/history — last 10 FX override edits from the
// append-only admin_action_audit table.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const packs: any = req.scope.resolve(PACKS_MODULE);
  const rows = await packs.listAdminActionAudits(
    { entity_type: "fx" },
    { order: { created_at: "DESC" }, take: 10 },
  );
  res.json({
    changes: rows.map((r: any) => ({
      at: r.created_at,
      admin_id: r.admin_id,
      before: r.before,
      after: r.after,
      reason: r.reason ?? null,
    })),
  });
}
```

(Check the relative import depth — `history/` sits one level deeper than `fx/route.ts`, hence the five `../`.)

- [ ] **Step 6: Run to verify PASS** — `corepack yarn jest --runTestsByPath src/api/admin/pricing/__tests__/fx-audit.spec.ts` → PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add backend/packages/api/src/modules/packs/migrations/Migration20260706000000.ts backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/api/admin/pricing
git commit -m "feat(api): audited FX override edits + fx history endpoint

editFxOverride writes the fx_rate upsert and the admin_action_audit row in
one transaction; CHECKs widened via migration (entity fx, action
edit_fx_rate); POST /admin/pricing/fx now requires a reason.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

**Deploy note:** DigitalOcean auto-deploy runs migrations — no manual step, but the storefront/admin must ship in the same deploy as this API change since the POST body contract changed (reason now required).

---

### Task 10: FX rate card on the Economy page

`useSetFxRate` (`queries.ts:205-210`) has ZERO consumers — the rate cannot be changed from any admin page today. Build the card. UI copy is hardcoded English (convention).

**Files:**
- Modify: `backend/apps/admin/src/lib/admin-rest.ts` (`setFxRate` `:388-391` gains `reason`; new `getFxHistory`)
- Modify: `backend/apps/admin/src/lib/query-keys.ts` (add `fxHistory`), `backend/apps/admin/src/lib/queries.ts` (add `useFxHistory`; `useSetFxRate` invalidates history too)
- Modify: `backend/apps/admin/src/routes/economy/page.tsx` (new card between the stats Container `:70` and the RTP Container `:72`)

**Interfaces:**
- Consumes: Task 9's POST contract + history endpoint; `FxRateState` (`admin-rest.ts:379-384`).
- Produces: `getFxHistory(): Promise<{ changes: FxChange[] }>`; `useFxHistory()`.

- [ ] **Step 1: Data layer**

`admin-rest.ts` — extend `setFxRate`'s body type with `reason: string` and add below it:

```ts
export interface FxChange {
  at: string;
  admin_id: string;
  before: { manual_override: boolean; manual_rate: number | null } | null;
  after: { manual_override: boolean; manual_rate: number | null };
  reason: string | null;
}

export const getFxHistory = () =>
  getJson<{ changes: FxChange[] }>('/admin/pricing/fx/history');
```

`query-keys.ts`: `fxHistory: ['admin', 'pricing', 'fx', 'history'] as const,`

`queries.ts`:

```ts
export const useFxHistory = (): UseQueryResult<{ changes: FxChange[] }> =>
  useQuery({ queryKey: qk.fxHistory, queryFn: getFxHistory });
```

and in `useSetFxRate`'s `onSuccess` (:209 area) add `qc.invalidateQueries({ queryKey: qk.fxHistory });` plus `toast.success('Exchange rate updated');`.

- [ ] **Step 2: The card**

In `economy/page.tsx`, add a new self-contained component above `EconomyPage` and render `<FxCard />` between the two existing Containers (after `:70`):

```tsx
const FxCard = () => {
  const { data: fx } = useFxRate();
  const { data: history } = useFxHistory();
  const setFx = useSetFxRate();
  const [override, setOverride] = useState(false);
  const [rate, setRate] = useState('');
  const [reason, setReason] = useState('');
  const [seeded, setSeeded] = useState(false);
  if (fx && !seeded) {
    setSeeded(true);
    setOverride(fx.manual_override);
    setRate(fx.manual_rate != null ? String(fx.manual_rate) : '');
  }

  const rateNum = Number(rate);
  const rateValid = !override || (Number.isFinite(rateNum) && rateNum > 0 && rateNum <= 1000);
  const canSave = !setFx.isPending && rateValid && reason.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    if (
      !window.confirm(
        'This reprices every card on the storefront immediately. Continue?',
      )
    )
      return;
    setFx.mutate({
      manual_override: override,
      manual_rate: override ? rateNum : null,
      reason: reason.trim(),
    });
    setReason('');
  };

  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Exchange rate (USD → MYR)</Heading>
        <Text className="text-ui-fg-subtle mt-1" size="small">
          Effective rate: {fx ? fx.effective.toFixed(4) : '…'}
          {fx?.manual_override ? ' (manual override)' : ' (auto)'}
        </Text>
      </div>
      <div className="flex flex-wrap items-end gap-4 border-t px-6 py-4">
        <div className="flex items-center gap-2">
          <Switch checked={override} onCheckedChange={setOverride} id="fx-ovr" />
          <Text size="small">Manual override</Text>
        </div>
        <div className="flex flex-col gap-y-1">
          <Text size="small" weight="plus">Rate</Text>
          <Input
            className="w-32"
            value={rate}
            disabled={!override}
            onChange={(e) => setRate(e.target.value)}
            placeholder="4.70"
          />
        </div>
        <div className="flex min-w-64 flex-1 flex-col gap-y-1">
          <Text size="small" weight="plus">Reason</Text>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Required — why is the rate changing?"
          />
        </div>
        <Button size="small" onClick={save} isLoading={setFx.isPending} disabled={!canSave}>
          Save rate
        </Button>
      </div>
      {history && history.changes.length > 0 && (
        <div className="border-t px-6 py-4">
          <Text size="small" weight="plus">Recent changes</Text>
          <ul className="mt-2 flex flex-col gap-1">
            {history.changes.map((c, i) => (
              <li key={i} className="text-ui-fg-subtle text-sm">
                {new Date(c.at).toLocaleString('en-US')} — {c.admin_id}:{' '}
                {c.after.manual_override
                  ? `override → ${c.after.manual_rate}`
                  : 'override off'}
                {c.reason ? ` (${c.reason})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Container>
  );
};
```

Imports to add in this file: `useState` from `react`; `Button`, `Input`, `Switch`, `toast` (if used) from `@medusajs/ui` (extend the existing import); `useFxRate`, `useFxHistory`, `useSetFxRate` from `../../lib/queries`. If `@medusajs/ui` exports no `Switch` in this version, use a `<Checkbox>` from the same package with the identical wiring.

- [ ] **Step 3: Verify + commit**

Type check via hooks. Manual smoke: economy page shows the card; toggling override + entering rate + reason enables Save; confirm dialog fires; after save the effective rate and Recent changes list refresh.

```bash
git add backend/apps/admin/src/lib backend/apps/admin/src/routes/economy/page.tsx
git commit -m "feat(admin): FX rate control card with confirm + change history

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Rewards-settings tab on Daily Rewards

`GET/POST /admin/rewards-settings` exists, validates, clamps, and audits (`backend/packages/api/src/api/admin/rewards-settings/route.ts`) but has zero UI consumers. Backend is untouched in this task.

**Files:**
- Modify: `backend/apps/admin/src/lib/admin-rest.ts` (two wrappers + types)
- Modify: `backend/apps/admin/src/lib/query-keys.ts`, `backend/apps/admin/src/lib/queries.ts`
- Modify: `backend/apps/admin/src/routes/daily-rewards/page.tsx` (third tab)

**Interfaces:**
- Consumes: backend field contract from `backend/packages/api/src/modules/packs/rewards-settings-validate.ts:3-15` — `commissionCooldownDays` (int ≥ 0), `teamOverridePct` (0–1 exclusive, whole percent), `overrideGenerationCap` (int ≥ 1), `withdrawals_per_day` (int ≥ 1); POST also requires `reason` (1–500).
- Produces: `getRewardsSettings(): Promise<RewardsSettingsView>`; `saveRewardsSettings(body: Partial<RewardsSettingsView> & { reason: string })`; `useRewardsSettings()`, `useSaveRewardsSettings()`.

- [ ] **Step 1: Data layer**

`admin-rest.ts`:

```ts
// ── Rewards engine settings ──────────────────────────────────────────────────

export interface RewardsSettingsView {
  commissionCooldownDays: number;
  teamOverridePct: number;
  overrideGenerationCap: number;
  withdrawals_per_day: number;
}

export const getRewardsSettings = () =>
  getJson<RewardsSettingsView>('/admin/rewards-settings');

export const saveRewardsSettings = (
  body: Partial<RewardsSettingsView> & { reason: string },
) => postJson<RewardsSettingsView>('/admin/rewards-settings', body);
```

`query-keys.ts`: `rewardsSettings: ['admin', 'rewards-settings'] as const,`

`queries.ts`:

```ts
export const useRewardsSettings = (): UseQueryResult<RewardsSettingsView> =>
  useQuery({ queryKey: qk.rewardsSettings, queryFn: getRewardsSettings });

export const useSaveRewardsSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveRewardsSettings,
    onSuccess: () => {
      toast.success('Engine settings saved');
      qc.invalidateQueries({ queryKey: qk.rewardsSettings });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
};
```

- [ ] **Step 2: The tab**

In `daily-rewards/page.tsx`: widen the tab union to `'boxes' | 'vouchers' | 'settings'`, add a third header `Button` ("Engine settings", `variant={tab === 'settings' ? 'primary' : 'secondary'}`, `onClick={() => switchTab('settings')}` — `switchTab` from Task 1 needs its parameter type widened to the same union), render `{tab === 'settings' && <SettingsTab />}` in the tab body expression, and add the component at the bottom of the file:

```tsx
const SettingsTab = () => {
  const { data, isError } = useRewardsSettings();
  const save = useSaveRewardsSettings();
  const [cooldown, setCooldown] = useState('');
  const [overridePct, setOverridePct] = useState(''); // whole percent, e.g. "20"
  const [genCap, setGenCap] = useState('');
  const [withdrawals, setWithdrawals] = useState('');
  const [reason, setReason] = useState('');
  const [seeded, setSeeded] = useState(false);
  if (data && !seeded) {
    setSeeded(true);
    setCooldown(String(data.commissionCooldownDays));
    setOverridePct(String(Math.round(data.teamOverridePct * 100)));
    setGenCap(String(data.overrideGenerationCap));
    setWithdrawals(String(data.withdrawals_per_day));
  }

  const cooldownN = Number(cooldown);
  const pctN = Number(overridePct);
  const capN = Number(genCap);
  const wdN = Number(withdrawals);
  const errors: string[] = [];
  if (!Number.isInteger(cooldownN) || cooldownN < 0)
    errors.push('Cooldown must be an integer ≥ 0.');
  if (!Number.isInteger(pctN) || pctN < 1 || pctN > 99)
    errors.push('Team override must be a whole percent between 1 and 99.');
  if (!Number.isInteger(capN) || capN < 1)
    errors.push('Generation cap must be an integer ≥ 1.');
  if (!Number.isInteger(wdN) || wdN < 1)
    errors.push('Withdrawals/day must be an integer ≥ 1.');
  const canSave =
    !save.isPending && seeded && errors.length === 0 && reason.trim().length > 0;

  const submit = () => {
    if (!canSave) return;
    save.mutate({
      commissionCooldownDays: cooldownN,
      teamOverridePct: pctN / 100,
      overrideGenerationCap: capN,
      withdrawals_per_day: wdN,
      reason: reason.trim(),
    });
    setReason('');
  };

  if (isError)
    return (
      <div className="px-6 py-8">
        <Text className="text-ui-fg-subtle">Failed to load settings.</Text>
      </div>
    );

  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    hint: string,
  ) => (
    <div className="flex flex-col gap-y-1">
      <Text size="small" weight="plus">{label}</Text>
      <Input className="w-40" value={value} onChange={(e) => set(e.target.value)} />
      <Text size="small" className="text-ui-fg-subtle">{hint}</Text>
    </div>
  );

  return (
    <div className="flex flex-col gap-y-5 border-t px-6 py-6">
      <Text className="text-ui-fg-subtle" size="small">
        Commission-engine knobs. Changes are clamped and audited server-side.
      </Text>
      <div className="flex flex-wrap gap-6">
        {field('Commission cooldown (days)', cooldown, setCooldown, 'Days before a commission matures.')}
        {field('Team override (%)', overridePct, setOverridePct, 'Whole percent, 1–99. Stored as a fraction.')}
        {field('Override generation cap', genCap, setGenCap, 'How many upline generations earn override.')}
        {field('Withdrawals per day', withdrawals, setWithdrawals, 'Per-customer daily withdrawal limit.')}
      </div>
      {errors.length > 0 && (
        <Text size="small" className="text-ui-fg-error">{errors[0]}</Text>
      )}
      <div className="flex items-end gap-4">
        <div className="flex min-w-64 flex-1 flex-col gap-y-1">
          <Text size="small" weight="plus">Reason</Text>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Required — audit note for this change"
          />
        </div>
        <Button onClick={submit} isLoading={save.isPending} disabled={!canSave}>
          Save settings
        </Button>
      </div>
    </div>
  );
};
```

Add `useRewardsSettings`, `useSaveRewardsSettings` to the page's `../../lib/queries` import.

**Escape hatch:** before building the form, hit the live GET once (or read `packs.rewardsSettings()` in `service.ts`) and confirm the response is exactly the four fields of `RewardsSettingsView`. If it returns extra/nested config, STOP and report back instead of inventing UI for unknown fields.

- [ ] **Step 3: Verify + commit**

Type check via hooks. Manual smoke: third tab renders seeded values; bad pct (e.g. 0 or 20.5) shows the error and disables Save; saving with a reason toasts and re-seeds.

```bash
git add backend/apps/admin/src/lib backend/apps/admin/src/routes/daily-rewards/page.tsx
git commit -m "feat(admin): rewards engine settings tab (cooldown, override pct, gen cap, withdrawals)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Phase 4 — Polish bundle

### Task 12: Polish — pool select-all, odds badge, tooltips, delivery email, shared box cap

Five independent small items; one task, one commit.

**Files:**
- Modify: `backend/apps/admin/src/routes/packs/[slug]/page.tsx` (pool modal, `selected` state `:99`, subtitle `:517`)
- Modify: `backend/apps/admin/src/routes/packs/page.tsx` (odds badge column)
- Modify: `backend/apps/admin/src/routes/economy/page.tsx` (RTP badge `:113-118`)
- Modify: `backend/apps/admin/src/routes/cards/page.tsx` (stock cell `:296-308`)
- Modify: `backend/apps/admin/src/routes/deliveries/page.tsx` (modal `:196-200`)
- Modify: `backend/packages/api/src/api/admin/daily-rewards/boxes/[tier]/route.ts` (GET), `backend/apps/admin/src/lib/admin-rest.ts` (`DailyBoxEditorDTO`), `backend/apps/admin/src/routes/daily-rewards/page.tsx` (`:43-44`, `:576-577`)

- [ ] **Step 1: Pool picker select-all / clear-all**

In `packs/[slug]/page.tsx`, next to the pool subtitle (`:517`, which already shows the selected count), add two buttons (the modal's card list uses `allCards` from `useCards` — grep `allCards` in this file for the exact variable):

```tsx
              <div className="flex gap-2">
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() =>
                    setSelected(new Set((allCards ?? []).map((c) => c.handle)))
                  }
                >
                  Select all
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() => setSelected(new Set())}
                >
                  Clear all
                </Button>
              </div>
```

- [ ] **Step 2: Published-odds badge on the pack list**

`packs/page.tsx`: `published_odds` is already in the list payload (`backend/packages/api/src/api/admin/packs/route.ts:35`). Add a header cell after Status (`:270`): `<Table.HeaderCell>Odds</Table.HeaderCell>` and the matching body cell after the status cell (`:326`):

```tsx
                <Table.Cell>
                  <StatusBadge color={p.published_odds ? 'green' : 'orange'}>
                    {p.published_odds ? 'Published' : 'Not set'}
                  </StatusBadge>
                </Table.Cell>
```

If `AdminPack` in `packs-api.ts` lacks `published_odds`, add `published_odds: unknown | null;` to the interface (the [slug] editor already reads it, so it is almost certainly present).

- [ ] **Step 3: Tooltips**

`economy/page.tsx` RTP badge (`:113-118`): wrap in a span with a title:

```tsx
                      <span title="RTP > 100% means players receive more value than the pack price on average — the house loses money on this pack.">
                        <Badge size="2xsmall" color={p.rtp_pct > 100 ? 'red' : 'grey'}>
                          {p.rtp_pct.toFixed(2)}%
                        </Badge>
                      </span>
```

`cards/page.tsx` stock cell (`:296-308`): add to the `<Table.Cell>` a `title` attribute:

```tsx
                <Table.Cell
                  title="Negative = units owed to winners; 0 = buyback-only; ∞ = untracked"
                  className={ ...existing ternary unchanged... }
                >
```

- [ ] **Step 4: Customer contact in the delivery modal**

`deliveries/page.tsx`, in the modal under the address `<Text>` (`:196-200`), add:

```tsx
                <Text className="text-ui-fg-subtle" size="small">
                  Customer: {detail.customer_email ?? detail.customer_id}
                </Text>
```

- [ ] **Step 5: Serve MAX_BOX_CREDIT_MYR instead of mirroring it**

Backend `daily-rewards/boxes/[tier]/route.ts` GET — spread the cap into the response:

```ts
import { MAX_BOX_CREDIT_MYR } from '../../../../../modules/packs/daily-box';
// in GET:
  res.json({
    ...(await packs.getDailyBoxEditor(req.params.tier)),
    max_box_credit_myr: MAX_BOX_CREDIT_MYR,
  });
```

(Verify the import path/export: `backend/packages/api/src/modules/packs/daily-box.ts:7` — `export const MAX_BOX_CREDIT_MYR = 10_000;`.)

Frontend: add `max_box_credit_myr: number;` to `DailyBoxEditorDTO` in `admin-rest.ts` (grep `DailyBoxEditorDTO` for the interface). In `daily-rewards/page.tsx`: delete the mirror const + its comment (`:43-44`); in `BoxesTab` derive `const maxCredit = seededFrom?.max_box_credit_myr ?? 10_000;` and replace both `MAX_BOX_CREDIT_MYR` references in the row validation (`:576-577`) with `maxCredit`.

- [ ] **Step 6: Verify + commit**

Type check via hooks; backend spec for the boxes route is not required (additive field), but re-run the Task 1 vitest to confirm the page still compiles its test: `corepack yarn vitest run src/routes/daily-rewards/box-snapshot.spec.ts` → PASS. Manual smoke across the five touches.

```bash
git add "backend/apps/admin/src/routes/packs/[slug]/page.tsx" backend/apps/admin/src/routes/packs/page.tsx backend/apps/admin/src/routes/economy/page.tsx backend/apps/admin/src/routes/cards/page.tsx backend/apps/admin/src/routes/deliveries/page.tsx "backend/packages/api/src/api/admin/daily-rewards/boxes/[tier]/route.ts" backend/apps/admin/src/lib/admin-rest.ts backend/apps/admin/src/routes/daily-rewards/page.tsx
git commit -m "polish(admin): pool select-all, odds badge, RTP/stock tooltips, delivery contact, served box cap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Execution order & verification summary

| Order | Task | Verifies with |
|---|---|---|
| 1 | Task 1 box dirty-guard | vitest box-snapshot.spec.ts |
| 2 | Task 2 success toasts | typecheck + smoke |
| 3 | Task 3 shipped pre-gate | typecheck + smoke |
| 4 | Task 4 Pager | typecheck |
| 5 | Task 5 pulls pagination | jest pulls pagination.spec.ts |
| 6 | Task 6 deliveries pagination | jest delivery-orders pagination.spec.ts |
| 7 | Task 7 customer history | jest history-pagination.spec.ts |
| 8 | Task 8 cards/packs search | typecheck + smoke |
| 9 | Task 9 FX audit (MIGRATION) | jest fx-audit.spec.ts |
| 10 | Task 10 FX card | typecheck + smoke |
| 11 | Task 11 settings tab | typecheck + smoke |
| 12 | Task 12 polish | vitest re-run + smoke |

Dependencies: Task 4 before 5/6/7; Task 9 before 10; Task 1 before 11 (shared `switchTab`); everything else independent. Tasks 5–7 all touch `queries.ts`/`query-keys.ts` — execute sequentially, never in parallel.

Full-suite gate before PR: run each new spec per-file (never the whole jest suite — OOM), plus the Stop-hook typecheck. Manual smoke pass with the full stack (`launching-pokenic-stack` skill; admin login `admin@pokenic.local` / see team credentials).
