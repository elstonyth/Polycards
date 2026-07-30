// capture-slots.mjs — Phase 6 QA: slots catalog + pack-detail render.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';
const OUT = 'tmp/shell-qa';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

await page
  .getByRole('button', { name: 'Accept' })
  .click({ timeout: 4000 })
  .catch(() => {});

await page.goto(BASE + '/slots', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/slots-catalog-phone.png` });
console.log('ok slots catalog captured');

// First pack row → detail page.
const firstRow = page.locator('a[href^="/slots/"]').first();
const href = await firstRow.getAttribute('href');
await page.goto(BASE + href, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/slots-detail-phone.png` });
console.log('ok slots detail captured', href);

await browser.close();
