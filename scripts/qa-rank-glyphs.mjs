// Screenshots the rank numerals where they actually ship: the /leaderboard rows
// (both periods) and the home podium, against the standalone prod build.
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://127.0.0.1:4000';
const OUT = 'C:/Users/PC/Desktop/Projects/PixelSlot/docs/research/rank-badges';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 1400 } });

await page.goto(`${BASE}/leaderboard`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const board = page.locator('ol').first();
await board.scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
await board.screenshot({ path: `${OUT}/qa-leaderboard-week.png` });

// All Time — same rows, different period, and the own-row highlight can differ.
const allTime = page.getByRole('button', { name: 'All Time' });
if (await allTime.count()) {
  await allTime.first().click();
  await page.waitForTimeout(900);
  await board.screenshot({ path: `${OUT}/qa-leaderboard-alltime.png` });
}

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
