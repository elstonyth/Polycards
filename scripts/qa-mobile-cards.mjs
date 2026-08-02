// Mobile verification (390x844 phone viewport):
//  1. vault grid = 3-up, tiles compact (needs scripts/.dev-logins + backend)
//  2. pack "Rare & above" rail — distinct tile x positions = cards visible
//     across the viewport (it's a horizontal rail now, not the old 3-up grid)
//  3. card-detail overlay fits the viewport WITHOUT scrolling
// Usage: node scripts/qa-mobile-cards.mjs [baseUrl]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';
const OUT = process.env.OUT_DIR ?? '.';
mkdirSync(OUT, { recursive: true });
const kv = Object.fromEntries(
  readFileSync(path.join(process.cwd(), 'scripts', '.dev-logins'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [
      l.slice(0, l.indexOf('=')).trim(),
      l.slice(l.indexOf('=') + 1).trim(),
    ]),
);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

// login (needed for vault)
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
const loginBtn = page
  .locator('header')
  .getByRole('button', { name: /^login$/i });
await loginBtn.waitFor({ state: 'visible', timeout: 60000 });
await loginBtn.click();
const email = page.locator('input[name="email"]');
await email.waitFor({ state: 'visible', timeout: 20000 });
await email.fill(kv.CUST_EMAIL || 'test@polycards.app');
await page.fill('input[name="password"]', kv.CUST_PW);
await page.keyboard.press('Enter');
await loginBtn.waitFor({ state: 'detached', timeout: 20000 });
console.log('login: ok');

// 1. vault
await page.goto(`${BASE}/vault`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const firstTile = page
  .locator('button[aria-label^="View details for"]')
  .first();
await firstTile.waitFor({ state: 'visible', timeout: 15000 });
const tileBox = await firstTile
  .locator('..')
  .locator('..')
  .boundingBox()
  .catch(() => null);
const tiles = await page
  .locator('button[aria-label^="View details for"]')
  .evaluateAll((els) =>
    els.slice(0, 4).map((e) => {
      const tile = e.closest('div.relative')?.parentElement ?? e;
      const r = tile.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width) };
    }),
  );
const rowXs = new Set(tiles.map((t) => t.x));
console.log(
  `vault: first-row tile xs=${[...rowXs].join(',')} (3-up = 3 distinct x) width≈${tiles[0]?.w}`,
);
await page.screenshot({ path: `${OUT}/vault-mobile.png`, fullPage: false });

// 2. pack pool rail ("Rare & above" normally, "All cards" for zero-Rare packs)
await page.goto(`${BASE}/slots/bronze-pack`, {
  waitUntil: 'networkidle',
});
await page.waitForTimeout(1000);
const heading = page.getByRole('heading', {
  name: /^(Rare & above|All cards)$/,
});
await heading.scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
const poolTiles = await page
  .locator('button[aria-label^="View details for"]')
  .evaluateAll((els) => {
    const xs = els.map((e) => Math.round(e.getBoundingClientRect().x));
    return [...new Set(xs)].filter((x) => x >= 0);
  });
console.log(`pack rail: distinct tile x positions=${poolTiles.length}`);
await page.screenshot({ path: `${OUT}/pack-pool-mobile.png` });

// 3. overlay fits without scroll
await page.locator('button[aria-label^="View details for"]').first().click();
await page.waitForTimeout(2000);
const dialog = page.locator('[role="dialog"][aria-modal="true"]').last();
const metrics = await page.evaluate(() => {
  const scroller = document.querySelector('.fixed.inset-0.overflow-y-auto');
  return scroller
    ? {
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        overflow: scroller.scrollHeight - scroller.clientHeight,
      }
    : null;
});
console.log(
  'overlay scroll metrics:',
  JSON.stringify(metrics),
  metrics && metrics.overflow <= 0
    ? '— fits, NO SCROLL: PASS'
    : '— SCROLLS: FAIL',
);
await page.screenshot({ path: `${OUT}/overlay-mobile.png` });
void dialog;
await browser.close();
