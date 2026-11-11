// One-off Playwright capture for the admin dashboard UI/UX audit.
// Usage: node scripts/audit-admin-capture.mjs
// Requires backend :9000 + admin :7000 up, and ADMIN_PW in env or scripts/.dev-logins.
import { chromium } from 'playwright';
import { adminUiLogin, requireAdminTotp } from './lib/admin-sign-in.mjs';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.ADMIN_BASE || 'http://localhost:7000/dashboard';
const OUT = process.env.OUT_DIR || 'docs/research/admin-audit';
mkdirSync(OUT, { recursive: true });

function devLogin(key, fallback) {
  if (process.env[key]) return process.env[key];
  const f = 'scripts/.dev-logins';
  if (existsSync(f)) {
    const m = readFileSync(f, 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm'));
    if (m) return m[1].trim();
  }
  return fallback;
}
const EMAIL = devLogin('ADMIN_EMAIL', 'admin@pokenic.app');
const PW = devLogin('ADMIN_PW', '');
requireAdminTotp(EMAIL);
if (!PW) {
  console.error('No ADMIN_PW found (env or scripts/.dev-logins)');
  process.exit(1);
}

const PAGES = [
  ['home', '/'],
  ['cards', '/cards'],
  ['packs', '/packs'],
  ['pulls', '/pulls'],
  ['economy', '/economy'],
  ['deliveries', '/deliveries'],
  ['daily-rewards', '/daily-rewards'],
  ['gacha', '/gacha'],
  ['operations', '/operations'],
  ['support', '/support'],
  ['from-pricecharting', '/products/from-pricecharting'],
];

const consoleLog = {};

async function shoot(page, name, width) {
  await page.waitForTimeout(1800); // let queries settle; vite dev never reaches networkidle
  await page.screenshot({
    path: path.join(OUT, `${name}-${width}.png`),
    fullPage: true,
  });
  console.log(`shot ${name} @${width}`);
}

async function gotoBounded(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  let current = 'startup';
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      (consoleLog[current] ??= []).push(
        `[${msg.type()}] ${msg.text().slice(0, 300)}`,
      );
    }
  });

  // login
  current = 'login';
  await gotoBounded(page, `${BASE}/sign-in`);
  await page.waitForSelector('#sign-in-email', { timeout: 15000 });
  await page.screenshot({
    path: path.join(OUT, 'login-1440.png'),
    fullPage: true,
  });
  await adminUiLogin(page, BASE, EMAIL, PW);
  console.log('logged in');

  for (const [name, route] of PAGES) {
    current = name;
    try {
      await gotoBounded(page, `${BASE}${route}`);
      await shoot(page, name, 1440);
    } catch (e) {
      console.error(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    }
  }

  // detail pages: first pack, first customer
  for (const [name, listRoute, hrefPrefix] of [
    ['pack-detail', '/packs', '/packs/'],
    ['customer-detail', '/customers', '/customers/'],
  ]) {
    current = name;
    try {
      await gotoBounded(page, `${BASE}${listRoute}`);
      await page.waitForTimeout(2000);
      const href = await page
        .locator(`a[href*="${hrefPrefix}"]`)
        .first()
        .getAttribute('href', { timeout: 5000 })
        .catch(() => null);
      if (href) {
        await gotoBounded(page, new URL(href, 'http://localhost:7000').href);
        await shoot(page, name, 1440);
      } else {
        // rows may navigate via onClick, not links — try clicking the first table row
        const row = page.locator('table tbody tr').first();
        if (await row.count()) {
          await row.click();
          await page.waitForTimeout(1500);
          if (page.url() !== `${BASE}${listRoute}`)
            await shoot(page, name, 1440);
          else console.log(`no detail nav for ${name}`);
        } else console.log(`no rows for ${name}`);
      }
    } catch (e) {
      console.error(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    }
  }

  // narrow pass
  await page.setViewportSize({ width: 900, height: 900 });
  for (const [name, route] of PAGES) {
    current = `${name}-narrow`;
    try {
      await gotoBounded(page, `${BASE}${route}`);
      await shoot(page, name, 900);
    } catch (e) {
      console.error(`FAIL ${name}@900: ${e.message.split('\n')[0]}`);
    }
  }

  writeFileSync(
    path.join(OUT, 'console-log.json'),
    JSON.stringify(consoleLog, null, 2),
  );
  console.log('console log written');
} finally {
  await browser.close();
}
