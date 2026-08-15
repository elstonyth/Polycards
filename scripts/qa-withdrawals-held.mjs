// QA capture: admin Withdrawals page — Held view with Approve/Deny buttons,
// plus the Approve confirm dialog (never confirmed; Escape closes it).
// Run from repo root: node scripts/qa-withdrawals-held.mjs
// Creds come from the gitignored scripts/.dev-logins (KEY=VALUE), same file
// login-stack.mjs uses. Screenshots -> docs/research/.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync('scripts/.dev-logins', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
// vite here binds ::1 only — Chromium resolves localhost to 127.0.0.1 first
// and refuses. Keep the localhost ORIGIN (backend CORS allowlists it) and pin
// the resolution to ::1 via host-resolver-rules instead.
const ADMIN = 'http://localhost:7000/dashboard';
const EMAIL = env.ADMIN_EMAIL ?? 'admin@pokenic.app';
const PW = env.ADMIN_PW ?? '';
if (!PW) throw new Error('ADMIN_PW missing from scripts/.dev-logins');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch({
  headless: true,
  args: ['--host-resolver-rules=MAP localhost [::1]'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

log('logging in…');
// Retried whole-flow, same as login-stack.mjs — the vite dev server can
// reload mid-login when it re-optimizes deps.
let loggedIn = false;
for (let i = 0; i < 4 && !loggedIn; i++) {
  try {
    await page.goto(`${ADMIN}/login`, { waitUntil: 'domcontentloaded' });
    const email = page.locator('input[name="email"]');
    await email.waitFor({ state: 'visible', timeout: 30000 });
    await email.fill(EMAIL);
    await page.fill('input[name="password"]', PW);
    await page.keyboard.press('Enter');
    await page.waitForURL((u) => !u.pathname.endsWith('/login'), {
      timeout: 30000,
    });
    loggedIn = true;
  } catch (e) {
    log(`login attempt ${i + 1} failed (${String(e.message).split('\n')[0]})`);
    await page.waitForTimeout(4000);
  }
}
if (!loggedIn) throw new Error('admin login failed after 4 attempts');
log('logged in');

await page.goto(`${ADMIN}/withdrawals`, { waitUntil: 'domcontentloaded' });
await page.getByText('Withdrawals').first().waitFor({ timeout: 30000 });
// Held is the page's DEFAULT view (Task 6, plan 094) — no view switch needed.
await page
  .getByRole('button', { name: 'Approve', exact: true })
  .first()
  .waitFor({ timeout: 15000 });
await page.waitForTimeout(500);
await page.screenshot({
  path: 'docs/research/qa-withdrawals-held.png',
  fullPage: true,
});
log('captured held view');

// Open (never confirm) the Approve dialog.
await page
  .getByRole('button', { name: 'Approve', exact: true })
  .first()
  .click();
// Medusa UI's prompt renders role=alertdialog, not dialog — anchor on the
// title text instead.
await page.getByText('Approve this payout?').waitFor({ timeout: 10000 });
await page.waitForTimeout(300);
await page.screenshot({
  path: 'docs/research/qa-withdrawals-approve-dialog.png',
});
log('captured approve dialog');
await page.keyboard.press('Escape');

await browser.close();
log('done');
