// QA: a collector's profile "Weekly rank" must equal their row on /leaderboard.
// Usage: node scripts/qa-profile-weekly-rank.mjs [baseUrl]   (default http://127.0.0.1:4000)
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:4000';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

await page.goto(`${base}/leaderboard`, { waitUntil: 'networkidle' });
const rows = await page.$$eval('a[href^="/profile/"]', (as) =>
  as.map((a) => a.getAttribute('href')),
);
const unique = [...new Set(rows)].slice(0, 10);
if (unique.length === 0) throw new Error('weekly board has no linked rows');

let failures = 0;
for (const [i, href] of unique.entries()) {
  await page.goto(`${base}${href}`, { waitUntil: 'networkidle' });
  const text = await page.locator('main header').first().innerText();
  const m = text.match(/WEEKLY RANK\s*\n?\s*(#\d+|—)/i);
  const shown = m ? m[1] : '(missing)';
  const ok = shown === `#${i + 1}`;
  if (!ok) failures++;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${href} board=#${i + 1} profile=${shown}`,
  );
  if (i === unique.length - 1) {
    await page.screenshot({ path: 'docs/research/qa-profile-weekly-rank.png' });
  }
}
await browser.close();
process.exit(failures ? 1 : 0);
