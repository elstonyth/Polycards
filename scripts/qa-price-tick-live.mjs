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
    const status = document.querySelector('[role="status"]');
    return {
      text: el?.textContent?.trim() ?? null,
      pulsing: el?.classList.contains('price-tick') ?? false,
      // The screen-reader half of the same signal. Must EXIST from first paint
      // (a live region added at change time is never announced) and must be
      // EMPTY until a genuine tick.
      statusPresent: status !== null,
      status: status?.textContent?.trim() ?? null,
    };
  }, PRICE);

const start = await read();
console.log('initial:', JSON.stringify(start));
const fail = async (msg) => {
  console.error(`FAIL: ${msg}`);
  await browser.close();
  process.exit(1);
};
if (start.pulsing) {
  await fail(
    'pulsing on first paint — the baseline is being treated as a change.',
  );
}
if (!start.statusPresent) {
  await fail(
    'no [role="status"] region at first paint — a live region created at change time is never announced.',
  );
}
if (start.status) {
  await fail(
    `[role="status"] already says ${JSON.stringify(start.status)} on load — it must be empty until a real tick, or mounting the page announces a change that never happened.`,
  );
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
if (pulsed.text === start.text) {
  await fail(
    `pulse fired but the rendered price is still ${JSON.stringify(start.text)} — the animation is firing on something the reader cannot see.`,
  );
}
if (!pulsed.status) {
  await fail(
    'pulse fired but [role="status"] stayed empty — the change is conveyed by colour and motion only.',
  );
}

await page.screenshot({ path: 'docs/research/motion-price-tick.png' });
await browser.close();
console.log(
  `OK — ${start.text} → ${pulsed.text}, pulse class applied, announced as ${JSON.stringify(pulsed.status)}.`,
);
