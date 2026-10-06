// Screenshots of the real-name + phone-lock surfaces (spec 2026-10-06) against
// a storefront built with NEXT_PUBLIC_MEDUSA_BACKEND_URL pointing at a mock
// backend that serves the new routes from in-memory state (POST /__state
// switches scenarios) and proxies the rest to a real local backend.
//
//   node scripts/qa-real-name-shots.mjs [storefront] [mock-backend]
//
// Output: docs/research/qa-real-name-*.png. DEMO DATA.
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4100';
const MOCK = process.argv[3] ?? 'http://localhost:9199';
const OUT = 'docs/research';

const setState = (s) =>
  fetch(`${MOCK}/__state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(s),
  });

const browser = await chromium.launch();
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };

// Answer the cookie banner up front (it is a dialog too, and would be the one
// a generic dialog locator finds).
async function newContext() {
  const ctx = await browser.newContext(mobile);
  await ctx.addInitScript(() =>
    window.localStorage.setItem('polycards.cookie-consent', 'rejected'),
  );
  return ctx;
}

async function rejectCookies(page) {
  // Best-effort: an open dialog can sit over the banner, and a modal's
  // focus trap may make it unclickable — the shots do not depend on it.
  const btn = page.getByRole('button', { name: /^reject$/i }).first();
  if (await btn.isVisible().catch(() => false))
    await btn.click({ force: true, timeout: 3000 }).catch(() => {});
}

// ── 1. Signup form (guest) ───────────────────────────────────────────────────
{
  const ctx = await newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?auth=signup`, { waitUntil: 'networkidle' });
  await rejectCookies(page);
  const dialog = page.getByRole('dialog', { name: 'Create account' });
  await dialog.waitFor({ state: 'visible', timeout: 30000 });
  await page.fill('input[name="username"]', 'collector88');
  await page.fill('input[name="realName"]', 'Tan Ah Kow');
  await page.fill('input[name="email"]', 'collector88@example.com');
  await page.getByRole('textbox', { name: 'Phone number' }).fill('0123456789');
  await page.fill('input[name="password"]', 'PolycardsTest123!');
  await page.fill('input[name="confirmPassword"]', 'PolycardsTest123!');
  await page.check('input[name="realNameConfirm"]');
  await dialog.screenshot({ path: `${OUT}/qa-real-name-1-signup.png` });

  // ── 2. OTP step reads the real name back ─────────────────────────────────
  // Enter submits the form: on a 390px screen the modal's own overlay sits
  // over the scrolled submit button and swallows a pointer click.
  await page.press('input[name="confirmPassword"]', 'Enter');
  await page
    .getByText('Real name on your account')
    .waitFor({ state: 'visible', timeout: 30000 });
  await dialog.screenshot({ path: `${OUT}/qa-real-name-2-otp-readback.png` });
  await ctx.close();
}

// Logged-in contexts: any cookie value — the mock ignores auth.
async function authedPage() {
  const ctx = await newContext();
  const { hostname } = new URL(BASE);
  await ctx.addCookies([
    { name: '_polycards_jwt', value: 'mock', domain: hostname, path: '/' },
  ]);
  return { ctx, page: await ctx.newPage() };
}

// ── 3. Real-name gate on an account page (old customer, no name) ─────────────
{
  await setState({
    realName: null,
    phoneVerified: true,
    missing: ['real_name'],
  });
  const { ctx, page } = await authedPage();
  await page.goto(`${BASE}/me`, { waitUntil: 'networkidle' });
  await rejectCookies(page);
  const gate = page.getByRole('dialog', { name: 'Add your real name' });
  await gate.waitFor({ state: 'visible', timeout: 30000 });
  await page.screenshot({ path: `${OUT}/qa-real-name-3-gate.png` });
  await gate.locator('input[name="real_name"]').fill('Tan Ah Kow');
  await gate.getByRole('button', { name: 'Continue' }).click();
  await gate.getByRole('button', { name: 'Confirm real name' }).waitFor();
  await page.screenshot({ path: `${OUT}/qa-real-name-4-gate-confirm.png` });
  await gate.getByRole('button', { name: 'Confirm real name' }).click();
  await gate.waitFor({ state: 'detached', timeout: 20000 });
  await page.screenshot({ path: `${OUT}/qa-real-name-5-gate-done.png` });
  await ctx.close();
}

// ── 4. Settings: real name read-only, verified phone locked ──────────────────
{
  await setState({ realName: 'Tan Ah Kow', phoneVerified: true, missing: [] });
  const { ctx, page } = await authedPage();
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  await rejectCookies(page);
  await page.getByLabel('Real name (read-only)').waitFor({ timeout: 30000 });
  await page.screenshot({
    path: `${OUT}/qa-real-name-6-settings-locked.png`,
    fullPage: true,
  });
  await ctx.close();
}

// ── 5. Free welcome pack page: verification prompt up front ──────────────────
{
  await setState({
    realName: null,
    phoneVerified: false,
    missing: ['phone', 'real_name'],
  });
  const { ctx, page } = await authedPage();
  await page.goto(`${BASE}/slots/free-welcome`, { waitUntil: 'networkidle' });
  await rejectCookies(page);
  const prompt = page.getByText(/To claim your welcome pack/).first();
  const shown = await prompt.waitFor({ state: 'visible', timeout: 30000 }).then(
    () => true,
    () => false,
  );
  if (shown) await prompt.scrollIntoViewIfNeeded();
  console.log('free-pack prompt visible:', shown);
  await page.screenshot({ path: `${OUT}/qa-real-name-7-free-pack-prompt.png` });
  await ctx.close();
}

await browser.close();
console.log('shots written to', OUT);
