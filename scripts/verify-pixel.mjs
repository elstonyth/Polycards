// Verifies the Meta Pixel fires on the live site AFTER cookie consent:
// 1. loads the home page, asserts NO facebook request pre-consent
// 2. clicks Accept on the cookie banner
// 3. asserts fbevents.js loads and a PageView beacon fires
// 4. opens a pack page (client-side nav) and asserts a ViewContent beacon
//    naming that pack — the first step of the ads funnel (src/lib/pixel.ts)
//   node scripts/verify-pixel.mjs            (defaults to https://polycards.gg)
//   BASE_URL=http://localhost:4000 node scripts/verify-pixel.mjs
//
// Beacons (www.facebook.com/tr) are recorded, then ABORTED: a verification run
// must never land test events in the real pixel's data. A beacon that is
// issued at all already proves the CSP let it through. DELIVER=1 (exactly)
// lets them reach Meta instead (e.g. while watching Events Manager → Test
// events); anything else, DELIVER=0 included, keeps them aborted.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'https://polycards.gg';
const PIXEL_ID = '1829134618519800';
const DELIVER = process.env.DELIVER === '1';

const browser = await chromium.launch();
// fbevents.js bot-filters HeadlessChrome UAs and silently skips the /tr
// beacon, so a default headless run false-fails step 3.
const context = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
const page = await context.newPage();

const FB_HOSTS = ['facebook.net', 'facebook.com'];
const isFacebookHost = (url) => {
  try {
    const host = new URL(url).hostname;
    return FB_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
};

const fbRequests = [];
page.on('request', (r) => {
  const url = r.url();
  if (isFacebookHost(url)) {
    fbRequests.push(url);
  }
});

// Every beacon's fields, from the query string (GET) AND the body (fbevents
// switches to a POST once custom data makes the payload big — ViewContent,
// Purchase), so a URL-only match would false-fail exactly those events.
const beacons = [];
await page.route(/^https:\/\/www\.facebook\.com\/tr/, (route) => {
  const request = route.request();
  const fields = new URL(request.url()).searchParams;
  const body = request.postData() ?? '';
  // Multipart (form POST into the hidden iframe) or urlencoded.
  const multipart = [...body.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)/g)];
  if (multipart.length > 0) {
    for (const [, key, value] of multipart) fields.append(key, value);
  } else {
    for (const [key, value] of new URLSearchParams(body))
      fields.append(key, value);
  }
  beacons.push(fields);
  return DELIVER ? route.continue() : route.abort();
});
const beaconFor = (event) =>
  beacons.find((f) => f.get('id') === PIXEL_ID && f.get('ev') === event);

await page.goto(BASE, { waitUntil: 'networkidle' });

const preConsent = fbRequests.length;
if (preConsent > 0) {
  console.error(`FAIL: ${preConsent} facebook request(s) BEFORE consent:`);
  fbRequests.forEach((u) => console.error('  ' + u));
  await browser.close();
  process.exit(1);
}
console.log('ok: no facebook requests before consent');

await page.getByRole('button', { name: 'Accept' }).click();
await page.waitForTimeout(4000);

const hasScript = fbRequests.some((u) => u.includes('fbevents.js'));
const pageView = beaconFor('PageView');

console.log(
  hasScript ? 'ok: fbevents.js loaded' : 'FAIL: fbevents.js not loaded',
);
console.log(pageView ? 'ok: PageView fired' : 'FAIL: no PageView /tr beacon');

// A pack page must report ViewContent for THAT pack.
// Not a /spin link (e.g. the free-pack badge): the reel page has no ViewContent.
const packLink = page
  .locator('a[href^="/slots/"]:not([href*="/spin"])')
  .first();
const href = await packLink.getAttribute('href').catch(() => null);
const slug = href?.split('/')[2]?.split('?')[0];
if (slug) {
  // Guarded so a missed click still ends in the FAIL line and the summary.
  await packLink
    .click()
    .catch((error) => console.log(`note: pack link click failed: ${error}`));
  await page.waitForURL(`**/slots/${slug}**`).catch(() => {});
  await page.waitForTimeout(4000);
}
const viewContent = beaconFor('ViewContent');
// Exact id, not a substring: 'gold-pack' must not pass on ["gold-pack-2"].
const viewedIds = (() => {
  try {
    return JSON.parse(viewContent?.get('cd[content_ids]') ?? '[]');
  } catch {
    return [];
  }
})();
const viewedOk =
  Boolean(slug) &&
  Array.isArray(viewedIds) &&
  viewedIds.includes(decodeURIComponent(slug));
console.log(
  viewedOk
    ? `ok: ViewContent fired for ${slug} (value ${viewContent.get('cd[value]')} ${viewContent.get('cd[currency]')})`
    : `FAIL: no ViewContent beacon for ${slug ?? '(no pack link found)'}`,
);

console.log(
  `beacons seen: ${beacons.map((f) => f.get('ev')).join(', ') || 'none'}` +
    (DELIVER ? '' : ' (all aborted — none reached Meta)'),
);

await browser.close();
process.exit(hasScript && pageView && viewedOk ? 0 : 1);
