// Capture the FULL claw machine (live, :4000) as an element screenshot — to audit ALL
// phygitals instances (banner + side rails + bottom base), not just the banner.
import { chromium } from 'playwright';

const SLUGS = [
  ['riftbound-starter', 'riftbound'],
  ['pokemon-mythic', 'mythic'],
  ['pokemon-elite', 'elite'],
  ['pokemon-legend', 'legend'],
  ['nba-platinum', 'modern-grails'],
  ['soccer-pro', 'pro-soccer'],
];
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1400 },
  deviceScaleFactor: 2,
});
await page.emulateMedia({ reducedMotion: 'reduce' });
for (const [slug, label] of SLUGS) {
  await page.goto(`http://localhost:4000/claw/${slug}`, {
    waitUntil: 'networkidle',
  });
  await page.addStyleTag({
    content:
      '*{animation:none!important;transition:none!important;transform:none!important}',
  });
  await page.waitForTimeout(500);
  const img = page.locator('img[src*="-machine.webp"]').first();
  try {
    await img.waitFor({ state: 'visible', timeout: 6000 });
    const box = await img.boundingBox();
    await page.screenshot({
      path: `docs/research/packdetail/full_${slug}.png`,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
    });
    console.log(`${slug} (${label}) ok`);
  } catch (e) {
    console.log(`${slug} (${label}) FAIL ${e.message}`);
  }
}
await browser.close();
console.log('done');
