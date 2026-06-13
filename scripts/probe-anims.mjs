// What AMBIENT (infinite-loop) CSS animations does ORIG run per route? These are
// the "alive" motions the clone may lack. Reports distinct animationName ->
// count + duration + a sample element, filtered to infinite iteration.
import { chromium } from 'playwright';

const ROUTES = [
  '/',
  '/claw',
  '/pack-party',
  '/activity',
  '/store',
  '/marketplace',
];
const ORIGIN = 'https://www.phygitals.com';

const EXTRACT = () => {
  const map = {};
  for (const el of document.querySelectorAll('*')) {
    const s = getComputedStyle(el);
    if (!s.animationName || s.animationName === 'none') continue;
    if (s.animationIterationCount !== 'infinite') continue; // ambient only
    const key = s.animationName;
    if (!map[key])
      map[key] = {
        count: 0,
        duration: s.animationDuration,
        sample: (
          el.tagName.toLowerCase() +
          '.' +
          (el.className?.toString().split(' ')[0] || '')
        ).slice(0, 40),
      };
    map[key].count++;
  }
  return map;
};

const browser = await chromium.launch();
for (const route of ROUTES) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(ORIGIN + route, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    for (let i = 0; i < 18; i++) {
      const r = await page
        .evaluate(() => document.images.length > 2)
        .catch(() => false);
      if (r) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(2500);
    const m = await page.evaluate(EXTRACT);
    console.log(`\n=== ${route} (infinite/ambient animations) ===`);
    const keys = Object.keys(m);
    if (!keys.length) console.log('  (none)');
    for (const k of keys)
      console.log(
        `  ${k.padEnd(22)} x${m[k].count}  ${m[k].duration}  e.g. ${m[k].sample}`,
      );
  } catch (e) {
    console.log(`${route} ERR ${e.message}`);
  }
  await ctx.close();
}
await browser.close();
