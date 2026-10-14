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
  '/' + relative(ROUTES, file).replace(/\\/g, '/').replace(/\/?page\.tsx$/, '');

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
  'orders', 'products', 'offers', 'collections', 'categories', 'inventory',
  'reservations', 'customers', 'customer-groups', 'promotions', 'campaigns',
  'price-lists', 'stores', 'reviews', 'payouts',
];

const lookup = (key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>(
      (o, k) =>
        o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined,
      en,
    );

const entry = (c: PageConfig): Entry => ({ path: c.path, label: c.label ?? '' });

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
      expect(typeof lookup(c.label ?? ''), `${c.path}: ${c.label}`).toBe('string');
    }
  });

  it('sends each label-only group to its first page', () => {
    for (const g of GROUPS.filter((x) => STUBS.includes(x.path))) {
      const src = readFileSync(join(ROUTES, g.path.slice(1), 'page.tsx'), 'utf8');
      expect(src).toContain(`<Navigate to="${g.children[0].path}" replace />`);
    }
  });

  it('hides exactly the 15 core sidebar items', () => {
    expect(navigation.items.map((i) => i.id).sort()).toEqual([...CORE_IDS].sort());
    expect(navigation.items.every((i) => i.hidden === true)).toBe(true);
  });
});
