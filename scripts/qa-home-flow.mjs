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
// - from the row a notch or a swipe lands on Front on the first frame at or
//   after 1.5 s (no earlier than 1.46 s), read from the gesture to the
//   landing frame in the driver's own trace;
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
// - a reload at the row, at a middle stop and in the free part;
// - (wp3c) the focused view's chunk failing: plain scrolling reaches the
//   sections below; a leave asked for off a rest; (phone) a second finger
//   and a finger landing mid-move past the paged edge; no tap on Closing's
//   controls anywhere past Closing; the 3D asleep in the free part and awake
//   again back at the lineup.
// - (lineup, work package 4) Closing to the lineup and back, per frame: the
//   chosen pack's centre and scale move one way only and never step faster
//   than the curve allows; the others fade in and out, never cut; when they
//   come into frame; the stop text gone at the lineup; the GPU estimate's
//   peak against the cap; the back let go past Closing + 0.5 and printed
//   again only at rest; a tap mid-move either way lands on its stop; (phone)
//   diagonal swipes at the lineup end on a rest.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const BASE =
  args.find((a) => !a.startsWith('--')) ??
  process.env.PW_BASE ??
  'http://localhost:4300';
const ONLY = (args.find((a) => a.startsWith('--only=')) ?? '=').split('=')[1];
/** --part=pass,motion,nav,keys,reload,wp3c,lineup: run only these groups. */
const PARTS = (args.find((a) => a.startsWith('--part=')) ?? '=')
  .split('=')[1]
  .split(',')
  .filter(Boolean);
const part = (p) => PARTS.length === 0 || PARTS.includes(p);
const OUT =
  process.env.QA_OUT ?? 'docs/research/home-3d/full-flow/checkpoints/wp3b';
