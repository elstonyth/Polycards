// Verify the black-pack + diamond-pack premium claw machines render their REBRANDED animated AVIF on
// the live prod server (:4000). Screenshots the machine <img> region on each detail page at 1440.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const OUT = 'docs/research/packdetail';
mkdirSync(OUT, { recursive: true });
const PAGES = [
  ['pokemon-black', 'black'],
  ['pokemon-diamond', 'diamond'],
];

const browser = await chromium.launch();
for (const [slug, tag] of PAGES) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/claw/${slug}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const img = page.locator('img[alt*="claw machine"]').first();
  const src = await img.getAttribute('src').catch(() => '?');
  const box = await img.boundingBox().catch(() => null);
  await img
    .screenshot({ path: `${OUT}/live_premium_${tag}.png` })
    .catch(async () => {
      await page.screenshot({ path: `${OUT}/live_premium_${tag}.png` });
    });
  console.log(
    `${tag}: src=${src} box=${box ? Math.round(box.width) + 'x' + Math.round(box.height) : 'none'}`,
  );
  await ctx.close();
}
await browser.close();
