// Screenshots the rank numerals where they actually ship: the /leaderboard rows
// (both periods) and the home podium, against the standalone prod build.
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// 127.0.0.1, not localhost — node resolves localhost to ::1 first on Windows.
const BASE = process.env.PW_BASE ?? 'http://127.0.0.1:4000';
const OUT = process.env.OUT_DIR ?? 'docs/research/rank-badges';
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 1400 } });

await page.goto(`${BASE}/leaderboard`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const board = page.locator('ol').first();
await board.scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
await board.screenshot({ path: `${OUT}/qa-leaderboard-week.png` });

// All Time — same rows, different period, and the own-row highlight can differ.
// The board always renders this control, so a missing one is a regression, not
// a state to skip past with a green run and no capture.
const allTime = page.getByRole('button', { name: 'All Time' });
if ((await allTime.count()) !== 1) {
  throw new Error('expected exactly one All Time control on /leaderboard');
}
await allTime.click();
await page.waitForTimeout(900);
await board.screenshot({ path: `${OUT}/qa-leaderboard-alltime.png` });

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const game = page.locator('section[aria-labelledby="game-heading"]');
if (await game.count()) {
  await game.scrollIntoViewIfNeeded();
  await page.waitForTimeout(900);
  await game.screenshot({ path: `${OUT}/qa-home-podium.png` });
  console.log('home podium: ok');
} else {
  console.log('home podium: section absent (empty ledger)');
}

await browser.close();
console.log('shots ->', OUT);
