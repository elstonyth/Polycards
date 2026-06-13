// Verify a /claw/[slug] detail page renders its REBRANDED claw machine on the live prod server (:4000).
// Screenshots the machine <img> region, reports its src (so you can confirm -anim.avif vs -machine.webp)
// and box size. Pass slugs as args: node scripts/verify-claw-anim.mjs nba-black onepiece-elite ...
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const OUT = 'docs/research/packdetail';
mkdirSync(OUT, { recursive: true });
const slugs = process.argv.slice(2);
if (!slugs.length) {
  console.error('usage: node scripts/verify-claw-anim.mjs <slug...>');
  process.exit(1);
}

const browser = await chromium.launch();
for (const slug of slugs) {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1200 },
    deviceScaleFactor: 1.5,
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/claw/${slug}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const img = page.locator('img[alt*="claw machine"]').first();
  const src = await img.getAttribute('src').catch(() => '?');
  const box = await img.boundingBox().catch(() => null);
  const tag = slug.replace(/[^a-z0-9]+/gi, '_');
  await img.screenshot({ path: `${OUT}/verify_${tag}.png` }).catch(async () => {
    await page.screenshot({ path: `${OUT}/verify_${tag}.png` });
  });
  console.log(
    `${slug}: src=${src} box=${box ? Math.round(box.width) + 'x' + Math.round(box.height) : 'none'}`,
  );
  await ctx.close();
}
await browser.close();
