# Admin Vault redesign — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the crowded admin sidebar with the 8-entry Vault menu, hide all 15 unused Medusa/Mercur core tabs, add the redirects, and re-theme the whole admin to the Vault look. The Dashboard itself comes in Phase 2.

**Architecture:**

- **Navigation** uses Mercur's supported override plus our own page configs:
  - `backend/apps/admin/src/_navigation.ts` hides all 15 core items.
  - Every custom page's `export const config` is re-parented under custom group parents.
  - Three tiny redirect pages act as label-only group parents.
  - Three custom routes override core list pages with redirects.
- **The theme** is pure CSS on Medusa UI's colour variables in `admin-ui.css`:
  - the dark theme is pinned in `index.html`;
  - Geist is served under Medusa's `Inter` family name, so core pages switch font too.
- No backend, data or env changes.

**Tech Stack:**

- Vite + React 18 SPA on `@mercurjs/admin` 2.3.3 (`@mercurjs/dashboard-sdk` file routing)
- `@medusajs/ui` and `@medusajs/icons`
- Vitest (node environment)
- Playwright, for the verification script

**Spec:** `docs/superpowers/specs/2026-10-14-admin-redesign-design.md` (read §3–§6 and §10–§11 before starting).

## Global Constraints

- **Frontend only.** Touch only `backend/apps/admin/**`, `scripts/qa-admin-vault-p1.mjs`, `DESIGN.md` and `docs/**`. No backend, migration, env or production access.
- **Page URLs never change.** Only sidebar placement, labels and redirects do.
- **Configs must be literals.** The SDK reads `config` objects from source as literals: string `label`, `nested`, `translationNs`; numeric-literal `rank`; identifier `icon`. Never compute them.
- **Nav labels are i18n keys** under the new `pcNav.*` namespace in `src/i18n/en.json`, with `translationNs: 'translation'`. Never add keys under a namespace core already owns: `i18n/no-core-shadow.test.ts` must stay green.
- **Every write action keeps its API call, confirmation and reason.** Phase 1 changes no page internals except two thumbnail background classes.
- **Mercur skills apply** (`backend/.claude/skills/medusa-ui-conformance`, `dashboard-page-ui`):
  - routes live in `src/routes`;
  - icons come from `@medusajs/icons`;
  - no hardcoded user-facing strings in new code;
  - reuse `@medusajs/ui`.
- **Phase 1 in-between state (spec §6.2a):**
  - "Dashboard" opens `/stats`, and `/orders` redirects to `/stats`.
  - Customer support (`/support`) and Import collection (`/products/from-pc-collection`) stay as sidebar children until Phase 3 merges them.
- **Commits** follow conventional style and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A stored "Light" theme choice from before this change.** The admin must still render Vault dark on first load.
   - Pinned by `index.html`.
   - Tested in Task 4, check "dark theme pinned".
2. **The profile breadcrumb "Players" (`/customers`) and old bookmarks** (`/orders`, `/reservations`) must land on a working page, never on Medusa's old lists.
   - Task 2 redirects.
   - Task 4 redirect checks.
3. **Opening a page inside a group** (e.g. `/packs/<slug>`, `/inventory/list/<handle>`, `/products/from-pricecharting`) must show its group expanded with the right child highlighted, never a collapsed menu.
   - Task 1 nests children by exact parent path.
   - Task 4 screenshots.
4. **Core Settings pages** (users, regions, locations, sales channels, API keys) must stay legible on the new dark tokens, and the kept Settings links must stay visible while the 8 leftovers hide.
   - Task 4: positive control on `settings/users` plus screenshots.
