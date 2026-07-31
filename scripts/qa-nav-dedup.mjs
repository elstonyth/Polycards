// One-off QA: the duplicate trust-link navigation is gone.
//   /me     — the "About & help" card (How it works / Fairness / About /
//             Contact) is removed; the Log out button is NOT
//   footer  — the link row is removed site-wide; the © line stays
// Run against the PROD build (serve-standalone :4000), from the repo root:
//   node scripts/qa-nav-dedup.mjs
// Creds come from the gitignored scripts/.dev-logins (never printed).
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = process.env.QA_OUT ?? ROOT;
const STORE = process.env.STORE_BASE ?? 'http://127.0.0.1:4000';
const TRUST = ['How it works', 'Fairness', 'About', 'Contact', 'Leaderboard'];

const creds = Object.fromEntries(
  fs
    .readFileSync(path.join(ROOT, 'scripts/.dev-logins'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
const shot = (name) =>
  page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });

async function login() {
  for (let i = 0; i < 4; i++) {
    try {
      await page.goto(`${STORE}/`, { waitUntil: 'domcontentloaded' });
      const btn = page
        .locator('header')
        .getByRole('button', { name: /^login$/i })
        .first();
      await btn.waitFor({ state: 'visible', timeout: 45000 });
      await btn.click();
      const email = page.locator('input[name="email"]');
      await email.waitFor({ state: 'visible', timeout: 20000 });
      await email.fill(creds.CUST_EMAIL ?? 'test@polycards.app');
      await page.fill('input[name="password"]', creds.CUST_PW ?? '');
      await page.press('input[name="password"]', 'Enter');
      await email.waitFor({ state: 'detached', timeout: 20000 });
      return true;
    } catch (e) {
      console.log(
        `login attempt ${i + 1}: ${String(e.message).split('\n')[0]}`,
      );
      await page.waitForTimeout(3000);
    }
  }
  return false;
}

// Assertions, not just logs: this script encodes the invariant item 7 has to
// preserve, so a regression must FAIL the run rather than print a line nobody
// reads. Exits 1 on any failure.
let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}` +
      (ok ? '' : ` (expected ${JSON.stringify(expected)})`),
  );
};

check('logged in', await login(), true);

// ── The footer is global — check it on a PUBLIC page too ──────────────────
for (const route of ['/', '/slots', '/me']) {
  await page.goto(`${STORE}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const footer = page.locator('footer[data-site-chrome]');
  const links = await footer.locator('a').count();
  const navs = await footer.locator('nav').count();
  const text = (await footer.innerText()).split('\n').join(' | ');
  check(`${route} footer has no links`, links, 0);
  check(`${route} footer has no nav landmark`, navs, 0);
  check(
    `${route} footer keeps the copyright line`,
    /© \d{4} Polycards/.test(text),
    true,
  );
}

// ── /me: the About card is gone, Log out survives ─────────────────────────
await page.goto(`${STORE}/me`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page
  .getByRole('button', { name: /^(Accept|Reject)$/ })
  .first()
  .click({ timeout: 4000 })
  .catch(() => {});
await page.waitForTimeout(400);

const body = await page.locator('body').innerText();
for (const label of TRUST) {
  // Count only NAV occurrences: an exact-text link, not prose.
  const n = await page.getByRole('link', { name: label, exact: true }).count();
  check(`/me has no nav link named "${label}"`, n, 0);
}
// Log out was deliberately KEPT — it is the only sign-out control in the app.
check(
  '/me still has Log out',
  await page.getByRole('button', { name: /log out/i }).count(),
  1,
);
// "Support" is the surviving route to /contact.
check(
  '/me Support tile still points at /contact',
  await page
    .getByRole('link', { name: 'Support' })
    .getAttribute('href')
    .catch(() => null),
  '/contact',
);
check('/me renders the copyright line', /© \d{4} Polycards/.test(body), true);
await shot('qa-16-me-after');

await browser.close();
console.log('');
console.log(failures === 0 ? 'OK — all checks passed' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
