// One-off QA: the customer account surfaces touched this round —
//   /orders     tap a card cell -> full card list + shipping details
//   /addresses  edit + remove a saved address
// Run against the PROD build (serve-standalone :4000), from the repo root:
//   node scripts/qa-account-surfaces.mjs
// Creds come from the gitignored scripts/.dev-logins (never printed).
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = process.env.QA_OUT ?? ROOT;
// 127.0.0.1, not localhost — the storefront sends HSTS and Chrome would
// force-upgrade http://localhost to https and land on an error page.
const STORE = process.env.STORE_BASE ?? 'http://127.0.0.1:4000';

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
  page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });

// Storefront has no /login route — auth is a header modal. Retry the whole
// flow; a bare click-then-fill throws if the modal lags.
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

console.log('login:', await login());

// ── /orders — the cards cell opens the full order ─────────────────────────
await page.goto(`${STORE}/orders`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(1200);
const openers = page.getByRole('button', { name: /^View order #/ });
console.log('orders with a detail affordance:', await openers.count());
await shot('qa-4-orders-list');

if ((await openers.count()) > 0) {
  await openers.first().click();
  const dialog = page.getByRole('dialog', { name: /Order #.* details/ });
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  const text = await dialog.innerText();
  console.log('--- order detail modal ---');
  console.log(text.split('\n').slice(0, 24).join('\n'));
  console.log('--- cards listed:', await dialog.locator('ul li').count());
  console.log('has shipping block:', /Shipping to/.test(text));
  console.log('has tracking block:', /Tracking/.test(text));
  await shot('qa-5-order-detail');
  await page.keyboard.press('Escape');
}

// ── /addresses — edit + remove ────────────────────────────────────────────
await page.goto(`${STORE}/addresses`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(1000);
const editBtns = page.getByRole('button', { name: /^Edit address for / });
const removeBtns = page.getByRole('button', { name: /^Remove address for / });
console.log('addresses with Edit:', await editBtns.count());
console.log('addresses with Remove:', await removeBtns.count());
await shot('qa-6-addresses-list');

if ((await editBtns.count()) > 0) {
  await editBtns.first().click();
  await page.waitForTimeout(600);
  const form = page.locator('form');
  console.log('form header:', await form.locator('p').first().innerText());
  console.log(
    'seeded first name:',
    await page.getByRole('textbox', { name: 'First name' }).inputValue(),
  );
  console.log(
    'seeded address   :',
    await page.getByRole('textbox', { name: 'Address' }).inputValue(),
  );
  console.log(
    'submit label     :',
    await form.getByRole('button', { name: /Save/ }).innerText(),
  );
  await shot('qa-7-address-edit');
  await form.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(400);
}

// ── Round-trip a THROWAWAY address: add -> edit -> remove ────────────────
// Exercises updateAddress + deleteAddress for real without touching the
// customer's actual saved address.
const STAMP = 'QAthrowaway';
// The pill is ABSENT on an empty book — AddressesClient starts with `adding`
// true there, so the form is already open and there is nothing to click. An
// unconditional click times out and kills the run before the edit and remove
// coverage below, which is exactly the state the delete step leaves behind.
const addPill = page.getByRole('button', { name: /Add a new address/ });
if ((await addPill.count()) > 0) {
  await addPill.click();
  await page.waitForTimeout(500);
}
const set = async (label, value) =>
  page.getByRole('textbox', { name: label }).fill(value);
await set('First name', STAMP);
await set('Last name', 'Delete-Me');
await set('Address', '1 QA Street');
await set('City', 'Testville');
await set('Postal code', '12345');
await set('Country code', 'MY');
await set('Phone (optional)', '+60100000000');
await page
  .locator('form')
  .getByRole('button', { name: /Save address/ })
  .click();
await page.waitForTimeout(2500);
const row = page.locator('li', { hasText: STAMP });
const added = await row.count();
console.log('throwaway added:', added);
// Everything below reads that row. Without this gate a failed add (or a
// failed login) surfaces as a stack trace from row.innerText() instead of
// one line saying the add never happened.
if (added === 0) {
  console.log(
    'SKIP edit/remove coverage — the throwaway address was not created',
  );
  await browser.close();
  process.exit(1);
}

// EDIT it — change the street, assert the list reflects it.
await page
  .getByRole('button', { name: new RegExp(`^Edit address for ${STAMP}`) })
  .click();
await page.waitForTimeout(500);
await set('Address', '2 QA Avenue');
// CLEAR the phone in the same edit. This is the case `|| undefined` used to
// lose: the key never reached the wire, so the partial update kept the old
// number while the optimistic row showed it blank until a reload.
await set('Phone (optional)', '');
await page
  .locator('form')
  .getByRole('button', { name: 'Save changes' })
  .click();
await page.waitForTimeout(2500);
console.log(
  'after edit, list shows:',
  (await row.innerText()).split(String.fromCharCode(10)).join(' | '),
);
// Reload: proves the server took the write, not just the optimistic patch.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const reloaded = (await row.innerText())
  .split(String.fromCharCode(10))
  .join(' | ');
console.log('after reload  , list shows:', reloaded);
console.log(
  'cleared phone stayed cleared:',
  !reloaded.includes('+60100000000'),
  '(expected true)',
);
await shot('qa-14-address-edited');

// REMOVE it.
await page
  .getByRole('button', { name: new RegExp(`^Remove address for ${STAMP}`) })
  .click();
const rm = page.getByRole('dialog', { name: 'Remove address' });
await rm.waitFor({ state: 'visible', timeout: 10000 });
await rm.getByRole('button', { name: /^Remove address$/ }).click();
await page.waitForTimeout(2500);
console.log('after remove, rows matching stamp:', await row.count());
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
console.log(
  'after reload, rows matching stamp:',
  await row.count(),
  '(expected 0)',
);
await shot('qa-15-address-removed');

if ((await removeBtns.count()) > 0) {
  await removeBtns.first().click();
  const dialog = page.getByRole('dialog', { name: 'Remove address' });
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  console.log('--- remove confirm ---');
  console.log((await dialog.innerText()).split('\n').slice(0, 8).join('\n'));
  await shot('qa-8-address-remove-confirm');
  // Deliberately NOT confirming — this is a read-only QA pass over real data.
  await dialog.getByRole('button', { name: 'Keep it' }).click();
}

await browser.close();
