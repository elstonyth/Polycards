// Read-only prod smoke after a dependency deploy. Asserts the storefront is
// serving AND that pack data is really coming back from the backend API --
// a Next build can render a perfectly healthy empty state when the API is
// down, so "page loaded" is not the assertion. No writes, no spin.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'https://polycards.gg';
const OUT = 'docs/research/prod-smoke';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
};

const r = await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
check(r?.status() === 200, 'home 200', `status=${r?.status()}`);
await page
  .getByRole('button', { name: /reject|accept/i })
  .first()
  .click({ timeout: 4000 })
  .catch(() => {});
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/home.png` });

// The real backend assertion: pack links only exist if the catalog API answered.
await page.goto(BASE + '/slots', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(2500);
const packs = await page.$$eval('a[href^="/slots/"]', (els) => [
  ...new Set(els.map((e) => e.getAttribute('href'))),
]);
check(packs.length > 0, 'catalog served packs from the API', `${packs.length} packs`);
await page.screenshot({ path: `${OUT}/slots.png` });

if (packs.length) {
  const slug = packs[0].split('?')[0];
  await page.goto(BASE + slug, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  // Price text proves the detail payload hydrated, not just the shell.
  const hasPrice = await page
    .getByText(/RM\s?[\d,]+/)
    .first()
    .isVisible()
    .catch(() => false);
  check(hasPrice, 'pack detail hydrated with pricing', slug);
  await page.screenshot({ path: `${OUT}/pack-detail.png` });
}

await page.goto(BASE + '/leaderboard', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/leaderboard.png` });

check(errors.length === 0, 'no console/page errors', `${errors.length} found`);
errors.slice(0, 5).forEach((e) => console.log('   ' + e));

await browser.close();
console.log(`\n=== prod smoke: ${failed === 0 ? 'CLEAN' : failed + ' FAILED'} ===`);
process.exit(failed ? 1 : 0);
