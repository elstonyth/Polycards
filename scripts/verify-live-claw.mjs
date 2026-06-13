// Capture the LIVE pack-detail claw machine (prod server :4000) for visual recheck.
// Screenshots the actual rendered <img> so we see exactly what the browser serves —
// not a disk webp, not a number. Reads back with the Read tool.
import { chromium } from 'playwright';

const SLUGS = [
  ['nba-platinum', 'modern-grails (de-blurred)'],
  ['pokemon-platinum', 'platinum (de-blurred)'],
  ['nba-black', 'black-pack (de-blurred)'],
];

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1200 },
  deviceScaleFactor: 1.5,
});
for (const [slug, label] of SLUGS) {
  await page.goto(`http://localhost:4000/claw/${slug}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(900);
  const img = page.locator('img[src*="-machine.webp"]').first();
  let shot = `docs/research/packdetail/live_${slug}.png`;
  try {
    await img.waitFor({ state: 'visible', timeout: 6000 });
    const src = await img.getAttribute('src');
    const box = await img.boundingBox();
    // crop to the banner zone (upper ~32% of the machine) at full image width
    await page.screenshot({
      path: shot,
      clip: {
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        width: box.width,
        height: box.height * 0.34,
      },
    });
    console.log(`${slug}\t${label}\tsrc=${src}`);
  } catch (e) {
    await page.screenshot({ path: shot, fullPage: false });
    console.log(
      `${slug}\t${label}\tNO machine img (full-page fallback) — ${e.message}`,
    );
  }
}
await browser.close();
console.log('done');
