// Capture the LIVE pack-detail claw machines (prod server :4000) FULL-HEIGHT, so the lower placard
// ("pokenic claw.") + url are visible — this is the zone the user flagged. Screenshots the actual
// rendered <img> (the animated AVIF when present). Reads back with the Read tool.
import { chromium } from 'playwright';

const SLUGS = [
  ['nba-legend', 'legend-pack-1dpaec (placard re-pinned)'],
  ['nba-platinum', 'modern-grails (placard re-pinned)'],
  ['riftbound-starter', 'riftbound (placard re-pinned)'],
  ['soccer-pro', 'pro-soccer (unchanged ref)'],
];

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1500 },
  deviceScaleFactor: 1.5,
});
for (const [slug, label] of SLUGS) {
  await page.goto(`http://localhost:4000/claw/${slug}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(1000);
  const img = page
    .locator('img[src*="-anim.avif"], img[src*="-machine.webp"]')
    .first();
  const shot = `docs/research/packdetail/live_${slug}.png`;
  try {
    await img.waitFor({ state: 'visible', timeout: 8000 });
    const src = await img.getAttribute('src');
    const box = await img.boundingBox();
    await page.screenshot({
      path: shot,
      clip: {
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        width: box.width,
        height: box.height,
      },
    });
    console.log(`${slug}\t${label}\tsrc=${src}`);
  } catch (e) {
    await page.screenshot({ path: shot, fullPage: false });
    console.log(`${slug}\t${label}\tFALLBACK(full-page) — ${e.message}`);
  }
}
await browser.close();
console.log('done');
