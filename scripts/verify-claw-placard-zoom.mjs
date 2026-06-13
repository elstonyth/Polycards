// Zoom the LIVE placard zone (lower-left of the machine) at high DSF so "pokenic claw." is legible —
// this is the exact region the user flagged. Confirms the fix on the real served animated AVIF.
import { chromium } from 'playwright';

const SLUGS = [
  ['nba-legend', 'legend-pack-1dpaec'],
  ['nba-platinum', 'modern-grails'],
  ['riftbound-starter', 'riftbound'],
];

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 1500 },
  deviceScaleFactor: 3,
});
for (const [slug, label] of SLUGS) {
  try {
    await page.goto(`http://localhost:4000/claw/${slug}`, {
      waitUntil: 'networkidle',
    });
    await page.waitForTimeout(1000);
    const img = page
      .locator('img[src*="-anim.avif"], img[src*="-machine.webp"]')
      .first();
    await img.waitFor({ state: 'visible', timeout: 8000 });
    const b = await img.boundingBox();
    if (!b) throw new Error('machine bounding box unavailable');
    // placard zone ~ x 0.30-0.56, y 0.70-0.90 of the machine image
    await page.screenshot({
      path: `docs/research/packdetail/livezoom_${slug}.png`,
      clip: {
        x: b.x + 0.28 * b.width,
        y: b.y + 0.7 * b.height,
        width: 0.42 * b.width,
        height: 0.24 * b.height,
      },
    });
    console.log(
      `${slug}\t${label}\tbox=${Math.round(b.width)}x${Math.round(b.height)}`,
    );
  } catch (e) {
    console.log(`${slug}\t${label}\tFAILED — ${e.message}`);
  }
}
await browser.close();
console.log('done');
