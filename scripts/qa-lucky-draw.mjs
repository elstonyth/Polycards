// Lucky Draw visual QA (spec 2026-10-24 §5, §9, §10) against the standalone
// production build. DEMO DATA: run it against the fixture backend
// scripts/qa-lucky-draw-mock.mjs (the storefront built with
// NEXT_PUBLIC_MEDUSA_BACKEND_URL=http://localhost:9199); the session cookie is
// seeded directly, the mock ignores auth.
//
// Per viewport (375×812, 1440×900): the vault tickets row, the ?open=1 intro,
// Prizes, the Enter sheet, the page after entering, the live spin when the
// timed prize's draw passes (mid-spin, landed, prize reveal, winner told),
// Results, a result's detail (fair-draw check + entries), My entry, and
// /task with "+N tickets" chips. Then a reduced-motion run: the winner shown
// with no spin. Screenshots go to docs/research/lucky-draw-*.png.
//
// Asserted on the way (a failure exits 1): no horizontal scroll at 375; no
// draw seed in the page (DOM + RSC payload) before the draw, and the seed
// shown after it; countdown and chance render and the chance updates after
// entering; no gold on the wheel overlay; the 3-digit tickets chip fits its
// stub; no "bet/gamble/lottery/jackpot" in the copy.
//
// Usage:
//   node scripts/qa-lucky-draw-mock.mjs &          (port 9199)
//   pwsh scripts/serve-standalone.ps1 -Port 4100   (build first, see above)
//   node scripts/qa-lucky-draw.mjs
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://localhost:4100';
const MOCK = process.env.PW_MOCK ?? 'http://localhost:9199';
const OUT = process.env.PW_OUT ?? 'docs/research';
const CHROME = '[data-site-chrome] { visibility: hidden !important; }';
const BANNED = /\b(bet|bets|betting|gamble|gambling|lottery|jackpot)\b/i;
const HEX64 = /\b[0-9a-f]{64}\b/g;
const TIMED = 'Umbreon ex SAR · PSA 10';

mkdirSync(OUT, { recursive: true });
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const shots = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function resetMock(drawInSec) {
  const r = await fetch(`${MOCK}/__mock/reset?drawIn=${drawInSec}`, {
    method: 'POST',
  });
  return (await r.json()).draw_at;
}

/** The seed commitments the page may show (seed_hash only, never a seed). */
async function knownHashes() {
  const page = await (await fetch(`${MOCK}/store/lucky-draw`)).json();
  return new Set(page.prizes.map((p) => p.seed_hash));
}

async function newPage(width, height, reducedMotion = 'no-preference') {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: width < 768 ? 2 : 1,
    reducedMotion,
  });
  await ctx.addCookies([
    {
      name: '_polycards_jwt',
      value: 'mock',
      domain: new URL(BASE).hostname,
      path: '/',
    },
  ]);
  return { ctx, page: await ctx.newPage() };
}

async function dismissChrome(page) {
  // Both mount after hydration (the banner after /api/me), so wait a moment;
  // the banner's dismissal then holds for the tab (sessionStorage).
  await page
    .getByRole('button', { name: /reject/i })
    .first()
    .click({ timeout: 3000 })
    .catch(() => {});
  await page
    .getByRole('button', { name: /dismiss telegram banner/i })
    .first()
    .click({ timeout: 5000 })
    .catch(() => {});
}

/** The sheet's glass blur is on (useLiquidGlass), not the bare 55% tint. */
async function frosted(dialog, label) {
  const filter = await dialog.evaluate(
    (d) => getComputedStyle(d).backdropFilter,
  );
  check(filter && filter !== 'none', `${label}: panel is frosted (${filter})`);
}

async function noSideScroll(page, label) {
  const { sw, iw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
  }));
  if (iw < 768)
    check(sw <= iw, `${label}: no horizontal scroll (${sw} <= ${iw})`);
}

async function cleanCopy(page, label) {
  const text = await page.evaluate(() => document.body.innerText);
  const hit = text.match(BANNED);
  check(
    !hit,
    `${label}: copy free of bet/gamble/lottery/jackpot${hit ? ` (found "${hit[0]}")` : ''}`,
  );
}

