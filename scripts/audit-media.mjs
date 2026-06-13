// Media/animation audit: for each public route, enumerate <video>, <canvas>,
// visible <iframe>, lottie players, and autoplaying CSS animations on ORIG vs CLONE.
// Flags routes where ORIG has media the CLONE is missing.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const ROUTES = [
  '/',
  '/claw',
  '/marketplace',
  '/leaderboard',
  '/how-it-works',
  '/pack-party',
  '/activity',
  '/series',
  '/lucky-draw',
  '/roulette',
  '/repacks',
  '/store',
  '/free',
  '/clawmaker',
  '/fairness',
];
const ORIGIN = {
  ORIG: 'https://www.phygitals.com',
  CLONE: 'http://localhost:4000',
};

const EXTRACT = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8;
  };
  const videos = [...document.querySelectorAll('video')]
    .filter(vis)
    .map((v) => ({
      src: (v.currentSrc || v.src || v.querySelector('source')?.src || '')
        .split('/')
        .slice(-1)[0],
      autoplay: v.autoplay,
      loop: v.loop,
      wh:
        Math.round(v.getBoundingClientRect().width) +
        'x' +
        Math.round(v.getBoundingClientRect().height),
    }));
  const canvases = [...document.querySelectorAll('canvas')]
    .filter(vis)
    .map(
      (c) =>
        Math.round(c.getBoundingClientRect().width) +
        'x' +
        Math.round(c.getBoundingClientRect().height),
    );
  const iframes = [...document.querySelectorAll('iframe')]
    .filter(vis)
    .map((f) => (f.src || '').split('/')[2] || 'inline');
  const lottie = document.querySelectorAll(
    'lottie-player, [class*=lottie], [data-lottie]',
  ).length;
  // count elements with a running CSS animation (infinite loops = ambient motion)
  let animated = 0;
  for (const el of document.querySelectorAll('*')) {
    const a = getComputedStyle(el).animationName;
    if (a && a !== 'none') animated++;
    if (animated > 60) break;
  }
  return {
    videos,
    canvases,
    iframes,
    lottie,
    animated,
    imgs: document.querySelectorAll('img').length,
  };
};

const browser = await chromium.launch();
const rows = [];
for (const route of ROUTES) {
  const out = {};
  for (const [site, origin] of Object.entries(ORIGIN)) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    try {
      await page.goto(origin + route, {
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
      out[site] = await page.evaluate(EXTRACT);
    } catch (e) {
      out[site] = { error: e.message };
    }
    await ctx.close();
  }
  rows.push({ route, ...out });
}
await browser.close();

// Print a comparison focused on media gaps
const lines = [];
for (const r of rows) {
  const o = r.ORIG || {},
    c = r.CLONE || {};
  const fmt = (x) =>
    x?.error
      ? 'ERR'
      : `vid=${x.videos?.length || 0} cv=${x.canvases?.length || 0} ifr=${x.iframes?.length || 0} lot=${x.lottie || 0} anim=${x.animated || 0} img=${x.imgs || 0}`;
  const gap = [];
  if ((o.videos?.length || 0) > (c.videos?.length || 0))
    gap.push(
      `MISSING ${(o.videos?.length || 0) - (c.videos?.length || 0)} VIDEO`,
    );
  if ((o.canvases?.length || 0) > (c.canvases?.length || 0))
    gap.push(
      `MISSING ${(o.canvases?.length || 0) - (c.canvases?.length || 0)} CANVAS`,
    );
  lines.push(`${r.route.padEnd(14)}  ORIG[${fmt(o)}]`);
  lines.push(
    `${''.padEnd(14)}  CLONE[${fmt(c)}]  ${gap.length ? '⚠ ' + gap.join(', ') : 'ok'}`,
  );
  if (o.videos?.length)
    lines.push(
      `${''.padEnd(16)}ORIG videos: ${o.videos.map((v) => v.src + (v.autoplay ? '(auto)' : '')).join(', ')}`,
    );
  if (c.videos?.length)
    lines.push(
      `${''.padEnd(16)}CLONE videos: ${c.videos.map((v) => v.src).join(', ')}`,
    );
  lines.push('');
}
const report = lines.join('\n');
writeFileSync('docs/research/packdetail/media-audit.txt', report);
console.log(report);
