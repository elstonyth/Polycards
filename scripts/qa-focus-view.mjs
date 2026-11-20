// QA for the focused pack view on /home-preview (the production server with
// HOME_PREVIEW=1). Headless Chrome, muted (--mute-audio plus a media guard),
// logged out; only the cookie banner's "Reject" is ever clicked.
//
//   node scripts/qa-focus-view.mjs [baseUrl]   (default http://localhost:4300)
//
// Checks, on a phone (390x844) and a desktop (1440x900) profile:
// - a down gesture at the row (a swipe, a wheel notch) focuses the centred
//   pack and lands on Front;
// - the buy dock at Front takes taps (phone);
// - a sideways swipe over the row while focused leaves the row alone;
// - a page moved off a stop by native scroll snaps back onto one;
// - the card overlay renders on the body, takes its own wheel and closes;
// - Back then Forward returns to the stop the entry rested on;
// - a key during the leave fade does not cancel the leave;
// - Space on a focused button is the button's own;
// - a second tap while the focus chunk loads loads no page;
// - /flow-preview/<slug>: the blocks as a document, and "All packs" lands on
//   /home-preview with the float-in;
// - reduced motion: a tap opens today's pack page; without JS the tile links
//   to it.
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? process.env.PW_BASE ?? 'http://localhost:4300';
const SLUG = '151';
let failures = 0;
const report = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
};

function mute() {
  const proto = HTMLMediaElement.prototype;
  const play = proto.play;
  proto.play = function (...a) {
    this.muted = true;
    this.volume = 0;
    return play.apply(this, a);
  };
}

const PROFILES = {
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};

const browser = await chromium.launch({
  channel: 'chrome',
  args: [
    '--mute-audio',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--ignore-gpu-blocklist',
  ],
});

async function open(size, extra = {}) {
  const ctx = await browser.newContext({ ...PROFILES[size], ...extra });
  await ctx.addInitScript(mute);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  return { ctx, page };
}

async function reject(page) {
  const b = page.getByRole('button', { name: 'Reject', exact: true });
  await b
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => b.click())
    .catch(() => {});
}

const focusOf = (page) =>
  page.evaluate(() => {
    const f = window.__packStage?.focus?.();
    return f
      ? { on: f.on, focus: f.focus, busy: f.busy, stops: f.stops, y: scrollY }
      : null;
  });

async function settle(page, k) {
  await page.waitForFunction(
    (kk) => {
      const f = window.__packStage.focus();
      return f && f.on && !f.busy && Math.abs(f.focus - kk) < 1e-3;
    },
    k,
    { timeout: 8000 },
  );
  await page.waitForTimeout(500);
}

/** Back to Front by ArrowUp, one stop at a time (Home goes to the row: full-flow plan 2.10). */
async function toFront(page) {
  for (let i = 0; i < 8; i++) {
    const f = await focusOf(page);
    if (!f?.on || Math.abs(f.focus - 1) < 1e-3) break;
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(
      () => {
        const g = window.__packStage.focus();
        return g && !g.busy && Math.abs(g.focus - Math.round(g.focus)) < 1e-3;
      },
      null,
      { timeout: 8000 },
    );
    await page.waitForTimeout(200);
  }
  await settle(page, 1);
}

async function stage(size, { waitKit = true } = {}) {
  const s = await open(size);
  await s.page.goto(`${BASE}/home-preview?stage=3d&debug=1&loader=never`, {
    waitUntil: 'load',
  });
  await reject(s.page);
  if (waitKit) {
    await s.page.waitForFunction(
      () =>
        window.__packStage?.ready?.() &&
        typeof window.__packStage.focus === 'function',
      null,
      { timeout: 40000 },
    );
    await s.page.waitForTimeout(3200);
  }
  return s;
}

async function tapCentre(page) {
  const art = page.locator(
    `[data-stage-panel]:not([hidden]) [data-stage-tile][data-pack-id="${SLUG}"] [data-stage-art]`,
  );
  const b = await art.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

async function swipe(page, cdp, x0, y0, x1, y1) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: x0, y: y0 }],
  });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: x0 + ((x1 - x0) * i) / 8, y: y0 + ((y1 - y0) * i) / 8 },
      ],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
}

