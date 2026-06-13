// E2E QA for the Task D forgot-password loop against :4000 (prod build) +
// :9000 (medusa start). The dev-mode "email" is the backend's WARN log line —
// pass the backend log file path as argv[2] so the script can lift the reset
// link out of it.
//
//   node scripts/qa-forgot-password.mjs <backend-log-file>
//
// Flow: signup fresh account → log out → forgot-password from the login modal
// → grab the logged link → set a new password → old password fails, new
// works → reused link fails. Screenshots to docs/research/.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const LOG_FILE = process.argv[2];
if (!LOG_FILE) {
  console.error(
    'usage: node scripts/qa-forgot-password.mjs <backend-log-file>',
  );
  process.exit(1);
}

const BASE = 'http://localhost:4000';
const EMAIL = `qa-forgot-${Date.now()}@test.dev`;
const OLD_PASSWORD = 'old-password-1';
const NEW_PASSWORD = 'new-password-2';

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

// ── 1. Signup ────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/?auth=signup`, { waitUntil: 'load', timeout: 60000 });
await page.getByPlaceholder('Username').fill('QA Forgot');
await page.getByPlaceholder('Email').fill(EMAIL);
await page.getByPlaceholder('Password', { exact: true }).fill(OLD_PASSWORD);
await page.getByPlaceholder('Confirm password').fill(OLD_PASSWORD);
await page.getByRole('button', { name: 'Create account' }).click();
await page.waitForTimeout(2500);
check(
  !(await page
    .getByRole('dialog')
    .isVisible()
    .catch(() => false)),
  'signup closes the auth modal',
);

// ── 2. Forgot password from a logged-out context ────────────────────────────
await page.context().clearCookies();
await page.goto(`${BASE}/?auth=login`, { waitUntil: 'load', timeout: 60000 });
await page.getByRole('button', { name: 'Forgot password?' }).click();
check(
  await page.getByText('Reset your password').isVisible(),
  'forgot view opens',
);
await page.getByPlaceholder('Email').fill(EMAIL);
await page.getByRole('button', { name: 'Send reset link' }).click();
await page.waitForTimeout(2000);
check(
  await page.getByText('a reset link is on its way').isVisible(),
  'forgot submit shows the "check your inbox" copy',
);
await page.screenshot({ path: 'docs/research/qa-forgot-1-sent.png' });

// ── 3. Lift the reset link from the backend log ─────────────────────────────
let link = null;
for (let i = 0; i < 20 && !link; i++) {
  const log = readFileSync(LOG_FILE, 'utf8');
  const re = new RegExp(
    `\\[password-reset\\] reset link for ${EMAIL.replace(/[.+]/g, '\\$&')}: (\\S+)`,
  );
  link = log.match(re)?.[1] ?? null;
  if (!link) await new Promise((r) => setTimeout(r, 500));
}
check(Boolean(link), `backend logged the reset link (${link ?? 'NOT FOUND'})`);
if (!link) {
  await b.close();
  process.exit(1);
}

// ── 4. Set the new password via the link ────────────────────────────────────
await page.goto(link, { waitUntil: 'load', timeout: 60000 });
check(
  await page.getByText('Choose a new password').isVisible(),
  '/reset-password renders the form',
);
check(
  await page.getByText(EMAIL).isVisible(),
  'the email is shown for context',
);
await page.screenshot({ path: 'docs/research/qa-forgot-2-reset-page.png' });
await page.getByPlaceholder('New password', { exact: true }).fill(NEW_PASSWORD);
await page.getByPlaceholder('Confirm new password').fill(NEW_PASSWORD);
await page.getByRole('button', { name: 'Update password' }).click();
await page.waitForURL(/\/(\?.*)?$/, { timeout: 15000 });
await page.waitForTimeout(800);
check(
  await page.getByRole('dialog', { name: 'Log in' }).isVisible(),
  'success redirects to / with the login modal open',
);
await page.screenshot({ path: 'docs/research/qa-forgot-3-back-to-login.png' });

// ── 5. Old password fails, new password works ───────────────────────────────
// All server-action auth posts arrive from the one Next.js IP, and this QA
// pace is faster than any human — drain the auth limiter's 5/10s burst
// window first so the login checks test passwords, not the rate limiter.
await page.waitForTimeout(10_500);
await page.getByPlaceholder('Email').fill(EMAIL);
await page.getByPlaceholder('Password', { exact: true }).fill(OLD_PASSWORD);
await page.getByRole('button', { name: 'Log in', exact: true }).click();
await page.waitForTimeout(2000);
check(
  await page.getByText('Incorrect email or password.').isVisible(),
  'old password is rejected',
);
await page.getByPlaceholder('Password', { exact: true }).fill(NEW_PASSWORD);
await page.getByRole('button', { name: 'Log in', exact: true }).click();
// Login is several server round-trips (token, customer, profile handle) —
// wait for the modal to actually unmount instead of a fixed pause.
const loggedIn = await page
  .getByRole('dialog')
  .waitFor({ state: 'detached', timeout: 15000 })
  .then(
    () => true,
    () => false,
  );
if (!loggedIn) {
  console.log(
    '[debug] dialog text:',
    await page
      .getByRole('dialog')
      .innerText()
      .catch(() => '(gone)'),
  );
  await page.screenshot({ path: 'docs/research/qa-forgot-5-login-fail.png' });
}
check(loggedIn, 'new password logs in (modal closes)');

// ── 6. The link is single-use ────────────────────────────────────────────────
await page.context().clearCookies();
await page.goto(link, { waitUntil: 'load', timeout: 60000 });
await page
  .getByPlaceholder('New password', { exact: true })
  .fill('attacker-password-3');
await page.getByPlaceholder('Confirm new password').fill('attacker-password-3');
await page.getByRole('button', { name: 'Update password' }).click();
await page.waitForTimeout(2000);
check(
  await page.getByText('invalid or has expired').isVisible(),
  'reusing the link shows the invalid/expired error',
);
await page.screenshot({ path: 'docs/research/qa-forgot-4-reuse-rejected.png' });

await b.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
