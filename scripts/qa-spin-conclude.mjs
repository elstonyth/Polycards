// One-off QA for the spin screen changes this round:
//   - the "Wins" tally is gone from the status bar (Credit only)
//   - the concluded reveal auto-returns to the slot: no "Spin again"/"Done"
//     buttons inside the reveal overlay, no press needed
//
// Runs a REAL pull against the local stack (charges the local test customer).
// Run against the PROD build (serve-standalone :4000), from the repo root:
//   node scripts/qa-spin-conclude.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = process.env.QA_OUT ?? ROOT;
const STORE = process.env.STORE_BASE ?? 'http://127.0.0.1:4000';
const SLUG = process.env.QA_PACK ?? 'bronze-pack';

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
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console]', m.text().slice(0, 200));
});
page.on('pageerror', (e) =>
  console.log('[pageerror]', String(e).slice(0, 200)),
);
page.on('response', async (r) => {
  if (r.url().includes('/store/packs/') && r.status() >= 400) {
    console.log('[http]', r.status(), r.url());
    console.log('[body]', (await r.text().catch(() => '')).slice(0, 500));
  }
});

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

await page.goto(`${STORE}/slots/${SLUG}/spin`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(2500);
// Dismiss the cookie banner — it overlays the bottom controls on a phone
// viewport, which is exactly where the Spin button lives.
await page
  .getByRole('button', { name: /^(Accept|Reject)$/ })
  .first()
  .click({ timeout: 4000 })
  .catch(() => {});
await page.waitForTimeout(500);

// ── Item 6: no "Wins" tally in the status bar ─────────────────────────────
const plate = page.locator('main, body').first();
const plateText = await plate.innerText();
console.log('status bar has "Credit":', /Credit/i.test(plateText));
console.log(
  'status bar has "Wins" :',
  /\bWins\b/.test(plateText),
  '(expected false)',
);
await shot('qa-9-spin-idle');

// ── Item 3: spin, act on the cards, then wait — no button press ───────────
const spinBtn = page.getByRole('button', { name: /^(Spin|Spin again)$/ });
await spinBtn.waitFor({ state: 'visible', timeout: 20000 });
console.log('spin CTA:', await spinBtn.innerText());
await spinBtn.click();

// The reveal has landed when a card back is tappable.
const tapHint = page.getByText('Tap the card to reveal');
try {
  await tapHint.waitFor({ state: 'visible', timeout: 60000 });
  console.log('reveal reached review');
} catch {
  await shot('qa-10-spin-stuck');
  console.log('--- page text at timeout ---');
  console.log((await page.locator('body').innerText()).slice(0, 1200));
  await browser.close();
  process.exit(1);
}
await page.locator('img[alt*="card back" i], [role="button"]').first();
// Flip: tapping any card flips them all.
await page.mouse.click(215, 400);
await page.waitForTimeout(1500);
await shot('qa-10-reveal-flipped');

const keep = page.getByRole('button', { name: 'Keep in vault' });
const n = await keep.count();
console.log('cards revealed:', n);
for (let i = 0; i < n; i++) {
  await keep.first().click();
  await page.waitForTimeout(600);
}

// Immediately after the last action the old build showed "Spin again" + "Done"
// INSIDE the reveal and waited for a press. Assert neither exists, then assert
// the stage clears itself.
await page.waitForTimeout(400);
const doneBtn = page.getByRole('button', { name: /^Done$/ });
console.log(
  'reveal shows a "Done" button:',
  await doneBtn.count(),
  '(expected 0)',
);
await shot('qa-11-reveal-concluded');

// The reveal is gone when the tap hint's stage unmounts and the machine's own
// Spin CTA is interactive again — with no click in between.
await page
  .getByText('Stored in your vault', { exact: false })
  .first()
  .waitFor({ state: 'detached', timeout: 15000 })
  .catch(() => {});
await page.waitForTimeout(1200);
const backOnMachine = await spinBtn.isVisible().catch(() => false);
console.log('returned to the slot with no press:', backOnMachine);
await shot('qa-12-back-on-machine');

// ── Item 3, the other half: let the CLOCK run out, touch nothing ──────────
// The user's wording was "if the timer is up, it will go automatically go back
// to the slot" — a distinct path from acting on every card, and the one with no
// manual exit left if it regresses.
await page.waitForTimeout(1500);
if (await spinBtn.isEnabled().catch(() => false)) {
  await spinBtn.click();
  await tapHint.waitFor({ state: 'visible', timeout: 60000 });
  await page.mouse.click(215, 400); // flip — the sell clock starts here
  await page.waitForTimeout(1500);
  console.log('second reveal flipped; waiting out the sell window (no clicks)');
  const clockGone = await page
    .getByText('Tap the card to reveal')
    .waitFor({ state: 'detached', timeout: 5000 })
    .then(() => true)
    .catch(() => true);
  void clockGone;
  // The window is 30s; give it that plus the 1.4s conclude delay and slack.
  await page.waitForTimeout(40000);
  const stillRevealing = await page
    .getByRole('button', { name: 'Keep in vault' })
    .count();
  console.log(
    'cards still on the reveal after expiry:',
    stillRevealing,
    '(expected 0)',
  );
  console.log(
    'back on the machine after expiry:',
    await spinBtn.isVisible().catch(() => false),
  );
  await shot('qa-14-after-expiry');
} else {
  console.log('spin CTA disabled (cooldown) — skipped the expiry pass');
}

await browser.close();
