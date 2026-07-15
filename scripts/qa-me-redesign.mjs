// Screenshot QA for the Show-style /me redesign (+ /addresses, /download).
// Serves against the worktree standalone build on :4100.
//   node scripts/qa-me-redesign.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const FRONT = process.env.PW_BASE ?? 'http://localhost:4100';
const API = 'http://localhost:9000';
const CUST = {
  email: process.env.QA_CUSTOMER_EMAIL ?? 'test@pokenic.app',
  password: process.env.QA_CUSTOMER_PASSWORD ?? 'PokenicTest123!',
};
mkdirSync('docs/research', { recursive: true });

const cust = await fetch(`${API}/auth/customer/emailpass`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(CUST),
}).then((r) => r.json());
if (!cust.token)
  throw new Error(
    'customer auth failed: ' + JSON.stringify(cust).slice(0, 200),
  );

const browser = await chromium.launch({ headless: true });
let failures = 0;

async function shoot(tag, viewport, routes) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addCookies([
    {
      name: '_pokenic_jwt',
      value: cust.token,
      url: FRONT,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  for (const route of routes) {
    pageErrors.length = 0;
    const resp = await page.goto(`${FRONT}${route}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(2500);
    // Dismiss the cookie banner so it doesn't cover mid-page sections.
    await page
      .locator('button:has-text("Reject")')
      .first()
      .click({ timeout: 1000 })
      .catch(() => {});
    await page.waitForTimeout(300);
    const file = `docs/research/me-redesign-${tag}${route.replace(/\W+/g, '_')}.png`;
    await page.screenshot({ path: file, fullPage: true });
    const ok = (resp?.status() ?? 0) < 400 && pageErrors.length === 0;
    if (!ok) failures++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} [${tag}] ${route} doc=${resp?.status()} pageErrors=${pageErrors.length} -> ${file}`,
    );
    for (const pe of pageErrors) console.log('   ', pe.slice(0, 200));
  }
  await ctx.close();
}

await shoot('mobile', { width: 390, height: 844 }, [
  '/me',
  '/addresses',
  '/download',
]);
await shoot('desktop', { width: 1280, height: 900 }, ['/me']);

await browser.close();
process.exit(failures ? 1 : 0);
