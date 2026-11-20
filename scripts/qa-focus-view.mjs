// QA for the focused pack view on /home-preview (the production server with
// HOME_PREVIEW=1). Headless Chrome, muted (--mute-audio plus a media guard),
// logged out; only the cookie banner's "Reject" is ever clicked.
//
//   node scripts/qa-focus-view.mjs [baseUrl]   (default http://localhost:4300)
//
// Checks, on a phone (390x844) and a desktop (1440x900) profile:
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
  await tapCentre(page);
  await settle(page, 1);

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

  await page.keyboard.press('Home');
  await settle(page, 1);
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
  page.on('framenavigated', (fr) => {
    if (fr === page.mainFrame()) loads++;
  });
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
    [...document.querySelectorAll('[data-testid="focus-stops"] section')].map(
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
  // the float-in moves the packs up into place: sample the art's top
  const samples = [];
  for (let i = 0; i < 14; i++) {
    samples.push(
      await page.evaluate(() => {
        const arts = [
          ...document.querySelectorAll(
            '[data-stage-panel]:not([hidden]) [data-stage-art]',
          ),
        ];
        return arts.length
          ? Math.min(...arts.map((el) => el.getBoundingClientRect().top))
          : null;
      }),
    );
    await page.waitForTimeout(60);
  }
  const tops = samples.filter((v) => v !== null);
  const moved = tops.length > 2 && Math.max(...tops) - Math.min(...tops) > 4;
  report(
    `all-packs-arrival-${size}`,
    moved,
    `art top over 0.8 s: ${tops.map((v) => Math.round(v)).join(' ')}`,
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