5. **Sprite thumbnails** (Pixel Pokédex, the card editor's Pokémon picker) must not render as white squares on the dark base.
   - Task 3 token swap.
   - Task 4 screenshots of `/pixel-pokemon` and `/cards`.

---

## File Structure

**Created:**

| File                                                                                    | Responsibility                                                                                        |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `backend/apps/admin/src/_navigation.ts`                                                 | Hides the 15 core sidebar items (supported Mercur override)                                           |
| `backend/apps/admin/src/lib/nav-contract.test.ts`                                       | Pins the sidebar contract: 8 top-level entries, each group's children, i18n labels, core items hidden |
| `backend/apps/admin/src/routes/payments/page.tsx`                                       | "Payments" group parent; redirects to `/withdrawals`                                                  |
| `backend/apps/admin/src/routes/rewards/page.tsx`                                        | "Rewards" group parent; redirects to `/daily-rewards`                                                 |
| `backend/apps/admin/src/routes/site/page.tsx`                                           | "Storefront" group parent; redirects to `/announcements`                                              |
| `backend/apps/admin/src/routes/orders/page.tsx`                                         | Overrides the core Orders list; redirects to `/stats` (Phase 2 repoints to `/overview`)               |
| `backend/apps/admin/src/routes/customers/page.tsx`                                      | Overrides the core Customers list; redirects to `/players`                                            |
| `backend/apps/admin/src/routes/reservations/page.tsx`                                   | Overrides the core Reservations list; redirects to `/inventory/list`                                  |
| `backend/apps/admin/src/assets/fonts/geist-latin-wght-normal.woff2` and `Geist-OFL.txt` | Self-hosted Geist (OFL)                                                                               |
| `scripts/qa-admin-vault-p1.mjs`                                                         | Playwright verification for this phase                                                                |

**Modified:**

| File                                                                                                                                      | Change                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `backend/apps/admin/src/i18n/en.json`                                                                                                     | Add the `pcNav` namespace                                                                       |
| 24 page files under `backend/apps/admin/src/routes/**`                                                                                    | Replace each `export const config` block (Task 1 table)                                         |
| `backend/apps/admin/src/admin-ui.css`                                                                                                     | Vault tokens, font alias, sidebar, Settings and theme-switch rules; remove old nav-hiding rules |
| `backend/apps/admin/index.html`                                                                                                           | Title, dark class, theme pin                                                                    |
| `backend/apps/admin/src/routes/pixel-pokemon/page.tsx` (lines ~218, ~334) and `src/routes/cards/CardPokemonFields.tsx` (lines ~239, ~305) | `bg-white` → `bg-ui-bg-component`                                                               |
| `DESIGN.md`                                                                                                                               | New "Admin console (Vault)" section                                                             |

---

### Task 0: Workspace and design docs on a branch

**Files:**

- Copy into the worktree:
  - `docs/superpowers/specs/2026-10-14-admin-redesign-design.md`
  - `docs/superpowers/specs/assets/2026-10-14-admin-vault-mockup.html`
  - `docs/superpowers/plans/2026-10-14-admin-vault-phase1.md`

These three files are untracked in the main checkout.

- [ ] **Step 1: Create the worktree.** Follow superpowers:using-git-worktrees; consent is pre-granted in this repo.
  - Prefer the native `EnterWorktree` tool, name `admin-vault-p1`, branch `feat/admin-vault-p1` from `master`.
  - Fallback: `git worktree add .worktrees/admin-vault-p1 -b feat/admin-vault-p1 master`.
  - Do not touch the user's uncommitted files on master.

- [ ] **Step 2: Install backend workspace dependencies** in the worktree (~1.5 min):

```bash
cd backend && corepack yarn install --immutable
```

Expected: `➤ YN0000: · Done`.

- [ ] **Step 3: Copy the three design docs from the main checkout into the same paths in the worktree.** Use plain `cp` with absolute source paths.

- [ ] **Step 4: Commit.**

```bash
git add docs/superpowers/specs/2026-10-14-admin-redesign-design.md docs/superpowers/specs/assets/2026-10-14-admin-vault-mockup.html docs/superpowers/plans/2026-10-14-admin-vault-phase1.md
git commit -m "docs(admin): Vault redesign spec, Phase 1 plan and mockup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

All later paths are relative to the worktree root. Admin commands run in `backend/apps/admin` with the pinned binaries (the global `tsc` on PATH breaks this build):

- `node ../../node_modules/vitest/vitest.mjs run`
- `node ../../node_modules/typescript/bin/tsc -b`
- `node ../../node_modules/vite/bin/vite.js build`
- `node ../../node_modules/eslint/bin/eslint.js .`

---

### Task 1: The 8-entry sidebar

**Files:**

- Create: `backend/apps/admin/src/lib/nav-contract.test.ts`
- Create: `backend/apps/admin/src/_navigation.ts`
- Create: `backend/apps/admin/src/routes/payments/page.tsx`, `src/routes/rewards/page.tsx`, `src/routes/site/page.tsx`
- Modify: `backend/apps/admin/src/i18n/en.json`
- Modify: the 24 page files in the table in Step 6

**Interfaces:**

- Produces:
  - group parent paths `/stats`, `/deliveries`, `/payments`, `/players`, `/packs`, `/inventory/list`, `/rewards`, `/site`;
  - i18n keys `pcNav.*`.
- Phase 2 relies on: replacing the `/stats` entry with `/overview` under the same `pcNav.dashboard` key.

- [ ] **Step 1: Write the failing contract test** at `backend/apps/admin/src/lib/nav-contract.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import navigation from '../_navigation';
import en from '../i18n/en.json';

// Sidebar contract for the Vault redesign (docs/superpowers/specs/
// 2026-10-14-admin-redesign-design.md §6). The dashboard SDK reads each page's
// `config` from source as literals, so this test reads the same source text.

const ROUTES = fileURLToPath(new URL('../routes', import.meta.url));

type PageConfig = {
  path: string;
  label?: string;
  translationNs?: string;
  nested?: string;
  rank?: number;
};

const pageFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return pageFiles(full);
    return name === 'page.tsx' ? [full] : [];
  });

const routePath = (file: string): string =>
  '/' +
  relative(ROUTES, file)
    .replace(/\\/g, '/')
    .replace(/\/?page\.tsx$/, '');

const readConfig = (file: string): PageConfig | null => {
  const src = readFileSync(file, 'utf8');
  const m = src.match(
    /export const config(?::\s*RouteConfig)?\s*=\s*\{([\s\S]*?)\n\};/,
  );
  if (!m) return null;
  const body = m[1];
  const str = (key: string) =>
    body.match(new RegExp(`\\b${key}:\\s*['"]([^'"]+)['"]`))?.[1];
  const rank = body.match(/\brank:\s*(-?\d+)/)?.[1];
  return {
    path: routePath(file),
    label: str('label'),
    translationNs: str('translationNs'),
    nested: str('nested'),
    rank: rank === undefined ? undefined : Number(rank),
  };
};

const configs = pageFiles(ROUTES)
  .map(readConfig)
  .filter((c): c is PageConfig => c !== null);
const byRank = (a: PageConfig, b: PageConfig) => (a.rank ?? 0) - (b.rank ?? 0);

type Entry = { path: string; label: string };
type Group = Entry & { children: Entry[] };

// Phase 1 state: Dashboard opens /stats (spec §6.2a); Customer support and
// Import collection remain children until Phase 3 merges them.
const GROUPS: Group[] = [
  { path: '/stats', label: 'pcNav.dashboard', children: [] },
  { path: '/deliveries', label: 'pcNav.orders', children: [] },
  {
    path: '/payments',
    label: 'pcNav.payments',
    children: [
      { path: '/withdrawals', label: 'pcNav.withdrawals' },
      { path: '/deposits', label: 'pcNav.deposits' },
      { path: '/ledger', label: 'pcNav.transactions' },
      { path: '/settlement', label: 'pcNav.reconciliation' },
      { path: '/economy', label: 'pcNav.profitReport' },
    ],
  },
  {
    path: '/players',
    label: 'pcNav.players',
    children: [
      { path: '/odds-sets', label: 'pcNav.playerGroups' },
      { path: '/referrals', label: 'pcNav.referrals' },
      { path: '/support', label: 'pcNav.customerSupport' },
    ],
  },
  {
    path: '/packs',
    label: 'pcNav.packs',
    children: [
      { path: '/cards', label: 'pcNav.cards' },
      { path: '/tier-defaults', label: 'pcNav.pricing' },
      { path: '/pixel-pokemon', label: 'pcNav.sprites' },
    ],
  },
  {
    path: '/inventory/list',
    label: 'pcNav.stock',
    children: [
      { path: '/products/from-pricecharting', label: 'pcNav.addStock' },
      { path: '/products/from-pc-collection', label: 'pcNav.importCollection' },
      { path: '/purchase-invoices', label: 'pcNav.purchaseInvoices' },
    ],
  },
  {
    path: '/rewards',
    label: 'pcNav.rewards',
    children: [
      { path: '/daily-rewards', label: 'pcNav.vipLevels' },
      { path: '/tasks', label: 'pcNav.tasks' },
      { path: '/challenge', label: 'pcNav.weeklyChallenge' },
    ],
  },
  {
    path: '/site',
    label: 'pcNav.storefront',
    children: [
      { path: '/announcements', label: 'pcNav.announcements' },
      { path: '/storefront', label: 'pcNav.cardFrame' },
    ],
  },
];

