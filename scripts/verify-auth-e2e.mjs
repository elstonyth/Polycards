// E2E auth verification against the local stack (:4000 prod build + :9000 backend):
//  1. standard signup (unique email + required MY phone) → logged-in header
//  2. re-login with the same credentials after clearing cookies
//  3. Google OAuth start: with prod forwarded headers the action must return a
//     Google consent URL carrying redirect_uri=https://polycards.gg/auth/google/callback
// Run from repo root: node scripts/verify-auth-e2e.mjs
import { chromium } from '@playwright/test';

const OUT = process.env.OUT_DIR ?? 'docs/research';
const BASE = process.env.PW_BASE ?? 'http://127.0.0.1:4000';
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`,
  );
  if (!ok) failures++;
};

const EMAIL = `auth-e2e-${Date.now()}@polycards.test`;
const PW = 'AuthE2eTest123!';
const PHONE = '010-233 4455'; // → +60102334455

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
const page = await ctx.newPage();

const openModal = async (mode) => {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const loginBtn = page
    .locator('header')
    .getByRole('button', { name: /^login$/i })
    .first();
  await loginBtn.waitFor({ state: 'visible', timeout: 30000 });
  await loginBtn.click();
  await page.locator('input[name="email"]').waitFor({ state: 'visible' });
  if (mode === 'signup') {
    await page.getByRole('button', { name: 'Sign up' }).click();
    await page.locator('input[name="username"]').waitFor({ state: 'visible' });
  }
};

// ── 1. signup with phone ─────────────────────────────────────────────────────
await openModal('signup');
await page.locator('input[name="username"]').fill('AuthE2E');
await page.locator('input[name="email"]').fill(EMAIL);
await page.getByLabel('Phone number').fill(PHONE);
await page.locator('input[name="password"]').fill(PW);
await page.locator('input[name="confirmPassword"]').fill(PW);
await page.getByRole('button', { name: 'Create account' }).click();
// Logged in when the modal unmounts (its email input detaches).
try {
  await page
    .locator('input[name="email"]')
    .waitFor({ state: 'detached', timeout: 20000 });
  check('standard signup with phone logs in', true);
} catch {
  const err = await page.locator('#auth-form-error').textContent();
  check('standard signup with phone logs in', false, err ?? 'modal stuck');
}
await page.waitForTimeout(1000);
await page.screenshot({ path: `${OUT}/auth-e2e-signed-up.png` });

// ── 2. fresh session, standard login ─────────────────────────────────────────
await ctx.clearCookies();
await openModal('login');
await page.locator('input[name="email"]').fill(EMAIL);
await page.locator('input[name="password"]').fill(PW);
await page.press('input[name="password"]', 'Enter');
try {
  await page
    .locator('input[name="email"]')
    .waitFor({ state: 'detached', timeout: 20000 });
  check('standard login with the same credentials', true);
} catch {
  const err = await page.locator('#auth-form-error').textContent();
  check(
    'standard login with the same credentials',
    false,
    err ?? 'modal stuck',
  );
}

await browser.close();

// ── 3. Google OAuth chain (piecewise — the consent hop itself needs a human) ─
// 3a. Backend token-exchange entry: POST /auth/customer/google with the prod
//     callback must return a Google consent URL carrying that exact
//     redirect_uri. (googleLoginStart, the storefront hop in front of this,
//     is pinned by unit tests: host allowlist + callback_url build.)
const BACKEND = process.env.BACKEND_BASE ?? 'http://localhost:9000';
try {
  const res = await fetch(`${BACKEND}/auth/customer/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      callback_url: 'https://polycards.gg/auth/google/callback',
    }),
  });
  const { location } = await res.json();
  const url = new URL(location ?? 'about:blank');
  check(
    'backend google provider returns a Google consent URL',
    url.hostname === 'accounts.google.com',
    url.hostname,
  );
  check(
    'consent carries the prod callback redirect_uri',
    url.searchParams.get('redirect_uri') ===
      'https://polycards.gg/auth/google/callback',
    url.searchParams.get('redirect_uri') ?? '',
  );
} catch (e) {
  check(
    'backend google provider returns a Google consent URL',
    false,
    String(e),
  );
}
// 3b. Storefront callback return leg — forwarded-host redirect (the prod
//     0.0.0.0 fix) is asserted by scripts/verify-phone-google.mjs.
console.log(`EMAIL=${EMAIL}`);
console.log(
  failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
