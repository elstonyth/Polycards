// scripts/qa-mobile-round3.mjs
// Round-3 mobile verification for the Vault Room (spec decisions #28-#31 +
// the conclude-fade bug under #27/#19). Requires standalone :4000 + backend
// :9000 + PW_CUSTOMER_EMAIL/PW_CUSTOMER_PASSWORD. Spends real local credit
// (1-reel + 3-reel spin). Screenshots → docs/research/round3-*.png.
import { chromium } from 'playwright';

const BASE = process.env.QA_BASE ?? 'http://localhost:4000';
const OUT = process.env.QA_OUT_DIR ?? 'docs/research';
const SLUG = process.env.QA_PACK_SLUG ?? '';
const EMAIL = process.env.PW_CUSTOMER_EMAIL;
const PASSWORD = process.env.PW_CUSTOMER_PASSWORD;
const VP = { width: 390, height: 844 };

if (!SLUG || !EMAIL || !PASSWORD) {
  console.error('Set QA_PACK_SLUG, PW_CUSTOMER_EMAIL, PW_CUSTOMER_PASSWORD.');
  process.exit(1);
}

let failures = 0;
function check(name, ok, detail) {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!ok) failures++;
}

async function snap(page, name) {
  const path = `${OUT}/round3-${name}.png`;
  await page.screenshot({ path, fullPage: false });
  console.log('captured', path);
}

async function login(page) {
  await page
    .getByRole('button', { name: /^login$/i })
    .first()
    .click();
  await page.locator('input[name="email"]').waitFor({ state: 'visible' });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.getByRole('button', { name: /^log in$/i }).click();
  await page
    .locator('input[name="email"]')
    .waitFor({ state: 'detached', timeout: 15000 });
}

// #28: the credit/wins plate must sit fully inside the viewport.
async function checkTopPlate(page, label) {
  const box = await page
    .locator('div.rounded-xl', { hasText: 'Credit' })
    .first()
    .boundingBox();
  check(
    `#28 top plate inside viewport (${label})`,
    box !== null && box.x >= 0 && box.x + box.width <= VP.width + 1,
    box
      ? `right edge ${Math.round(box.x + box.width)}px of ${VP.width}`
      : 'not found',
  );
}

// Effective (ancestor-multiplied) opacity of the reel machine wrapper + column count.
async function machineState(page) {
  return page.evaluate(() => {
    const stack = [...document.querySelectorAll('div')].find(
      (d) =>
        d.className.includes('items-stretch') &&
        d.className.includes('justify-center'),
    );
    if (!stack) return { opacity: 0, columns: 0 };
    let o = 1;
    for (let el = stack; el; el = el.parentElement) {
      o *= parseFloat(getComputedStyle(el).opacity || '1');
    }
    const columns = stack.querySelectorAll(
      'div.overflow-hidden.rounded-2xl',
    ).length;
    return { opacity: o, columns };
  });
}

async function waitFlipReady(page) {
  await page
    .waitForFunction(
      () => {
        const el = [...document.querySelectorAll('button')].find((b) =>
          /flip to reveal your card/i.test(b.getAttribute('aria-label') ?? ''),
        );
        return el && !el.disabled;
      },
      { timeout: 25000 },
    )
    .catch(() => {});
}