for (const size of ['phone', 'desktop']) {
  const { ctx, page } = await stage(size);
  const cdp = size === 'phone' ? await ctx.newCDPSession(page) : null;

  // a down gesture at the row focuses the centred pack (full-flow WP3a)
  if (cdp) await swipe(page, cdp, 200, 600, 200, 380);
  else {
    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, 120);
  }
  const entered = await page
    .waitForFunction(
      () => {
        const f = window.__packStage.focus();
        return f && f.on && !f.busy && Math.abs(f.focus - 1) < 1e-3;
      },
      null,
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  const se = await page.evaluate(() => ({
    path: location.pathname,
    id: window.__packStage.state.focusOn?.id ?? null,
  }));
  report(
    `scroll-entry-${size}`,
    entered && se.id === SLUG,
    `landed on Front: ${entered}; focused ${se.id}; address ${se.path}`,
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__packStage.focus()?.on, null, {
    timeout: 8000,
  });
  await page.waitForTimeout(900);

  // a native scroll of a pixel or forty at the row (a key, the scrollbar)
  // goes back to the row unfocused, with the row's heading showing
  for (const by of [1, 40]) {
    await page.evaluate((b) => window.scrollBy(0, b), by);
    await page.waitForTimeout(1500);
    const nb = await page.evaluate(() => ({
      y: scrollY,
      on: !!window.__packStage.focus()?.on,
      head: Number(
        getComputedStyle(document.querySelector('[data-stage-head]')).opacity,
      ),
    }));
    report(
      `row-nudge-${by}px-${size}`,
      nb.y === 0 && !nb.on && nb.head > 0.99,
      `scroll ${nb.y}, focused ${nb.on}, heading opacity ${nb.head}`,
    );
  }

  await tapCentre(page);
  await settle(page, 1);

  if (cdp) {
    // a swipe that starts on the tab bar while focused is the flow's: the
    // page never follows the finger and ends on a rest
    await swipe(page, cdp, 200, 820, 200, 600);
    await page.waitForTimeout(2200);
    const tb = await focusOf(page);
    const offTb = Math.min(...tb.stops.map((y) => Math.abs(y - tb.y)));
    report(
      `tab-bar-swipe-${size}`,
      tb.on && offTb < 1,
      `focused ${tb.on}, off a rest by ${offTb} px (focus ${tb.focus})`,
    );
    await toFront(page);
  }

  if (size === 'phone') {
    const dock = page.locator('[data-testid="focus-stops"]');
    const before = await dock.innerText();
    await page
      .locator(
        '[data-testid="focus-stops"] button[aria-label="Increase quantity"]',
      )
      .last()
      .tap();
    await page.waitForTimeout(400);
    report(
      `dock-tap-${size}`,
      (await dock.innerText()) !== before,
      'the quantity changed',
    );
  }

  const track0 = await page.evaluate(() => window.__packStage.state.track);
  if (cdp) await swipe(page, cdp, 300, 330, 100, 330);
  else {
    await page.mouse.move(900, 450);
    await page.mouse.down();
    await page.mouse.move(500, 450, { steps: 10 });
    await page.mouse.up();
  }
  await page.waitForTimeout(900);
  const track1 = await page.evaluate(() => window.__packStage.state.track);
  const f3 = await focusOf(page);
  report(
    `sideways-swipe-${size}`,
    track0 === track1 && Math.abs(f3.focus - 1) < 1e-3,
    `track ${track0} -> ${track1}, focus ${f3.focus}`,
  );

  await page.evaluate(() => window.scrollBy(0, 300));
  await page.waitForTimeout(1500);
  const f4 = await focusOf(page);
  const off = Math.min(...f4.stops.map((y) => Math.abs(y - f4.y)));
  report(
    `snap-back-${size}`,
    off < 1 && Math.abs(f4.focus - Math.round(f4.focus)) < 1e-3,
    `off a stop by ${off} px, focus ${f4.focus}`,
  );

  await toFront(page);
  await page.keyboard.press('ArrowDown');
  await settle(page, 2);
  await page.locator('[data-focus-strip] > div').first().click();
  const dialog = page.locator('[role="dialog"]').last();
  await dialog.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  const onBody = await page.evaluate(
    () =>
      !!document.querySelector('[role="dialog"]') &&
      !document
        .querySelector('[role="dialog"]')
        .closest('[data-testid="focus-stops"]'),
  );
  const db = await dialog.boundingBox();
  if (db) {
    await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2);
    await page.mouse.wheel(0, 200);
  }
  await page.waitForTimeout(1700);
  const f1 = await focusOf(page);
  const close = dialog.getByRole('button', { name: /close/i }).first();
  if (await close.isVisible().catch(() => false)) await close.click();
  else await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  const closed = !(await page
    .locator('[role="dialog"]')
    .first()
    .isVisible()
    .catch(() => false));
  report(
    `card-overlay-${size}`,
    onBody && Math.abs(f1.focus - 2) < 1e-3 && closed,
    `on the body ${onBody}, focus after a wheel over it ${f1.focus}, closed ${closed}`,
  );

  // Back then Forward: the stop the entry rested on (Pull Odds or the next)
  // (the overlay gave focus back to its tile, where the arrows scroll the strip)
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('ArrowDown');
  await settle(page, 3);
  await page.waitForTimeout(400);
  await page.goBack();
  await page.waitForFunction(() => !window.__packStage.focus()?.on, null, {
    timeout: 8000,
  });
  await page.waitForTimeout(600);
  await page.goForward();
  await page
    .waitForFunction(
      () => {
        const f = window.__packStage.focus();
        return f?.on && !f.busy && f.focus > 0.5;
      },
      null,
      { timeout: 8000 },
    )
    .catch(() => {});
  await page.waitForTimeout(600);
  const fw = await focusOf(page);
  report(
    `forward-restores-stop-${size}`,
    fw?.on && Math.abs(fw.focus - 3) < 1e-3,
    `focus after Forward ${fw?.focus}`,
  );

  // a key during the leave fade does not cancel the leave
  await page.keyboard.press('End');
  await settle(
    page,
    await page.evaluate(() => window.__packStage.focus().kinds.length),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  await page.keyboard.press('ArrowDown');
  const left = await page
    .waitForFunction(() => !window.__packStage.focus()?.on, null, {
      timeout: 8000,
    })
    .then(() => true)
    .catch(() => false);
  report(`key-during-leave-${size}`, left, `left the focus: ${left}`);

  // Space on a focused button is the button's own
  await page.waitForTimeout(800);
  await tapCentre(page);
  await settle(page, 1);
  const spaceKept = await page.evaluate(() => {
    const b = document.querySelector(
      '[data-testid="focus-stops"] section[data-on] button, [data-testid="focus-stops"] button',
    );
    if (!b) return null;
    b.focus();
    const e = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    b.dispatchEvent(e);
    return !e.defaultPrevented;
  });
  report(
    `space-on-button-${size}`,
    spaceKept === true,
    `not cancelled: ${spaceKept}`,
  );
  report(`errors-${size}`, page.errors.length === 0, page.errors.join(' | '));
  await ctx.close();
}

