// Capture the live rookie + nba-black machine banner at high res to confirm the
// fix on the page (no dark edge streaks, Pokenic centred, phygitals gone).
import { chromium } from 'playwright';
const OUT = 'docs/research/packdetail';
const browser = await chromium.launch();
for (const [slug, name] of [
  ['pokemon-rookie', 'live_rookie_banner'],
  ['nba-black', 'live_nbablack_banner'],
]) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 3,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`http://localhost:4000/claw/${slug}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(2200);
    // find the claw-machine image; clip to its top ~32% (the banner)
    const box = await page.evaluate(() => {
      const im = [...document.querySelectorAll('img')]
        .map((i) => ({ i, r: i.getBoundingClientRect() }))
        .filter((o) => o.r.width > 300 && o.r.top < 700)
        .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
      if (!im) return null;
      const r = im.r;
      return {
        x: Math.round(r.x),
        y: Math.round(r.y + r.height * 0.1),
        w: Math.round(r.width),
        h: Math.round(r.height * 0.3),
      };
    });
    if (box) await page.screenshot({ path: `${OUT}/${name}.png`, clip: box });
    console.log(`${name} ${box ? 'OK' : 'no img'}`);
  } catch (e) {
    console.log(`${name} FAIL ${e.message}`);
  }
  await ctx.close();
}
await browser.close();
