// Verify the CLONE's claw machine actually animates (headed — headless pauses animated AVIF).
// Loads a pack-detail page, confirms it serves -anim.avif, captures the machine at two times,
// and reports whether the pixels changed (claw moved) + saves frames to eyeball.
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const slug = process.argv[2] || 'pokemon-legend';
const OUT = 'docs/research/packdetail';
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
await page.goto(`http://localhost:4000/claw/${slug}`, {
  waitUntil: 'networkidle',
  timeout: 60000,
});
await page.bringToFront();
await page.waitForTimeout(1500);

const img = page.locator('img[alt*="claw machine"]').first();
const src = await img.getAttribute('src');
const box = await img.boundingBox();
const clip = { x: box.x, y: box.y, width: box.width, height: box.height };

await page.screenshot({ path: `${OUT}/clone-anim-a.png`, clip });
await page.waitForTimeout(1600); // ~40 frames at 25fps — claw should have moved
await page.screenshot({ path: `${OUT}/clone-anim-b.png`, clip });
await browser.close();

const md5 = (f) => createHash('md5').update(readFileSync(f)).digest('hex');
const a = md5(`${OUT}/clone-anim-a.png`),
  b = md5(`${OUT}/clone-anim-b.png`);
console.log(`slug=${slug}`);
console.log(`served src = ${src}`);
console.log(
  `frame A md5 ${a.slice(0, 10)} | frame B md5 ${b.slice(0, 10)} | ${a === b ? 'IDENTICAL (NOT animating!)' : 'DIFFERENT (animating ✓)'}`,
);
