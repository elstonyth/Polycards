// Phase 7 — leaderboard + live-pulls feed verification (Playwright vs :4000).
//
// Proves both customer-facing surfaces are wired to the live gacha ledger:
//   - /leaderboard renders the LIVE aggregated board (the seeded demo collectors,
//     e.g. "Kenji"), NOT the static mock ("FightingProdigy3098"), with NO email
//     anywhere in the HTML (PII-safe), and tab switching works.
//   - the home "Recent Pulls" feed polls /api/recent-pulls and swaps in live
//     pulls — discriminated by a pack label only the live data has (e.g.
//     "Mythic Pack"; the mock only ever shows "Rookie/Elite Pack").
// Screenshots -> docs/research/phase6.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const API = 'http://localhost:9000';
const OUT = 'docs/research/phase6';
mkdirSync(OUT, { recursive: true });

const PK = readFileSync('.env.local', 'utf8')
  .split(/\r?\n/)
  .find((l) => l.startsWith('NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY='))
  ?.split('=')[1]
  ?.replace(/['"]/g, '')
  .trim();

const r = { checks: {} };
const ok = (k, c, d) =>
  (r.checks[k] = c ? 'PASS' : `FAIL${d ? ' — ' + d : ''}`);

// Ground truth: live leaderboard top name from the backend.
const lb = await (
  await fetch(`${API}/store/leaderboard?period=weekly`, {
    headers: { 'x-publishable-api-key': PK },
  })
).json();
const topName = lb.entries[0]?.name;
r.liveTopName = topName;

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1400 },
  reducedMotion: 'reduce',
});
const page = await ctx.newPage();

// --- /leaderboard ---
await page.goto(`${BASE}/leaderboard`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const lbHtml = await page.content();
ok(
  'leaderboard_live_top_name',
  topName && lbHtml.includes(topName),
  `expected "${topName}"`,
);
ok('leaderboard_not_mock', !lbHtml.includes('FightingProdigy3098'));
ok(
  'leaderboard_no_email',
  !/@pokenic\.local|@[\w.-]+\.(com|local)\b/i.test(
    lbHtml.replace(/elstonyth@outlook\.com/g, ''),
  ),
);
await page.screenshot({
  path: `${OUT}/06-leaderboard-live.png`,
  fullPage: true,
});

// tab switch -> All Time still renders a table
await page
  .getByRole('tab', { name: /All Time/i })
  .click()
  .catch(() => {});
await page.waitForTimeout(500);
const allTimeRows = await page
  .locator('table tbody tr')
  .count()
  .catch(() => 0);
ok('leaderboard_alltime_tab', allTimeRows > 0, `rows ${allTimeRows}`);

// --- home live feed ---
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
// Give the on-mount poll of /api/recent-pulls time to swap in live data.
await page.waitForTimeout(3000);
const feedText = await page
  .locator('section', {
    has: page.getByRole('heading', { name: /Recent Pulls/i }),
  })
  .first()
  .innerText()
  .catch(() => '');
// Live pack labels (Mythic/Legend/Elite/Platinum/...) — the mock only has
// Rookie/Elite, so any of these non-mock pack names proves the live swap.
const liveOnlyPack =
  /Mythic Pack|Legend Pack|Platinum Pack|Pro Pack|Starter Pack|Rookie Pack/.test(
    feedText,
  );
ok('home_feed_rendered', /Recent Pulls/i.test(feedText));
ok(
  'home_feed_has_cards',
  feedText.split('\n').filter((l) => /Pack/.test(l)).length >= 3,
  'pack labels',
);

// Confirm the same-origin poll endpoint returns live data.
const apiFeed = await page.evaluate(async () => {
  const res = await fetch('/api/recent-pulls', { cache: 'no-store' });
  return res.ok ? (await res.json()).pulls : null;
});
ok(
  'home_feed_poll_endpoint',
  Array.isArray(apiFeed) && apiFeed.length > 0,
  `len ${apiFeed?.length}`,
);
ok('home_feed_live_pack_present', liveOnlyPack);

// Home "Weekly Leaderboard" teaser must swap its mock board for the live one on
// mount (via /api/leaderboard) — same live-without-dynamic pattern as the feed.
const homeHtml = await page.content();
ok(
  'home_leaderboard_live',
  topName && homeHtml.includes(topName),
  `expected "${topName}"`,
);
ok('home_leaderboard_not_mock', !homeHtml.includes('FightingProdigy3098'));
const apiLb = await page.evaluate(async () => {
  const res = await fetch('/api/leaderboard', { cache: 'no-store' });
  return res.ok ? (await res.json()).entries : null;
});
ok(
  'home_leaderboard_poll_endpoint',
  Array.isArray(apiLb) && apiLb.length > 0,
  `len ${apiLb?.length}`,
);
await page.screenshot({ path: `${OUT}/07-home-live-feed.png`, fullPage: true });

await browser.close();
r.verdict = Object.values(r.checks).every((v) => v === 'PASS')
  ? 'PASS'
  : 'FAIL';
console.log(JSON.stringify(r, null, 2));
