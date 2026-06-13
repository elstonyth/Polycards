// Capture the rebuilt CLONE pack-detail page vs ORIG at 1440 + a mobile shot.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
mkdirSync('docs/research/packdetail', { recursive: true });

const SHOTS = [
  ['https://www.phygitals.com/claw/mythic-pack?quantity=1', 'ORIG', 1440, 1100],
  ['http://localhost:4000/claw/pokemon-mythic', 'CLONE', 1440, 1100],
  ['http://localhost:4000/claw/pokemon-mythic', 'CLONE_mobile', 390, 844],
];

const browser = await chromium.launch();
for (const [url, name, w, h] of SHOTS) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 25; i++) {
      const r = await page
        .evaluate(() => document.images.length > 2)
        .catch(() => false);
      if (r) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `docs/research/packdetail/NEW_${name}.png` });
    console.log(`${name} OK`);
  } catch (e) {
    console.log(`${name} FAIL ${e.message}`);
  }
  await ctx.close();
}
await browser.close();
