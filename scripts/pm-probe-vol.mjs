// Verify the leaderboard Volume cell format: ORIG "US$..." vs CLONE "$...".
import { chromium } from 'playwright';
const ORIGIN = {
  ORIG: 'https://www.phygitals.com',
  CLONE: 'http://localhost:4000',
};
const EXTRACT = () => {
  // grab text cells that look like currency
  const cells = [...document.querySelectorAll('td,span,div')]
    .filter(
      (e) => e.children.length === 0 && /\$\s?\d[\d,]*/.test(e.textContent),
    )
    .map((e) => e.textContent.trim())
    .filter((t) => t.length < 24);
  return [...new Set(cells)].slice(0, 8);
};
const browser = await chromium.launch();
const out = {};
for (const [site, origin] of Object.entries(ORIGIN)) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1024 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(origin + '/leaderboard', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    for (let i = 0; i < 22; i++) {
      const r = await page
        .evaluate(
          () =>
            document.querySelectorAll('td').length > 0 ||
            document.images.length > 4,
        )
        .catch(() => false);
      if (r) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1800);
    out[site] = await page.evaluate(EXTRACT);
  } catch (e) {
    out[site] = { error: e.message };
  }
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
