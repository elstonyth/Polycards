// Batch-recon the Wave 3 live pages: dump heading/button/image structure so we
// build faithful clones instead of guessing. Output: docs/research/wave3-recon.json
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const ROUTES = [
  '/lucky-draw',
  '/roulette',
  '/repacks',
  '/clawmaker',
  '/store',
  '/free',
  '/fairness',
];
const browser = await chromium.launch();
const out = {};

for (const route of ROUTES) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  try {
    await page
      .goto('https://www.phygitals.com' + route, {
        waitUntil: 'domcontentloaded',
        timeout: 25000,
      })
      .catch(() => {});
    await page.waitForTimeout(3500);
    out[route] = await page.evaluate((r) => {
      const main = document.querySelector('main') || document.body;
      const redirected = !location.pathname.includes(r.replace(/^\//, ''))
        ? location.pathname
        : null;
      const h = (s) =>
        [...main.querySelectorAll(s)]
          .map((e) => e.textContent.trim())
          .filter(Boolean)
          .slice(0, 8);
      const btns = [
        ...new Set(
          [...main.querySelectorAll('button,a')]
            .map((b) => b.textContent.trim())
            .filter((t) => t && t.length > 1 && t.length < 26),
        ),
      ].slice(0, 20);
      const imgs = [...main.querySelectorAll('img')]
        .filter((i) => i.naturalWidth > 60)
        .map((i) =>
          (i.currentSrc || i.src).replace(/^https?:\/\/[^/]+/, '').slice(0, 80),
        )
        .filter((s) => !/mergedwhite|logowhite/.test(s))
        .slice(0, 6);
      const prices = (main.textContent.match(/\$[\d,.]+/g) || []).slice(0, 6);
      const para = h('p')
        .filter((t) => t.length > 25)
        .slice(0, 4);
      return {
        redirected,
        h1: h('h1'),
        h2: h('h2'),
        buttons: btns,
        paragraphs: para,
        sampleImgs: [...new Set(imgs)],
        prices,
      };
    }, route);
  } catch (e) {
    out[route] = { error: e.message };
  }
  await page.close();
}
await browser.close();
writeFileSync('docs/research/wave3-recon.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
