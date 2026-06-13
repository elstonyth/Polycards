// QA: Task B public profiles on the prod build (:4000).
// 1) /profile/kenji-ejxy renders REAL data (name, pulls > 0, no mock rank).
// 2) Home leaderboard rows link by handle when the backend provides one.
// Screenshots → docs/research/. Run: node scripts/qa-public-profile.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:4000';
const HANDLE = 'kenji-ejxy';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

// --- profile page ---
await page.goto(`${BASE}/profile/${HANDLE}`, { waitUntil: 'networkidle' });
const h1 = await page.locator('h1').first().textContent();
const statTiles = await page.locator('p.font-heading').allTextContents();
await page.screenshot({
  path: 'docs/research/qa-profile-kenji.png',
  fullPage: false,
});

// --- leaderboard links on home ---
await page.goto(BASE, { waitUntil: 'networkidle' });
const profileLinks = await page
  .locator('a[href^="/profile/"]')
  .evaluateAll((as) => as.map((a) => a.getAttribute('href')));

console.log(
  JSON.stringify(
    {
      profile: { h1, statTiles },
      leaderboardProfileLinks: [...new Set(profileLinks)].slice(0, 12),
    },
    null,
    2,
  ),
);
await browser.close();
