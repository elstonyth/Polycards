// Proves the sell toast RUNS A TOTAL across a multi-card batch (rather than
// each sale overwriting the last). Spins 2 reels, sells both.
// Run against the PROD build on :4000:
//   CUST_EMAIL=... CUST_PW=... node scripts/shot-sell-toast-multi.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.PW_BASE || 'http://127.0.0.1:4000';
const OUT = process.env.OUT || 'docs/research';
const PACK = process.env.QA_PACK || 'bronze-pack';

mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 430, height: 932 } });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 160)));

const dismissCookies = async () => {
  const reject = p.getByRole('button', { name: /^reject$/i });
  if (await reject.count()) {
    await reject.first().click();
    await p.waitForTimeout(800);
  }
};

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

// count=2 → a two-card batch, which is what makes the total meaningful.
await p.goto(`${BASE}/slots/${PACK}/spin?count=2`, {
  waitUntil: 'domcontentloaded',
});
await p.waitForTimeout(4000);
await dismissCookies();

await p
  .getByRole('button', { name: /^spin$/i })
  .first()
  .click();
console.log('spinning');

const tap = p.getByText(/Tap the card to reveal/i).first();
await tap.waitFor({ state: 'visible', timeout: 60000 });
await p.mouse.click(215, 400);
await p.waitForTimeout(2500);

// Sell every card the batch offers, one at a time. The rail advances to the
// next unsold card on its own once the current one concludes.
for (let i = 0; i < 2; i++) {
  const sell = p.getByRole('button', { name: /^Sell for RM/ }).first();
  try {
    await sell.waitFor({ state: 'visible', timeout: 25000 });
  } catch {
    console.log(`no sell CTA for card ${i + 1} — stopping`);
    break;
  }
  await sell.click();
  const confirm = p.getByRole('button', { name: /^Sell for RM/ }).last();
  await confirm.waitFor({ state: 'visible', timeout: 15000 });
  await confirm.click();
  // Wait for THIS sale's wording, not merely "a toast is visible" — the
  // previous sale's toast is still on screen while this one is in flight, so a
  // generic match reads the old text and the running total looks broken.
  const expected =
    i === 0 ? /^Sold — RM/ : new RegExp(`^Sold ${i + 1} cards — RM`);
  const toast = p.getByRole('status').filter({ hasText: expected });
  await toast.first().waitFor({ state: 'visible', timeout: 25000 });
  console.log(
    `after sale ${i + 1}:`,
    (await toast.first().innerText()).replace(/\s+/g, ' '),
  );
  await p.screenshot({ path: `${OUT}/spin-sell-toast-multi-${i + 1}.png` });
  await p.waitForTimeout(1500);
}

console.log('done');
await b.close();
