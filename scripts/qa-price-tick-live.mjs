// End-to-end check for the live price pulse on /card/[handle]: load the page,
// change the price underneath it, and confirm the next 60s poll actually
// re-arms the CSS animation (class applied + a fresh React key) instead of
// swapping the number silently.
//
// The operator supplies the price change out of band — this script only
// watches. Run it, then bump `card.market_value` for QA_CARD in the DB while
// it waits.
//
//   BASE_URL=http://localhost:4100 node scripts/qa-price-tick-live.mjs
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:4100';
const CARD = process.env.QA_CARD ?? 'mega-charizard-x-ex-125-psa-10-11069001';
// The poll is 60s (use-card-price.ts) — allow one full cycle plus slack.
const WAIT_MS = Number(process.env.QA_WAIT_MS ?? 75_000);

const PRICE = 'p.font-heading.tabular-nums';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${BASE}/card/${encodeURIComponent(CARD)}`, {
  waitUntil: 'load',
});

const read = () =>
  page.evaluate((q) => {
    const el = document.querySelector(q);
    return {
      text: el?.textContent?.trim() ?? null,
      pulsing: el?.classList.contains('price-tick') ?? false,
    };
  }, PRICE);

const start = await read();
console.log('initial:', JSON.stringify(start));
if (start.pulsing) {
  console.error(
    'FAIL: pulsing on first paint — the baseline is being treated as a change.',
  );
  await browser.close();
  process.exit(1);
}

console.log(`watching for ${WAIT_MS / 1000}s — change the price now...`);
let pulsed = null;
const deadline = Date.now() + WAIT_MS;
while (Date.now() < deadline) {
  const now = await read();
  if (now.pulsing) {
    pulsed = now;
    break;
  }
  await page.waitForTimeout(500);
}

if (!pulsed) {
  console.error(`FAIL: price never pulsed within ${WAIT_MS / 1000}s.`);
  console.error('(If the price was never changed, that is expected — retry.)');
  await browser.close();
  process.exit(1);
}

console.log('pulsed:', JSON.stringify(pulsed));
await page.screenshot({ path: 'docs/research/motion-price-tick.png' });
await browser.close();
console.log(`OK — ${start.text} → ${pulsed.text}, pulse class applied.`);
