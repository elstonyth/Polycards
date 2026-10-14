// Phase 1 check for the Vault admin redesign
// (docs/superpowers/plans/2026-10-14-admin-vault-phase1.md, Task 4).
// Logs in with a QA token (see qa-stats-shot.mjs), checks the sidebar, the
// redirects, the Geist font and the Settings clean-up,
// and screenshots every custom page plus the kept Settings pages.
// Requires the backend on :9000 and this branch's admin dev server on :7000.
//
// Usage: QA_JWT_FILE=/path/qa-admin.jwt [OUT=dir] [ADMIN_URL=http://localhost:7001 QA_NO_CORS=1] node scripts/qa-admin-vault-p1.mjs
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
  ['/', '/overview'],
  ['/orders', '/overview'],
  ['/stats', '/overview'],
  ['/customers', '/players'],
  ['/reservations', '/inventory/list'],
  ['/products', '/cards'],
  ['/inventory', '/inventory/list'],
  ['/payments', '/withdrawals'],
  ['/rewards', '/daily-rewards'],
  ['/site', '/announcements'],
];
const PAGES = [
  '/overview',
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

// QA_NO_CORS=1 lets a worktree's admin run beside the usual one on another
// port: the local backend's admin CORS allows :7000 only. Test browser only.
const browser = await chromium.launch({
  args: process.env.QA_NO_CORS ? ['--disable-web-security'] : [],
});
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
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

await page.goto(`${ADMIN}/overview`);
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

const geistLoaded = await page.evaluate(() =>
  [...document.fonts].some(
    (f) => f.family.replace(/["']/g, '') === 'Inter' && f.status === 'loaded',
  ),
);
check(geistLoaded, 'Geist file loaded under the Inter family');

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

// Dashboard: every section renders and none shows its load error.
await page.goto(`${ADMIN}/overview`);
await settle();
await page.waitForTimeout(1500);
for (const heading of [
  'Dashboard',
  'Money in vs money out',
  'Needs your attention',
  'Referral commission per week',
  'Latest payments',
]) {
  check(
    await page.getByText(heading, { exact: true }).first().isVisible(),
    `dashboard shows "${heading}"`,
  );
}
check(
  (await page.getByText("Couldn't load this section.").count()) === 0,
  'no dashboard section failed to load',
);
await page.screenshot({ path: `${OUT}/overview-light.png`, fullPage: true });

// The same page in Medusa's dark theme (the operator's own choice).
const dark = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: 'dark',
});
await dark.addInitScript(() =>
  localStorage.setItem('medusa_admin_theme', 'dark'),
);
await dark.request.post(`${BACKEND}/auth/session`, {
  headers: { authorization: `Bearer ${token}` },
});
const darkPage = await dark.newPage();
await darkPage.goto(`${ADMIN}/overview`);
await darkPage.waitForSelector('nav', { timeout: 60000 });
await darkPage.waitForTimeout(3000);
await darkPage.screenshot({ path: `${OUT}/overview-dark.png`, fullPage: true });
await dark.close();

check(errors.length === 0, `no page errors (${errors.length})`);
for (const e of errors) console.log(`  ${e}`);
await browser.close();
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`screenshots in ${OUT}`);
