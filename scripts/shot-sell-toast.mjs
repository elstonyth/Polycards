// Proves the sell-back confirmation toast on the spin screen: log in, spin
// bronze-pack, sell the pulled card, screenshot the toast.
// Run against the PROD build on :4000 (never next dev):
//   CUST_EMAIL=... CUST_PW=... node scripts/shot-sell-toast.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.PW_BASE || 'http://127.0.0.1:4000';
const OUT = process.env.OUT || 'docs/research';
const PACK = process.env.QA_PACK || 'bronze-pack';

mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 430, height: 932 } });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 160)));

// The cookie banner sits above everything and swallows clicks — dismiss it
// first, declining non-essential.
const dismissCookies = async () => {
  const reject = p.getByRole('button', { name: /^reject$/i });
  if (await reject.count()) {
    await reject.first().click();
    await p.waitForTimeout(800);
  }
};

// Login is a modal on the home page — there is no /login route.
await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2500);
await dismissCookies();
await p
  .getByRole('button', { name: /^login$/i })
  .first()
  .click();
const email = p.locator('input[name="email"]');
await email.waitFor({ state: 'visible', timeout: 20000 });
await email.fill(process.env.CUST_EMAIL);
await p.fill('input[name="password"]', process.env.CUST_PW);
await p.press('input[name="password"]', 'Enter');
await email.waitFor({ state: 'detached', timeout: 20000 });
console.log('logged in');

await p.goto(`${BASE}/slots/${PACK}/spin`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4000);
await dismissCookies();

await p
  .getByRole('button', { name: /^spin$/i })
  .first()
  .click();
console.log('spinning');

// The card lands FACE DOWN — the sell window only opens on the flip, so the
// run has to tap it the way a player does.
const tap = p.getByText(/Tap the card to reveal/i).first();
await tap.waitFor({ state: 'visible', timeout: 60000 });
await p.mouse.click(215, 400);
await p.waitForTimeout(2500);

// The sell CTA only appears once the card flips (reveal 'review' phase).
const sell = p.getByRole('button', { name: /^Sell for RM/ }).first();
try {
  await sell.waitFor({ state: 'visible', timeout: 60000 });
} catch (err) {
  await p.screenshot({ path: `${OUT}/spin-debug.png`, fullPage: true });
  const names = await p
    .getByRole('button')
    .evaluateAll((els) => els.map((el) => el.textContent?.trim().slice(0, 60)));
  console.log('BUTTONS:', JSON.stringify(names));
  throw err;
}
await p.screenshot({ path: `${OUT}/spin-sell-offer.png` });
await sell.click();

// Confirm modal — its button carries the same "Sell for RM x" label.
const confirm = p.getByRole('button', { name: /^Sell for RM/ }).last();
await confirm.waitFor({ state: 'visible', timeout: 15000 });
await p.screenshot({ path: `${OUT}/spin-sell-confirm.png` });
await confirm.click();

// The toast is the point of this run: it must be visible AFTER the reveal
// auto-concludes, which is what the inline "+RM x credited" chip cannot do.
const toast = p
  .getByRole('status')
  .filter({ hasText: /credited to your balance/ });
await toast.first().waitFor({ state: 'visible', timeout: 20000 });
console.log('toast:', (await toast.first().innerText()).replace(/\s+/g, ' '));
await p.screenshot({ path: `${OUT}/spin-sell-toast.png` });

// The whole point of mounting the toast outside RevealStage: it must OUTLIVE
// the reveal. So wait for the reveal to actually conclude — "Spin again" is
// only reachable on the idle machine — and only then assert the toast is still
// there. A bare timeout would pass even if the toast died with the stage.
await p
  .getByRole('button', { name: /^spin again$/i })
  .first()
  .waitFor({ state: 'visible', timeout: 15000 });
await toast.first().waitFor({ state: 'visible', timeout: 10000 });
await p.screenshot({ path: `${OUT}/spin-sell-toast-after-conclude.png` });
console.log('toast survived the reveal auto-conclude');
await b.close();
