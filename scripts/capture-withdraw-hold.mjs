// /bank-withdrawal in each hold state the backend names, against a fixture
// backend (demo data). The mock serves `hold` on GET /store/credits and a
// refusal with `code` on POST /store/credits/withdraw; GET /__scenario/<name>
// switches the wallet it serves. The storefront routes the refusal by its text
// (js-sdk drops the code), so the shot proves the hold, not the code.
//
// Usage (storefront standalone built against the mock, served on PW_BASE):
//   MOCK_BASE=http://localhost:9201 PW_BASE=http://127.0.0.1:4101 \
//     node scripts/capture-withdraw-hold.mjs
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.PW_BASE ?? 'http://127.0.0.1:4101';
const MOCK = process.env.MOCK_BASE ?? 'http://localhost:9201';
const OUT = process.env.OUT ?? 'docs/research/withdraw-hold';
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});
// The mock ignores the token's value; the storefront only needs a session.
await ctx.addCookies([
  {
    name: '_polycards_jwt',
    value: 'mock-session',
    domain: new URL(BASE).hostname,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  },
]);
await ctx.addInitScript(() => {
  try {
    window.localStorage.setItem('polycards.cookie-consent', 'rejected');
    window.sessionStorage.setItem(
      'polycards.telegram-banner-session-dismissed',
      String(Date.now()),
    );
  } catch {
    /* private mode */
  }
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

async function open(scenario) {
  await fetch(`${MOCK}/__scenario/${scenario}`);
  await page.goto(`${BASE}/bank-withdrawal`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1');
  await page.waitForTimeout(1200);
}
const shot = (name) =>
  page.locator('main').screenshot({
    path: `${OUT}/${name}.png`,
    style: '[data-site-chrome]{visibility:hidden}',
  });

for (const scenario of ['locked', 'frozen']) {
  await open(scenario);
  await shot(scenario);
  console.log(scenario, (await page.locator('main').innerText()).slice(0, 300).replace(/\n+/g, ' | '));
}

// Open wallet, then a refusal raced in: the remedy follows the code.
await open('open');
await page.fill('input[aria-label="Withdrawal amount in RM"]', '60');
await page.getByRole('button', { name: /^Withdraw RM/ }).click();
await page.waitForSelector('main [role="alert"]');
await page.waitForTimeout(300);
const alert = page.locator('main [role="alert"]');
console.log('refusal', await alert.innerText());
console.log('remedy link', await alert.locator('a').getAttribute('href'));
await shot('refusal-code-locked');

console.log('page errors', errors.length ? errors : 'none');
await browser.close();