async function shot(target, name, what, opts = {}) {
  const path = `${OUT}/lucky-draw-${name}.png`;
  await target.screenshot({ path, ...opts });
  shots.push(`${path} — ${what}`);
}

/** Gold = the chase/tier golds' hue band, saturated and mid-light. */
async function goldIn(locator) {
  return locator.evaluate((root) => {
    const toRgb = (c) => {
      const m = c && c.match(/rgba?\(([^)]+)\)/);
      if (m)
        return m[1]
          .split(/[ ,/]+/)
          .filter(Boolean)
          .map(Number);
      const h = c && c.match(/^#([0-9a-f]{6})$/i);
      return h
        ? [0, 2, 4].map((i) => parseInt(h[1].slice(i, i + 2), 16))
        : null;
    };
    const isGold = (c) => {
      const rgb = toRgb(c);
      if (!rgb || rgb[3] === 0) return false;
      const [r, g, b] = rgb.slice(0, 3).map((v) => v / 255);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      if (max === min) return false;
      const d = max - min;
      const s = d / (1 - Math.abs(2 * l - 1));
      let h =
        max === r
          ? ((g - b) / d) % 6
          : max === g
            ? (b - r) / d + 2
            : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      return h >= 35 && h <= 58 && s > 0.6 && l > 0.3 && l < 0.75;
    };
    const hits = [];
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const cs = getComputedStyle(el);
      for (const v of [
        cs.color,
        cs.backgroundColor,
        cs.borderTopColor,
        cs.fill,
        cs.stroke,
        el.getAttribute('fill'),
        el.getAttribute('stroke'),
        el.getAttribute('stop-color'),
      ]) {
        if (isGold(v)) hits.push(`${el.tagName.toLowerCase()} ${v}`);
      }
    }
    return hits;
  });
}

