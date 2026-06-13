// Confirm whether the "Recent Pulls" row auto-scrolls (marquee) on ORIG vs CLONE.
// Scrolls the section into view, measures the first pull card's x at t0 and t=2.5s.
import { chromium } from 'playwright';

const SITES = {
  ORIG: 'https://www.phygitals.com/',
  CLONE: 'http://localhost:4000/',
};

const SCROLL_TO_PULLS = () => {
  const h = [...document.querySelectorAll('h2,h3,p')].find((e) =>
    /recent pulls/i.test(e.textContent),
  );
  if (h) h.scrollIntoView({ block: 'center' });
  return !!h;
};
// x of the first card-like child in the recent-pulls row
const FIRST_CARD_X = () => {
  const h = [...document.querySelectorAll('h2,h3,p')].find((e) =>
    /recent pulls/i.test(e.textContent),
  );
  if (!h) return null;
  // find the nearest following horizontal flex row with several children
  let row = null;
  let node = h.parentElement;
  for (let up = 0; up < 5 && node; up++, node = node.parentElement) {
    const cand = [...node.querySelectorAll('div')].find((d) => {
      const s = getComputedStyle(d);
      return (
        s.display === 'flex' &&
        d.children.length >= 4 &&
        d.getBoundingClientRect().width > 600
      );
    });
    if (cand) {
      row = cand;
      break;
    }
  }
  if (!row) return null;
  const first = row.children[0];
  return Math.round(first.getBoundingClientRect().left * 100) / 100;
};

const browser = await chromium.launch();
for (const [name, url] of Object.entries(SITES)) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 20; i++) {
      const r = await page
        .evaluate(() => document.images.length > 3)
        .catch(() => false);
      if (r) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(2000);
    await page.evaluate(SCROLL_TO_PULLS);
    await page.waitForTimeout(800);
    const x0 = await page.evaluate(FIRST_CARD_X);
    await page.waitForTimeout(2500);
    const x1 = await page.evaluate(FIRST_CARD_X);
    const moved = x0 != null && x1 != null ? Math.abs(x1 - x0) : 'n/a';
    console.log(
      `${name}: x0=${x0}  x1=${x1}  movedPx=${moved}  ${typeof moved === 'number' && moved > 2 ? '→ AUTO-SCROLLS' : '→ static'}`,
    );
  } catch (e) {
    console.log(`${name} ERR ${e.message}`);
  }
  await ctx.close();
}
await browser.close();
