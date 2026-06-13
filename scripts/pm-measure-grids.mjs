// Measure the card/pack GRID density on ORIG vs CLONE for /claw and /marketplace.
// Finds the largest grid/flex-wrap container with many similar children and reports
// column count (distinct x in first row), card width, gap, and gridTemplateColumns.
import { chromium } from 'playwright';

const ROUTES = ['/claw', '/marketplace'];
const ORIGIN = {
  ORIG: 'https://www.phygitals.com',
  CLONE: 'http://localhost:4000',
};

const EXTRACT = () => {
  const cs = (el, props) => {
    const s = getComputedStyle(el);
    const o = {};
    props.forEach((p) => (o[p] = s[p]));
    return o;
  };
  // candidate containers: many children, children roughly equal width, arranged in rows
  const all = [...document.querySelectorAll('div, ul, section')];
  let best = null,
    bestScore = 0;
  for (const el of all) {
    const kids = [...el.children];
    if (kids.length < 4) continue;
    const rects = kids
      .map((k) => k.getBoundingClientRect())
      .filter((r) => r.width > 80 && r.height > 80);
    if (rects.length < 4) continue;
    const widths = rects.map((r) => Math.round(r.width));
    const wmode = widths
      .sort(
        (a, b) =>
          widths.filter((x) => x === a).length -
          widths.filter((x) => x === b).length,
      )
      .pop();
    const sameW = rects.filter(
      (r) => Math.abs(Math.round(r.width) - wmode) < 4,
    ).length;
    const score = sameW; // more equal-width children = more grid-like
    if (score > bestScore && sameW >= 4) {
      bestScore = score;
      best = { el, rects, kids };
    }
  }
  if (!best) return 'NO GRID';
  const { el, rects } = best;
  // columns = number of children sharing the minimum top (first row)
  const minTop = Math.min(...rects.map((r) => r.top));
  const firstRow = rects
    .filter((r) => Math.abs(r.top - minTop) < 8)
    .sort((a, b) => a.left - b.left);
  const cols = firstRow.length;
  const cardW = Math.round(firstRow[0].width);
  const gapX =
    firstRow.length > 1
      ? Math.round(firstRow[1].left - firstRow[0].right)
      : null;
  return {
    container: cs(el, [
      'display',
      'gridTemplateColumns',
      'gap',
      'columnGap',
      'rowGap',
      'padding',
      'maxWidth',
      'width',
    ]),
    containerRect: {
      w: Math.round(el.getBoundingClientRect().width),
      left: Math.round(el.getBoundingClientRect().left),
    },
    columns: cols,
    cardWidth: cardW,
    gapX,
    totalChildren: best.kids.length,
  };
};

const browser = await chromium.launch();
const out = {};
for (const route of ROUTES) {
  out[route] = {};
  for (const [site, origin] of Object.entries(ORIGIN)) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 1024 },
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    try {
      await page.goto(origin + route, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      for (let i = 0; i < 22; i++) {
        const r = await page
          .evaluate(() => document.images.length > 4)
          .catch(() => false);
        if (r) break;
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(2000);
      out[route][site] = await page.evaluate(EXTRACT);
    } catch (e) {
      out[route][site] = { error: e.message };
    }
    await ctx.close();
  }
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
