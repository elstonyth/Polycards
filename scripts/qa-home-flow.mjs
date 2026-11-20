// QA for the full-page flow's address, history, restore and keys on
// /home-preview (full-flow plan 2.8, 2.9 and 2.10; work package 3b), on the
// production server with HOME_PREVIEW=1. Headless Chrome, muted
// (--mute-audio plus a media guard), logged out; only the cookie banner's
// "Reject" is ever clicked.
//
//   node scripts/qa-home-flow.mjs [baseUrl] [--only=phone|desktop]
//                                           (default http://localhost:4300)
//
// Writes its tables and frames to QA_OUT (default
// docs/research/home-3d/full-flow/checkpoints/wp3b).
//
// Checks, on a phone (390x844, touch) and a desktop (1440x900, wheel):
// - from the row a notch or a swipe lands on Front in 1.46-1.52 s (timed
//   from the gesture to the landing frame in the driver's own trace);
// - each stop in turn, down to the free part and back up to the row: the
//   rest, the text block, the address and history.length at every rest;
//   scrolling never adds an entry, and leaving the details puts the base
//   path back;
// - the text switches 20% into a move down and 80% into it up (D06);
// - a tap 300 ms into a move: the move still lands on its stop (fault 1);
// - (phone) swipes at 30, 44, 46 and 60 degrees from vertical end on a rest
//   (fault 2);
// - Back and Forward across a tap entry and across a leave; a scroll entry
//   adds no entry (Back leaves the page);
// - the keys at the row, at a middle stop, at Closing and in the free part,
//   and focus landing in the row's tabs while focused;
// - a reload at the row, at a middle stop and in the free part.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const BASE =
  args.find((a) => !a.startsWith('--')) ??
  process.env.PW_BASE ??
  'http://localhost:4300';
const ONLY = (args.find((a) => a.startsWith('--only=')) ?? '=').split('=')[1];
/** --part=pass,motion,nav,keys,reload: run only these groups. */
const PARTS = (args.find((a) => a.startsWith('--part=')) ?? '=')
  .split('=')[1]
  .split(',')
  .filter(Boolean);
const part = (p) => PARTS.length === 0 || PARTS.includes(p);
const OUT =
  process.env.QA_OUT ?? 'docs/research/home-3d/full-flow/checkpoints/wp3b';
const SLUG = '151';
const PREVIEW = '/home-preview';
/** The landing window for one move [plan 2.2: 1.46-1.5 s]; the landing frame may come up to one frame (measured) after it. */
const LAND_MS = [1460, 1500];
mkdirSync(OUT, { recursive: true });

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

/** The scroll at the document's load, before any script of ours ran. */
function loadScroll() {
  addEventListener('load', () => {
    window.__loadY = scrollY;
  });
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
  // instant native scrolling: the browser's own key scrolls in the free part
  // land at once (a headless software-rendered browser can hold a smooth key
  // scroll back for seconds); the flow's own moves are written by script
  args: [
    '--mute-audio',
    '--disable-smooth-scrolling',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--ignore-gpu-blocklist',
  ],
});

async function open(size) {
  const ctx = await browser.newContext(PROFILES[size]);
  await ctx.addInitScript(mute);
  await ctx.addInitScript(loadScroll);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  const cdp = size === 'phone' ? await ctx.newCDPSession(page) : null;
  return { ctx, page, cdp, size };
}

async function reject(page) {
  const b = page.getByRole('button', { name: 'Reject', exact: true });
  await b
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => b.click())
    .catch(() => {});
}

/** The stage is ready and the focused view's chunk has loaded. */
async function ready(page) {
  await page.waitForFunction(
    () =>
      window.__packStage?.ready?.() &&
      typeof window.__packStage.focus === 'function' &&
      window.__packStage.focus() !== null &&
      window.__packStage.flow?.().on,
    null,
    { timeout: 40000 },
  );
  await page.waitForTimeout(800);
}

