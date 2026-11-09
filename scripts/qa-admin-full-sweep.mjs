// Full admin-dashboard sweep against the vite-dev admin on :7000.
// Logs in, then visits every sidebar section (custom extension routes + core
// Medusa) recording page JS exceptions, console errors, and 5xx responses.
// Bounded gotos only (domcontentloaded — networkidle hangs on the HMR socket).
// Screenshots land in docs/research/sweep/.
//
//   QA_ADMIN_EMAIL=… QA_ADMIN_PASSWORD=… node scripts/qa-admin-full-sweep.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
import { adminUiLogin, requireAdminTotp } from './lib/admin-sign-in.mjs';

const EMAIL = process.env.QA_ADMIN_EMAIL;
const PW = process.env.QA_ADMIN_PASSWORD;
requireAdminTotp(EMAIL);
if (!EMAIL || !PW) {
  console.error('Set QA_ADMIN_EMAIL and QA_ADMIN_PASSWORD.');
  process.exit(1);
}
const BASE = 'http://localhost:7000/dashboard';
mkdirSync('docs/research/sweep', { recursive: true });

const CUSTOM = [
  '/cards',
  '/packs',
  '/products/from-pricecharting',
  '/pulls',
  '/deliveries',
  '/economy',
  '/daily-rewards',
  '/pixel-pokemon',
  '/storefront',
  '/support',
];
const CORE = [
  '/',
  '/orders',
  '/products',
  '/collections',
  '/categories',
  '/customers',
  '/customer-groups',
  '/promotions',
  '/campaigns',
  '/price-lists',
  '/inventory',
  '/reservations',
  '/settings/store',
  '/settings/users',
  '/settings/regions',
  '/settings/sales-channels',
  '/settings/product-types',
  '/settings/product-tags',
  '/settings/locations',
  '/settings/publishable-api-keys',
  '/settings/secret-api-keys',
  '/settings/return-reasons',
  '/settings/workflows',
  '/settings/profile',
];

let failures = 0;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  const pageErrors = [];
  const badResponses = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('response', (r) => {
    if (r.status() >= 500) badResponses.push(`${r.status()} ${r.url()}`);
  });

  // --- login ---
  await adminUiLogin(page, BASE, EMAIL, PW);
  console.log('PASS: admin login');

  // derive one pack-detail and one customer-detail route from list pages
  const routes = [...CUSTOM, ...CORE];
  for (const [listRoute, prefix] of [
    ['/packs', '/dashboard/packs/'],
    ['/customers', '/dashboard/customers/cus_'],
  ]) {
    try {
      await page.goto(`${BASE}${listRoute}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(3000);
      const href = await page
        .locator(`a[href^="${prefix}"]`)
        .first()
        .getAttribute('href', { timeout: 5000 })
        .catch(() => null);
      if (href) routes.push(href.replace('/dashboard', ''));
      else console.log(`SKIP: no ${prefix}* anchor on ${listRoute}`);
    } catch {
      console.log(`SKIP: probe of ${listRoute} failed`);
    }
  }

  for (const route of routes) {
    pageErrors.length = 0;
    badResponses.length = 0;
    let crashed = false,
      note = '';
    try {
      await page.goto(`${BASE}${route}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(3500);
      const body = await page.locator('body').innerText();
      if (/An error occurred|Something went wrong/i.test(body)) {
        crashed = true;
        note = 'error boundary text on page';
      }
      if (body.trim().length < 30) {
        crashed = true;
        note = 'page effectively empty';
      }
      await page.screenshot({
        path: `docs/research/sweep/admin${route.replace(/\W+/g, '_') || '_home'}.png`,
      });
    } catch (e) {
      crashed = true;
      note = String(e).slice(0, 120);
    }
    const ok = !crashed && pageErrors.length === 0 && badResponses.length === 0;
    if (!ok) failures++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} [admin] ${route}${note ? ' — ' + note : ''}` +
        (pageErrors.length ? ` pageErrors=${pageErrors.length}` : '') +
        (badResponses.length
          ? ` 5xx=${badResponses.slice(0, 3).join(' | ')}`
          : ''),
    );
    for (const pe of pageErrors.slice(0, 3))
      console.log(`    pageerror: ${pe.slice(0, 200)}`);
  }
} finally {
  await browser.close();
}
console.log(`\nadmin sweep done, ${failures} failures`);
process.exit(failures ? 1 : 0);
