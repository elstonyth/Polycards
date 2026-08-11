// Verify the /me quick-access changes on the :4000 standalone build:
//   1. History tile no longer renders the credit dot (nor the Me tab dot).
//   2. A customer with NO phone gets the Settings tile lit.
// Creates a throwaway PHONELESS customer straight against the backend (the
// storefront signup form makes phone required, so the phoneless cohort — Google
// signups — can only be made this way), then logs in through the UI.
import { chromium } from '@playwright/test';

const STORE = 'http://127.0.0.1:4000';
const API = 'http://127.0.0.1:9000';
const PK = process.env.PK;
const EMAIL = `phoneless-${Date.now()}@example.test`;
const PW = 'Password123!';
const OUT = 'docs/research';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const post = async (path, body, headers = {}) => {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-publishable-api-key': PK,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
};

const reg = await post('/auth/customer/emailpass/register', {
  email: EMAIL,
  password: PW,
});
const created = await post(
  '/store/customers',
  { email: EMAIL, first_name: 'Phoneless' },
  { authorization: `Bearer ${reg.token}` },
);
log(
  `customer ${created.customer.id} phone=${created.customer.phone ?? 'null'}`,
);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 1000 },
});
const page = await ctx.newPage();

await page.goto(`${STORE}/`, { waitUntil: 'domcontentloaded' });
const loginBtn = page
  .locator('header')
  .getByRole('button', { name: /^login$/i })
  .first();
await loginBtn.waitFor({ state: 'visible', timeout: 60000 });
await loginBtn.click();
const email = page.locator('input[name="email"]');
await email.waitFor({ state: 'visible', timeout: 20000 });
await email.fill(EMAIL);
await page.fill('input[name="password"]', PW);
await page.press('input[name="password"]', 'Enter');
await email.waitFor({ state: 'detached', timeout: 20000 });
log('logged in');

await page.goto(`${STORE}/me`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/me-phone-nudge.png`, fullPage: true });

// Assertions, so the PNG is not the only evidence.
const settingsTile = page.locator('a[href="/settings"]').last();
const dots = await page
  .locator('a[href="/transactions"] span.rounded-full')
  .count();
const settingsRing = await settingsTile.locator('span.ring-1').count();
const srHint = await settingsTile.getByText(/add your phone number/i).count();
const meTabDot = await page
  .locator('nav[aria-label="Primary"] a[href="/me"] span[aria-hidden]')
  .count();
log(
  JSON.stringify({
    historyTileDots: dots,
    settingsHighlightRing: settingsRing,
    settingsSrHint: srHint,
    meTabDotSpans: meTabDot,
  }),
);

// Phase 2 — the nudge must CLEAR once a number is saved, and it must clear on
// the client-side nav back (this repo has a logged stale-RSC-on-back-nav
// failure, so SettingsForm's router.refresh() is verified, not assumed).
await page.goto(`${STORE}/settings`, { waitUntil: 'networkidle' });
await page.getByLabel('Phone number').fill('012 345 6789');
await page.getByRole('button', { name: /save changes/i }).click();
await page.getByText(/changes saved/i).waitFor({ timeout: 15000 });
log('phone saved');

await page.locator('nav[aria-label="Primary"] a[href="/me"]').last().click();
await page.waitForURL('**/me');
await page.waitForTimeout(1500);
await page.screenshot({
  path: `${OUT}/me-phone-nudge-cleared.png`,
  fullPage: true,
});
log(
  JSON.stringify({
    afterSave_settingsHighlightRing: await page
      .locator('a[href="/settings"]')
      .last()
      .locator('span.ring-1')
      .count(),
  }),
);

await browser.close();
