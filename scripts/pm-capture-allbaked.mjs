// Verify the rebrand on live pages: 4 dramatic phygitals packs + product-shot regression.
import { chromium } from 'playwright';
const OUT = 'docs/research/packdetail';
const PACKS = [
  ['nba-black', 'live_nbablack'],
  ['nba-legend', 'live_nbalegend'],
  ['nba-platinum', 'live_nbaplat'],
  ['soccer-pro', 'live_soccerpro'],
  ['pokemon-mythic', 'live_mythic2'],
];
const browser = await chromium.launch();
for (const [slug, name] of PACKS) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`http://localhost:4000/claw/${slug}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(2200);
    await page.screenshot({
      path: `${OUT}/${name}.png`,
      clip: { x: 0, y: 100, width: 760, height: 560 },
    });
    console.log(`${name} OK`);
  } catch (e) {
    console.log(`${name} FAIL ${e.message}`);
  }
  await ctx.close();
}
await browser.close();
