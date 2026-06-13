// 4K legibility check: render each /claw/[slug] at a 3840 viewport (machine ~2243px wide) and screenshot
// the machine <img> at full detail, so the bottom brand zones (url / placard / badge) can be read at the
// largest size the page ever shows. Catches any phygitals residue that is sub-pixel at 1440 but legible at
// 4K. node scripts/verify-claw-4k.mjs <slug...>
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const OUT = 'docs/research/packdetail/4k';
mkdirSync(OUT, { recursive: true });
const slugs = process.argv.slice(2);

const browser = await chromium.launch();
for (const slug of slugs) {
  const ctx = await browser.newContext({
    viewport: { width: 3840, height: 2160 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/claw/${slug}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const img = page.locator('img[alt*="claw machine"]').first();
  const box = await img.boundingBox().catch(() => null);
  const tag = slug.replace(/[^a-z0-9]+/gi, '_');
  await img.screenshot({ path: `${OUT}/4k_${tag}.png` }).catch(async () => {
    await page.screenshot({ path: `${OUT}/4k_${tag}.png` });
  });
  console.log(
    `${slug}: machine box=${box ? Math.round(box.width) + 'x' + Math.round(box.height) : 'none'}`,
  );
  await ctx.close();
}
await browser.close();
