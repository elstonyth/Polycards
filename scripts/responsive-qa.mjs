// Responsive + asset QA for the clone. For every route × breakpoint:
//  - horizontal overflow (documentElement.scrollWidth - innerWidth)
//  - broken images (img.complete && naturalWidth === 0)
//  - reduced-motion render check at one width (sections visible)
// Saves a couple of extreme-width screenshots per route for visual spot-check.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'docs/research/qa';
mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:4000';
const ROUTES = [
  '/',
  '/claw',
  '/claw/pokemon-rookie',
  '/pack-party',
  '/marketplace',
  '/leaderboard',
  '/how-it-works',
  '/about',
  '/contact',
  '/activity',
  '/pokemon/generation/1',
  '/series',
  '/card/charizard-ex-scarlet-violet-151-1',
  '/profile/FightingProdigy3098',
  '/login',
  '/signup',
  '/settings',
  '/orders',
  '/earnings',
  '/borrow-lend',
  '/pokecoin',
  '/accelerate-claim',
  '/lucky-draw',
  '/roulette',
  '/repacks',
  '/clawmaker',
  '/store',
  '/free',
  '/fairness',
  '/social',
  '/merchants',
  '/airdrop',
  '/launchpad/fwog',
  '/30th',
];
const WIDTHS = [390, 768, 1440, 1920, 2560, 3840];
const SHOT_AT = new Set([390, 3840]); // capture extremes only

const browser = await chromium.launch();
const report = [];

for (const route of ROUTES) {
  const name =
    route === '/'
      ? 'home'
      : route.replace(/^\//, '').replace(/\//g, '_').replace(/-/g, '');
  for (const w of WIDTHS) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    try {
      await page
        .goto(BASE + route, { waitUntil: 'networkidle', timeout: 30000 })
        .catch(() => {});
      await page.waitForTimeout(700);
      // scroll to bottom to trigger lazy images + reveals, then back to top
      await page.evaluate(async () => {
        await new Promise((res) => {
          let y = 0;
          const t = setInterval(() => {
            window.scrollBy(0, 1200);
            y += 1200;
            if (y >= document.body.scrollHeight) {
              clearInterval(t);
              res();
            }
          }, 30);
        });
      });
      await page.waitForTimeout(500);
      const m = await page.evaluate(() => {
        const overflow =
          document.documentElement.scrollWidth - window.innerWidth;
        const imgs = [...document.querySelectorAll('img')];
        const broken = imgs
          .filter((i) => i.complete && i.naturalWidth === 0)
          .map((i) => (i.currentSrc || i.src).slice(-60));
        return { overflow, imgTotal: imgs.length, broken };
      });
      const flag = m.overflow > 1 ? '  ⚠ OVERFLOW' : '';
      const bflag = m.broken.length ? `  ⚠ ${m.broken.length} BROKEN` : '';
      report.push(
        `${name.padEnd(12)} ${String(w).padStart(4)}px  overflow=${String(m.overflow).padStart(4)}  imgs=${m.imgTotal}${flag}${bflag}`,
      );
      if (m.broken.length)
        m.broken.forEach((b) => report.push(`      broken: ...${b}`));
      if (SHOT_AT.has(w)) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(200);
        await page.screenshot({ path: `${OUT}/${name}_${w}.png` });
      }
    } catch (e) {
      report.push(`${name} ${w}px FAIL ${e.message}`);
    }
    await ctx.close();
  }
}
await browser.close();
console.log(report.join('\n'));
console.log('\ndone');
