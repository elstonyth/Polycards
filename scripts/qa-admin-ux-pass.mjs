// qa-admin-ux-pass.mjs — logged-in sweep of the custom admin routes for the
// admin UI/UX pass. Admin dev server on :7000, backend on :9000.
// Usage: node scripts/qa-admin-ux-pass.mjs [outDir]
// Creds come from the gitignored scripts/.dev-logins (never printed).
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.ADMIN_BASE ?? 'http://localhost:7000';
const OUT = process.argv[2] ?? 'docs/research/admin-ux-pass';

const creds = Object.fromEntries(
  readFileSync(path.join(process.cwd(), 'scripts/.dev-logins'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      // A missing "=" makes indexOf return -1, and slice(0, -1) would hand back
      // a plausible-looking key with a silently wrong value — the login would
      // then fail 20s later with no clue why. Fail on the malformed line.
      if (i <= 0)
        throw new Error(`Malformed line in scripts/.dev-logins: ${l}`);
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

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
await page.fill('input[name="email"]', creds.ADMIN_EMAIL ?? '');
await page.fill('input[name="password"]', creds.ADMIN_PW ?? '');
await page.click('button[type="submit"]');
await page
  .waitForURL((u) => !/login/.test(u.pathname), { timeout: 30000 })
  .catch(() => console.log('WARN: still on /login after submit'));
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