function frameStats(deltas) {
  const d = deltas.slice(1); // first delta includes scheduling noise
  d.sort((a, b) => a - b);
  const avg = d.reduce((s, x) => s + x, 0) / d.length;
  const p95 = d[Math.floor(d.length * 0.95)] ?? 0;
  const jank = d.filter((x) => x > 34).length;
  const worst = d[d.length - 1] ?? 0;
  return { avg, p95, jank, worst, n: d.length };
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: VP });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);

  await page.goto(`${BASE}/slots/${SLUG}`, { waitUntil: 'domcontentloaded' });
  await login(page);

  // ---------- 1-reel pass ----------
  await page.goto(`${BASE}/slots/${SLUG}/spin?count=1`, {
    waitUntil: 'domcontentloaded',
  });
  const spinBtn = page.getByRole('button', { name: /^spin( again)?$/i });
  await spinBtn.waitFor({ timeout: 10000 });
  await page.waitForTimeout(1200); // balance hydrate + entrance
  await checkTopPlate(page, 'idle');
  await snap(page, 'idle-1reel');

  if (!(await spinBtn.isEnabled())) {
    console.error('Spin disabled (credit?) — aborting spin passes.');
    process.exit(1);
  }

  // #31: the blur phase must actually travel — sample the strip transform
  // twice mid-blur (600ms and 1400ms into the spin).
  await spinBtn.click();
  await page.waitForTimeout(600);
  const travel = await page.evaluate(
    () =>
      new Promise((res) => {
        const el = document.querySelector('div.will-change-transform');
        const read = () =>
          new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
        const a = read();
        setTimeout(() => res(Math.abs(read() - a)), 800);
      }),
  );
  check(
    '#31 blur phase streams',
    travel > 500,
    `${Math.round(travel)}px in 800ms`,
  );
  await page.waitForTimeout(300);
  await snap(page, 'spin-blur');

  await waitFlipReady(page);
  await page.waitForTimeout(900); // machine fade-out completes
  const flipBtn = page
    .getByRole('button', { name: /flip to reveal your card/i })
    .first();
  const cardBox = await flipBtn.boundingBox();
  check(
    '#29 card width ~64vw',
    cardBox !== null && cardBox.width > 238 && cardBox.width < 262,
    cardBox ? `${Math.round(cardBox.width)}px` : 'not found',
  );
  check(
    '#29 card clears the top plate',
    cardBox !== null && cardBox.y >= 105,
    cardBox ? `top ${Math.round(cardBox.y)}px` : 'not found',
  );
  const hidden = await machineState(page);
  check(
    '#19 machine hidden during review',
    hidden.opacity < 0.05,
    `opacity ${hidden.opacity.toFixed(3)}`,
  );
  await snap(page, 'reveal-single');

  await flipBtn.click({ force: true });
  await page.waitForTimeout(900);
  await snap(page, 'flipped-single');

  // #27 bug: keep → conclude → the machine must fade BACK IN.
  await page
    .getByRole('button', { name: /keep in vault/i })
    .first()
    .click();
  await page.waitForTimeout(2800); // 1.4s beat + 0.55s fade + margin
  const after1 = await machineState(page);
  check(
    '#27 machine visible after conclude',
    after1.opacity > 0.9,
    `opacity ${after1.opacity.toFixed(3)}`,
  );
  check(
    '#27 reel count persists (1)',
    after1.columns === 1,
    `${after1.columns} column(s)`,
  );
  check(
    '#27 Spin again offered',
    await page.getByRole('button', { name: /^spin again$/i }).isVisible(),
  );
  await snap(page, 'concluded-1reel');

  // ---------- 3-reel pass (4x CPU throttle for the frame sampling) ----------
  const add = page.getByRole('button', { name: 'Add a reel' });
  await add.click();
  await page.waitForTimeout(700);
  await add.click();
  await page.waitForTimeout(900);

  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const framesP = page.evaluate(
    (ms) =>
      new Promise((res) => {
        const ds = [];
        let last = performance.now();
        const t0 = last;
        const tick = (t) => {
          ds.push(t - last);
          last = t;
          if (t - t0 < ms) requestAnimationFrame(tick);
          else res(ds);
        };
        requestAnimationFrame(tick);
      }),
    4400,
  );
  await page.getByRole('button', { name: /^spin again$/i }).click();
  const stats = frameStats(await framesP);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  console.log(
    `frame deltas (4x throttle, 3 reels): avg ${stats.avg.toFixed(1)}ms, p95 ${stats.p95.toFixed(1)}ms, >34ms: ${stats.jank}/${stats.n}, worst ${stats.worst.toFixed(1)}ms`,
  );
  check(
    '#31 spin holds frame budget at 4x throttle',
    stats.p95 < 34,
    `p95 ${stats.p95.toFixed(1)}ms`,
  );

  await waitFlipReady(page);
  await page.waitForTimeout(900);

  // #30: the 2nd card must PEEK into the viewport.
  const flipButtons = page.getByRole('button', {
    name: /flip to reveal your card/i,
  });
  check('3 cards on the rail', (await flipButtons.count()) === 3);
  const second = await flipButtons.nth(1).boundingBox();
  const peekPx = second ? VP.width - second.x : 0;
  check(
    '#30 neighbor card peeks',
    peekPx >= 15,
    `${Math.round(peekPx)}px visible`,
  );
  await snap(page, 'rail-peek-unflipped');

  await flipButtons.first().click({ force: true });
  await page.waitForTimeout(1500);
  await snap(page, 'rail-peek-flipped');

  // Keep all three (dispatchEvent — no scroll, preserves rail centering).
  // A kept card's footer swaps to static text, so the button LIST SHRINKS —
  // always take the first remaining button, never nth(i).
  const keeps = page.getByRole('button', { name: /keep in vault/i });
  for (let i = 0; i < 3; i++) {
    await keeps.first().waitFor({ timeout: 10000 });
    await keeps.first().dispatchEvent('click');
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(2800);
  const after3 = await machineState(page);
  check(
    '#27 machine visible after 3-reel conclude',
    after3.opacity > 0.9,
    `opacity ${after3.opacity.toFixed(3)}`,
  );
  check(
    '#27 reel count persists (3)',
    after3.columns === 3,
    `${after3.columns} column(s)`,
  );
  await checkTopPlate(page, 'after wins ticker grew');
  await snap(page, 'concluded-3reels');

  await ctx.close();
} finally {
  await browser.close();
}
console.log(
  failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
