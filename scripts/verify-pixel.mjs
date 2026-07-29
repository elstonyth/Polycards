// Verifies the Meta Pixel fires on the live site AFTER cookie consent:
// 1. loads the home page, asserts NO facebook request pre-consent
// 2. clicks Accept on the cookie banner
// 3. asserts fbevents.js loads and a /tr?...ev=PageView beacon fires
//   node scripts/verify-pixel.mjs            (defaults to https://polycards.gg)
//   BASE_URL=http://localhost:4000 node scripts/verify-pixel.mjs
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'https://polycards.gg';
const PIXEL_ID = '1867225397993589';

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
const pageView = fbRequests.find(
  (u) => u.includes('/tr') && u.includes(PIXEL_ID) && u.includes('PageView'),
);

console.log(
  hasScript ? 'ok: fbevents.js loaded' : 'FAIL: fbevents.js not loaded',
);
console.log(
  pageView
    ? `ok: PageView fired -> ${pageView.slice(0, 100)}…`
    : 'FAIL: no PageView /tr beacon',
);

// client-side nav should auto-fire a second PageView (pushState tracking)
const before = fbRequests.filter((u) => u.includes('/tr')).length;
await page
  .getByRole('link', { name: /slots/i })
  .first()
  .click()
  .catch(() => {});
await page.waitForTimeout(3000);
const after = fbRequests.filter((u) => u.includes('/tr')).length;
console.log(
  after > before
    ? 'ok: client-side nav fired another pixel event'
    : 'note: no extra event on client nav (check manually in Events Manager)',
);

await browser.close();
process.exit(hasScript && pageView ? 0 : 1);
