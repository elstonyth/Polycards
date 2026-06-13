// Route-audit WAVE 2 capture (gap-closure Task 2): the 17 routes never diffed
// against live. Shots → docs/research/audit/shots/<slug>/{live,clone}-<w>.png
// (same layout as wave 1) + manifest-wave2.json.
//
// Wave-1 lesson baked in: the live phygitals SPA scrolls inside
// main.overflow-y-auto, so fullPage screenshots came back viewport-only and
// below-the-fold content was never compared. This pass scrolls the REAL
// scroll container to force lazy renders, then takes a TALL-VIEWPORT
// (viewport-only) screenshot sized to the content height — full content for
// live AND clone at 390/1440. 3840 stays viewport-only (token cost cap).
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const LIVE = 'https://www.phygitals.com';
const CLONE = 'http://localhost:4000';
const OUT = 'docs/research/audit/shots';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const ROUTES = [
  '/contact',
  '/series',
  '/30th',
  '/free',
  '/lucky-draw',
  '/roulette',
  '/clawmaker',
  '/airdrop',
  '/social',
  '/orders',
  '/messages',
  '/earnings',
  '/referrals',
  '/pokecoin',
  '/nbacoin',
  '/accelerate-claim',
  '/pokemon/generation/1',
];

// [width, fullContent?]
const WIDTHS = [
  [390, true],
  [1440, true],
  [3840, false],
];
const MAX_VIEWPORT_H = 12_000; // playwright handles tall viewports headless

const slug = (p) => p.replace(/^\//, '').replace(/\//g, '_');

// Scroll whichever container actually scrolls (live: main.overflow-y-auto;
// clone: the window) to trigger lazy renders, then return content height.
// HARD-CAPPED: live /messages grew scrollHeight at least as fast as we
// scrolled, so an uncapped "until total >= scrollHeight" loop never exits
// (hung the wave-2 run for 19 min). Cap the ticks AND race the evaluate.
async function scrollAndMeasure(page) {
  const evaluated = page
    .evaluate(async () => {
      const main = document.querySelector('main');
      const el =
        main && main.scrollHeight > main.clientHeight + 50
          ? main
          : (document.scrollingElement ?? document.documentElement);
      await new Promise((res) => {
        let total = 0;
        let ticks = 0;
        const t = setInterval(() => {
          el.scrollBy ? el.scrollBy(0, 600) : (el.scrollTop += 600);
          total += 600;
          ticks += 1;
          // 200 ticks * 600px = 120k px — beyond any finite page we audit.
          if (total >= el.scrollHeight + 1800 || ticks >= 200) {
            clearInterval(t);
            res(null);
          }
        }, 60);
      });
      el.scrollTop = 0;
      window.scrollTo(0, 0);
      return Math.max(
        el.scrollHeight,
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      );
    })
    .catch(() => 900);
  const timeout = new Promise((res) => setTimeout(() => res(900), 45_000));
  return Promise.race([evaluated, timeout]);
}

const browser = await chromium.launch();
const manifest = [];

async function run(site, base, path) {
  const dir = `${OUT}/${slug(path)}`;
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    userAgent: UA,
  });
  const page = await ctx.newPage();
  const rec = { site, path, files: {}, heights: {}, errors: [] };
  try {
    // networkidle never fires on the live SPA — fixed render wait instead.
    await page
      .goto(base + path, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      .catch((e) => rec.errors.push('goto:' + e.message.slice(0, 50)));
    await page.waitForTimeout(site === 'live' ? 8000 : 2500);
    for (const [w, fullContent] of WIDTHS) {
      await page.setViewportSize({
        width: w,
        height: fullContent ? 900 : 2160,
      });
      await page.waitForTimeout(site === 'live' ? 1500 : 500);
      if (fullContent) {
        const h = await scrollAndMeasure(page);
        rec.heights[w] = h;
        await page.setViewportSize({
          width: w,
          height: Math.min(Math.max(h, 900), MAX_VIEWPORT_H),
        });
        await page.waitForTimeout(site === 'live' ? 1200 : 400);
      }
      const file = `${dir}/${site}-${w}.png`;
      await page
        .screenshot({ path: file, fullPage: false })
        .catch(() => rec.errors.push('shot' + w));
      rec.files[w] = file;
    }
  } catch (e) {
    rec.errors.push('fatal:' + String(e.message || e).slice(0, 60));
  } finally {
    await ctx.close();
  }
  manifest.push(rec);
  console.log(
    `${site.padEnd(5)} ${path.padEnd(24)} ${
      rec.errors.length
        ? 'ERR ' + rec.errors.join('|')
        : 'ok h=' + JSON.stringify(rec.heights)
    }`,
  );
}

// Partial reruns: ONLY=messages SITE=live node scripts/capture-wave2.mjs
// (leading slash optional — Git Bash on Windows rewrites "/x" env values
// into MSYS paths, so pass routes without it there)
const onlyRoutes = process.env.ONLY
  ? process.env.ONLY.split(',').map((r) => {
      const clean = r.replace(/^[A-Za-z]:[\\/].*?(?=[^\\/]*$)/, '').trim();
      return clean.startsWith('/') ? clean : '/' + clean;
    })
  : null;
const onlySite = process.env.SITE || null;
const routes = onlyRoutes ?? ROUTES;
const jobs = [];
if (!onlySite || onlySite === 'clone')
  for (const p of routes) jobs.push(['clone', CLONE, p]);
if (!onlySite || onlySite === 'live')
  for (const p of routes) jobs.push(['live', LIVE, p]);
const q = [...jobs];
async function worker() {
  while (q.length) {
    const [site, base, path] = q.shift();
    await run(site, base, path);
  }
}
await Promise.all([worker(), worker()]);
await browser.close();
// Partial reruns must not clobber the full manifest.
const manifestFile = onlyRoutes
  ? 'docs/research/audit/manifest-wave2-partial.json'
  : 'docs/research/audit/manifest-wave2.json';
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
console.log(`\nCaptured ${manifest.length} site×route jobs → ${manifestFile}`);
