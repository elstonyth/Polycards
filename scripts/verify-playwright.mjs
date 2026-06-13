// Independent verification in clean, cacheless browsers (Chromium + Firefox).
// Proves whether the clone renders correctly outside the user's cached Chrome.
// Run from storefront root: node scripts/verify-playwright.mjs
import { chromium, firefox } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const URL = 'http://localhost:4000/';
const OUT = path.join(process.cwd(), 'docs', 'playwright');
fs.mkdirSync(OUT, { recursive: true });

async function run(name, type) {
  const browser = await type.launch();
  // Fresh context = no cache, no cookies, no extensions, no stored state.
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  const failed = [];
  page.on('requestfailed', (r) => {
    if (/\.(webp|png|jpg|jpeg)/.test(r.url())) failed.push(r.url());
  });

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });

  // Scroll through to trigger every lazy image, then settle.
  await page.evaluate(async () => {
    const h = document.body.scrollHeight;
    for (let y = 0; y <= h; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 150));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(2500);

  const imgStats = await page.evaluate(() => {
    const imgs = [...document.images];
    const broken = imgs.filter((x) => x.complete && x.naturalWidth === 0);
    return {
      total: imgs.length,
      loaded: imgs.filter((x) => x.complete && x.naturalWidth > 0).length,
      pending: imgs.filter((x) => !x.complete).length,
      broken: broken.length,
      brokenSrcs: broken.map((x) => {
        try {
          return new URL(x.src).pathname;
        } catch {
          return '?';
        }
      }),
    };
  });

  // Full-page screenshot + a hero-only crop.
  const full = path.join(OUT, `${name}-fullpage.png`);
  await page.screenshot({ path: full, fullPage: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  const hero = path.join(OUT, `${name}-hero.png`);
  await page.screenshot({ path: hero });

  await browser.close();
  return { name, imgStats, requestFailed: failed, full, hero };
}

const results = [];
for (const [name, type] of [
  ['chromium', chromium],
  ['firefox', firefox],
]) {
  try {
    results.push(await run(name, type));
  } catch (e) {
    results.push({ name, error: String(e) });
  }
}

console.log(JSON.stringify(results, null, 2));
