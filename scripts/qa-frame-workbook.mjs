// Verify the frame-workbook fixes end to end on :4000 (worktree build):
//  1. normal state: LV10-40 unlocked, 50+ padlocked
//  2. equip 40 then equip 20 — workbook stays truthful after refetches
//  3. trip the backend store-read limiter (old 30/10s budget) → /me must show
//     the amber "couldn't load" notice with NO false padlocks
//  4. after the burst window clears → normal unlocked state returns
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = process.env.OUT_DIR ?? '.';
mkdirSync(OUT, { recursive: true });
const kv = (file) =>
  Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [
        l.slice(0, l.indexOf('=')).trim(),
        l.slice(l.indexOf('=') + 1).trim(),
      ]),
  );
const logins = kv(path.join(process.cwd(), 'scripts', '.dev-logins'));
const env = kv(path.join(process.cwd(), '.env.local'));
const CUST = {
  email: logins.CUST_EMAIL || 'test@pokenic.app',
  password: logins.CUST_PW,
};
const PK = env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY;
if (!CUST.password || !PK)
  throw new Error('missing CUST_PW or publishable key');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

// -- login --
await page.goto('http://127.0.0.1:4000/', { waitUntil: 'domcontentloaded' });
const loginBtn = page
  .locator('header')
  .getByRole('button', { name: /^login$/i });
await loginBtn.waitFor({ state: 'visible', timeout: 60000 });
await loginBtn.click();
const email = page.locator('input[name="email"]');
await email.waitFor({ state: 'visible', timeout: 20000 });
await email.fill(CUST.email);
await page.fill('input[name="password"]', CUST.password);
await page.keyboard.press('Enter');
await loginBtn.waitFor({ state: 'detached', timeout: 20000 });
console.log('STEP login: ok');

const gotoMe = async () => {
  await page.goto('http://127.0.0.1:4000/me', { waitUntil: 'networkidle' });
};
const state = async () => ({
  equipLabels: await page
    .locator('button[aria-label^="Equip LV"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))),
  lockedLabels: await page
    .locator('button[aria-label*="unlocks at level"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))),
  unavailable: await page
    .locator('button[aria-label*="level unavailable"]')
    .count(),
  equipped: await page
    .locator('button[aria-label*="(equipped)"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))),
  notice: await page.getByText(/Couldn.t load your VIP level/).count(),
});

// -- 1. normal state --
await gotoMe();
let s = await state();
console.log('STEP normal:', JSON.stringify(s));
await page.screenshot({ path: `${OUT}/1-normal.png` });

// -- 2. equip 40, then equip 20 --
for (const lv of [40, 20]) {
  const btn = page.locator(`button[aria-label="Equip LV ${lv} frame"]`);
  if ((await btn.count()) === 0) {
    console.log(
      `STEP equip ${lv}: SKIP (not equippable — maybe already equipped)`,
    );
    continue;
  }
  await btn.click();
  await page.waitForTimeout(3500); // server action + router.refresh
  s = await state();
  console.log(`STEP after equip ${lv}:`, JSON.stringify(s));
  await page.waitForTimeout(6000); // let the burst window breathe between equips
}
await page.screenshot({ path: `${OUT}/2-after-equips.png` });

// -- 3. trip the limiter (per-actor: authenticate as the same customer) --
const auth = await fetch('http://localhost:9000/auth/customer/emailpass', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: CUST.email, password: CUST.password }),
});
if (!auth.ok) throw new Error(`customer auth failed: ${auth.status}`);
const { token } = await auth.json();
let denied = 0;
for (let i = 0; i < 40; i++) {
  const r = await fetch('http://localhost:9000/store/vip', {
    headers: { authorization: `Bearer ${token}`, 'x-publishable-api-key': PK },
  });
  if (r.status === 429) denied++;
}
console.log(
  `STEP hammer: 40 hits, ${denied} × 429 (limiter tripped: ${denied > 0})`,
);

await gotoMe();
s = await state();
console.log('STEP fail-open:', JSON.stringify(s));
await page.screenshot({ path: `${OUT}/3-fail-open.png` });
const failOpenOk =
  s.notice > 0 && s.lockedLabels.length === 0 && s.unavailable > 0;
console.log(`VERDICT fail-open UI: ${failOpenOk ? 'PASS' : 'FAIL'}`);

// -- 4. recovery after the burst window --
await page.waitForTimeout(12_000);
await gotoMe();
s = await state();
console.log('STEP recovered:', JSON.stringify(s));
await page.screenshot({ path: `${OUT}/4-recovered.png` });
const recoveredOk = s.notice === 0 && s.equipLabels.length > 0;
console.log(`VERDICT recovery: ${recoveredOk ? 'PASS' : 'FAIL'}`);

await browser.close();