// Label-only group parents: their page just redirects to the first child.
const STUBS = ['/payments', '/rewards', '/site'];

const CORE_IDS = [
  'orders',
  'products',
  'offers',
  'collections',
  'categories',
  'inventory',
  'reservations',
  'customers',
  'customer-groups',
  'promotions',
  'campaigns',
  'price-lists',
  'stores',
  'reviews',
  'payouts',
];

const lookup = (key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>(
      (o, k) =>
        o && typeof o === 'object'
          ? (o as Record<string, unknown>)[k]
          : undefined,
      en,
    );

const entry = (c: PageConfig): Entry => ({
  path: c.path,
  label: c.label ?? '',
});

describe('sidebar contract (Vault spec §6)', () => {
  it('shows exactly the 8 top-level entries, in order', () => {
    const top = configs.filter((c) => !c.nested).sort(byRank);
    expect(top.map(entry)).toEqual(
      GROUPS.map(({ path, label }) => ({ path, label })),
    );
  });

  it.each(GROUPS)('$path lists its pages in order', (group) => {
    const kids = configs.filter((c) => c.nested === group.path).sort(byRank);
    expect(kids.map(entry)).toEqual(group.children);
  });

  it('nests nothing under a hidden core parent', () => {
    const parents = GROUPS.map((g) => g.path);
    for (const c of configs.filter((x) => x.nested)) {
      expect(parents, `${c.path} → ${c.nested}`).toContain(c.nested);
    }
  });

  it('labels every entry through i18n with an English string', () => {
    for (const c of configs) {
      expect(c.translationNs, c.path).toBe('translation');
      expect(typeof lookup(c.label ?? ''), `${c.path}: ${c.label}`).toBe(
        'string',
      );
    }
  });

  it('sends each label-only group to its first page', () => {
    for (const g of GROUPS.filter((x) => STUBS.includes(x.path))) {
      const src = readFileSync(
        join(ROUTES, g.path.slice(1), 'page.tsx'),
        'utf8',
      );
      expect(src).toContain(`<Navigate to="${g.children[0].path}" replace />`);
    }
  });

  it('hides exactly the 15 core sidebar items', () => {
    expect(navigation.items.map((i) => i.id).sort()).toEqual(
      [...CORE_IDS].sort(),
    );
    expect(navigation.items.every((i) => i.hidden === true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

```bash
cd backend/apps/admin && node ../../node_modules/vitest/vitest.mjs run src/lib/nav-contract.test.ts
```

Expected: FAIL, because `../_navigation` can't be resolved. If the sandbox blocks swc/esbuild native bindings, rerun with the sandbox disabled (see memory `worktree-test-setup`).

- [ ] **Step 3: Create `backend/apps/admin/src/_navigation.ts`:**

```ts
import { defineNavigationConfig } from '@mercurjs/dashboard-sdk';

// Vault redesign (docs/superpowers/specs/2026-10-14-admin-redesign-design.md
// §6.2): hide every core Medusa/Mercur sidebar item. Polycards uses none of
// these as a page; the data it does use (players, groups, stock) is reached
// through our own pages. Core items always render ABOVE custom ones, so the
// 8-entry menu only reads in order once all of them are gone. Hiding removes
// the sidebar entry only — the URL still opens (see the redirect routes for
// /orders, /customers and /reservations).
export default defineNavigationConfig({
  items: [
    'orders',
    'products',
    'offers',
    'collections',
    'categories',
    'inventory',
    'reservations',
    'customers',
    'customer-groups',
    'promotions',
    'campaigns',
    'price-lists',
    'stores',
    'reviews',
    'payouts',
  ].map((id) => ({ id, hidden: true })),
});
```

- [ ] **Step 4: Add the `pcNav` namespace to `backend/apps/admin/src/i18n/en.json`** as a new top-level key, after the last existing top-level key. Keep 2-space JSON.

```json
  "pcNav": {
    "dashboard": "Dashboard",
    "orders": "Orders",
    "payments": "Payments",
    "withdrawals": "Withdrawals",
    "deposits": "Deposits",
    "transactions": "Transactions",
    "reconciliation": "Reconciliation",
    "profitReport": "Profit report",
    "players": "Players",
    "playerGroups": "Player groups",
    "referrals": "Referrals",
    "customerSupport": "Customer support",
    "packs": "Packs",
    "cards": "Cards",
    "pricing": "Pricing",
    "sprites": "Pokémon sprites",
    "stock": "Stock",
    "addStock": "Add stock",
    "importCollection": "Import collection",
    "purchaseInvoices": "Purchase invoices",
    "rewards": "Rewards",
    "vipLevels": "VIP levels",
    "tasks": "Tasks",
    "weeklyChallenge": "Weekly challenge",
    "storefront": "Storefront",
    "announcements": "Announcements",
    "cardFrame": "Card frame"
  }
```

- [ ] **Step 5: Create the three group-parent pages.**

`backend/apps/admin/src/routes/payments/page.tsx`:

```tsx
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { CreditCard } from '@medusajs/icons';
import { Navigate } from 'react-router-dom';

// Sidebar group "Payments" (Vault spec §6.1). It has no page of its own: the
// entry opens the group's first page, where the sidebar shows the group open.
export const config: RouteConfig = {
  label: 'pcNav.payments',
  translationNs: 'translation',
  icon: CreditCard,
  rank: 20,
};

const PaymentsGroup = () => <Navigate to="/withdrawals" replace />;

export default PaymentsGroup;
```

`backend/apps/admin/src/routes/rewards/page.tsx`:

```tsx
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { Star } from '@medusajs/icons';
import { Navigate } from 'react-router-dom';

// Sidebar group "Rewards" (Vault spec §6.1): opens its first page.
export const config: RouteConfig = {
  label: 'pcNav.rewards',
  translationNs: 'translation',
  icon: Star,
  rank: 60,
};

const RewardsGroup = () => <Navigate to="/daily-rewards" replace />;

export default RewardsGroup;
```

`backend/apps/admin/src/routes/site/page.tsx`:

```tsx
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { BuildingStorefront } from '@medusajs/icons';
import { Navigate } from 'react-router-dom';

// Sidebar group "Storefront" (Vault spec §6.1): opens its first page. Its path
// is /site because /storefront is the Card frame page itself.
export const config: RouteConfig = {
  label: 'pcNav.storefront',
  translationNs: 'translation',
  icon: BuildingStorefront,
  rank: 70,
};

const StorefrontGroup = () => <Navigate to="/announcements" replace />;

export default StorefrontGroup;
```

- [ ] **Step 6: Replace the `export const config` block in each page below.**

Each new block has exactly these properties, in this order:

- `label: '<key>'`
- `translationNs: 'translation'`
- `icon: <Icon>` if the table names one
- `rank: <n>`
- `nested: '<parent>'` for children

Delete the old block's comments about ranks; they described the old ordering. Keep each file's existing icon import unless the table changes it.

| File (under `backend/apps/admin/src/routes/`) | label                    | icon                                    | rank | nested                            |
| --------------------------------------------- | ------------------------ | --------------------------------------- | ---- | --------------------------------- |
| `stats/page.tsx`                              | `pcNav.dashboard`        | `House` (replace the `ChartBar` import) | 0    | —                                 |
| `deliveries/page.tsx`                         | `pcNav.orders`           | `TruckFast`                             | 10   | — (remove `nested: '/orders'`)    |
| `withdrawals/page.tsx`                        | `pcNav.withdrawals`      | `ArrowUpTray`                           | 0    | `/payments`                       |
| `deposits/page.tsx`                           | `pcNav.deposits`         | `CurrencyDollar`                        | 1    | `/payments`                       |
| `ledger/page.tsx`                             | `pcNav.transactions`     | `Receipt`                               | 2    | `/payments`                       |
| `settlement/page.tsx`                         | `pcNav.reconciliation`   | `Receipt`                               | 3    | `/payments`                       |
| `economy/page.tsx`                            | `pcNav.profitReport`     | `CurrencyDollar`                        | 4    | `/payments`                       |
| `players/page.tsx`                            | `pcNav.players`          | `Users`                                 | 30   | — (remove `nested: '/customers'`) |
| `odds-sets/page.tsx`                          | `pcNav.playerGroups`     | `Users`                                 | 0    | `/players`                        |
| `referrals/page.tsx`                          | `pcNav.referrals`        | `Users`                                 | 1    | `/players`                        |
| `support/page.tsx`                            | `pcNav.customerSupport`  | `Buildings`                             | 2    | `/players`                        |
| `packs/page.tsx`                              | `pcNav.packs`            | `Gift`                                  | 40   | — (remove `nested: '/products'`)  |
| `cards/page.tsx`                              | `pcNav.cards`            | `Sparkles`                              | 0    | `/packs`                          |
| `tier-defaults/page.tsx`                      | `pcNav.pricing`          | `Sparkles`                              | 1    | `/packs`                          |
| `pixel-pokemon/page.tsx`                      | `pcNav.sprites`          | `Photo`                                 | 2    | `/packs`                          |
| `inventory/list/page.tsx`                     | `pcNav.stock`            | `ArchiveBox`                            | 50   | — (remove `nested: '/inventory'`) |
| `products/from-pricecharting/page.tsx`        | `pcNav.addStock`         | (none)                                  | 0    | `/inventory/list`                 |
| `products/from-pc-collection/page.tsx`        | `pcNav.importCollection` | (none)                                  | 1    | `/inventory/list`                 |
| `purchase-invoices/page.tsx`                  | `pcNav.purchaseInvoices` | `Receipt`                               | 2    | `/inventory/list`                 |
| `daily-rewards/page.tsx`                      | `pcNav.vipLevels`        | `Star`                                  | 0    | `/rewards`                        |
| `tasks/page.tsx`                              | `pcNav.tasks`            | `CheckCircle`                           | 1    | `/rewards`                        |
| `challenge/page.tsx`                          | `pcNav.weeklyChallenge`  | `Trophy`                                | 2    | `/rewards`                        |
| `announcements/page.tsx`                      | `pcNav.announcements`    | `BellAlert`                             | 0    | `/site`                           |
| `storefront/page.tsx`                         | `pcNav.cardFrame`        | `Photo`                                 | 1    | `/site`                           |

Worked example: `withdrawals/page.tsx` becomes

```tsx
export const config: RouteConfig = {
  label: 'pcNav.withdrawals',
  translationNs: 'translation',
  icon: ArrowUpTray,
  rank: 0,
  nested: '/payments',
};
```

`stats/page.tsx` becomes:

```tsx
import { House } from '@medusajs/icons';
// ...
export const config: RouteConfig = {
  label: 'pcNav.dashboard',
  translationNs: 'translation',
  icon: House,
  rank: 0,
};
```

Keep each file's own quote style (`stats`, `economy`, `support` and `tasks` use double quotes).

- [ ] **Step 7: Run the contract test and the i18n tests.**

```bash
cd backend/apps/admin && node ../../node_modules/vitest/vitest.mjs run src/lib/nav-contract.test.ts src/i18n
```

Expected: PASS. That is 6 contract tests plus 8 parameterised group cases, and the two `no-core-shadow` tests (`pcNav` is a new top-level key, so it shadows nothing).

- [ ] **Step 8: Typecheck.**

```bash
cd backend/apps/admin && node ../../node_modules/typescript/bin/tsc -b
```

Expected: exit 0. If `RouteConfig` rejects `translationNs`, check `node_modules/@mercurjs/dashboard-sdk/dist/index.d.ts` for the field name the SDK types use and match it. The SDK's AST reader (`dashboard-sdk/dist/vite.js`, `translationNs`) is the source of truth.

- [ ] **Step 9: Commit.**

```bash
git add backend/apps/admin/src
git commit -m "feat(admin): 8-entry Vault sidebar, core tabs hidden via _navigation.ts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Redirects for the core Orders, Customers and Reservations lists

**Files:**

- Create: `backend/apps/admin/src/routes/orders/page.tsx`
- Create: `backend/apps/admin/src/routes/customers/page.tsx`
- Create: `backend/apps/admin/src/routes/reservations/page.tsx`

**Interfaces:**

- Consumes the target paths `/stats`, `/players` and `/inventory/list` from Task 1.
- Phase 2 changes the `/orders` target (and its `redirectTo`) to `/overview`.

How the overrides work (verified in `@mercurjs/admin/dist/index.js`, `mergeRoutes` / `createLeafRoute`):

- A custom page at a core path replaces only that list's index route (`path: ""`); detail routes such as `/orders/:id` stay.
- The core parent route keeps its `permissions` handle.
- The `/orders` page declares its own handle with a `redirectTo`, so a role without `order:read` is redirected instead of shown "access denied". `RoutePermissionGuard` uses the deepest declared requirement and honours `redirectTo`.

These are three trivial redirect components with no branching logic, so they get no unit test. Task 4's Playwright checks prove them.

- [ ] **Step 1: Create `backend/apps/admin/src/routes/orders/page.tsx`:**

```tsx
import { Navigate } from 'react-router-dom';

// Replaces Medusa's Orders list, which is always empty here — Polycards never
// creates Medusa orders. Login (`from ?? "/orders"`) and the root route (`/` →
// /orders) both land here, so this is how the dashboard opens on our home page.
// Phase 1 home is the Stats page; Phase 2 points this at /overview (Vault spec
// §6.2a). The handle's redirectTo sends a role WITHOUT order:read to the same
// place instead of an "access denied" screen (RoutePermissionGuard).
export const handle = { permissions: 'order:read', redirectTo: '/stats' };

const OrdersRedirect = () => <Navigate to="/stats" replace />;

export default OrdersRedirect;
```

- [ ] **Step 2: Create `backend/apps/admin/src/routes/customers/page.tsx`:**

```tsx
import { Navigate } from 'react-router-dom';

// Replaces Medusa's Customers list (titled "Players" by our customers.domain
// rename) with our Players page — one player list, not two. It also catches
// the player profile's "Players" breadcrumb, which links here. Profiles at
// /customers/:id are unaffected.
const CustomersRedirect = () => <Navigate to="/players" replace />;

export default CustomersRedirect;
```

- [ ] **Step 3: Create `backend/apps/admin/src/routes/reservations/page.tsx`:**

```tsx
import { Navigate } from 'react-router-dom';

// Replaces Medusa's Reservations list. Polycards never reserves stock, but a
// reservation made by hand here would silently lower gacha stock
// (modules/packs/card-stock.ts subtracts reserved quantity), so the page is
// redirected to our Stock list rather than just hidden.
const ReservationsRedirect = () => <Navigate to="/inventory/list" replace />;

export default ReservationsRedirect;
```

- [ ] **Step 4: Run the contract test again and typecheck.** The new pages have no `config`, so the sidebar contract must be unchanged.

```bash
cd backend/apps/admin && node ../../node_modules/vitest/vitest.mjs run src/lib/nav-contract.test.ts && node ../../node_modules/typescript/bin/tsc -b
```

Expected: PASS and exit 0.

- [ ] **Step 5: Commit.**

```bash
git add backend/apps/admin/src/routes/orders backend/apps/admin/src/routes/customers/page.tsx backend/apps/admin/src/routes/reservations
git commit -m "feat(admin): redirect unused core Orders, Customers and Reservations lists

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Vault theme

**Files:**

- Create: `backend/apps/admin/src/assets/fonts/geist-latin-wght-normal.woff2`
- Create: `backend/apps/admin/src/assets/fonts/Geist-OFL.txt`
- Modify: `backend/apps/admin/src/admin-ui.css`
- Modify: `backend/apps/admin/index.html`
- Modify: `backend/apps/admin/src/routes/pixel-pokemon/page.tsx`, `backend/apps/admin/src/routes/cards/CardPokemonFields.tsx`
- Modify: `DESIGN.md`

**Interfaces:**

- Produces the Vault values on Medusa's variables: `--bg-subtle` `#0a0a0a`, `--bg-base` `#141414`, `--bg-component` `#1f1f1f`, `--fg-base` `#fafafa`, `--fg-subtle` `#a3a3a3`, `--fg-muted` `#8f8f8f`.
- Produces the font family `Geist`, also aliased as `Inter`. Phase 2 uses these and adds the Nekst face.

- [ ] **Step 1: Fetch Geist (OFL) from npm into the scratchpad and copy the two files in.**

```bash
SCRATCH="$(mktemp -d)" && (cd "$SCRATCH" && npm pack @fontsource-variable/geist@5.3.0 --silent && tar -xzf fontsource-variable-geist-5.3.0.tgz)
mkdir -p backend/apps/admin/src/assets/fonts
cp "$SCRATCH/package/files/geist-latin-wght-normal.woff2" backend/apps/admin/src/assets/fonts/
cp "$SCRATCH/package/LICENSE" backend/apps/admin/src/assets/fonts/Geist-OFL.txt
```

Expected: both files exist. The woff2 is ~25–35 KB.

- [ ] **Step 2: Edit `backend/apps/admin/index.html`.**
  - Change `<html lang="en">` to `<html lang="en" class="dark" style="color-scheme: dark">`.
  - Change `<title>Mercur Admin</title>` to `<title>Polycards Admin</title>`.
  - Add this script just before `<script type="module" src="/src/main.tsx"></script>`:

```html
<script>
  // Vault is dark-only (docs/superpowers/specs/2026-10-14-admin-redesign-design.md
  // §5.1). The dashboard's ThemeProvider reads this key on boot, so pinning it
  // here also overrides a "light" choice stored before the redesign.
  try {
    localStorage.setItem('medusa_admin_theme', 'dark');
  } catch (e) {}
</script>
```

- [ ] **Step 3: Edit `backend/apps/admin/src/admin-ui.css`.**

Delete the whole `/* --- Sidebar nav --- */` section: the comment block plus all three rule groups for `/collections`, `/categories` and `/payouts`, through the end of the file. `_navigation.ts` replaces it.

Update the header comment's "ONE deliberate exception" paragraph to read:

```css
 * Deliberate GLOBAL exceptions, all at the bottom of this file: the Vault
 * theme (Medusa colour variables + the Geist font), and rules on the prebuilt
 * sidebar and user menu, which our routes never render, so `.pc-admin` can
 * never reach them.
```

Then append:

```css
/* --- Vault theme (Vault spec §5) ---------------------------------------- */
/*
 * Re-themes the whole dashboard, core pages included, through Medusa UI's own
 * colour variables — never their markup. index.html pins the dark theme and
 * the user-menu theme switch is hidden below, so `.dark` is always the active
 * class; the same values are declared on :root so a stray light class can't
 * produce a half-light page. Anything not listed keeps Medusa's dark default
 * (the blue interactive/focus colour, tags, danger buttons).
 */
:root,
.dark {
  --bg-subtle: #0a0a0a;
  --bg-subtle-hover: #121212;
  --bg-subtle-pressed: #171717;
  --bg-base: #141414;
  --bg-base-hover: #1a1a1a;
  --bg-base-pressed: #1f1f1f;
  --bg-component: #1f1f1f;
  --bg-component-hover: #262626;
  --bg-component-pressed: #2e2e2e;
  --bg-field: #161616;
  --bg-field-hover: #1c1c1c;
  --bg-field-component: #1f1f1f;
  --bg-field-component-hover: #262626;
  --bg-highlight: rgba(255, 255, 255, 0.05);
  --bg-highlight-hover: rgba(255, 255, 255, 0.08);
  --bg-disabled: #1a1a1a;
  --fg-base: #fafafa;
  --fg-subtle: #a3a3a3;
  --fg-muted: #8f8f8f;
  --fg-disabled: #5c5c5c;
  --fg-on-inverted: #0a0a0a;
  --border-base: rgba(255, 255, 255, 0.08);
  --border-strong: rgba(255, 255, 255, 0.14);
  --button-inverted: #fafafa;
  --button-inverted-hover: #e5e5e5;
  --button-inverted-pressed: #d4d4d4;
  --button-neutral: #1f1f1f;
  --button-neutral-hover: #262626;
  --button-neutral-pressed: #2e2e2e;
  --button-transparent-hover: rgba(255, 255, 255, 0.06);
  --button-transparent-pressed: rgba(255, 255, 255, 0.1);
  --elevation-card-rest: 0 0 0 1px rgba(255, 255, 255, 0.08);
  --elevation-card-hover: 0 0 0 1px rgba(255, 255, 255, 0.14);
}

/*
 * Geist, the storefront's body face, for the whole admin. Every Medusa rule
 * (the html base and ~25 txt-* typography classes, some !important) names
 * `Inter` first, and Mercur ships no Inter webfont — operators were really
 * reading their OS fallback. Declaring the Geist file under the Inter family
 * switches every one of those rules at once; a document @font-face also beats
 * a locally installed Inter. `Geist` is the honest name for our own code.
 */
@font-face {
  font-family: 'Geist';
  src: url('./assets/fonts/geist-latin-wght-normal.woff2') format('woff2');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Inter';
  src: url('./assets/fonts/geist-latin-wght-normal.woff2') format('woff2');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}

/* --- Prebuilt sidebar and user menu (Vault spec §5.3, §6.3) ------------- */
/*
 * Selectors are the prebuilt dashboard's own data-testid hooks and its
 * ACTIVE_NAV_LINK_CLASSES token (`bg-ui-bg-base`). Re-check them on every
 * Mercur upgrade: they are markup we don't own.
 */

/* The active row sits on the raised graphite step, like the mockup. */
[data-testid='sidebar'] a[class~='bg-ui-bg-base'] {
  background-color: var(--bg-component);
}

/* Vault is dark-only; the Profile → Theme submenu would only offer a broken
   light mode. */
[data-testid='sidebar-user-menu-theme-trigger'] {
  display: none;
}

/* Medusa leftovers in the Settings sidebar. _navigation.ts cannot reach the
   Settings sidebar, so CSS is the only option; the pages stay URL-reachable
   and no data changes. Users, Sales channels, Locations, Publishable API keys,
   Marketplace and Regions stay — the store needs them. */
[data-testid='sidebar-nav-item-settings-tax-regions'],
[data-testid='sidebar-nav-item-settings-return-reasons'],
[data-testid='sidebar-nav-item-settings-refund-reasons'],
[data-testid='sidebar-nav-item-settings-product-types'],
[data-testid='sidebar-nav-item-settings-product-tags'],
[data-testid='sidebar-nav-item-settings-attributes'],
[data-testid='sidebar-nav-item-settings-commissions'],
[data-testid='sidebar-nav-item-settings-secret-api-keys'] {
  display: none;
}
```

- [ ] **Step 4: Swap the sprite thumbnail backgrounds** (white squares on the dark base). Change `bg-white` to `bg-ui-bg-component` in exactly four places:
  - `backend/apps/admin/src/routes/pixel-pokemon/page.tsx`, two `<img>` thumbnails (~lines 218 and 334)
  - `backend/apps/admin/src/routes/cards/CardPokemonFields.tsx`, two thumbnails (~lines 239 and 305)

Leave the `neutral-*`, `white/…` and `#FF00FF` values in `announcements`, `storefront` and `daily-rewards`. They imitate the storefront's own surfaces on purpose (spec §5.1).

- [ ] **Step 5: Append to `DESIGN.md`** (end of file):

```markdown
## Admin console (Vault)

The operator dashboard (`backend/apps/admin`) wears the same identity in its product register: **Vault**. Source of truth: `docs/superpowers/specs/2026-10-14-admin-redesign-design.md` §5.

- **Dark only.** The dark theme is pinned in `index.html`; the theme switch is hidden.
- **Implementation.** Colours live on Medusa UI's own variables in `admin-ui.css`, so core pages inherit them:
  - page `#0a0a0a`, panel `#141414`, control `#1f1f1f`;
  - text `#fafafa` / `#a3a3a3` / `#8f8f8f`;
  - hairline `rgba(255,255,255,.08)`;
  - primary action Paper White on Ink Black.
- **Signal colours only:** Buyback Green FG for money in, Alarm Red for alerts and for a rise in money out, Chase Gold for "needs action" and the current-period emphasis.
- **Type:** Geist for UI, self-hosted and aliased over Medusa's `Inter`. Nekst Black only for headline money figures on the Dashboard.
- **Shape and motion:** matte panels, 14px radius, no drop shadows on in-flow surfaces. Motion lives on the Dashboard and is fully off under `prefers-reduced-motion`.
```

- [ ] **Step 6: Build, lint and test.**

```bash
cd backend/apps/admin && node ../../node_modules/typescript/bin/tsc -b && node ../../node_modules/vite/bin/vite.js build && node ../../node_modules/eslint/bin/eslint.js . && node ../../node_modules/vitest/vitest.mjs run
```

Expected:

- the build emits `dist/assets/geist-latin-wght-normal-<hash>.woff2`;
- lint reports 0 problems;
- all Vitest files pass.

- [ ] **Step 7: Commit.**

```bash
git add backend/apps/admin/index.html backend/apps/admin/src/admin-ui.css backend/apps/admin/src/assets backend/apps/admin/src/routes/pixel-pokemon/page.tsx backend/apps/admin/src/routes/cards/CardPokemonFields.tsx DESIGN.md
git commit -m "feat(admin): Vault theme — dark tokens, Geist, sidebar and settings clean-up

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Verify on the local stack

**Files:**

- Create: `scripts/qa-admin-vault-p1.mjs`

**Interfaces:**

- Consumes:
  - QA token minting from `backend/packages/api/src/scripts/qa-mint-admin-session.ts` (main checkout; the backend is unchanged by this branch);
  - the template `scripts/qa-stats-shot.mjs`.

- [ ] **Step 1: Create `scripts/qa-admin-vault-p1.mjs`:**

```js
// Phase 1 check for the Vault admin redesign
// (docs/superpowers/plans/2026-10-14-admin-vault-phase1.md, Task 4).
// Logs in with a QA token (see qa-stats-shot.mjs), checks the sidebar, the
// redirects, the pinned dark theme, the Geist font and the Settings clean-up,
// and screenshots every custom page plus the kept Settings pages.
// Requires the backend on :9000 and this branch's admin dev server on :7000.
//
// Usage: QA_JWT_FILE=/path/qa-admin.jwt [OUT=dir] node scripts/qa-admin-vault-p1.mjs
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const BACKEND = process.env.BACKEND_URL || 'http://localhost:9000';
const ADMIN = `${process.env.ADMIN_URL || 'http://localhost:7000'}/dashboard`;
const OUT = process.env.OUT || 'docs/research/admin-vault-p1';
mkdirSync(OUT, { recursive: true });
if (!process.env.QA_JWT_FILE) throw new Error('QA_JWT_FILE not set');
const token = readFileSync(process.env.QA_JWT_FILE, 'utf8').trim();

const TOP = [
  'Dashboard',
  'Orders',
  'Payments',
  'Players',
  'Packs',
  'Stock',
  'Rewards',
  'Storefront',
];
const REDIRECTS = [
  ['/', '/stats'],
  ['/orders', '/stats'],
  ['/customers', '/players'],
  ['/reservations', '/inventory/list'],
  ['/payments', '/withdrawals'],
  ['/rewards', '/daily-rewards'],
  ['/site', '/announcements'],
];
const PAGES = [
  '/stats',
  '/deliveries',
  '/withdrawals',
  '/deposits',
  '/ledger',
  '/settlement',
  '/economy',
  '/players',
  '/odds-sets',
  '/referrals',
  '/support',
  '/packs',
  '/cards',
  '/tier-defaults',
  '/pixel-pokemon',
  '/inventory/list',
  '/products/from-pricecharting',
  '/products/from-pc-collection',
  '/purchase-invoices',
  '/purchase-invoices/new',
  '/daily-rewards',
  '/tasks',
  '/challenge',
  '/announcements',
  '/storefront',
  '/settings/users',
  '/settings/regions',
  '/settings/sales-channels',
  '/settings/locations',
  '/settings/publishable-api-keys',
  '/settings/marketplace',
  '/settings/profile',
];
const HIDDEN_SETTINGS = [
  'tax-regions',
  'return-reasons',
  'refund-reasons',
  'product-types',
  'product-tags',
  'attributes',
  'commissions',
  'secret-api-keys',
];

const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
// A "light" choice stored before the redesign must not survive the pin.
await ctx.addInitScript(() =>
  localStorage.setItem('medusa_admin_theme', 'light'),
);
const session = await ctx.request.post(`${BACKEND}/auth/session`, {
  headers: { authorization: `Bearer ${token}` },
});
if (!session.ok()) throw new Error(`POST /auth/session → ${session.status()}`);

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
const here = () =>
  new URL(page.url()).pathname.replace(/^\/dashboard/, '') || '/';
const settle = async () => {
  await page.waitForSelector('nav', { timeout: 60000 });
  await page.waitForTimeout(1500);
};

for (const [from, to] of REDIRECTS) {
  await page.goto(`${ADMIN}${from}`);
  await page
    .waitForURL((u) => u.pathname === `/dashboard${to}`, { timeout: 30000 })
    .catch(() => {});
  check(here() === to, `${from} → ${to} (got ${here()})`);
}

await page.goto(`${ADMIN}/stats`);
await settle();
const top = await page.$$eval(
  '[data-testid="sidebar-core-routes"] a[data-testid^="sidebar-nav-link-"]',
  (links) =>
    links
      .filter((a) => a.offsetParent !== null)
      .map((a) => a.textContent.trim()),
);
check(
  JSON.stringify(top) === JSON.stringify(TOP),
  `sidebar = ${top.join(' · ')}`,
);

const theme = await page.evaluate(() => ({
  dark: document.documentElement.classList.contains('dark'),
  bg: getComputedStyle(document.documentElement)
    .getPropertyValue('--bg-subtle')
    .trim(),
  font: [...document.fonts].some(
    (f) => f.family.replace(/["']/g, '') === 'Inter' && f.status === 'loaded',
  ),
}));
check(theme.dark, 'dark theme pinned over a stored "light"');
check(theme.bg === '#0a0a0a', `--bg-subtle is Vault ink (got "${theme.bg}")`);
check(theme.font, 'Geist file loaded under the Inter family');

const firstCustomer = await ctx.request
  .get(`${BACKEND}/admin/customers?limit=1&fields=id`)
  .then((r) => r.json())
  .then((b) => b.customers?.[0]?.id)
  .catch(() => undefined);
const pages = firstCustomer ? [...PAGES, `/customers/${firstCustomer}`] : PAGES;
check(
  Boolean(firstCustomer),
  'found a local customer for the profile screenshot',
);

for (const p of pages) {
  await page.goto(`${ADMIN}${p}`);
  await settle();
  const name = p.slice(1).replace(/[/:]/g, '_') || 'root';
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

await page.goto(`${ADMIN}/settings/users`);
await settle();
check(
  await page
    .locator('[data-testid="sidebar-nav-item-settings-users"]')
    .isVisible(),
  'settings/users still visible (positive control for the hide rules)',
);
for (const id of HIDDEN_SETTINGS) {
  const visible = await page
    .locator(`[data-testid="sidebar-nav-item-settings-${id}"]`)
    .isVisible()
    .catch(() => false);
  check(!visible, `settings/${id} hidden`);
}

check(errors.length === 0, `no page errors (${errors.length})`);
for (const e of errors) console.log(`  ${e}`);
await browser.close();
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`screenshots in ${OUT}`);
```

- [ ] **Step 2: Start the servers.**
  - **Backend:** if nothing answers `http://localhost:9000/health`, start it from the **main checkout**. This branch has no backend change, and the main checkout already has its env file. Run in the background:

```bash
cd <main-checkout>/backend/packages/api && corepack yarn dev
```

- **Admin:** run this branch's dev server on :7000 in the background. If :7000 is already taken by the user's own dev server, ask the user before stopping it, because CORS only allows :7000.

```bash
cd backend/apps/admin && node ../../node_modules/vite/bin/vite.js --port 7000
```

- [ ] **Step 3: Mint a QA session.** Run from the main checkout. Write the token outside the repo, in this session's scratchpad.

```bash
cd <main-checkout>/backend/packages/api && QA_JWT_OUT=<scratchpad>/qa-admin.jwt ./node_modules/.bin/medusa exec ./src/scripts/qa-mint-admin-session.ts
```

Expected: `QA admin session for user … (N role(s)) written to …`.

- [ ] **Step 4: Run the check.**

```bash
QA_JWT_FILE=<scratchpad>/qa-admin.jwt node scripts/qa-admin-vault-p1.mjs
```

Expected: every line `ok`, exit 0. On any `FAIL`:

- **Sidebar order wrong:** compare with the contract test. A core item still showing means its id is missing from `_navigation.ts`.
- **A Settings item still visible:** that Settings entry uses a different `data-testid`. Read it in the browser and fix the selector, keeping the positive control.
- **Theme not dark:** confirm the `index.html` script runs before `/src/main.tsx`.

- [ ] **Step 5: Read the screenshots back** (Read tool on the PNGs in `docs/research/admin-vault-p1/`) and check each against the Review Focus list:
  - text readable on every page, including Settings;
  - no white sprite squares on `/pixel-pokemon`;
  - the active sidebar row raised;
  - the group open with the right child highlighted on child pages.

Fix any token that makes a core page illegible, then rerun Step 4.

- [ ] **Step 6: Restricted-role landing (spec §11).**
  - Creating a throwaway RBAC role needs tooling this repo doesn't have yet (no role-creation script; the QA token copies the user's real roles).
  - If no restricted role can be minted locally, record in the PR that the `redirectTo` path is **code-verified only**: `RoutePermissionGuard` in `@mercurjs/dashboard-shared` uses the deepest declared requirement and navigates to its `redirectTo`. Note too that no restricted human role exists today: humans are `*:*`, desk bots `*:read`.
  - Do not invent a role-creation script in this phase.

- [ ] **Step 7: Stop the servers you started** (by port, `taskkill /T /F` on the PIDs from `netstat -ano`). Never stop the user's own processes.

- [ ] **Step 8: Commit.**

```bash
git add scripts/qa-admin-vault-p1.mjs
git commit -m "test(admin): Playwright check for the Vault Phase 1 sidebar, redirects and theme

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Finish the branch

- [ ] **Step 1: Run the full admin gate one last time** (Task 3 Step 6 commands). All must pass.
- [ ] **Step 2:** Use superpowers:finishing-a-development-branch. The PR description must cover:
  - the "what moved where" table for staff (old label → new place, from spec §6.1);
  - the Phase 1 in-between state (Dashboard opens Stats until Phase 2);
  - the restricted-role note from Task 4 Step 6;
  - the screenshot list.

  Pushing and opening the PR need the user's go-ahead. Auto mode blocks `gh pr merge` (see memory `merge-and-stop-hook-gotchas`).
