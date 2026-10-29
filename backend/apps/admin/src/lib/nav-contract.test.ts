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

const configBody = (file: string): string | undefined =>
  readFileSync(file, 'utf8').match(
    /export const config(?::\s*RouteConfig)?\s*=\s*\{([\s\S]*?)\n\};/,
  )?.[1];

const readConfig = (file: string): PageConfig | null => {
  const body = configBody(file);
  if (body === undefined) return null;
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

const allConfigs = pageFiles(ROUTES)
  .map(readConfig)
  .filter((c): c is PageConfig => c !== null);
// Pages under /settings/ live in the Settings layout's own sidebar, not here.
const configs = allConfigs.filter((c) => !c.path.startsWith('/settings/'));
const byRank = (a: PageConfig, b: PageConfig) => (a.rank ?? 0) - (b.rank ?? 0);

type Entry = { path: string; label: string };
type Group = Entry & { children: Entry[] };

// Customer support and Import collection remain children until Phase 3
// merges them.
const GROUPS: Group[] = [
  { path: '/overview', label: 'pcNav.dashboard', children: [] },
  // The AI assistant (2026-10-29): every role that may use it sees it; the
  // conversation review under it is super-admin only.
  {
    path: '/assistant',
    label: 'pcNav.assistant',
    children: [{ path: '/assistant/review', label: 'pcNav.assistantReview' }],
  },
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
  // Top-level since 2026-10-23: the automation operator role sees only this
  // entry, and a nested entry renders only under a visible parent.
  { path: '/automation', label: 'pcNav.automation', children: [] },
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
      // GRN above Purchase invoices: cards arrive before their invoice.
      { path: '/goods-receive-notes', label: 'pcNav.goodsReceiveNotes' },
      { path: '/purchase-invoices', label: 'pcNav.purchaseInvoices' },
      { path: '/procurement', label: 'pcNav.procurement' },
    ],
  },
  {
    path: '/rewards',
    label: 'pcNav.rewards',
    children: [
      { path: '/daily-rewards', label: 'pcNav.vipLevels' },
      { path: '/tasks', label: 'pcNav.tasks' },
      { path: '/challenge', label: 'pcNav.weeklyChallenge' },
      { path: '/lucky-draw', label: 'pcNav.luckyDraw' },
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

// Core list pages replaced by a redirect (spec §6.2). /orders is also the
// post-login landing; /stats was folded into the Dashboard.
const REDIRECTS: [string, string][] = [
  ['/orders', '/overview'],
  ['/stats', '/overview'],
  ['/customers', '/players'],
  ['/reservations', '/inventory/list'],
  ['/products', '/cards'],
  ['/inventory', '/inventory/list'],
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
  it('shows exactly the 10 top-level entries, in order', () => {
    const top = configs.filter((c) => !c.nested).sort(byRank);
    expect(top.map(entry)).toEqual(
      GROUPS.map(({ path, label }) => ({ path, label })),
    );
  });

  it('gates every top-level entry with permissions', () => {
    // The sidebar shows an entry without `permissions` to EVERY role, so one
    // ungated page would appear for the automation operator. Nested entries
    // hide with their parent.
    for (const c of allConfigs.filter((x) => !x.nested)) {
      const body = configBody(join(ROUTES, c.path.slice(1), 'page.tsx'));
      expect(body, c.path).toMatch(/\bpermissions:\s*\[/);
    }
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
    for (const c of allConfigs) {
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

  it('parses every page that declares a config, with an integer rank', () => {
    // The SDK reads `export const config` as literals and ignores a rank that
    // isn't a plain non-negative integer; a page this parser misses would
    // drop out of every assertion above while still showing in the sidebar.
    for (const file of pageFiles(ROUTES)) {
      if (!/\bconst config\b/.test(readFileSync(file, 'utf8'))) continue;
      expect(readConfig(file), routePath(file)).not.toBeNull();
      const rank = configBody(file)
        ?.match(/\brank:\s*([^,\n]+)/)?.[1]
        .trim();
      expect(rank, routePath(file)).toMatch(/^\d+$/);
    }
  });

  it('gives nested entries no icon (the sidebar never renders one)', () => {
    for (const file of pageFiles(ROUTES)) {
      const c = readConfig(file);
      if (!c?.nested) continue;
      expect(configBody(file), c.path).not.toMatch(/\bicon:/);
    }
  });

  it.each(REDIRECTS)('%s redirects to %s', (from, to) => {
    const src = readFileSync(join(ROUTES, from.slice(1), 'page.tsx'), 'utf8');
    expect(src).toContain(`<Navigate to="${to}" replace />`);
    expect(src).not.toMatch(/export const config/);
  });

  it('sends a role without order:read to the same landing page', () => {
    const src = readFileSync(join(ROUTES, 'orders', 'page.tsx'), 'utf8');
    const landing = REDIRECTS.find(([from]) => from === '/orders')?.[1];
    expect(src).toContain(`redirectTo: '${landing}'`);
  });

  it('hides exactly the 15 core sidebar items', () => {
    expect(navigation.items.map((i) => i.id).sort()).toEqual(
      [...CORE_IDS].sort(),
    );
    expect(navigation.items.every((i) => i.hidden === true)).toBe(true);
  });
});