async function run(width, height) {
  const tag = String(width);
  const drawAt = await resetMock(60);
  const hashes = await knownHashes();
  const { ctx, page } = await newPage(width, height);

  // 1. Vault: the tickets row.
  await page.goto(`${BASE}/vault`, { waitUntil: 'load' });
  await dismissChrome(page);
  const row = page.getByRole('region', { name: 'Lucky Draw tickets' });
  await row.waitFor();
  check(
    (await row.innerText()).includes('1,250'),
    `${tag} vault row shows 1,250 tickets`,
  );
  await noSideScroll(page, `${tag} vault`);
  await shot(row, `vault-row-${tag}`, 'vault tickets row (balance + Use)');
  await shot(page, `vault-${tag}`, 'vault viewport with the tickets row');

  // 2. Use → /lucky-draw?open=1 plays the ticket intro once.
  await row.getByRole('link', { name: 'Use tickets in Lucky Draw' }).click();
  const intro = page.locator('div.glass-scrim[aria-hidden]');
  await intro.waitFor({ timeout: 10_000 });
  await wait(500);
  await shot(
    page,
    `intro-${tag}`,
    'ticket intro from the vault Open (?open=1)',
  );
  await intro.waitFor({ state: 'detached', timeout: 5000 });
  // The Telegram banner is hidden on /vault, so it is dismissed here.
  await dismissChrome(page);
  check(
    page.url().endsWith('/lucky-draw'),
    `${tag} ?open=1 dropped from the URL`,
  );

  // 3. Prizes, before the draw: open the prize from the wheel's list.
  await page
    .locator('section[aria-label="Prizes"] ol')
    .getByRole('button')
    .filter({ hasText: TIMED })
    .first()
    .click();
  await page.getByRole('button', { name: `Enter ${TIMED}` }).waitFor();
  await wait(800); // images + countdown tick
  const before = await page.content();
  const leaked = (before.match(HEX64) ?? []).filter((h) => !hashes.has(h));
  check(leaked.length === 0, `${tag} no draw seed in the page before the draw`);
  const firstCard = page.locator('main li').filter({ hasText: TIMED }).first();
  const cardText = await firstCard.innerText();
  check(
    /\d+m \d{2}s/.test(cardText),
    `${tag} countdown renders (${cardText.match(/\d+m \d{2}s/)?.[0]})`,
  );
  check(
    /MY CHANCE\s*0%/i.test(cardText),
    `${tag} chance renders (0% before entering)`,
  );
  await noSideScroll(page, `${tag} prizes`);
  await cleanCopy(page, `${tag} prizes`);
  await shot(
    page.locator('main'),
    `prizes-${tag}`,
    'Prizes tab before the draw (countdown, totals, top entrants)',
    {
      style: CHROME,
    },
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(300);
  await shot(
    page,
    `prizes-viewport-${tag}`,
    'Prizes tab as the screen shows it (chrome included)',
  );

  // 4. Enter sheet → 40 tickets.
  await page.getByRole('button', { name: `Enter ${TIMED}` }).click();
  const sheet = page.getByRole('dialog', { name: `Enter ${TIMED}` });
  await sheet.waitFor();
  await wait(300);
  await frosted(sheet, `${tag} enter sheet`);
  await page.locator('#enter-tickets').fill('40');
  await wait(300);
  check(
    (await sheet.innerText()).includes('4.7%'),
    `${tag} sheet previews the chance after entering (4.7%)`,
  );
  await noSideScroll(page, `${tag} enter sheet`);
  await shot(
    page,
    `enter-sheet-${tag}`,
    'Enter sheet with 40 tickets and the chance preview',
  );
  await sheet.getByRole('button', { name: 'Enter 40 tickets' }).click();
  await page.getByText(/You’re in — 40 tickets/).waitFor();
  await wait(400);
  const after = await firstCard.innerText();
  check(/MY CHANCE\s*4.7%/i.test(after), `${tag} card chance updated to 4.7%`);
  check(
    (await page.locator('main h1').locator('xpath=../..').innerText()).includes(
      '1,210',
    ),
    `${tag} header balance updated to 1,210`,
  );
  await shot(
    page.locator('main'),
    `entered-${tag}`,
    'after entering: notice, balance 1,210, my tickets 40, chance 4.7%',
    {
      style: CHROME,
    },
  );

  // 5. The live spin once the draw time passes (polled every 5–7 s).
  const spin = page.locator('[role="dialog"][aria-labelledby="spin-title"]');
  const msLeft = Date.parse(drawAt) - Date.now();
  await spin.waitFor({ timeout: msLeft + 20_000 });
  const t0 = Date.now();
  const at = async (ms) => wait(Math.max(0, ms - (Date.now() - t0)));
  await at(2500);
  await shot(
    page,
    `spin-mid-${tag}`,
    'live spin, mid-spin (names faded at speed)',
  );
  const gold = await goldIn(spin);
  check(
    gold.length === 0,
    `${tag} no gold on the wheel overlay${gold.length ? ` (${gold.slice(0, 3).join('; ')})` : ''}`,
  );
  await noSideScroll(page, `${tag} spin`);
  await at(7900);
  await shot(
    page,
    `spin-landed-${tag}`,
    'wheel landed on the winner (dust rising)',
  );
  await at(8750);
  await shot(
    page,
    `spin-reveal-${tag}`,
    'prize card rising from the hub in the holo frame',
  );
  await at(10_500);
  await shot(
    page,
    `spin-told-${tag}`,
    'winner and "N of M tickets" told under the prize',
  );
  const told = await spin.innerText();
  check(/of [\d,]+ tickets/.test(told), `${tag} spin tells "N of M tickets"`);
  check(
    /Hash|Seed/.test(told) === false,
    `${tag} spin overlay carries no seed text`,
  );
  await spin.getByRole('button', { name: 'Done' }).click();

  // 6. Results → result detail.
  await page.getByRole('button', { name: 'Results', exact: true }).click();
  await page.locator('main').getByText(TIMED).first().waitFor();
  await wait(500);
  await noSideScroll(page, `${tag} results`);
  await cleanCopy(page, `${tag} results`);
  await shot(
    page.locator('main'),
    `results-${tag}`,
    'Results tab: this draw and last month’s',
    { style: CHROME },
  );
  await page.locator('main button').filter({ hasText: TIMED }).first().click();
  const detail = page.locator(
    '[role="dialog"][aria-labelledby="result-title"]',
  );
  await detail.waitFor();
  await frosted(detail, `${tag} result detail`);
  await wait(400);
  // The seed and its hash are not shown (operator 2026-10-25).
  const shown = await detail.innerText();
  check(
    (shown.match(HEX64) ?? []).length === 0,
    `${tag} result detail shows no seed or hash`,
  );
  await noSideScroll(page, `${tag} result detail`);
  await shot(
    page,
    `result-detail-${tag}`,
    'result detail: winner, tickets, Watch the draw',
  );
  await detail.getByText('(in draw order)').scrollIntoViewIfNeeded();
  await detail.evaluate((d) =>
    d.querySelector('ol')?.scrollIntoView({ block: 'end' }),
  );
  await shot(
    page,
    `result-entries-${tag}`,
    'result detail: entries in draw order with ticket ranges, winner badged',
  );
  await detail.getByRole('button', { name: 'Close' }).click();

  // 7. My entry.
  await page.getByRole('button', { name: 'My entry', exact: true }).click();
  await page.locator('main').getByText('Ticket history').waitFor();
  await wait(500);
  await noSideScroll(page, `${tag} my entry`);
  await cleanCopy(page, `${tag} my entry`);
  await shot(
    page.locator('main'),
    `my-entry-${tag}`,
    'My entry: pools joined with chance and outcome, ticket history',
    {
      style: CHROME,
    },
  );

  // 8. /task: "+N tickets" chips (120 on Daily, 999 on Achievements).
  await page.goto(`${BASE}/task`, { waitUntil: 'load' });
  await dismissChrome(page);
  const chip = page.getByRole('link', { name: /\+120 tickets/ });
  await chip.waitFor();
  await wait(1200);
  await noSideScroll(page, `${tag} task`);
  await cleanCopy(page, `${tag} task`);
  await shot(
    page.locator('main'),
    `task-daily-${tag}`,
    '/task Daily: +5, +120 and (claimed) +1 ticket chips',
    {
      style: CHROME,
    },
  );
  await page
    .getByRole('button', { name: /^achievements/i })
    .click({ force: true });
  const big = page.getByRole('link', { name: /\+999 tickets/ });
  await big.waitFor();
  await wait(600);
  const fit = await big.evaluate((a) => {
    const stub = a.closest('li')?.lastElementChild;
    const r = a.getBoundingClientRect();
    const s = stub.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(stub).paddingLeft);
    return {
      chip: r.width,
      room: s.width - 2 * pad,
      inside: r.left >= s.left && r.right <= s.right,
    };
  });
  check(
    fit.inside && fit.chip <= fit.room,
    `${tag} 3-digit chip fits its stub (${Math.round(fit.chip)} of ${Math.round(fit.room)} px)`,
  );
  await shot(
    page.locator('main'),
    `task-achievements-${tag}`,
    '/task Achievements: the 3-digit +999 tickets chip',
    {
      style: CHROME,
    },
  );
  await ctx.close();
}

/** Reduced motion: the draw result is shown directly — no reel, no dust. */
async function reducedRun() {
  await resetMock(12);
  const { ctx, page } = await newPage(375, 812, 'reduce');
  await page.goto(`${BASE}/lucky-draw`, { waitUntil: 'load' });
  await dismissChrome(page);
  const spin = page.locator('[role="dialog"][aria-labelledby="spin-title"]');
  await spin.waitFor({ timeout: 35_000 });
  await wait(150);
  const face = spin.locator('svg g[transform^="rotate"]').first();
  const first = await face.getAttribute('transform');
  const toldNow = /of [\d,]+ tickets/.test(await spin.innerText());
  await shot(
    page,
    'reduced-375',
    'reduced motion: winner shown at once, wheel already at rest',
  );
  await wait(1500);
  check(toldNow, 'reduced: winner told immediately');
  check(
    first === (await face.getAttribute('transform')),
    `reduced: wheel does not turn (${first})`,
  );
  await ctx.close();
}

const browser = await chromium.launch();
try {
  await run(375, 812);
  await run(1440, 900);
  await reducedRun();
} finally {
  await browser.close();
}
console.log(`\n${shots.length} screenshots:\n${shots.join('\n')}`);
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('\nall checks passed');
