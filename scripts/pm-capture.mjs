// Pixel-match capture: ORIG (live phygitals.com) vs CLONE (localhost:4000).
// For each width, captures the hero (scroll 0) and one viewport below it.
// Handles the live site's INNER scroll container (main.overflow-y-auto) — the
// window does not scroll on phygitals, so fullPage / window.scrollTo are useless.
// Saves to docs/research/pixelmatch/{site}_{w}_{pos}.png — read PNGs back with Read.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'docs/research/pixelmatch';
mkdirSync(OUT, { recursive: true });

const SITES = [
  ['https://www.phygitals.com/', 'ORIG'],
  ['http://localhost:4000/', 'CLONE'],
];
const VIEWPORTS = [
  { w: 1440, h: 1024, tag: '1440' },
  { w: 768, h: 1024, tag: '768' },
  { w: 390, h: 844, tag: '390' },
];

// Find the real scroll container and scroll it by dy; returns the new scrollTop.
const SCROLL_FN = (dy) => {
  const cands = [document.scrollingElement, ...document.querySelectorAll('*')];
  let best = null,
    bestH = 0;
  for (const el of cands) {
    if (!el) continue;
    const oy = getComputedStyle(el).overflowY;
    const scrollable =
      el === document.scrollingElement || oy === 'auto' || oy === 'scroll';
    if (scrollable && el.scrollHeight - el.clientHeight > bestH) {
      bestH = el.scrollHeight - el.clientHeight;
      best = el;
    }
  }
  if (!best) return 0;
  best.scrollTop = dy;
  return best.scrollTop;
};

const browser = await chromium.launch();
const log = [];

for (const [url, site] of SITES) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.w, height: vp.h },
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // wait for real content / images to populate (heavy SPA on ORIG)
      for (let i = 0; i < 25; i++) {
        const ready = await page
          .evaluate(() => document.images.length > 3)
          .catch(() => false);
        if (ready) break;
        await page.waitForTimeout(600);
      }
      await page.waitForTimeout(2200);

      // hero (top)
      await page.evaluate(SCROLL_FN, 0);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/${site}_${vp.tag}_hero.png` });

      // one viewport below the fold
      const got = await page.evaluate(SCROLL_FN, Math.round(vp.h * 0.92));
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${OUT}/${site}_${vp.tag}_below.png` });

      log.push(`${site} ${vp.tag}px  OK  scrolledTo=${got}`);
    } catch (e) {
      log.push(`${site} ${vp.tag}px  FAIL  ${e.message}`);
    }
    await ctx.close();
  }
}

await browser.close();
console.log(log.join('\n'));
console.log('done');
