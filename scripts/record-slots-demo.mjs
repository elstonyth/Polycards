// scripts/record-slots-demo.mjs
// Records a cursor-driven walkthrough of the Phase B slot flow on the prod
// standalone (:4000): /slots → pick a pack → SPIN → winner reveal → sell-back
// option → the pull saved in the Vault. A fake cursor (Playwright doesn't draw
// one in video) glides between targets, with a step caption banner.
// Output: docs/demo/slots-phaseB-demo.webm  (run on :4000 with backend :9000).
//   QA_SLOT_EMAIL=… QA_SLOT_PASSWORD=… node scripts/record-slots-demo.mjs
import { chromium } from 'playwright';
import { mkdirSync, renameSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const EMAIL = process.env.QA_SLOT_EMAIL || 'test@pokenic.app';
const PASSWORD = process.env.QA_SLOT_PASSWORD || 'PokenicTest123!';
const PACK = 'pokemon-rookie';
const SIZE = { width: 1280, height: 800 };
const OUT = 'docs/demo';
mkdirSync(OUT, { recursive: true });

// Injected on every navigation: a fake cursor that follows real mouse moves,
// plus a caption banner the script updates via window.__cap(text).
const INIT = `
(() => {
  if (window.__cursorReady) return;
  window.__cursorReady = true;
  const cur = document.createElement('div');
  cur.id = '__cursor';
  cur.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform .05s linear;will-change:transform;';
  cur.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M5 3l14 7-6 1.5L9 18 5 3z" fill="white" stroke="black" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  const cap = document.createElement('div');
  cap.id = '__cap';
  cap.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483646;pointer-events:none;background:rgba(10,10,12,.82);color:#fff;font:600 16px/1.3 system-ui,sans-serif;padding:10px 18px;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.5);opacity:0;transition:opacity .25s;max-width:80vw;text-align:center;';
  const mount = () => { if (!document.body) return; document.body.appendChild(cur); document.body.appendChild(cap); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  addEventListener('mousemove', (e) => { cur.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'; }, true);
  window.__cap = (t) => { cap.textContent = t; cap.style.opacity = t ? '1' : '0'; };
})();
`;

const browser = await chromium.launch();

// 1) Log in in a throwaway context, capture auth state (so the recorded run
//    starts already authenticated, at /slots).
const setup = await browser.newContext();
const sp = await setup.newPage();
await sp.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await sp
  .getByRole('button', { name: /^login$/i })
  .first()
  .click();
await sp.fill('input[name="email"]', EMAIL);
await sp.fill('input[name="password"]', PASSWORD);
await sp.press('input[name="password"]', 'Enter');
await sp.waitForTimeout(2500);
const storageState = await setup.storageState();
await setup.close();

// 2) Recorded context.
const ctx = await browser.newContext({
  storageState,
  viewport: SIZE,
  recordVideo: { dir: OUT, size: SIZE },
});
await ctx.addInitScript(INIT);
const page = await ctx.newPage();

let cx = SIZE.width / 2;
let cy = SIZE.height / 2;
const sleep = (ms) => page.waitForTimeout(ms);
const caption = (t) =>
  page.evaluate((x) => window.__cap && window.__cap(x), t).catch(() => {});
async function glide(x, y, steps = 28) {
  await page.mouse.move(x, y, { steps });
  cx = x;
  cy = y;
  await sleep(250);
}
async function glideToCenter(locator, steps = 28) {
  const box = await locator.boundingBox();
  if (!box) return null;
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await glide(x, y, steps);
  return { x, y };
}
async function clickAt(locator) {
  const c = await glideToCenter(locator);
  if (!c) return false;
  await sleep(180);
  await page.mouse.click(c.x, c.y);
  return true;
}

try {
  // --- Browse packs ---
  await page.goto(`${BASE}/slots`, { waitUntil: 'networkidle' });
  await sleep(700);
  await caption('Browse the slot packs');
  await glide(360, 320);
  await glide(880, 360);
  await sleep(900);

  // --- Pick a pack ---
  await caption('Pick a pack to open');
  const openLink = page.locator(`a[href*="/slots/${PACK}"]`).first();
  await openLink.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(400);
  await clickAt(openLink);
  await page
    .waitForURL(`**/slots/${PACK}**`, { timeout: 15000 })
    .catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(900);

  // --- Spin ---
  await caption('Full-screen reveal — tap SPIN');
  const spin = page.getByRole('button', { name: /^spin$/i }).first();
  await spin.waitFor({ timeout: 15000 });
  await sleep(500);
  await clickAt(spin);

  // --- The reel spins (win-after-stop: nothing revealed mid-scroll) ---
  await caption('The Pokémon reel spins…');
  await glide(SIZE.width / 2, 260, 20);
  await page.getByText(/YOU WON/i).waitFor({ timeout: 15000 });
  await sleep(400);

  // --- Winner ---
  await caption('Winner lands on the payline — grows + glows its tier colour');
  await glide(SIZE.width / 2, 410, 18);
  await sleep(2200);

  // --- Sell-back option ---
  const sell = page
    .getByRole('button', { name: /sell back|sell for/i })
    .first();
  if (await sell.isVisible().catch(() => false)) {
    await caption('Sell it back instantly — or keep it in your Vault');
    await glideToCenter(sell);
    await sleep(2200);
  } else {
    await caption('Your prize — keep it, or sell it back');
    await sleep(1800);
  }

  // --- Vault ---
  await caption('Every pull is saved to your Vault');
  await page.goto(`${BASE}/vault`, { waitUntil: 'networkidle' });
  await sleep(900);
  await glide(SIZE.width / 2, 360);
  await sleep(2200);
  await caption('');
  await sleep(500);

  const video = page.video();
  await ctx.close(); // finalize the recording
  await browser.close();
  if (video) {
    const tmp = await video.path();
    const dest = `${OUT}/slots-phaseB-demo.webm`;
    try {
      renameSync(tmp, dest);
    } catch {
      /* cross-device or locked — leave at tmp */
    }
    console.log('VIDEO:', dest, '(or', tmp, ')');
  }
  console.log('DEMO RECORDED');
} catch (e) {
  const video = page.video();
  await ctx.close().catch(() => {});
  await browser.close().catch(() => {});
  if (video)
    console.log('partial video at', await video.path().catch(() => '?'));
  console.error('RECORD FAILED:', e.message);
  process.exitCode = 1;
}
