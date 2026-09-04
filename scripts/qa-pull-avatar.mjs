// QA: the pull-history feed's avatar link (PR "tap a puller's avatar to open
// their activity"). Drives the standalone production build — never `next dev`.
//
//   npm run build && pwsh scripts/serve-standalone.ps1 -Port 4000
//   node scripts/qa-pull-avatar.mjs            # PW_BASE overrides :4000
//
// Checks: the avatar link's href/label, that it lands on the profile's
// Activity tab, that the row body still opens /card/[handle] (home) and the
// card overlay (pack detail), that no interactive element nests inside
// another, and that no width pans the page sideways.
//
// DATA DEPENDENCY: at least one puller in the feed needs a public handle
// (customer metadata.handle — the ensure-profile-handle workflow sets it on
// registration). A DB whose pullers have none has no avatar links at all;
// the run reports SKIPPED for those checks rather than failing the feature.
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://127.0.0.1:4000';
const FEED = 'section[aria-labelledby="recent-pulls-heading"]';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const fails = [];
const skips = [];

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
const feed = page.locator(FEED);
await feed.scrollIntoViewIfNeeded();
await page.waitForTimeout(1500); // one poll tick: the live feed swaps rows in

const avatar = feed.locator('a[aria-label*="activity"]').first();
if ((await feed.locator('a[aria-label*="activity"]').count()) === 0) {
  skips.push(
    'no puller in this feed has a public handle — avatar-link checks skipped',
  );
} else {
  console.log('avatar link label:', await avatar.getAttribute('aria-label'));
  console.log('avatar href:', await avatar.getAttribute('href'));
  // Measure the control this change CREATED: the 40px face is the smallest
  // thing on the row and misses DESIGN.md's 44px tap target unless it carries
  // padding, and no other check in this repo would catch that.
  const box = await avatar.boundingBox();
  console.log(`avatar tap target: ${box?.width}x${box?.height}`);
  if (!box || box.width < 44 || box.height < 44)
    fails.push(`avatar tap target ${box?.width}x${box?.height} is under 44x44`);
  await avatar.click();
  await page.waitForURL(/\/profile\//, { timeout: 15000 });
  console.log('after avatar click:', page.url());
  if (!/\?tab=activity/.test(page.url()))
    fails.push('avatar did not carry ?tab=activity');
  const tab = (
    await page.locator('button[aria-pressed="true"]').first().innerText()
  ).trim();
  console.log('active profile tab:', tab);
  if (tab !== 'Activity')
    fails.push(`profile opened on "${tab}", not Activity`);
  await page.screenshot({ path: 'docs/research/qa-pull-avatar-profile.png' });
  await page.goBack({ waitUntil: 'domcontentloaded' });
}

// Home: the row body still opens the card page.
const row = feed.locator('a[aria-label*="pulled"]').first();
await row.scrollIntoViewIfNeeded();
await row.click();
await page.waitForURL(/\/card\//, { timeout: 15000 });
console.log('after row click:', page.url());

// A row WITHOUT a public handle keeps its face inside the card control, so
// that 40px still opens the card — before this change every avatar did, and
// leaving an unlinked face outside the control would make it dead space.
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await feed.scrollIntoViewIfNeeded();
await page.waitForTimeout(1500);
const facelessFace = feed
  .locator(
    'li:not(:has(a[aria-label*="activity"])) a[aria-label*="pulled"] img',
  )
  .first();
if ((await facelessFace.count()) === 0) {
  skips.push(
    'every row in this feed has a public handle — unlinked-face check skipped',
  );
} else {
  await facelessFace.click();
  await page.waitForURL(/\/card\//, { timeout: 15000 });
  console.log('unlinked face opens the card:', page.url());
}

// Pack detail: the same rows are BUTTONS (onSelect opens the card overlay).
await page.goto(`${BASE}/slots/bronze-pack`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500); // let the feed's first poll settle the rows
const packRow = page.locator('button[aria-label*="pulled"]').first();
if ((await packRow.count()) === 0) {
  skips.push('/slots/bronze-pack has no pull rows — overlay check skipped');
} else {
  await packRow.click(); // auto-waits and retries on the live feed's re-render
  const overlay = page.locator('[role="dialog"]').first();
  const opened = await overlay
    .waitFor({ timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  console.log('pack row opened overlay:', opened);
  if (!opened)
    fails.push('a pack-detail row tap no longer opens the card overlay');
  // The URL becomes /card/<handle> by design — CardDetailOverlay pushState()s
  // it so the open card is linkable — so the page, not the URL, is the check.
}

// Widths: this feed's whole comment history is phone-width regressions, and
// the row is now [avatar link][card control] instead of one flat control.
for (const width of [320, 375, 412, 1280]) {
  const p = await browser.newPage({ viewport: { width, height: 900 } });
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const f = p.locator(FEED);
  await f.scrollIntoViewIfNeeded();
  await p.waitForTimeout(1500);
  await f.screenshot({
    path: `docs/research/qa-pull-avatar-feed-${width}.png`,
  });
  // scrollWidth - clientWidth: innerWidth reads 0 overflow under emulation.
  const pan = await p.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  const nested = await f.evaluate(
    (el) =>
      el.querySelectorAll('a a, a button, button a, button button').length,
  );
  console.log(`${width}px — page pan: ${pan}px, nested interactive: ${nested}`);
  if (pan > 0) fails.push(`${width}px pans the page sideways by ${pan}px`);
  if (nested > 0) fails.push(`${width}px: ${nested} nested interactive nodes`);
  await p.close();
}

await browser.close();
for (const s of skips) console.log(`SKIPPED: ${s}`);
// A skipped check is NOT a pass: printing PASS after skipping the avatar
// assertions reports an unverified feature as verified — the same vacuous
// shape as an axe run with zero passes.
if (fails.length) {
  console.log(`FAIL\n- ${fails.join('\n- ')}`);
  process.exit(1);
}
if (skips.length) {
  console.log('INCONCLUSIVE — the checks above were skipped, nothing proven');
  process.exit(2);
}
console.log('PASS');
