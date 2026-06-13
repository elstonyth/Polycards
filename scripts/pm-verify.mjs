// Post-fix verification (CLONE only, fast). Confirms each measured fix landed and
// no horizontal overflow was introduced. Screenshots home/claw/leaderboard @1440.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'docs/research/pixelmatch/verify';
mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:4000';

const browser = await chromium.launch();
const report = [];

// --- Numeric confirmations ---------------------------------------------------
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1024 },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();

// HOME: eyebrow opacity + how-it-works font-size
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);
const home = await page.evaluate(() => {
  const eyebrow = [...document.querySelectorAll('p')].find(
    (e) => e.textContent.trim() === 'Packs available now',
  );
  const hiw = [...document.querySelectorAll('a')].find(
    (a) =>
      a.textContent.trim() === 'How it works' &&
      a.getBoundingClientRect().width > 0,
  );
  return {
    eyebrowColor: eyebrow ? getComputedStyle(eyebrow).color : 'NOT FOUND',
    hiwFont: hiw
      ? getComputedStyle(hiw).fontSize +
        ' / ' +
        getComputedStyle(hiw).fontWeight
      : 'NOT FOUND',
  };
});
report.push(`HOME eyebrow color (want ~white/0.25): ${home.eyebrowColor}`);
report.push(`HOME 'How it works' (want 16px / 400): ${home.hiwFont}`);
await page.screenshot({ path: `${OUT}/home_1440.png` });

// CLAW: pack grid columns
await page.goto(BASE + '/claw', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
await page.waitForTimeout(1800);
const claw = await page.evaluate(() => {
  const opens = [...document.querySelectorAll('a')].filter(
    (e) => e.textContent.trim().toLowerCase() === 'open',
  );
  let grid = null,
    node = opens[0];
  for (let i = 0; i < 8 && node?.parentElement; i++) {
    const p = node.parentElement;
    if ([...p.children].filter((c) => c.querySelector('a')).length >= 4) {
      grid = p;
      break;
    }
    node = p;
  }
  if (!grid) return { columns: '?', cardWidth: '?' };
  const kids = [...grid.children].map((k) => k.getBoundingClientRect());
  const minTop = Math.min(...kids.map((r) => r.top));
  const row = kids.filter((r) => Math.abs(r.top - minTop) < 10);
  return { columns: row.length, cardWidth: Math.round(row[0].width) };
});
report.push(
  `CLAW pack columns @1440 (want 5): ${claw.columns}, cardW=${claw.cardWidth}`,
);
await page.screenshot({ path: `${OUT}/claw_1440.png` });

// LEADERBOARD: volume US$ + no "Weekly Leaderboard" heading on this route
await page.goto(BASE + '/leaderboard', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
await page.waitForTimeout(1800);
const lb = await page.evaluate(() => {
  const vol = [...document.querySelectorAll('td')]
    .map((t) => t.textContent.trim())
    .find((t) => /\$\d/.test(t));
  const hasHeading = [...document.querySelectorAll('h2')].some(
    (h) => h.textContent.trim() === 'Weekly Leaderboard',
  );
  return { vol: vol || '?', hasWeeklyHeading: hasHeading };
});
report.push(`LEADERBOARD volume sample (want US$...): ${lb.vol}`);
report.push(
  `LEADERBOARD has 'Weekly Leaderboard' heading (want false): ${lb.hasWeeklyHeading}`,
);
await page.screenshot({ path: `${OUT}/leaderboard_1440.png` });
await ctx.close();

// --- Overflow sweep (the grid + header changes could regress) ----------------
const WIDTHS = [390, 768, 1024, 1120, 1280, 1440, 1920, 2560, 3840];
report.push('\n--- overflow sweep (overflow>1px = FAIL) ---');
for (const route of ['/', '/claw', '/leaderboard']) {
  for (const w of WIDTHS) {
    const c = await browser.newContext({
      viewport: { width: w, height: 900 },
      deviceScaleFactor: 1,
    });
    const p = await c.newPage();
    try {
      await p.goto(BASE + route, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await p.waitForTimeout(500);
      const m = await p.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        broken: [...document.querySelectorAll('img')].filter(
          (i) => i.complete && i.naturalWidth === 0,
        ).length,
      }));
      const flag = m.overflow > 1 ? '  ⚠ OVERFLOW' : '';
      const bflag = m.broken ? `  ⚠ ${m.broken} BROKEN` : '';
      report.push(
        `${route.padEnd(13)} ${String(w).padStart(4)}px  overflow=${String(m.overflow).padStart(4)}${flag}${bflag}`,
      );
    } catch (e) {
      report.push(`${route} ${w} FAIL ${e.message}`);
    }
    await c.close();
  }
}

await browser.close();
console.log(report.join('\n'));
