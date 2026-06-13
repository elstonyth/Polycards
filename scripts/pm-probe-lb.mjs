// Probe ORIG /leaderboard table header cells (exact case/size/spacing/color) and
// check for a "Weekly Leaderboard" heading on that route. Compare to CLONE.
import { chromium } from 'playwright';

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
  const P = [
    'fontSize',
    'fontWeight',
    'letterSpacing',
    'textTransform',
    'color',
  ];
  // header cells: th, or the first row of a grid/table-like header
  let ths = [...document.querySelectorAll('th')];
  if (!ths.length) {
    // fallback: elements whose text is exactly one of the known headers
    const names = ['name', 'volume', 'claw pulls', 'points', '#'];
    ths = [...document.querySelectorAll('div,span,p')].filter(
      (e) =>
        names.includes(e.textContent.trim().toLowerCase()) &&
        e.children.length === 0,
    );
  }
  const headers = ths
    .slice(0, 6)
    .map((t) => ({ raw: t.textContent.trim(), styles: cs(t, P) }));

  const h = [...document.querySelectorAll('h1,h2,h3')]
    .map((e) => e.textContent.trim())
    .filter(Boolean)
    .slice(0, 8);
  return { headers, headings: h };
};

const browser = await chromium.launch();
const out = {};
for (const [site, origin] of Object.entries(ORIGIN)) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1024 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(origin + '/leaderboard', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    for (let i = 0; i < 22; i++) {
      const r = await page
        .evaluate(
          () =>
            document.querySelectorAll('th').length > 0 ||
            document.images.length > 4,
        )
        .catch(() => false);
      if (r) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1800);
    out[site] = await page.evaluate(EXTRACT);
  } catch (e) {
    out[site] = { error: e.message };
  }
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