const SLUG = '151';
const PREVIEW = '/home-preview';
/** The landing window for one move [plan 2.2: 1.46-1.5 s]; the landing frame is the first frame at or after it. */
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
      // the stop text layer and the panel's taps
      text: (() => {
        const el = document.querySelector('[data-testid="focus-stops"]');
        return el ? getComputedStyle(el).visibility : null;
      })(),
      inert: !!document.querySelector('[data-spin-wrap]')?.inert,
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
    // The move starts at the gesture's own time and ends on the first frame
    // at or after 1.5 s. So the end time includes that frame's own length.
    // On this headless software renderer frames of 45-60 ms come in every
    // part of the move, against a median of about 28: renderer jitter, not
    // a hitch at the landing, and not growing with the zoom (measured with
    // full-flow/checkpoints/wp4/entry-timing-probe.mjs). A fixed allowance
    // of median frames failed whenever a long frame crossed 1.5 s. So the
    // check reads the landing frame from the driver's trace instead: the
    // last frame drawn before the move was seen to end. It passes when that
    // frame is at least 1460 ms after the gesture, the frame before it came
    // before 1500 ms (the move did not run on past its end), and the scroll
    // there is Front.
    const endIdx =
      landAt === null || !g
        ? -1
        : tr.trace.findLastIndex(([t]) => t <= landAt && t > g);
    const endF = endIdx > 0 ? tr.trace[endIdx] : null;
    const prevF = endIdx > 0 ? tr.trace[endIdx - 1] : null;
    const endMs = endF ? endF[0] - g : null;
    const prevMs = prevF ? prevF[0] - g : null;
    report(
      `entry-timing-${size}`,
      endMs !== null &&
        prevMs !== null &&
        endMs >= LAND_MS[0] &&
        prevMs < LAND_MS[1] &&
        Math.abs(endF[1] - r.stops[1]) < 1,
      `gesture to the move's end on Front: ${ms} ms; landing frame at ${endMs?.toFixed(1)} ms, the frame before at ${prevMs?.toFixed(1)} ms (window ${LAND_MS[0]}-${LAND_MS[1]} ms; median frame ${frame.toFixed(1)} ms; scroll ${r.y}, Front at ${r.stops[1]})`,
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
    // Closing to the lineup (work package 4): a rest, the address back to the
    // base path, the stop text gone, the panel taking no taps
    await gesture(s, 1);
    r = await rest(page);
    rows.push({ step: 'down: lineup', ...r });
    await shot(page, size, 'pass-down-lineup');
    report(
      `lineup-rest-${size}`,
      near(r.y, r.stops[n + 1]) &&
        r.stops.length === n + 2 &&
        r.on &&
        r.past &&
        r.text === 'hidden' &&
        r.inert &&
        r.path === PREVIEW &&
        r.len === s0.len &&
        r.idx === s0.idx,
      `scroll ${r.y} (lineup ${r.stops[n + 1]}), past ${r.past}, stop text ${r.text}, inert ${r.inert}, address ${r.path}, history.length ${r.len}`,
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
    // back up: from just below the paged edge one up gesture rests on the
    // lineup (ours stops at every section), the next on Closing
    await page.evaluate((e) => window.scrollTo(0, e + 40), r.edge);
    await page.waitForTimeout(400);
    await gesture(s, -1);
    r = await rest(page);
    rows.push({ step: 'up: lineup', ...r });
    await shot(page, size, 'pass-up-lineup');
    report(
      `up-into-lineup-${size}`,
      near(r.y, r.stops[n + 1]) && r.path === PREVIEW && r.len === s0.len,
      `scroll ${r.y} (lineup ${r.stops[n + 1]}), address ${r.path}, history.length ${r.len}`,
    );
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
    // End pages to the lineup (plan 2.10, work package 4)
    r = await key(page, 'End');
    check(
      'row-End-to-lineup',
      r.on && near(r.y, r.stops[n + 1]) && r.past && r.path === PREVIEW,
      r,
    );
    await shot(page, size, 'keys-lineup');
    r = await key(page, 'ArrowUp');
    check(
      'lineup-ArrowUp-to-closing',
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
      'lineup-ArrowDown-to-free',
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

  // ---- the review fixes (work package 3c) ----
  if (part('wp3c')) {
    // the focused view's chunk cannot be had: the page reads as plain
    // scrolling and the sections below are reached
    {
      const s = await open(size);
      const { page } = s;
      let aborted = 0;
      await page.route(/pack-stage-focus\.[^/]*\.js/, (r) => {
        aborted++;
        return r.abort('failed');
      });
      await page.goto(BASE + PREVIEW + '?stage=3d&debug=1&loader=never', {
        waitUntil: 'load',
      });
      await reject(page);
      await page.waitForFunction(
        () =>
          window.__packStage?.ready?.() && window.__packStage.flow?.().bound,
        null,
        { timeout: 40000 },
      );
      await page.waitForTimeout(3500);
      const f0 = await page.evaluate(() => window.__packStage.flow());
      const vh = PROFILES[size].viewport.height;
      let top = null;
      for (let i = 0; i < 5; i++) {
        if (s.cdp) await swipe(s, 200, 650, 200, 250);
        else {
          await page.mouse.move(720, 450);
          await page.mouse.wheel(0, 400);
        }
        await page.waitForTimeout(600);
        top = await page.evaluate(() =>
          Math.round(
            document
              .querySelector('[data-flow-section]')
              ?.getBoundingClientRect().top ?? 1e9,
          ),
        );
        if (top < vh) break;
      }
      await shot(page, size, 'wp3c-chunk-failed');
      report(
        'chunk-failure-' + size,
        !f0.on && f0.focusFailed && aborted >= 1 && top !== null && top < vh,
        'flow on ' +
          f0.on +
          ', failed ' +
          f0.focusFailed +
          ', requests aborted ' +
          aborted +
          '; the first section below at ' +
          top +
          ' px (viewport ' +
          vh +
          ')',
      );
      report(
        'errors-chunk-' + size,
        page.errors.length === 0,
        page.errors.join(' | '),
      );
      await s.ctx.close();
    }

    // a second finger: the pinch leaves the page off its rest, which snaps
    // back, and the driver's loop goes to sleep
    // (its own page: the pinch zooms it, which later checks must not inherit)
    if (size === 'phone') {
      const s = await open(size);
      const { page } = s;
      await load(s);
      await gesture(s, 1);
      const fr = await rest(page);
      await s.cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: 150, y: 500, id: 1 }],
      });
      await s.cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { x: 150, y: 500, id: 1 },
          { x: 250, y: 520, id: 2 },
        ],
      });
      for (let i = 1; i <= 4; i++) {
        await s.cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            { x: 150 - i * 10, y: 500, id: 1 },
            { x: 250 + i * 10, y: 520, id: 2 },
          ],
        });
        await page.waitForTimeout(16);
      }
      await s.cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [{ x: 110, y: 500, id: 1 }],
      });
      await s.cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      // the pinch's zoom moved the page off its rest
      await page.evaluate(() => window.scrollBy(0, 150));
      await page.waitForTimeout(1500);
      const r = await rest(page);
      await page.waitForTimeout(600);
      const looping = await page.evaluate(
        () => window.__packStage.flow().looping,
      );
      report(
        'second-finger-' + size,
        fr.on && r.on && near(r.y, fr.y) && !looping,
        'Front at ' +
          fr.y +
          '; after the pinch the page rests at ' +
          r.y +
          ', the loop ' +
          (looping ? 'still runs' : 'sleeps'),
      );
      await s.ctx.close();
    }

    const s = await open(size);
    const { page } = s;
    await load(s);
    const s0 = await snap(page);

    // a leave asked for while the page is off its rest (it snaps back
    // during the text's fade): the leave still runs
    if (!s.cdp) {
      await gesture(s, 1);
      const fr = await rest(page);
      await page.evaluate(() => {
        window.scrollBy(0, 200);
        setTimeout(
          () =>
            document.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
            ),
          60,
        );
      });
      await page.waitForTimeout(3000);
      const r = await rest(page);
      report(
        'leave-off-rest-' + size,
        fr.on && !r.on && near(r.y, s0.y),
        'focused at ' +
          fr.y +
          '; Escape after a scroll off the rest: focused ' +
          r.on +
          ', scroll ' +
          r.y +
          ' (row ' +
          s0.y +
          ')',
      );
    }

    // to Closing (End pages to the lineup, ArrowUp back), and its controls
    await page.keyboard.press('End');
    await page.waitForTimeout(200);
    await rest(page);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(200);
    let r = await rest(page);
    const engineAt = () =>
      page.evaluate(() => ({
        present: window.__packStage.present?.() ?? null,
        running: window.__packStage.running(),
        gpu: window.__packStage.stats()?.gpuBytesEstimate ?? null,
        live: window.__packStage.live(),
        shown: window.__packStage.flow().shown,
      }));
    const e0 = await engineAt();
    const pts = await page.evaluate(() => {
      const c = (el) => {
        const b = el?.getBoundingClientRect();
        return b && b.width > 0
          ? [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]
          : null;
      };
      const on = '[data-testid="focus-stops"] section[data-on]';
      return Object.fromEntries(
        Object.entries({
          open: c(document.querySelector(on + ' button')),
          allPacks: c([...document.querySelectorAll(on + ' button')].at(-1)),
          tab: c(document.querySelector('[data-stage-head] button')),
          tile: c(
            document.querySelector(
              '[data-stage-panel]:not([hidden]) [data-stage-tile][data-pack-id="151"] [data-stage-art]',
            ),
          ),
        }).filter(([, v]) => v),
      );
    });

    // on to the lineup; then a finger that lands while the move from the
    // lineup crosses the paged edge: the move still lands on the exit end,
    // the page never following it
    await gesture(s, 1);
    r = await rest(page);
    const lineupY = r.y;
    if (s.cdp) {
      await gesture(s, 1);
      await page
        .waitForFunction((edge) => window.scrollY > edge, r.edge, {
          timeout: 3000,
          polling: 16,
        })
        .catch(() => {});
      // whether the page cancels each move of the finger (read by a window
      // listener added after the flow's): the page must never follow it
      await page.evaluate(() => {
        window.__moveLog = [];
        if (window.__moveLogOn) return;
        window.__moveLogOn = true;
        addEventListener(
          'touchmove',
          (e) => window.__moveLog.push(e.defaultPrevented),
          { passive: true },
        );
      });
      const yIn = await page.evaluate(() => scrollY);
      const ys = page.evaluate(
        () =>
          new Promise((done) => {
            const out = [];
            const t0 = performance.now();
            const tick = () => {
              out.push(scrollY);
              if (performance.now() - t0 < 1200) requestAnimationFrame(tick);
              else done(out);
            };
            requestAnimationFrame(tick);
          }),
      );
      await swipe(s, 200, 300, 200, 600);
      const seq = await ys;
      const back = seq.some((v, i) => i > 0 && v < seq[i - 1] - 0.5);
      const moves = await page.evaluate(() => window.__moveLog);
      const kept = moves.length > 0 && moves.every(Boolean);
      r = await rest(page);
      report(
        'edge-touch-mid-move-' + size,
        yIn > r.edge && kept && !back && near(r.y, r.exitEnd),
        'finger at ' +
          Math.round(yIn) +
          ' (edge ' +
          r.edge +
          '); the scroll ' +
          (back ? 'went back under it' : 'kept going') +
          ', ' +
          moves.filter(Boolean).length +
          ' of ' +
          moves.length +
          ' moves cancelled' +
          ', landing ' +
          r.y +
          ' (exit end ' +
          r.exitEnd +
          ')',
      );
    } else {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(200);
      r = await rest(page);
    }

    // nothing of Closing takes a tap anywhere past Closing: the lineup, the
    // paged edge, the exit
    const t = await page.evaluate(() => window.__packStage.flow().table);
    const ysTap = [
      Math.round(t.rl),
      Math.round(t.edge + 10),
      ...[0, 0.25, 0.5, 0.75, 1].map((f) =>
        Math.round(t.exitStart + f * (t.exitEnd - t.exitStart)),
      ),
    ];
    const tapRows = [];
    let tapsOk = true;
    for (const y of ysTap) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(400);
      const hit = await page.evaluate((p) => {
        const o = {};
        for (const [k, [x, yy]] of Object.entries(p)) {
          const el = document.elementFromPoint(x, yy);
          o[k] = el?.closest('[data-stage-root]') ? 'PANEL' : 'page';
        }
        return { o, y: Math.round(scrollY) };
      }, pts);
      const bad = Object.values(hit.o).includes('PANEL');
      tapsOk &&= !bad;
      tapRows.push(
        '| ' +
          hit.y +
          ' | ' +
          Object.entries(hit.o)
            .map(([k, v]) => k + ' ' + v)
            .join(', ') +
          ' |',
      );
    }
    writeFileSync(
      OUT + '/wp3c-taps-' + size + '.md',
      [
        '| scrollY | what a tap at each Closing control hits |',
        '|---|---|',
        ...tapRows,
      ].join('\n') + '\n',
    );
    report(
      'no-tap-past-closing-' + size,
      tapsOk && Object.keys(pts).length >= 3,
      Object.keys(pts).join(', ') +
        ' at ' +
        ysTap.join(', ') +
        ': ' +
        (tapsOk
          ? 'none lands on the panel'
          : 'a tap lands on the hidden panel'),
    );

    // the 3D sleeps in the free part, and wakes on the way back to the lineup
    await page.evaluate((v) => window.scrollTo(0, v), t.exitEnd);
    await page.waitForTimeout(1500);
    const e1 = await engineAt();
    // back up: the scrollbar into the paged part, which snaps to the lineup
    await page.evaluate((v) => window.scrollTo(0, v), t.edge - 50);
    await page.waitForTimeout(300);
    r = await rest(page);
    await page.waitForTimeout(400);
    const e2 = await engineAt();
    const MB = (b) => (b === null ? null : Math.round((b / 1048576) * 10) / 10);
    report(
      'engine-sleeps-in-the-free-part-' + size,
      e0.present === true &&
        e1.present === false &&
        !e1.running &&
        e2.present === true &&
        e2.running &&
        near(r.y, lineupY) &&
        e2.live.length > 0,
      'Closing: present ' +
        e0.present +
        ', running ' +
        e0.running +
        ', ' +
        MB(e0.gpu) +
        ' MB; free part: present ' +
        e1.present +
        ', running ' +
        e1.running +
        ', ' +
        MB(e1.gpu) +
        ' MB; back at the lineup (' +
        r.y +
        '): present ' +
        e2.present +
        ', running ' +
        e2.running +
        ', drawn ' +
        e2.live.join(','),
    );
    report(
      'errors-wp3c-' + size,
      page.errors.length === 0,
      page.errors.join(' | '),
    );
    await s.ctx.close();
  }

  // ---- Closing to the lineup and back (work package 4) ----
  if (part('lineup')) {
    const s = await open(size);
    const { page } = s;
    await load(s);
    // to Closing (End pages to the lineup, ArrowUp back), the back printed
    await page.keyboard.press('End');
    await page.waitForTimeout(200);
    await rest(page);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(200);
    let r = await rest(page);
    await page.waitForTimeout(2500);
    const n = r.kinds.length;
    const closingY = r.stops[n];
    const lineupY = r.stops[n + 1];
    const backAtClosing = await page.evaluate(
      () => window.__packStage.runtime?.()?.focusBack?.state ?? null,
    );
    /** Every frame for `ms`: the chosen pack as drawn, the others, the GPU, the back. */
    const record = (ms) =>
      page.evaluate(
        (len) =>
          new Promise((done) => {
            const out = [];
            const t0 = performance.now();
            const index = window.__packStage.state.focusOn?.ctx?.index ?? null;
            const tick = () => {
              const ps = window.__packStage;
              const rt = ps.runtime?.();
              const all = rt?.drawn ?? [];
              const tx = document.querySelector('[data-testid="focus-stops"]');
              out.push({
                t: performance.now() - t0,
                y: scrollY,
                spin: ps.state.spin,
                foc: all.find((d) => d.index === index) ?? null,
                others: all
                  .filter((d) => d.index !== index && d.opacity > 0.001)
                  .map((d) => [d.id, d.opacity]),
                live: (ps.live?.() ?? []).length,
                gpu: ps.stats?.()?.gpuBytesEstimate ?? 0,
                back: rt?.focusBack?.state ?? null,
                busy: ps.flow().busy,
                text: tx ? Number(getComputedStyle(tx).opacity) : null,
              });
              if (performance.now() - t0 < len) requestAnimationFrame(tick);
              else done(out);
            };
            requestAnimationFrame(tick);
          }),
        ms,
      );
    const MOVE = 1500;
    /** The chosen pack along the move (qa-focus-frames' rule): one way, no step faster than the curve allows. */
    const curve = (frames) => {
      const mv = frames.filter(
        (f, i) => f.foc && (i === 0 || f.foc.at !== frames[i - 1].foc?.at),
      );
      const bad = [];
      const a0 = mv[0]?.foc;
      const a1 = mv.at(-1)?.foc;
      if (!a0 || !a1) return ['the chosen pack was not drawn'];
      const span = {
        scale: Math.abs(a1.scale - a0.scale),
        pos: Math.hypot(a1.x - a0.x, a1.y - a0.y),
      };
      const allow = (dt, v) => ((v * 3 * dt) / MOVE) * 1.3 + v * 0.01;
      const want = Math.sign(a1.scale - a0.scale);
      let prevD = 0;
      for (let i = 1; i < mv.length; i++) {
        const a = mv[i - 1].foc;
        const b = mv[i].foc;
        const dt = b.at - a.at;
        const ds = b.scale - a.scale;
        if (ds * want < -span.scale * 0.01)
          bad.push(
            `scale went back ${a.scale.toFixed(3)} -> ${b.scale.toFixed(3)}`,
          );
        if (Math.abs(ds) > allow(dt, span.scale))
          bad.push(
            `scale step ${Math.abs(ds).toFixed(3)} in ${dt.toFixed(0)} ms`,
          );
        const dp = Math.hypot(b.x - a.x, b.y - a.y);
        if (dp > allow(dt, span.pos))
          bad.push(`centre step ${dp.toFixed(3)} in ${dt.toFixed(0)} ms`);
        // one way: the distance from the start never shrinks
        const d = Math.hypot(b.x - a0.x, b.y - a0.y);
        if (d < prevD - span.pos * 0.01) bad.push('centre went back');
        prevD = Math.max(prevD, d);
      }
      return bad;
    };
    /** The others' opacity, frame to frame: a fade, never a cut. */
    const ramp = (frames) => {
      const bad = [];
      for (let i = 1; i < frames.length; i++) {
        const a = new Map(frames[i - 1].others);
        const b = new Map(frames[i].others);
        const span = Math.max(1, (frames[i].t - frames[i - 1].t) / (1000 / 60));
        for (const id of new Set([...a.keys(), ...b.keys()])) {
          const d = Math.abs((b.get(id) ?? 0) - (a.get(id) ?? 0));
          if (d > 0.15 * span)
            bad.push(
              `${id} ${(a.get(id) ?? 0).toFixed(2)} -> ${(b.get(id) ?? 0).toFixed(2)}`,
            );
        }
      }
      return bad;
    };
    const MB = (b) => Math.round((b / 1048576) * 10) / 10;
    const cap = size === 'phone' ? 40 : 96;
    // down: Closing to the lineup
    const pd = record(2600);
    await gesture(s, 1);
    const down = await pd;
    r = await rest(page);
    await shot(page, size, 'lineup-rest');
    const cd = curve(down);
    report(
      `closing-to-lineup-pack-follows-the-curve-${size}`,
      cd.length === 0 && near(r.y, lineupY),
      `${down.length} frames, landing ${r.y} (lineup ${lineupY})${cd.length ? '; ' + cd.slice(0, 3).join('; ') : ''}`,
    );
    const rd = ramp(down);
    report(
      `closing-to-lineup-others-fade-in-${size}`,
      rd.length === 0 && down.at(-1).others.length > 0,
      `${down.at(-1).others.length} others drawn at the end${rd.length ? '; cuts: ' + rd.slice(0, 3).join('; ') : ''}`,
    );
    // when the others come into frame, from the move's own start (its first
    // frame with the hand-off under way; the recording starts before the
    // gesture), counting a pack once it is in frame at 25% opacity or more
    // (the reference: 1 to the full row between 25% and 74% of the move
    // [measured D §C])
    {
      const i0 = Math.max(0, down.findIndex((f) => f.spin > 0) - 1);
      const t0 = down[i0].t;
      const full = down.at(-1).live;
      const seen = (f) =>
        f.live > 1 && Math.max(0, ...f.others.map((o) => o[1])) >= 0.25;
      const firstIn = down.find(seen);
      const allIn = down.find((f) => seen(f) && f.live >= full);
      const pct = (f) => (f ? ((f.t - t0) / MOVE) * 100 : null);
      console.log(
        `INFO lineup-in-frame-${size}: packs in frame 1 -> ${full}; the first other at ${pct(firstIn)?.toFixed(0) ?? 'never'}%, all at ${pct(allIn)?.toFixed(0) ?? 'never'}% of the move (reference 25% to 74%)`,
      );
    }
    const gDown = Math.max(...down.map((f) => f.gpu));
    const heldBack = down.filter((f) => f.spin >= 0.5 && f.back !== null);
    report(
      `closing-to-lineup-back-let-go-${size}`,
      backAtClosing === 'ready' && heldBack.length === 0,
      `back at Closing ${backAtClosing}; frames past Closing + 0.5 still holding it: ${heldBack.length}`,
    );
    // up: the lineup to Closing
    const pu = record(2600);
    await gesture(s, -1);
    const up = await pu;
    r = await rest(page);
    const cu = curve(up);
    report(
      `lineup-to-closing-pack-follows-the-curve-${size}`,
      cu.length === 0 && near(r.y, closingY) && r.block === 'closing',
      `${up.length} frames, landing ${r.y} (Closing ${closingY}), block ${r.block}${cu.length ? '; ' + cu.slice(0, 3).join('; ') : ''}`,
    );
    const ru = ramp(up);
    report(
      `lineup-to-closing-others-fade-out-${size}`,
      ru.length === 0 && up.at(-1).others.length === 0,
      `${up.at(-1).others.length} others drawn at the end${ru.length ? '; cuts: ' + ru.slice(0, 3).join('; ') : ''}`,
    );
    const printedMid = up.filter((f) => f.busy && f.back === 'printing');
    await page.waitForTimeout(2500);
    const backAgain = await page.evaluate(
      () => window.__packStage.runtime?.()?.focusBack?.state ?? null,
    );
    report(
      `lineup-to-closing-back-printed-at-rest-${size}`,
      printedMid.length === 0 && backAgain === 'ready',
      `frames printing the back mid-move: ${printedMid.length}; at rest on Closing: ${backAgain}`,
    );
    const gUp = Math.max(...up.map((f) => f.gpu));
    report(
      `hand-off-gpu-${size}`,
      MB(Math.max(gDown, gUp)) <= cap,
      `peak ${MB(gDown)} MB down, ${MB(gUp)} MB up (cap ${cap} MB)`,
    );
    // fault 1 at the hand-off: a tap 300 ms into the move, either way
    await gesture(s, 1);
    await page.waitForTimeout(300);
    await tap(s, 30, s.cdp ? 300 : 450);
    await page.waitForTimeout(1600);
    r = await rest(page);
    const tapDown = near(r.y, lineupY);
    await gesture(s, -1);
    await page.waitForTimeout(300);
    await tap(s, 30, s.cdp ? 300 : 450);
    await page.waitForTimeout(1600);
    r = await rest(page);
    const tapUp = near(r.y, closingY);
    report(
      `tap-mid-hand-off-${size}`,
      tapDown && tapUp,
      `down: on the lineup ${tapDown}; up: on Closing ${tapUp} (${r.y})`,
    );
    // fault 2 at the lineup (phone): diagonal swipes end on a rest
    if (s.cdp) {
      const ends = [];
      for (const deg of [46, 60, 44, 30]) {
        await page.evaluate((v) => window.scrollTo(0, v), lineupY);
        r = await rest(page);
        const a = (deg * Math.PI) / 180;
        const dx = 220 * Math.sin(a);
        const dy = 220 * Math.cos(a);
        await swipe(s, 195 - dx / 2, 640, 195 + dx / 2, 640 - dy);
        await page.waitForTimeout(300);
        r = await rest(page);
        const ok = onRest(r) || near(r.y, r.exitEnd);
        ends.push({ deg, y: r.y, ok });
      }
      report(
        `diagonal-swipes-at-the-lineup-${size}`,
        ends.every((e) => e.ok),
        ends
          .map((e) => `${e.deg}deg -> ${e.y}${e.ok ? '' : ' OFF A REST'}`)
          .join(', '),
      );
    }
    writeFileSync(
      `${OUT}/lineup-frames-${size}.json`,
      JSON.stringify({ down, up }, null, 1),
    );
    report(
      `errors-lineup-${size}`,
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