// a second tap while the focus chunk loads loads no page
{
  const { ctx, page } = await open('phone');
  await page.route(/pack-stage-focus/, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.goto(`${BASE}/home-preview?stage=3d&debug=1&loader=never`, {
    waitUntil: 'load',
  });
  await reject(page);
  await page.waitForFunction(() => window.__packStage?.ready?.(), null, {
    timeout: 40000,
  });
  await page.waitForTimeout(900);
  let loads = 0;
  // a document load (pushState to /slots/<id> is not one)
  page.on('load', () => loads++);
  await tapCentre(page);
  await page.waitForTimeout(150);
  await tapCentre(page).catch(() => {});
  await page.waitForTimeout(4000);
  const st = await page.evaluate(() => ({
    path: location.pathname,
    on: !!window.__packStage?.focus?.()?.on,
  }));
  report(
    'double-tap-while-loading',
    loads === 0 && st.on,
    `page loads ${loads}, path ${st.path}, focused ${st.on}`,
  );
  await ctx.close();
}

// /flow-preview: a document, and "All packs" lands on the stage with the float-in
for (const size of ['phone', 'desktop']) {
  const { ctx, page } = await open(size);
  await page.goto(`${BASE}/flow-preview/${SLUG}`, { waitUntil: 'load' });
  await reject(page);
  await page.waitForTimeout(1500);
  const kinds = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="focus-stops"] > section')].map(
      (s) => s.getAttribute('data-kind'),
    ),
  );
  report(
    `flow-preview-document-${size}`,
    kinds.join(',') === 'front,tophits,odds,buyback,pulls,closing',
    kinds.join(','),
  );
  await page
    .locator('[data-testid="focus-stops"] button', { hasText: /All packs/ })
    .first()
    .click();
  await page.waitForURL(/\/home-preview/, { timeout: 15000 });
  // the float-in: the tiles' vertical offset (in art heights) eases to 0
  const key = size === 'phone' ? '--m-dy' : '--d-dy';
  const samples = [];
  for (let i = 0; i < 16; i++) {
    samples.push(
      await page.evaluate((k) => {
        const t = [
          ...document.querySelectorAll(
            '[data-stage-panel]:not([hidden]) [data-stage-tile]',
          ),
        ];
        return t.length
          ? Math.max(
              ...t.map((el) =>
                Math.abs(Number(el.style.getPropertyValue(k)) || 0),
              ),
            )
          : null;
      }, key),
    );
    await page.waitForTimeout(50);
  }
  const dys = samples.filter((v) => v !== null);
  const played = dys.length > 2 && dys[0] > 0.05 && dys.at(-1) < 0.01;
  report(
    `all-packs-arrival-${size}`,
    played,
    `largest tile offset over 0.8 s: ${dys.map((v) => v.toFixed(3)).join(' ')}`,
  );
  await ctx.close();
}

// reduced motion: today's pack page; no JS: the tile links to it
{
  const { ctx, page } = await open('phone', { reducedMotion: 'reduce' });
  await page.goto(`${BASE}/home-preview?debug=1&loader=never`, {
    waitUntil: 'load',
  });
  await reject(page);
  await page.waitForTimeout(2500);
  await tapCentre(page);
  await page.waitForURL(/\/slots\//, { timeout: 15000 }).catch(() => {});
  const p = await page.evaluate(() => ({
    path: location.pathname,
    stage: !!document.querySelector('[data-stage-root]'),
  }));
  report(
    'reduced-motion-tap',
    p.path === `/slots/${SLUG}` && !p.stage,
    `${p.path}, stage on the page ${p.stage}`,
  );
  await ctx.close();
  const html = await (await fetch(`${BASE}/home-preview`)).text();
  report(
    'no-js-link',
    html.includes(`href="/slots/${SLUG}`),
    'the server HTML links the tile to its pack page',
  );
}

await browser.close();
console.log(failures === 0 ? 'all passed' : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
