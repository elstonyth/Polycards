// Verify the Pokémon /claw catalog after adding the premium Black + Diamond tiers:
// counts the rendered Pokémon pack tiles, checks for broken images on the list and
// on both new detail pages (whose claw machine falls back to the brand-clean icon).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const OUT = 'docs/research/audit/shots/claw-pokemon';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const r = {};
const brokenImgs = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('img')]
      .filter(
        (i) => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.src),
      )
      .map((i) => (i.currentSrc || i.src).split('/').pop()),
  );

// 1) /claw list — pokemon section
{
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/claw`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(600);
  r.pokemon_tiles = await page.evaluate(() => {
    const want = [
      'Black Pack',
      'Diamond Pack',
      'Mythic Pack',
      'Legend Pack',
      'Elite Pack',
      'Platinum Pack',
      'Rookie Pack',
    ];
    const body = document.body.textContent || '';
    // count distinct visible pack names in the first (pokemon) section
    const open = [...document.querySelectorAll('button, a')].map((e) =>
      e.textContent?.trim(),
    );
    return { presentNames: want.filter((n) => body.includes(n)) };
  });
  r.broken_claw = await brokenImgs(page);
  r.overflow_claw = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  await page.screenshot({
    path: `${OUT}/claw-1440-top.png`,
    clip: { x: 0, y: 0, width: 1440, height: 800 },
  });
  await ctx.close();
}

// 2) new detail pages
for (const slug of ['pokemon-black', 'pokemon-diamond']) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/claw/${slug}`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  await page.waitForTimeout(700);
  r[`${slug}_broken`] = await brokenImgs(page);
  r[`${slug}_title`] = await page.title();
  await page.screenshot({ path: `${OUT}/detail-${slug}.png`, fullPage: false });
  await ctx.close();
}

await browser.close();
r.verdict =
  r.broken_claw.length === 0 &&
  r.overflow_claw <= 1 &&
  r['pokemon-black_broken'].length === 0 &&
  r['pokemon-diamond_broken'].length === 0 &&
  r.pokemon_tiles.presentNames.length === 7
    ? 'PASS'
    : 'CHECK';
console.log(JSON.stringify(r, null, 2));
