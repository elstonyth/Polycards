// qa-admin-ux-pass.mjs — logged-in sweep of the custom admin routes for the
// admin UI/UX pass. Admin dev server on :7000, backend on :9000.
// Usage: node scripts/qa-admin-ux-pass.mjs [outDir]
// Creds come from the gitignored scripts/.dev-logins (never printed).
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.ADMIN_BASE ?? 'http://localhost:7000';
const OUT = process.argv[2] ?? 'docs/research/admin-ux-pass';

const CREDS_FILE = path.join(process.cwd(), 'scripts/.dev-logins');
const creds = existsSync(CREDS_FILE)
  ? Object.fromEntries(
      readFileSync(CREDS_FILE, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.trim().startsWith('#'))
        .map((l) => {
          const i = l.indexOf('=');
          // A missing "=" makes indexOf return -1, and slice(0, -1) would hand
          // back a plausible-looking key with a silently wrong value — the
          // login would then fail 30s later with no clue why.
          if (i <= 0)
            throw new Error(`Malformed line in scripts/.dev-logins: ${l}`);
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    )
  : {};
const ADMIN_EMAIL = creds.ADMIN_EMAIL || process.env.ADMIN_EMAIL;
const ADMIN_PW = creds.ADMIN_PW || process.env.ADMIN_PW;
// Preflight: empty credentials just bounce off the login form 30s later.
if (!ADMIN_EMAIL || !ADMIN_PW) {
  throw new Error(
    'No admin credentials. Set ADMIN_EMAIL/ADMIN_PW in scripts/.dev-logins ' +
      'or in the environment.',
  );
}

const ROUTES = [
  'withdrawals',
  'deposits',
  'packs',
  'cards',
  'players',
  'economy',
  'ledger',
  'deliveries',
  'support',
  'odds-sets',
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`);
});

await page.goto(`${BASE}/dashboard/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[name="email"]', ADMIN_EMAIL);
await page.fill('input[name="password"]', ADMIN_PW);
await page.click('button[type="submit"]');
// Throw rather than warn: a swallowed failure screenshots every route logged
// OUT and still exits 0, which reads as a clean sweep of broken pages.
await page
  .waitForURL((u) => !/login/.test(u.pathname), { timeout: 30000 })
  .catch(() => {
    throw new Error('login did not complete — still on /login after submit');
  });
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(OUT, 'home.png'), fullPage: true });

for (const route of ROUTES) {
  await page.goto(`${BASE}/dashboard/${route}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(3000);
  await page.screenshot({
    path: path.join(OUT, `${route}.png`),
    fullPage: true,
  });
}

if (errors.length) console.log('ERRORS:\n' + [...new Set(errors)].join('\n'));
await browser.close();
console.log('wrote ' + OUT);