async function load(s, path = PREVIEW) {
  await s.page.goto(`${BASE}${path}?stage=3d&debug=1&loader=never`, {
    waitUntil: 'load',
  });
  await reject(s.page);
  await ready(s.page);
}

const snap = (page) =>
  page.evaluate(() => {
    const ps = window.__packStage;
    const f = ps?.focus?.() ?? null;
    const fl = ps?.flow?.() ?? null;
    const sec = document.querySelector(
      '[data-testid="focus-stops"] section[data-on]',
    );
    return {
      path: location.pathname,
      len: history.length,
      idx: window.navigation?.currentEntry?.index ?? null,
      y: Math.round(scrollY * 10) / 10,
      on: !!f?.on,
      focus: f?.on ? f.focus : 0,
      past: !!f?.past,
      block: f?.on ? (sec?.getAttribute('data-kind') ?? null) : null,
      flowOn: !!fl?.on,
      busy: !!fl?.busy,
      stops: fl?.stops ?? [],
      exitEnd: fl?.table?.exitEnd ?? null,
      edge: fl?.table?.edge ?? null,
      kinds: f?.kinds ?? [],
      stage: !!document.querySelector('[data-stage-root]'),
    };
  });

/** Waits for the page to rest: no move, the scroll still for 300 ms. */
async function rest(page, timeout = 6000) {
  const t0 = Date.now();
  let last = null;
  let still = 0;
  while (Date.now() - t0 < timeout) {
    const s = await snap(page);
    if (!s.busy && last && Math.abs(s.y - last.y) < 0.5) still++;
    else still = 0;
    last = s;
    if (still >= 3) break;
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(150);
  return snap(page);
}

async function swipe(s, x0, y0, x1, y1) {
  const { cdp, page } = s;
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

/** One gesture: a swipe on the phone, a wheel notch on the desktop. */
async function gesture(s, dir) {
  if (s.cdp) {
    if (dir > 0) await swipe(s, 200, 600, 200, 380);
    else await swipe(s, 200, 380, 200, 600);
  } else {
    await s.page.mouse.move(720, 450);
    await s.page.mouse.wheel(0, dir * 120);
  }
}

async function tap(s, x, y) {
  if (s.cdp) {
    await s.cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y }],
    });
    await s.cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  } else await s.page.mouse.click(x, y);
}

async function tapCentre(page) {
  const art = page.locator(
    `[data-stage-panel]:not([hidden]) [data-stage-tile][data-pack-id="${SLUG}"] [data-stage-art]`,
  );
  const b = await art.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

const shot = (page, size, name) =>
  page.screenshot({ path: `${OUT}/${size}-${name}.png` });
const onRest = (s) => s.stops.some((v) => Math.abs(v - s.y) < 1);
const near = (a, b) => a !== null && b !== null && Math.abs(a - b) < 1;

async function key(page, k, wait = true) {
  await page.keyboard.press(k);
  await page.waitForTimeout(120);
  return wait ? rest(page) : snap(page);
}

/**
 * A key the page must leave to the browser: whether anything cancelled it
 * (read by a window listener added after the flow's), and the scroll once
 * the browser's own smooth key scroll has moved (it can start late in a
 * headless software-rendered browser: up to 2.5 s is allowed).
 */
async function nativeKey(page, k) {
  await page.evaluate(() => {
    window.__keyLog = [];
    if (window.__keyLogOn) return;
    window.__keyLogOn = true;
    addEventListener('keydown', (e) =>
      window.__keyLog.push([e.key, e.defaultPrevented]),
    );
  });
  const y0 = await page.evaluate(() => scrollY);
  await page.keyboard.press(k);
  const t0 = Date.now();
  while (Date.now() - t0 < 2500) {
    await page.waitForTimeout(100);
    if (Math.abs((await page.evaluate(() => scrollY)) - y0) > 1) break;
  }
  const r = await rest(page);
  const log = await page.evaluate(() => window.__keyLog);
  return { ...r, cancelled: log.some(([, p]) => p), keyLog: log };
}

const table = (rows) =>
  [
    '| step | address | history.length | entry index | scrollY | focus | block |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.step} | ${r.path} | ${r.len} | ${r.idx} | ${r.y} | ${r.on ? r.focus : 'row'} | ${r.block ?? ''} |`,
    ),
  ].join('\n');

