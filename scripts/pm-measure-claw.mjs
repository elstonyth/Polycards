// Measure the /claw pack-card grid precisely by anchoring on the "Open" button
// each pack card contains, then inspecting its grid parent. Also card height on
// /marketplace (anchoring on price cells) to confirm the vertical-density gap.
import { chromium } from 'playwright';

const ORIGIN = {
  ORIG: 'https://www.phygitals.com',
  CLONE: 'http://localhost:4000',
};

const CLAW = () => {
  const cs = (el, props) => {
    const s = getComputedStyle(el);
    const o = {};
    props.forEach((p) => (o[p] = s[p]));
    return o;
  };
  // Find "Open" buttons (pack cards). Climb to the card = the grid's direct child.
  const opens = [...document.querySelectorAll('button, a, span')].filter(
    (e) => e.textContent.trim().toLowerCase() === 'open',
  );
  if (!opens.length) return 'NO OPEN BUTTONS';
  // the grid is a common ancestor that has many of these
  const card = opens[0].closest('[class]');
  // climb until parent has >=4 children that each contain an Open button
  let node = opens[0];
  let grid = null,
    cardEl = null;
  for (let i = 0; i < 8 && node.parentElement; i++) {
    const p = node.parentElement;
    const kidsWithOpen = [...p.children].filter(
      (c) =>
        [...c.querySelectorAll('button,a,span')].some(
          (b) => b.textContent.trim().toLowerCase() === 'open',
        ) || c.textContent.trim().toLowerCase() === 'open',
    );
    if (kidsWithOpen.length >= 4) {
      grid = p;
      cardEl = node;
      break;
    }
    node = p;
  }
  if (!grid) return 'NO GRID FOUND';
  const kids = [...grid.children].map((k) => k.getBoundingClientRect());
  const minTop = Math.min(...kids.map((r) => r.top));
  const firstRow = kids
    .filter((r) => Math.abs(r.top - minTop) < 10)
    .sort((a, b) => a.left - b.left);
  return {
    container: cs(grid, [
      'display',
      'gridTemplateColumns',
      'gap',
      'columnGap',
      'rowGap',
      'flexWrap',
      'width',
    ]),
    columns: firstRow.length,
    cardWidth: Math.round(firstRow[0].width),
    cardHeight: Math.round(cardEl.getBoundingClientRect().height),
    gapX:
      firstRow.length > 1
        ? Math.round(firstRow[1].left - firstRow[0].right)
        : null,
  };
};

const MKT_CARD_H = () => {
  // marketplace: a card contains a price like $NN.NN; report its card height
  const priceEls = [...document.querySelectorAll('*')].filter(
    (e) => /^\$?US?\$?\d/.test(e.textContent.trim()) && e.children.length === 0,
  );
  if (!priceEls.length) return null;
  // climb to a card-sized ancestor (height 200-520)
  let node = priceEls[0];
  for (let i = 0; i < 8 && node.parentElement; i++) {
    const h = node.getBoundingClientRect().height;
    if (h >= 200 && h <= 560 && node.getBoundingClientRect().width < 360)
      return Math.round(h);
    node = node.parentElement;
  }
  return null;
};

const browser = await chromium.launch();
const out = {};
for (const [site, origin] of Object.entries(ORIGIN)) {
  out[site] = {};
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1024 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(origin + '/claw', {
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
    await page.waitForTimeout(2200);
    out[site].claw = await page.evaluate(CLAW);
    await page.goto(origin + '/marketplace', {
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
    await page.waitForTimeout(2200);
    out[site].marketplaceCardHeight = await page.evaluate(MKT_CARD_H);
  } catch (e) {
    out[site].error = e.message;
  }
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
