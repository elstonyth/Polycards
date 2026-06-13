// Verify the DOM text overlay on the claw machine: per slug, screenshot the whole machine AND a
// zoomed crop of the placard zone, so we can confirm "pokenic claw."/"pokenic.com" is crisp, correctly
// sized, correctly positioned, and NOT overlapping the Mew / "?" / other baked art. Headless is fine
// (DOM text renders; the placard zone of the AVIF is static). Prod server must be on :4000.
//   node scripts/verify-overlay.mjs
import { chromium } from 'playwright';

const OUT = 'docs/research/packdetail';
const SLUGS = [
  'pokemon-mythic',
  'nba-legend',
  'soccer-pro',
  'riftbound-starter',
  'nba-black',
];
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 2400, height: 1500 },
  deviceScaleFactor: 2,
});

for (const slug of SLUGS) {
  await page.goto(`http://localhost:4000/claw/${slug}`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  });
  await page.waitForTimeout(800);
  const img = page.locator('img[alt*="claw machine"]').first();
  const src = await img.getAttribute('src');
  const box = await img.boundingBox();
  if (!box) {
    console.log(`${slug}: NO machine img`);
    continue;
  }
  await page.screenshot({ path: `${OUT}/ov_${slug}.png`, clip: box });
  // zoom the placard zone (≈ x 30–55%, y 70–95% of the machine box)
  const z = {
    x: box.x + 0.3 * box.width,
    y: box.y + 0.7 * box.height,
    width: 0.3 * box.width,
    height: 0.26 * box.height,
  };
  await page.screenshot({ path: `${OUT}/ov_${slug}_placard.png`, clip: z });
  console.log(
    `${slug}: src=${src?.split('/').pop()}  box=${Math.round(box.width)}x${Math.round(box.height)}`,
  );
}
await browser.close();
console.log('done');
