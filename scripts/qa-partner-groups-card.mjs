// Companion to qa-partner-groups.mjs: screenshot ONE existing customer's
// Referral card (the locked per-customer rate). Run from the repo root:
//   QA_CUSTOMER=cus_… node scripts/qa-partner-groups-card.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = process.env.QA_OUT ?? path.join(ROOT, 'docs/research');
const ADMIN = process.env.QA_ADMIN ?? 'http://localhost:7000/dashboard';
const CUSTOMER = process.env.QA_CUSTOMER;
if (!CUSTOMER) throw new Error('QA_CUSTOMER is required');

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
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${ADMIN}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[name="email"]', creds.ADMIN_EMAIL);
await page.fill('input[name="password"]', creds.ADMIN_PW);
await page.press('input[name="password"]', 'Enter');
await page.waitForURL((u) => !u.pathname.endsWith('/login'), {
  timeout: 60000,
});

await page.goto(`${ADMIN}/customers/${CUSTOMER}`, {
  waitUntil: 'domcontentloaded',
});
const heading = page.getByRole('heading', { name: 'Referral' });
await heading.waitFor({ timeout: 60000 });
await page.waitForTimeout(1500);
// Element screenshot: the page scrolls inside a container, so a viewport
// shot after scrollIntoView still shows the header. Heading → its px-6
// wrapper → the Container card.
const card = heading.locator('xpath=ancestor::div[2]');
const file = path.join(OUT, 'qa-partner-3b-referral-card-locked.png');
await card.screenshot({ path: file });
console.log('shot', file);
await browser.close();
