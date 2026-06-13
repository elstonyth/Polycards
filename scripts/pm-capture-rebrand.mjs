// Verify the Pokenic claw-machine rebrand on an avif machine (mythic), a webp-only
// machine (nba-black = black-pack-jjnfuk), and mobile.
import { chromium } from 'playwright';
const OUT = 'docs/research/packdetail';
const SHOTS = [
  [
    'http://localhost:4000/claw/pokemon-mythic',
    'rebrand_mythic_1440',
    1440,
    900,
  ],
  ['http://localhost:4000/claw/nba-black', 'rebrand_nbablack_1440', 1440, 900],
  ['http://localhost:4000/claw/pokemon-mythic', 'rebrand_mythic_390', 390, 844],
];
const browser = await chromium.launch();
for (const [url, name, w, h] of SHOTS) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2200);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`${name} OK`);
  } catch (e) {
    console.log(`${name} FAIL ${e.message}`);
  }
  await ctx.close();
}
await browser.close();