const sizes = ONLY ? [ONLY] : ['phone', 'desktop'];

for (const size of sizes) {
  // ---- entry timing, each stop down and up, history at every rest ----
  if (part('pass')) {
    const s = await open(size);
    const { page } = s;
    await load(s);
    const s0 = await snap(page);
    const rows = [{ step: 'row', ...s0 }];
    await shot(page, size, 'pass-row');
    // the move's end: the first frame the driver no longer reports a move
    const landed = page.evaluate(
      () =>
        new Promise((done) => {
          let seen = false;
          const t0 = performance.now();
          const tick = () => {
            const busy = window.__packStage.flow().busy;
            if (busy) seen = true;
            if (seen && !busy) done(performance.now());
            else if (performance.now() - t0 > 5000) done(null);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    await gesture(s, 1);
    const landAt = await landed;
    let r = await rest(page);
    const tr = await page.evaluate(() => window.__packStage.spinTrace());
    const g = tr.gestures.at(-1);
    const ms = landAt !== null && g ? Math.round(landAt - g) : null;
    // one frame of this browser (median gap of the driver's trace)
    const gaps = tr.trace
      .slice(1)
      .map(([t], i) => t - tr.trace[i][0])
      .filter((v) => v > 0 && v < 100)
      .sort((a, b) => a - b);
    const frame = gaps[Math.floor(gaps.length / 2)] ?? 17;
    report(
      `entry-timing-${size}`,
      ms !== null && ms >= LAND_MS[0] && ms <= LAND_MS[1] + 1.5 * frame,
      `gesture to the move's end on Front: ${ms} ms (window ${LAND_MS[0]}-${LAND_MS[1]} ms plus one frame of ${frame.toFixed(1)} ms; scroll ${r.y}, Front at ${r.stops[1]})`,
    );
    report(
      `entry-address-${size}`,
      r.on &&
        r.path === `/slots/${SLUG}` &&
        r.len === s0.len &&
        r.idx === s0.idx,
      `address ${r.path}, history.length ${s0.len} -> ${r.len}, entry ${s0.idx} -> ${r.idx}`,
    );
    rows.push({ step: 'down: Front', ...r });
    await shot(page, size, 'pass-down-1');
    const n = r.kinds.length;
    let down = true;
    for (let k = 2; k <= n; k++) {
      await gesture(s, 1);
      r = await rest(page);
      rows.push({ step: `down: ${r.kinds[k - 1]}`, ...r });
      await shot(page, size, `pass-down-${k}`);
      down &&=
        near(r.y, r.stops[k]) &&
        Math.abs(r.focus - k) < 1e-3 &&
        r.block === r.kinds[k - 1] &&
        r.path === `/slots/${SLUG}` &&
        r.len === s0.len;
    }
    report(
      `each-stop-down-${size}`,
      down,
      rows
        .slice(2)
        .map((x) => `${x.block}@${x.y}`)
        .join(' '),
    );
    await gesture(s, 1);
    r = await rest(page);
    rows.push({ step: 'down: free part', ...r });
    await shot(page, size, 'pass-down-free');
    report(
      `leave-down-address-${size}`,
      near(r.y, r.exitEnd) &&
        r.past &&
        r.path === PREVIEW &&
        r.len === s0.len &&
        r.idx === s0.idx,
      `scroll ${r.y} (exit end ${r.exitEnd}), address ${r.path}, history.length ${r.len}, entry ${r.idx}`,
    );
    // back up: from just below the paged edge one up gesture rests on Closing
    await page.evaluate((e) => window.scrollTo(0, e + 40), r.edge);
    await page.waitForTimeout(400);
    await gesture(s, -1);
    r = await rest(page);
    rows.push({ step: 'up: Closing', ...r });
    await shot(page, size, 'pass-up-closing');
    report(
      `up-into-closing-${size}`,
      near(r.y, r.stops[n]) &&
        r.block === 'closing' &&
        r.path === `/slots/${SLUG}` &&
        r.len === s0.len,
      `scroll ${r.y}, block ${r.block}, address ${r.path}, history.length ${r.len}`,
    );
    let up = true;
    for (let k = n - 1; k >= 1; k--) {
      await gesture(s, -1);
      r = await rest(page);
      rows.push({ step: `up: ${r.kinds[k - 1]}`, ...r });
      up &&=
        near(r.y, r.stops[k]) &&
        r.block === r.kinds[k - 1] &&
        r.path === `/slots/${SLUG}` &&
        r.len === s0.len;
    }
    report(
      `each-stop-up-${size}`,
      up,
      rows
        .slice(-(n - 1))
        .map((x) => `${x.block}@${x.y}`)
        .join(' '),
    );
    await gesture(s, -1);
    await page.waitForTimeout(400);
    r = await rest(page);
    rows.push({ step: 'up: row', ...r });
    await shot(page, size, 'pass-up-row');
    report(
      `history-unchanged-${size}`,
      !r.on &&
        near(r.y, s0.y) &&
        r.path === PREVIEW &&
        r.len === s0.len &&
        r.idx === s0.idx,
      `back on the row ${!r.on}, address ${r.path}, history.length ${s0.len} -> ${r.len}`,
    );
    writeFileSync(`${OUT}/history-${size}.md`, table(rows) + '\n');
    writeFileSync(`${OUT}/history-${size}.json`, JSON.stringify(rows, null, 2));
    report(
      `errors-pass-${size}`,
      page.errors.length === 0,
      page.errors.join(' | '),
    );
    await s.ctx.close();
  }

  // ---- text timing (D06), a tap mid-move, diagonal swipes ----
  if (part('motion')) {
    const s = await open(size);
    const { page } = s;
    await load(s);
    await gesture(s, 1);
    let r = await rest(page);
    const rec = () =>
      page.evaluate(
        () =>
          new Promise((done) => {
            const out = [];
            const t0 = performance.now();
            const tick = () => {
              const sec = document.querySelector(
                '[data-testid="focus-stops"] section[data-on]',
              );
              out.push([scrollY, sec?.getAttribute('data-kind') ?? null]);
              if (performance.now() - t0 < 1800) requestAnimationFrame(tick);
              else done(out);
            };
            requestAnimationFrame(tick);
          }),
      );
    const switchAt = (samples, a, b, from) => {
      for (let i = 1; i < samples.length; i++)
        if (samples[i][1] !== samples[i - 1][1] && samples[i - 1][1] === from)
          return 1 + (samples[i][0] - a) / (b - a);
      return null;
    };
    const [s1, s2] = [r.stops[1], r.stops[2]];
    const pDown = rec();
    await page.keyboard.press('ArrowDown');
    const pd = switchAt(await pDown, s1, s2, 'front');
    r = await rest(page);
    const pUp = rec();
    await page.keyboard.press('ArrowUp');
    const pu = switchAt(await pUp, s1, s2, r.kinds[1]);
    r = await rest(page);
    report(
      `text-timing-${size}`,
      pd !== null &&
        pu !== null &&
        pd >= 1.1 &&
        pd <= 1.35 &&
        pu >= 1.05 &&
        pu <= 1.3,
      `the block switches at P ${pd?.toFixed(3)} going down (20% in), ${pu?.toFixed(3)} going up (80% in)`,
    );

    // fault 1: a tap 300 ms into a move
    await gesture(s, 1);
    await page.waitForTimeout(300);
    await tap(s, s.cdp ? 30 : 30, s.cdp ? 300 : 450);
    await page.waitForTimeout(1600);
    r = await rest(page);
    report(
      `tap-mid-move-${size}`,
      near(r.y, r.stops[2]) && Math.abs(r.focus - 2) < 1e-3,
      `after a tap at 300 ms the page rests at ${r.y} (stop 2 at ${r.stops[2]})`,
    );

    if (s.cdp) {
      const ends = [];
      for (const deg of [30, 44, 46, 60]) {
        const a = (deg * Math.PI) / 180;
        const dx = 220 * Math.sin(a);
        const dy = 220 * Math.cos(a);
        await swipe(s, 195 - dx / 2, 640, 195 + dx / 2, 640 - dy);
        await page.waitForTimeout(300);
        r = await rest(page);
        ends.push({ deg, y: r.y, ok: onRest(r) });
      }
      report(
        `diagonal-swipes-${size}`,
        ends.every((e) => e.ok),
        ends
          .map((e) => `${e.deg}deg -> ${e.y}${e.ok ? '' : ' OFF A REST'}`)
          .join(', '),
      );
    }
    report(
      `errors-motion-${size}`,
      page.errors.length === 0,
      page.errors.join(' | '),
    );
    await s.ctx.close();
  }

  // ---- Back and Forward across an entry and a leave ----
  if (part('nav')) {
    const s = await open(size);
    const { page } = s;
    await page.goto(`${BASE}/about`, { waitUntil: 'load' });
    await reject(page);
    await load(s);
    const s0 = await snap(page);
    await tapCentre(page);
    let r = await rest(page);
    const tapped = r.on && r.path === `/slots/${SLUG}` && r.idx === s0.idx + 1;
    await page.goBack();
    await page.waitForTimeout(400);
    r = await rest(page);
    const back = !r.on && r.path === PREVIEW && r.idx === s0.idx;
    await shot(page, size, 'nav-tap-back');
    await page.goForward();
    await page.waitForTimeout(400);
    r = await rest(page);
    const fwd =
      r.on && r.path === `/slots/${SLUG}` && Math.abs(r.focus - 1) < 1e-3;
    await shot(page, size, 'nav-tap-forward');
    report(
      `back-forward-tap-entry-${size}`,
      tapped && back && fwd,
      `tap pushes ${tapped}, Back unfocuses ${back}, Forward refocuses on Front ${fwd}`,
    );
    // leave downwards from the tap entry: one step back, then Forward and Back
    const n = r.kinds.length;
    await page.keyboard.press('End');
    await page.waitForTimeout(200);
    r = await rest(page);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);
    r = await rest(page);
    const left = r.past && r.path === PREVIEW && r.idx === s0.idx;
    await shot(page, size, 'nav-leave-free');
    // Forward to the pack's entry while past the details: the page stays,
    // and the address is stepped back to the base path again
    await page.goForward();
    await page.waitForTimeout(800);
    r = await rest(page);
    const fwd2 = r.on && r.past && near(r.y, r.exitEnd) && r.path === PREVIEW;
    await shot(page, size, 'nav-leave-forward');
    // back up to the row with the keys: Home is the browser's in the free
    // part (the page lands on the row and the focus ends there)
    await page.keyboard.press('Home');
    await page.waitForTimeout(800);
    r = await rest(page, 8000);
    const back2 = !r.on && r.path === PREVIEW && near(r.y, s0.y);
    await shot(page, size, 'nav-leave-home');
    report(
      `back-forward-across-leave-${size}`,
      left && fwd2 && back2,
      `leaving down steps back ${left}; Forward keeps the free part with the base address ${fwd2} (scroll ${r.y}); Home returns to the row ${back2}`,
    );
    // a scroll entry adds no entry: Back leaves the page
    await gesture(s, 1);
    r = await rest(page);
    const scrolled = r.on && r.path === `/slots/${SLUG}` && r.idx === s0.idx;
    await page.goBack();
    await page.waitForLoadState('load').catch(() => {});
    await page.waitForTimeout(800);
    const after = new URL(page.url()).pathname;
    report(
      `scroll-entry-adds-no-entry-${size}`,
      scrolled && after === '/about',
      `scroll entry replaces the address ${scrolled}; Back lands on ${after}`,
    );
    report(
      `errors-nav-${size}`,
      page.errors.length === 0,
      page.errors.join(' | '),
    );
    await s.ctx.close();
  }

  // ---- the keys (plan 2.10) ----
  if (part('keys')) {
    const s = await open(size);
    const { page } = s;
    await load(s);
    await page.evaluate(() => document.activeElement?.blur());
    const s0 = await snap(page);
    const lines = [];
    const check = (name, ok, r) => {
      lines.push(
        `| ${name} | ${r.path} | ${r.len} | ${r.y} | ${r.on ? r.focus : 'row'} | ${r.block ?? ''} | ${ok ? 'PASS' : 'FAIL'} |`,
      );
      report(
        `key-${name}-${size}`,
        ok,
        `scroll ${r.y}, focus ${r.on ? r.focus : 'row'}, address ${r.path}`,
      );
    };
    const atRow = (r) => !r.on && near(r.y, s0.y) && r.path === PREVIEW;
    for (const k of ['ArrowUp', 'PageUp', 'Home', 'Escape']) {
      const r = await key(page, k);
      check(`row-${k}-nothing`, atRow(r), r);
    }
    let r = await key(page, 'ArrowDown');
    check(
      'row-ArrowDown-enters',
      r.on &&
        near(r.y, r.stops[1]) &&
        r.path === `/slots/${SLUG}` &&
        r.len === s0.len,
      r,
    );
    const n = r.kinds.length;
    for (const [k, to] of [
      ['ArrowDown', 2],
      ['Space', 3],
      ['Shift+Space', 2],
      ['PageDown', 3],
      ['PageUp', 2],
      ['ArrowUp', 1],
      ['PageDown', 2],
      ['ArrowDown', 3],
    ]) {
      r = await key(page, k);
      check(
        `stop-${k}-to-${to}`,
        r.on && near(r.y, r.stops[to]) && Math.abs(r.focus - to) < 1e-3,
        r,
      );
    }
    await shot(page, size, 'keys-middle');
    r = await key(page, 'Home');
    await page.waitForTimeout(600);
    r = await rest(page);
    check('middle-Home-to-row', atRow(r), r);
    r = await key(page, 'Space');
    check('row-Space-enters', r.on && near(r.y, r.stops[1]), r);
    r = await key(page, 'ArrowUp');
    await page.waitForTimeout(600);
    r = await rest(page);
    check('front-ArrowUp-to-row', atRow(r), r);
    r = await key(page, 'End');
    check(
      'row-End-to-closing',
      r.on && near(r.y, r.stops[n]) && r.block === 'closing',
      r,
    );
    await shot(page, size, 'keys-closing');
    r = await key(page, 'Escape');
    await page.waitForTimeout(600);
    r = await rest(page);
    check('closing-Escape-to-row', atRow(r), r);
    r = await key(page, 'End');
    r = await key(page, 'ArrowDown');
    check(
      'closing-ArrowDown-to-free',
      near(r.y, r.exitEnd) && r.past && r.path === PREVIEW && r.len === s0.len,
      r,
    );
    await shot(page, size, 'keys-free');
    const yFree = r.y;
    r = await key(page, 'Escape');
    check('free-Escape-nothing', near(r.y, yFree), r);
    r = await nativeKey(page, 'ArrowDown');
    const activeAt = await page.evaluate(() => {
      const a = document.activeElement;
      return `${a?.tagName ?? ''}${a?.getAttribute('data-testid') ? '#' + a.getAttribute('data-testid') : ''}`;
    });
    check(
      `free-ArrowDown-native(focus on ${activeAt})`,
      !r.cancelled && r.y > yFree + 1 && r.y > r.edge,
      r,
    );
    const y2 = r.y;
    r = await nativeKey(page, 'PageUp');
    check('free-PageUp-native', !r.cancelled && r.y < y2 - 100, r);
    r = await key(page, 'End');
    const max = await page.evaluate(
      () => document.documentElement.scrollHeight - innerHeight,
    );
    check('free-End-native', Math.abs(r.y - max) < 2, r);
    r = await key(page, 'Home');
    await page.waitForTimeout(800);
    r = await rest(page);
    check('free-Home-native-to-row', atRow(r), r);
    // focus landing in the row's tabs while focused goes back to the row
    r = await key(page, 'ArrowDown');
    r = await key(page, 'ArrowDown');
    const focusedTab = await page.evaluate(() => {
      const b = document.querySelector('[data-stage-head] button');
      b?.focus();
      return !!b && document.activeElement === b;
    });
    await page.waitForTimeout(300);
    r = await rest(page, 8000);
    check('focus-in-row-tabs-to-row', focusedTab && atRow(r), r);
    writeFileSync(
      `${OUT}/keys-${size}.md`,
      [
        '| key check | address | history.length | scrollY | focus | block | result |',
        '|---|---|---|---|---|---|---|',
        ...lines,
      ].join('\n') + '\n',
    );
    report(
      `errors-keys-${size}`,
      page.errors.length === 0,
      page.errors.join(' | '),
    );
    await s.ctx.close();
  }

  // ---- a reload at three rests (plan 2.8: a reload starts at the row) ----
  if (part('reload')) {
    const s = await open(size);
    const { page } = s;
    await load(s);
    const s0 = await snap(page);
    const reload = async () => {
      await page.reload({ waitUntil: 'load' });
      const loadY = await page.evaluate(() => window.__loadY ?? null);
      const path = new URL(page.url()).pathname;
      if (path === PREVIEW) await ready(page);
      else await page.waitForTimeout(2500);
      return { loadY, r: await rest(page) };
    };
    let x = await reload();
    await shot(page, size, 'reload-row');
    report(
      `reload-at-row-${size}`,
      x.r.flowOn && !x.r.on && near(x.r.y, s0.y),
      `scroll at load ${x.loadY}, then ${x.r.y}; flow on ${x.r.flowOn}; focused ${x.r.on}`,
    );
    await gesture(s, 1);
    await rest(page);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowDown');
    // the second key waits for the first move: page once more after it lands
    await rest(page);
    let r = await key(page, 'ArrowDown');
    await shot(page, size, 'reload-middle-before');
    x = await reload();
    await shot(page, size, 'reload-middle');
    report(
      `reload-at-middle-stop-${size}`,
      x.r.path === `/slots/${SLUG}` && !x.r.stage,
      `resting at ${r.block} (address ${r.path}); the reload serves ${x.r.path} ${x.r.stage ? 'with the preview stage' : 'as the pack page (not the preview)'}`,
    );
    await load(s);
    await page.keyboard.press('End');
    await page.waitForTimeout(200);
    await rest(page);
    r = await key(page, 'ArrowDown');
    await shot(page, size, 'reload-free-before');
    x = await reload();
    await shot(page, size, 'reload-free');
    const pose = await page.evaluate(() => ({
      focus: window.__packStage.state.focus,
      focusOn: window.__packStage.state.focusOn,
    }));
    report(
      `reload-in-free-part-${size}`,
      r.past &&
        x.r.path === PREVIEW &&
        x.r.flowOn &&
        !x.r.on &&
        near(x.r.y, s0.y) &&
        pose.focus === 0 &&
        pose.focusOn == null,
      `from ${r.y} (address ${r.path}, past ${r.past}): reload serves ${x.r.path}; scroll at load ${x.loadY}, then ${x.r.y}; flow on ${x.r.flowOn}; focused ${x.r.on}; state.focus ${pose.focus}; focusOn ${pose.focusOn}`,
    );
    report(
      `errors-reload-${size}`,
      page.errors.length === 0,
      page.errors.join(' | '),
    );
    await s.ctx.close();
  }
}

await browser.close();
console.log(failures === 0 ? 'all passed' : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
