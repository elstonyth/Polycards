// QA: leaderboard column changes — This Week reward column before pulled
// value; All Time subline shows pulls only (no RM spend).
// Usage: node scripts/qa-leaderboard-columns.mjs   (expects :4000 serving)
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://127.0.0.1:4000';
const OUT = 'docs/research';

const browser = await chromium.launch();
for (const [tag, viewport] of [
  ['mobile', { width: 390, height: 844 }],
  ['desktop', { width: 1440, height: 900 }],
]) {
  const page = await browser.newPage({ viewport });
  await page.goto(`${BASE}/leaderboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const standings = page.locator('section[aria-label="Standings"]');
  await standings.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await standings.screenshot({ path: `${OUT}/lb-week-${tag}.png` });

  await page.getByRole('button', { name: 'All Time' }).click();
  await page.waitForTimeout(400);
  await standings.screenshot({ path: `${OUT}/lb-alltime-${tag}.png` });

  // Assert no RM subline on All Time rows
  const sublines = await standings.locator('ol li p').allTextContents();
  const rmSubline = sublines.filter((t) => t.includes('RM'));
  console.log(
    `[${tag}] alltime sublines=${sublines.length} withRM=${rmSubline.length}`,
    rmSubline.length ? `OFFENDERS: ${rmSubline.join(' | ')}` : 'OK',
  );
  if (rmSubline.length) process.exitCode = 1;
  await page.close();
}
await browser.close();
console.log('done');
