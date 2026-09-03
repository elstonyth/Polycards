// QA: the pixel-Pokémon badge on card slabs — pack rail, Top Hits dialog,
// card-detail overlay. Usage: node scripts/qa-pokemon-badge.mjs [baseUrl]
// Screenshots to docs/research/qa-pokemon-badge-*.png.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';
mkdirSync('docs/research', { recursive: true });

const DIALOG_SEL =
  '[role="dialog"][aria-label="Top Hits"], [role="dialog"][aria-label="All cards"]';
const TILE = 'button[aria-label^="View details for"]';
// A selector LIST doesn't distribute a suffix — prefixing DIALOG_SEL would
// leave the first alternative matching the whole dialog. Distribute by hand.
const DIALOG_TILE_SEL = DIALOG_SEL.split(', ')
  .map((d) => `${d} ${TILE}`)
  .join(', ');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
// Meta Pixel never settles — block it or any networkidle wait hangs.
await ctx.route('**connect.facebook.net**', (r) => r.abort());
const page = await ctx.newPage();

await page.goto(`${BASE}/slots`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const slugs = await page.evaluate(() => [
  ...new Set(
    [...document.querySelectorAll('a[href^="/slots/"]')]
      .map((a) => a.getAttribute('href').replace('/slots/', '').split('?')[0])
      .filter((s) => s && !s.includes('/')),
  ),
]);
console.log(JSON.stringify({ slugs }));

let picked = null;
for (const slug of slugs) {
  await page.goto(`${BASE}/slots/${slug}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const tiles = await page.locator('button[aria-label^="View details for"]').count();
  if (tiles > 0) { picked = slug; break; }
}
if (!picked) throw new Error('no pack renders card tiles');
console.log(JSON.stringify({ picked }));

// 1) The rail on the pack page.
const rail = page.locator('button[aria-label^="View details for"]').first();
await rail.scrollIntoViewIfNeeded();
await page.waitForTimeout(1500);
const badges = await page.locator('button[aria-label^="View details for"] img[src*="sprites"], button[aria-label^="View details for"] img[src*="pokemon"]').count();
console.log(JSON.stringify({ railTiles: await page.locator('button[aria-label^="View details for"]').count(), railBadges: badges }));
await page.screenshot({ path: 'docs/research/qa-pokemon-badge-rail.png' });

// 2) The Top Hits dialog.
await page.locator('button[aria-haspopup="dialog"]').first().click();
await page.waitForSelector(DIALOG_SEL, { timeout: 5000 });
await page.waitForTimeout(2000);
await page.screenshot({ path: 'docs/research/qa-pokemon-badge-dialog.png' });
// One tile on its own — the badge is ~40px on a grid shot, too small to judge.
await page
  .locator(DIALOG_TILE_SEL)
  .first()
  .screenshot({ path: 'docs/research/qa-pokemon-badge-tile.png' });

// 3) The card-detail overlay, opened from a dialog tile.
await page.locator(DIALOG_TILE_SEL).first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: 'docs/research/qa-pokemon-badge-overlay.png' });

await browser.close();
console.log('done');
