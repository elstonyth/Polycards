// One-off QA capture of the /task hub and the /referral page (referral
// rebuild + task engine). Logs in first — every panel below only renders for
// an authenticated customer.
// Usage:
//   PW_BASE=http://localhost:4100 PW_EMAIL=demo@polycards.test \
//   PW_PASSWORD=... node scripts/qa-task-hub.mjs
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://localhost:4100';
const EMAIL = process.env.PW_EMAIL ?? '';
const PASSWORD = process.env.PW_PASSWORD ?? '';
const OUT = 'docs/research';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
await page.goto(`${BASE}/task`, { waitUntil: 'domcontentloaded' });

// Cookie banner would otherwise sit over the tab bar in every shot.
const reject = page.getByRole('button', { name: /reject/i });
if (await reject.count())
  await reject
    .first()
    .click()
    .catch(() => {});

if (EMAIL && PASSWORD) {
  await page.getByRole('button', { name: /^login$/i }).click();
  await page.getByPlaceholder('Email').fill(EMAIL);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /^log in$/i }).click();
  // The action redirects and re-renders the hub; wait for the tab list.
  await page
    .getByRole('tab', { name: /weekly tasks/i })
    .waitFor({ state: 'attached', timeout: 20000 });
  await page.waitForTimeout(1500);
}

for (const [tab, file] of [
  [/weekly tasks/i, 'task-hub-weekly'],
  [/achievements/i, 'task-hub-achievements'],
]) {
  // force: the page has a permanently animating badge, so Playwright's
  // stability check never settles; the tabs themselves are static.
  await page.getByRole('tab', { name: tab }).click({ force: true });
  await page.waitForTimeout(700); // let the banner image paint
  await page.screenshot({ path: `${OUT}/${file}.png`, fullPage: true });
}

// Referral is its own page now.
await page.goto(`${BASE}/referral`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/referral-page.png`, fullPage: true });

console.log('captured 3 screenshots');
await browser.close();
