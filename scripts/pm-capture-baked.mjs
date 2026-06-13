// Capture baked-rebrand product-shot pages (banner close-up) to confirm seamless.
import { chromium } from 'playwright';
const OUT = 'docs/research/packdetail';
const PACKS = [
  ['pokemon-mythic', 'baked_mythic'],
  ['pokemon-rookie', 'baked_rookie'],
  ['onepiece-legend', 'baked_onepiece'],
  ['yugioh-pro', 'baked_yugioh'],
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
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`${name} OK`);
  } catch (e) {
    console.log(`${name} FAIL ${e.message}`);
  }
  await ctx.close();
}
await browser.close();
