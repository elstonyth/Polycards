// QA for the full-page flow's address, history, restore and keys on
// /home-preview, on the
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
// - the text switches about 20% into a move, down and up alike (finding 13);
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
// - (lineup) Closing to the lineup and back, per frame: the
//   chosen pack's centre and scale move one way only and never step faster
//   than the curve allows; the others fade in and out, never cut; when they
//   come into frame; the stop text gone at the lineup; the GPU estimate's
//   peak against the cap; the back let go past Closing + 0.5 and printed
//   again only at rest; a tap mid-move either way lands on its stop; (phone)
//   diagonal swipes at the lineup end on a rest.
// - (wp4b, the second review and the lineup exit) Back then Forward during a
//   leave; a scroll entry right after a leave (its step back held 400 ms);
//   Back after a lap unfocuses; a stalled focus chunk (plain scrolling after
//   the deadline, the page's own scroll restoration while off, the flow back
//   on at the row once it loads); a held PageDown pages once; the lineup
//   exit moves on the gesture's first frame; neither floating chip shows
//   from Closing to the exit's end, and both are back in the free part.
// - (wp5, the endless pick) a 200 px drag at the lineup picks two packs on
//   and the page stays; up to Closing shows the picked pack's name and
//   address, with no history entry added; a detail stop is the picked pack;
//   twelve long drags never reach an end; flings both ways rest on a pack;
//   the GPU estimate's peak during them; ArrowLeft and ArrowRight pick at
//   the lineup only; (desktop) one sideways wheel gesture steps one pack; a
//   pick then the exit keeps the picked pack.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

/** The pack trim's margin at each end of the free span, in viewports, read
 * from the page's own source (stage-flow.ts) so the checks follow it. */
const LAP_TRIM_MARGIN = (() => {
  const src = readFileSync(
    new URL('../src/components/pack-stage/stage-flow.ts', import.meta.url),
    'utf8',
  );
  const m = /export const LAP_TRIM_MARGIN = ([\d.]+);/.exec(src);
  if (!m) throw new Error('LAP_TRIM_MARGIN not found in stage-flow.ts');
  return Number(m[1]);
})();
/** Whether the trim can turn on: the free span (exit end to rise start, from
 * the page's flow table) is longer than its two margins. */
const trimFits = (t, vh) =>
  !t.rise || t.rise.start - t.exitEnd > 2 * LAP_TRIM_MARGIN * vh;
const spanText = (t, vh) =>
  'free span ' +
  (t.rise ? Math.round(t.rise.start - t.exitEnd) : 'open') +
  ' px, two margins ' +
  Math.round(2 * LAP_TRIM_MARGIN * vh) +
  ' px (trim ' +
  (trimFits(t, vh) ? 'expected in the middle' : 'must stay off') +
  ')';
/** The phone's GPU estimate cap in the free span (trim-gpu-free-span-phone). */
const FREE_GPU_CAP = 40 * 1048576;

const args = process.argv.slice(2);
const BASE =
  args.find((a) => !a.startsWith('--')) ??
  process.env.PW_BASE ??
  'http://localhost:4300';
const ONLY = (args.find((a) => a.startsWith('--only=')) ?? '=').split('=')[1];
/** --part=pass,motion,nav,keys,reload,wp3c,lineup,wp4b,wp5,wp67,poly: run only these groups. */
const PARTS = (args.find((a) => a.startsWith('--part=')) ?? '=')
  .split('=')[1]
  .split(',')
  .filter(Boolean);
const part = (p) => PARTS.length === 0 || PARTS.includes(p);
const OUT =
  process.env.QA_OUT ?? 'docs/research/home-3d/full-flow/checkpoints/wp3b';
const SLUG = '151';
const PREVIEW = '/home-preview';
/** The landing window for one move [1.46-1.5 s]; the landing frame is the first frame at or after it. */
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
    ...(process.env.QA_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--use-angle=swiftshader']
      : ['--use-angle=d3d11', '--enable-gpu']),
    ...(process.env.QA_NETLOG
      ? ['--log-net-log=' + process.env.QA_NETLOG]
      : []),
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
    // Closing to the lineup: a rest, the address back to the
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
        pu >= 1.65 &&
        pu <= 1.9,
      `the block switches at P ${pd?.toFixed(3)} going down (20% in), ${pu?.toFixed(3)} going up (20% in)`,
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

  // ---- the keys ----
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
    // End pages to the lineup
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
    // a PageUp this close to the exit's end reaches the hand-over to the
    // lineup: step into the free part again before End
    if (r.y < yFree - 1) r = await key(page, 'ArrowDown');
    check(
      'free-before-End',
      r.past && r.exitEnd !== null && r.y > r.exitEnd - 1,
      r,
    );
    // End is the browser's: it lands past Last's top, so the page wraps to
    // the row (the wrap applies to End at Last)
    const endLog = await nativeKey(page, 'End');
    await page.waitForTimeout(1500);
    r = await rest(page);
    check('free-End-native-wraps-to-row', !endLog.cancelled && atRow(r), r);
    // Home is the browser's too: from the free part straight to the row
    r = await key(page, 'ArrowDown');
    r = await key(page, 'ArrowDown');
    r = await key(page, 'End');
    await page.waitForTimeout(400);
    await page.evaluate((v) => window.scrollTo(0, v), yFree);
    await page.waitForTimeout(400);
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

  // ---- the review fixes ----
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
        lap: window.__packStage.flow().lap,
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

    // the free part draws nothing and keeps only the chosen pack (trimmed,
    // not sent away, where the span is longer than its two trim margins;
    // shorter, the trim stays off), and the lineup's packs come back on the way up
    const vh = page.viewportSize().height;
    const trimY = t.rise ? (t.exitEnd + t.rise.start) / 2 : t.exitEnd + vh;
    await page.evaluate((v) => window.scrollTo(0, v), trimY);
    await page.waitForTimeout(1500);
    const e1 = await engineAt();
    // back up: the scrollbar into the paged part, which snaps to the lineup
    await page.evaluate((v) => window.scrollTo(0, v), t.edge - 50);
    await page.waitForTimeout(300);
    r = await rest(page);
    await page.waitForTimeout(400);
    const e2 = await engineAt();
    const MB = (b) => (b === null ? null : Math.round((b / 1048576) * 10) / 10);
    const fits = trimFits(t, vh);
    report(
      'engine-trims-in-the-free-part-' + size,
      e0.present === true &&
        e1.present === true &&
        e1.live.length === 0 &&
        e1.gpu !== null &&
        e0.gpu !== null &&
        e1.lap?.free === true &&
        (fits
          ? e1.lap.trim === true && e1.gpu < e0.gpu
          : e1.lap.trim === false &&
            e1.gpu <= e0.gpu &&
            (size !== 'phone' || e1.gpu <= FREE_GPU_CAP)) &&
        e2.present === true &&
        e2.running &&
        near(r.y, lineupY) &&
        e2.live.length > 0,
      spanText(t, vh) +
        '; Closing: present ' +
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

  // ---- Closing to the lineup and back ----
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
    // (the reference: 1 to the full row between 25% and 74% of the move)
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

  // ---- a reload at three rests (a reload starts at the row) ----
  // ---- the second review's fixes and the lineup exit ----
  if (part('wp4b')) {
    const chipState = (page) =>
      page.evaluate(() => {
        const one = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return 'absent';
          const cs = getComputedStyle(el);
          const b = el.getBoundingClientRect();
          return cs.visibility !== 'hidden' &&
            Number(cs.opacity) > 0.02 &&
            b.width > 0
            ? 'visible'
            : 'hidden';
        };
        return {
          free: one("[data-testid='free-pack-badge']"),
          telegram: one('[data-telegram-banner]'),
        };
      });
    // Back, then Forward during the leave: the focus comes back with the
    // address, and Back from there unfocuses
    {
      const s = await open(size);
      const { page } = s;
      await page.goto(BASE + '/about', { waitUntil: 'load' });
      await reject(page);
      await load(s);
      const s0 = await snap(page);
      await tapCentre(page);
      await rest(page);
      await page.goBack();
      await page.waitForTimeout(350);
      const mid = await snap(page);
      await page.goForward();
      await page.waitForTimeout(400);
      let r = await rest(page, 8000);
      const resumed = r.on && r.path === '/slots/' + SLUG && r.focus === 1;
      await page.goBack();
      await page.waitForTimeout(400);
      r = await rest(page, 8000);
      const unfocused = !r.on && r.path === PREVIEW && r.idx === s0.idx;
      report(
        'back-forward-during-leave-' + size,
        mid.on && mid.busy && resumed && unfocused,
        'Back started the leave ' +
          (mid.on && mid.busy) +
          '; Forward during it resumes the pack on Front with its address ' +
          resumed +
          '; Back then unfocuses at the row with the base path ' +
          unfocused +
          ' (' +
          r.path +
          ', entry ' +
          r.idx +
          ')',
      );
      await s.ctx.close();
    }
    // a scroll entry before the leave's step back has landed (review
    // finding 2): the step back is held 400 ms here to open the window
    {
      const s = await open(size);
      const { page } = s;
      await page.goto(BASE + '/about', { waitUntil: 'load' });
      await reject(page);
      await load(s);
      await tapCentre(page);
      await rest(page);
      await page.evaluate(() => {
        const b = history.back.bind(history);
        history.back = () => setTimeout(b, 400);
      });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !window.__packStage.focus()?.on, null, {
        timeout: 8000,
        polling: 'raf',
      });
      await gesture(s, 1);
      let r = await rest(page, 8000);
      const entered = r.on && r.path === '/slots/' + SLUG;
      for (const k of ['End', 'ArrowUp']) {
        await page.keyboard.press(k);
        await page.waitForTimeout(200);
        await rest(page);
      }
      await page.keyboard.press('Home');
      await page.waitForTimeout(300);
      r = await rest(page, 9000);
      await page.waitForTimeout(600);
      r = await snap(page);
      report(
        'scroll-entry-right-after-leave-' + size,
        entered && !r.on && r.path === PREVIEW,
        'entered by scroll before the step back landed ' +
          entered +
          '; after a lap and Home the row shows ' +
          r.path,
      );
      await s.ctx.close();
    }
    // Back after a lap still unfocuses
    {
      const s = await open(size);
      const { page } = s;
      await page.goto(BASE + '/about', { waitUntil: 'load' });
      await reject(page);
      await load(s);
      const s0 = await snap(page);
      await tapCentre(page);
      await rest(page);
      for (const k of ['End', 'ArrowUp']) {
        await page.keyboard.press(k);
        await page.waitForTimeout(200);
        await rest(page);
      }
      await page.waitForTimeout(300);
      const atClosing = await snap(page);
      await page.goBack();
      await page.waitForTimeout(600);
      await page.waitForLoadState('load').catch(() => {});
      const where = new URL(page.url()).pathname;
      const r = where === PREVIEW ? await rest(page, 8000) : null;
      report(
        'back-after-a-lap-unfocuses-' + size,
        atClosing.path === '/slots/' + SLUG &&
          atClosing.idx === s0.idx + 1 &&
          !!r &&
          !r.on &&
          r.path === PREVIEW,
        'at Closing after the lap: ' +
          atClosing.path +
          ' entry ' +
          atClosing.idx +
          ' (row ' +
          s0.idx +
          '); Back lands on ' +
          where +
          (r ? ', focused ' + r.on : ''),
      );
      await s.ctx.close();
    }
    // a stalled chunk: plain scrolling after the deadline, the flow back on
    // at the row once it loads
    {
      const s = await open(size);
      const { page } = s;
      let release = null;
      const gate = new Promise((r) => (release = r));
      await page.route(/pack-stage-focus\.[^/]*\.js/, async (r) => {
        await gate;
        await r.continue().catch(() => {});
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
      const early = await page.evaluate(() => ({
        on: window.__packStage.flow().on,
        restoration: history.scrollRestoration,
      }));
      await page.waitForTimeout(5500);
      const off = await page.evaluate(() => ({
        on: window.__packStage.flow().on,
        failed: window.__packStage.flow().focusFailed,
        restoration: history.scrollRestoration,
      }));
      const y0 = await page.evaluate(() => scrollY);
      await gesture(s, 1);
      await page.waitForTimeout(700);
      const y1 = await page.evaluate(() => scrollY);
      // well away from the row (more than half a panel) when it lands
      await page.evaluate(() => window.scrollTo(0, 1500));
      await page.waitForTimeout(300);
      release();
      await page.waitForFunction(
        () => window.__packStage.focus() !== null,
        null,
        {
          timeout: 20000,
        },
      );
      await page.waitForTimeout(300);
      const away = await page.evaluate(() => window.__packStage.flow().on);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(800);
      const back = await page.evaluate(() => ({
        on: window.__packStage.flow().on,
        restoration: history.scrollRestoration,
      }));
      report(
        'stalled-chunk-' + size,
        early.on &&
          early.restoration === 'manual' &&
          !off.on &&
          off.failed &&
          off.restoration === 'auto' &&
          y1 > y0 + 50 &&
          !away &&
          back.on &&
          back.restoration === 'manual',
        'before the deadline flow on ' +
          early.on +
          ' (' +
          early.restoration +
          '); after it flow on ' +
          off.on +
          ', failed ' +
          off.failed +
          ', restoration ' +
          off.restoration +
          '; one gesture scrolled plainly ' +
          Math.round(y0) +
          ' to ' +
          Math.round(y1) +
          '; loaded away from the row: flow on ' +
          away +
          '; back at the row: flow on ' +
          back.on +
          ' (' +
          back.restoration +
          ')',
      );
      report(
        'errors-stalled-' + size,
        page.errors.length === 0,
        page.errors.join(' | '),
      );
      await s.ctx.close();
    }
    // a held PageDown pages once, and the lineup exit
    // starts on the gesture's first frame (open point 2), and the two chips
    // stay hidden from Closing to the exit's end (open point 4)
    {
      const s = await open(size);
      const { page } = s;
      await load(s);
      await page.evaluate(() => document.activeElement?.blur());
      await page.evaluate(() => {
        window.__repeats = 0;
        addEventListener('keydown', (e) => {
          if (e.repeat) window.__repeats++;
        });
      });
      // held for 2.6 s: well past the 1.5 s move, so a repeat could page again
      await page.keyboard.down('PageDown');
      for (let i = 0; i < 65; i++) {
        await page.waitForTimeout(40);
        await page.keyboard.down('PageDown'); // a held key repeats
      }
      await page.keyboard.up('PageDown');
      let r = await rest(page, 8000);
      const repeats = await page.evaluate(() => window.__repeats);
      report(
        'held-pagedown-pages-once-' + size,
        repeats >= 60 && r.on && near(r.y, r.stops[1]),
        'a PageDown held 2.6 s (' +
          repeats +
          ' repeats) rests on ' +
          r.y +
          ' (Front ' +
          r.stops[1] +
          ', focus ' +
          r.focus +
          ')',
      );
      // to Closing, then down through the hand-off, the lineup and its exit,
      // the chips read every frame
      await page.keyboard.press('End');
      await page.waitForTimeout(200);
      await rest(page);
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(200);
      await rest(page);
      await page.evaluate(() => {
        window.__chipLog = [];
        window.__chipOn = true;
        // the chip's opacity (0 when hidden, -1 when not on the page)
        const vis = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return -1;
          const cs = getComputedStyle(el);
          return cs.visibility === 'hidden' ? 0 : Number(cs.opacity);
        };
        const f = () => {
          if (!window.__chipOn) return;
          window.__chipLog.push([
            Math.round(scrollY),
            vis("[data-testid='free-pack-badge']"),
            vis('[data-telegram-banner]'),
          ]);
          requestAnimationFrame(f);
        };
        requestAnimationFrame(f);
      });
      await gesture(s, 1);
      r = await rest(page);
      const lineupY = r.y;
      const t = await page.evaluate(() => window.__packStage.flow().table);
      // the exit: frames from the gesture, scroll and the stage's exit value
      const rec = page.evaluate(
        () =>
          new Promise((done) => {
            const o = [];
            const t0 = performance.now();
            const f = () => {
              o.push([scrollY, window.__packStage.state.exit]);
              if (performance.now() - t0 < 1700) requestAnimationFrame(f);
              else done(o);
            };
            requestAnimationFrame(f);
          }),
      );
      await page.waitForTimeout(60);
      await gesture(s, 1);
      const frames = await rec;
      r = await rest(page);
      const trace = await page.evaluate(() => window.__packStage.spinTrace());
      const i = frames.findIndex((v) => Math.abs(v[0] - frames[0][0]) >= 0.5);
      const firstMove = i >= 0 ? frames[i] : null;
      // the driver's own stamps: the gesture, then the first frame after
      // the one it ran in (the gesture's own frame is the move's start)
      const g = trace.gestures.at(-1) ?? null;
      const f1 = g === null ? null : trace.trace.find((v) => v[0] > g + 0.5);
      const firstFrameMoved = !!f1 && f1[1] > t.rl + 0.5;
      report(
        'exit-starts-at-once-' + size,
        near(lineupY, t.rl) &&
          firstFrameMoved &&
          !!firstMove &&
          firstMove[1] > 0 &&
          near(r.y, t.exitEnd),
        'from the lineup (' +
          lineupY +
          '): the first driver frame after the gesture (' +
          (f1 && g !== null ? Math.round(f1[0] - g) + ' ms after it' : 'none') +
          ') is at scroll ' +
          (f1 ? Math.round(f1[1]) : null) +
          '; the first frame that moved (scroll ' +
          (firstMove ? Math.round(firstMove[0]) : null) +
          ') has exit ' +
          (firstMove ? firstMove[1].toFixed(4) : null) +
          '; landed ' +
          r.y +
          ' (exit end ' +
          t.exitEnd +
          ')',
      );
      await page.waitForTimeout(700);
      await page.evaluate(() => (window.__chipOn = false));
      const log = await page.evaluate(() => window.__chipLog);
      const shownPast = log.filter(
        ([y, a, b]) => y < t.exitEnd - 0.5 && (a > 0.02 || b > 0.02),
      );
      // in the free part each chip passes through in-between opacities (a fade, not a cut)
      const after = log.filter(([y]) => y >= t.exitEnd - 0.5);
      const fades = [1, 2].map((k) =>
        after.some((v) => v[k] > 0.05 && v[k] < 0.95),
      );
      const free = await chipState(page);
      await page.screenshot({
        path: OUT + '/' + size + '-wp4b-free-chips.png',
      });
      report(
        'chips-hidden-closing-to-exit-end-' + size,
        log.length > 60 &&
          shownPast.length === 0 &&
          // the chips stay out over the free part (they would sit on its
          // content); they come back at the row
          free.free !== 'visible' &&
          free.telegram !== 'visible',
        log.length +
          ' frames from Closing to the exit end, ' +
          shownPast.length +
          ' with a chip shown' +
          (shownPast[0] ? ' (first at ' + shownPast[0][0] + ')' : '') +
          '; faded in (in-between opacities seen): free pack ' +
          fades[0] +
          ', Telegram ' +
          fades[1] +
          '; in the free part: free pack ' +
          free.free +
          ', Telegram ' +
          free.telegram,
      );
      report(
        'errors-wp4b-' + size,
        page.errors.length === 0,
        page.errors.join(' | '),
      );
      await s.ctx.close();
    }
  }

  // ---- (wp5) the endless pick in the lineup, and the carry ----
  if (part('wp5')) {
    const s = await open(size);
    const { page } = s;
    await load(s);
    await page.keyboard.press('End');
    await page.waitForTimeout(200);
    let r = await rest(page);
    await page.waitForTimeout(600);
    const lineupY = r.y;
    const len0 = r.len;
    const pick = () =>
      page.evaluate(() => {
        const ps = window.__packStage;
        const ln = ps.flow().line;
        const tiles = [
          ...document.querySelectorAll(
            '[data-stage-panel]:not([hidden]) [data-stage-tile]',
          ),
        ];
        const id = ps.state.focusOn?.id ?? null;
        const tile = tiles.find((t) => t.dataset.packId === id);
        return {
          y: scrollY,
          track: ps.state.track,
          n: tiles.length,
          id,
          index: ps.state.focusOn?.ctx?.index ?? null,
          name:
            tile?.querySelector('[data-stage-label] span')?.textContent ?? null,
          ids: tiles.map((t) => t.dataset.packId),
          pos: ln.pos,
          lineIndex: ln.index,
          moving: ln.moving || ln.pending,
          gpu: ps.stats?.()?.gpuBytesEstimate ?? 0,
          path: location.pathname,
          len: history.length,
        };
      });
    /** Waits for the line to rest and its pick to be carried. */
    const settled = async () => {
      const t0 = Date.now();
      let p = await pick();
      while (p.moving && Date.now() - t0 < 15000) {
        await page.waitForTimeout(60);
        p = await pick();
      }
      await page.waitForTimeout(250);
      return pick();
    };
    /** A sideways drag of dx px at 16 ms per move, held still before the release (no fling). */
    const dragX = async (dx, o = {}) => {
      const moves = o.moves ?? 10;
      const y0 = o.y ?? (size === 'phone' ? 520 : 470);
      const x0 =
        o.x ??
        (dx < 0
          ? size === 'phone'
            ? 330
            : 1100
          : size === 'phone'
            ? 60
            : 340);
      if (s.cdp) {
        await s.cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: x0, y: y0 }],
        });
        for (let i = 1; i <= moves; i++) {
          await s.cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: x0 + (dx * i) / moves, y: y0 }],
          });
          await page.waitForTimeout(16);
        }
        if (o.hold !== false) await page.waitForTimeout(200);
        await s.cdp.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        });
      } else {
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        for (let i = 1; i <= moves; i++) {
          await page.mouse.move(x0 + (dx * i) / moves, y0);
          await page.waitForTimeout(16);
        }
        if (o.hold !== false) await page.waitForTimeout(200);
        await page.mouse.up();
      }
    };
    const mod = (a, n) => ((a % n) + n) % n;
    let p0 = await pick();
    const startIndex = p0.index;
    // the row follows the hand: one pack per on-screen spacing (the two tiles nearest the middle)
    const vw = page.viewportSize().width;
    const pitch = await page.evaluate(() => {
      const xs = [
        ...document.querySelectorAll(
          '[data-stage-panel]:not([hidden]) [data-stage-tile] [data-stage-art]',
        ),
      ]
        .map((a) => a.getBoundingClientRect())
        .filter((b) => b.width > 0)
        .map((b) => b.left + b.width / 2)
        .sort(
          (a, b) => Math.abs(a - innerWidth / 2) - Math.abs(b - innerWidth / 2),
        );
      return Math.abs(xs.find((x) => Math.abs(x - xs[0]) > 20) - xs[0]);
    });
    // two packs on: two spacings
    await dragX(-2 * pitch, { x: vw / 2 + pitch });
    let p = await settled();
    const want2 = mod(startIndex + 2, p.n);
    report(
      `pick-two-packs-${size}`,
      p.index === want2 &&
        p.track === want2 &&
        p.ids[want2] === p.id &&
        Math.abs(p.y - lineupY) < 1,
      `from ${startIndex} to ${p.index} (want ${want2}, of ${p.n}); track ${p.track}; ${p.id}; scrollY ${p.y} (lineup ${lineupY})`,
    );
    await shot(page, size, 'wp5-picked');
    // up to Closing: the picked pack's Closing, its address, no entry added
    await gesture(s, -1);
    await page.waitForTimeout(200);
    r = await rest(page);
    await page.waitForTimeout(400);
    p = await pick();
    const closingText = await page.evaluate(
      () =>
        document.querySelector(
          '[data-testid="focus-stops"] section[data-on][data-kind="closing"]',
        )?.textContent ?? '',
    );
    report(
      `closing-shows-the-picked-pack-${size}`,
      r.block === 'closing' &&
        !!p.name &&
        closingText.includes(p.name) &&
        p.path === `/slots/${encodeURIComponent(p.id)}` &&
        p.len === len0,
      `block ${r.block}; name "${p.name}" in Closing: ${closingText.includes(p.name ?? '@')}; address ${p.path}; history ${p.len} (was ${len0})`,
    );
    await shot(page, size, 'wp5-closing-after-pick');
    // one more stop up: still the picked pack
    await gesture(s, -1);
    await page.waitForTimeout(200);
    r = await rest(page);
    p = await pick();
    report(
      `detail-stop-is-the-picked-pack-${size}`,
      p.id === p.ids[want2] &&
        r.on &&
        r.block !== null &&
        r.block !== 'closing',
      `block ${r.block}; focused ${p.id}`,
    );
    await shot(page, size, 'wp5-detail-after-pick');
    // back down to the lineup: the address leaves, the row is where it was
    await gesture(s, 1);
    await page.waitForTimeout(200);
    await rest(page);
    await gesture(s, 1);
    await page.waitForTimeout(200);
    r = await rest(page);
    p = await pick();
    report(
      `back-at-the-lineup-${size}`,
      Math.abs(r.y - lineupY) < 1 && p.track === want2 && p.len === len0,
      `scrollY ${r.y}; track ${p.track}; history ${p.len}; address ${p.path}`,
    );
    // twelve long drags the same way never reach an end (as many whole
    // spacings as fit in 80% of the width, at least one)
    const per = Math.max(1, Math.floor((0.8 * vw) / pitch));
    const before = await pick();
    const tracks = [];
    let gpuMax = before.gpu;
    for (let k = 0; k < 12; k++) {
      await dragX(-per * pitch, { moves: 12, x: vw / 2 + (per * pitch) / 2 });
      const q = await settled();
      tracks.push(q.track);
      gpuMax = Math.max(gpuMax, q.gpu);
    }
    const after = await pick();
    const travelled = Math.round(after.pos - before.pos);
    report(
      `twelve-drags-no-end-${size}`,
      travelled === 12 * per &&
        tracks.every((t) => t >= 0 && t < after.n && Number.isInteger(t)) &&
        after.index === mod(before.index + 12 * per, after.n),
      `travelled ${travelled} packs (want ${12 * per}, spacing ${pitch} px); tracks ${tracks.join(',')}; index ${before.index} -> ${after.index}`,
    );
    // flings both ways (released moving): always rests on a pack
    const flings = [];
    for (const dx of [-260, 260, -180, 180]) {
      const g = page.evaluate(
        () =>
          new Promise((done) => {
            let max = 0;
            const t0 = performance.now();
            const tick = () => {
              max = Math.max(
                max,
                window.__packStage.stats?.()?.gpuBytesEstimate ?? 0,
              );
              if (performance.now() - t0 < 2200) requestAnimationFrame(tick);
              else done(max);
            };
            requestAnimationFrame(tick);
          }),
      );
      await dragX(dx, { moves: 8, hold: false });
      const q = await settled();
      gpuMax = Math.max(gpuMax, await g);
      flings.push({ dx, track: q.track, ok: Number.isInteger(q.track) });
    }
    report(
      `flings-rest-on-a-pack-${size}`,
      flings.every((f) => f.ok),
      flings.map((f) => `${f.dx}px -> ${f.track}`).join(', '),
    );
    const cap = size === 'phone' ? 40e6 : 96e6;
    report(
      `gpu-during-the-pick-${size}`,
      gpuMax <= cap,
      `peak ${(gpuMax / 1e6).toFixed(1)} MB (cap ${cap / 1e6})`,
    );
    // keys at the lineup: one pack each way
    p0 = await pick();
    await page.keyboard.press('ArrowRight');
    let q = await settled();
    const right = q.index === mod(p0.index + 1, q.n);
    await page.keyboard.press('ArrowLeft');
    q = await settled();
    const left = q.index === p0.index;
    report(
      `arrows-pick-at-the-lineup-${size}`,
      right && left && Math.abs(q.y - lineupY) < 1,
      `right ${right}, left ${left}, scrollY ${q.y}`,
    );
    // (desktop) the sideways wheel steps one pack per gesture
    if (!s.cdp) {
      p0 = await pick();
      // one trackpad gesture: falling deltas 16 ms apart, dispatched in the
      // page so a slow software-rendered browser cannot stretch the gaps
      await page.evaluate(
        () =>
          new Promise((done) => {
            const ds = [40, 32, 20, 10, 5];
            let k = 0;
            const next = () => {
              const deltaX = ds[k++];
              document.body.dispatchEvent(
                new WheelEvent('wheel', {
                  deltaX,
                  deltaY: 0,
                  bubbles: true,
                  cancelable: true,
                }),
              );
              if (k < ds.length) setTimeout(next, 16);
              else done();
            };
            next();
          }),
      );
      q = await settled();
      report(
        `sideways-wheel-one-pack-${size}`,
        q.index === mod(p0.index + 1, q.n) && Math.abs(q.y - lineupY) < 1,
        `${p0.index} -> ${q.index}; scrollY ${q.y}`,
      );
    }
    // a pick then the exit: the free part, the picked pack still focused
    await dragX(200);
    const picked = await settled();
    await gesture(s, 1);
    await page.waitForTimeout(200);
    r = await rest(page);
    p = await pick();
    report(
      `pick-then-exit-${size}`,
      near(r.y, r.exitEnd) && p.id === picked.id && p.len === len0,
      `scrollY ${r.y} (exit end ${r.exitEnd}); focused ${p.id} (picked ${picked.id}); history ${p.len}`,
    );
    // ArrowRight away from the lineup is not taken by the flow
    const nk = await nativeKey(page, 'ArrowRight');
    report(
      `arrows-free-away-from-the-lineup-${size}`,
      !nk.cancelled,
      `cancelled: ${nk.cancelled}`,
    );
    report(
      `no-page-errors-wp5-${size}`,
      page.errors.length === 0,
      page.errors.join(' | ') || 'none',
    );
    await s.ctx.close();
  }

  // ---- The rise, the return and the wrap ----
  if (part('wp67')) {
    const s = await open(size);
    const { page } = s;
    await load(s);
    const len0 = (await snap(page)).len;
    const lapState = () =>
      page.evaluate(() => {
        const ps = window.__packStage;
        const fl = ps.flow();
        const flow = document.querySelector('[data-home-flow]');
        const head = document.querySelector('[data-stage-head]');
        const drawn = (ps.runtime?.()?.drawn ?? []).filter(
          (d) => d.opacity > 0,
        );
        return {
          y: scrollY,
          t: fl.table,
          lap: fl.lap,
          busy: fl.busy,
          on: !!ps.focus?.()?.on,
          free: flow.hasAttribute('data-flow-free'),
          lapAttr: flow.hasAttribute('data-flow-lap'),
          headOp: head ? Number(getComputedStyle(head).opacity) : null,
          drawn: drawn.map((d) => ({
            id: d.id,
            o: Math.round(d.opacity * 1000) / 1000,
            x: Math.round(d.x * 1000) / 1000,
            y: Math.round(d.y * 1000) / 1000,
            z: Math.round(d.z * 1000) / 1000,
            s: Math.round(d.scale * 1000) / 1000,
          })),
          gpu: ps.stats?.()?.gpuBytesEstimate ?? 0,
          track: ps.state.track,
          index: ps.state.focusOn?.ctx?.index ?? null,
          id: ps.state.focusOn?.id ?? null,
          path: location.pathname,
          len: history.length,
        };
      });
    const MB = (b) => Math.round((b / 1e6) * 100) / 100;
    const to = async (y, wait = 500) => {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(wait);
      return lapState();
    };
    /** Waits until the flow is not busy and the scroll is still. */
    const settle = async () => {
      await rest(page, 8000);
      await page.waitForTimeout(500);
      return lapState();
    };
    // to the lineup, and its exit to the free part
    await page.keyboard.press('End');
    await page.waitForTimeout(200);
    await rest(page);
    await page.waitForTimeout(800);
    const atLineup = await lapState();
    const chosen = atLineup.id;
    const chosenIndex = atLineup.index;
    const t = atLineup.t;
    const exitEnd = t.exitEnd;
    // the end's rests: the footer in view, the chosen pack alone, Last's top
    const [E0, E1] = t.ends;
    // the middle of the free span (trimmed when the span is longer than its
    // two margins: a quarter viewport past the exit end and before the rise)
    const free = await to((exitEnd + Math.min(t.rise.start, E0)) / 2, 1500);
    report(
      'wp67-free-nothing-drawn-' + size,
      free.free && !free.lapAttr && free.drawn.length === 0 && free.lap?.free,
      `at ${Math.round(free.y)}: drawn ${free.drawn.length}, lap ${JSON.stringify(free.lap)}, GPU ${MB(free.gpu)} MB (lineup ${MB(atLineup.gpu)} MB)`,
    );
    const vh = page.viewportSize().height;
    const fits = trimFits(t, vh);
    report(
      'wp67-free-keeps-only-the-chosen-pack-' + size,
      free.gpu > 0 &&
        (fits
          ? free.lap?.trim === true && free.gpu < atLineup.gpu
          : free.lap?.trim === false &&
            free.drawn.every((d) => d.id === chosen) &&
            free.gpu <= atLineup.gpu &&
            (size !== 'phone' || free.gpu <= FREE_GPU_CAP)),
      `${spanText(t, vh)}; trim ${free.lap?.trim}; drawn [${free.drawn.map((d) => d.id).join(',')}] (chosen ${chosen}); GPU estimate ${MB(free.gpu)} MB in the free span, ${MB(atLineup.gpu)} MB at the lineup`,
    );
    // The first section grows by 300 px: the rise, the end's rests and Last
    // stay keyed to the last section (all move by 300), and the free part
    // leaves the page where the visitor is reading
    await page.evaluate(() => {
      const jp = document.querySelector('[data-flow-section]');
      const d = document.createElement('div');
      d.id = 'qa-grow';
      d.style.height = '300px';
      jp.appendChild(d);
    });
    await page.waitForTimeout(600);
    const grown = await lapState();
    const moved = (a, b) => Math.abs(b - a - 300) < 1.5;
    report(
      'wp67-first-section-height-moves-the-end-with-it-' + size,
      moved(t.rise.start, grown.t.rise.start) &&
        moved(t.rise.end, grown.t.rise.end) &&
        moved(t.lastTop, grown.t.lastTop) &&
        t.ends.every((v, i) => moved(v, grown.t.ends[i])) &&
        Math.abs(grown.y - free.y) < 1.5,
      `rise ${t.rise.start}-${t.rise.end} to ${grown.t.rise.start}-${grown.t.rise.end}; ends [${t.ends}] to [${grown.t.ends}]; Last top ${t.lastTop} to ${grown.t.lastTop}; scroll ${Math.round(free.y)} to ${Math.round(grown.y)}`,
    );
    await page.evaluate(() => document.getElementById('qa-grow')?.remove());
    await page.waitForTimeout(600);
    const t2 = (await lapState()).t;
    const [F0, F1] = t2.ends;
    /** The footer's links at a point, and what a tap there would hit. */
    const footerHit = () =>
      page.evaluate(() => {
        const links = [
          ...document.querySelectorAll('[data-flow-section="footer"] a[href]'),
        ];
        const seen = links
          .map((a) => {
            const r = a.getBoundingClientRect();
            const x = r.left + r.width / 2;
            const y = r.top + r.height / 2;
            const inView = y > 0 && y < innerHeight;
            const hit = inView ? document.elementFromPoint(x, y) : null;
            return {
              text: a.textContent.trim(),
              inView,
              hits: !!hit && (hit === a || a.contains(hit)),
            };
          })
          .filter((l) => l.text);
        return seen;
      });
    // the footer's rest: the page stays there (no snap), the footer's links in
    // view and on top
    const atFooter = await to(F0, 1500);
    const links = await footerHit();
    report(
      'wp67-footer-rest-links-reachable-' + size,
      Math.abs(atFooter.y - F0) < 1 &&
        atFooter.free &&
        !atFooter.busy &&
        links.length >= 3 &&
        links.every((l) => l.inView && l.hits),
      `y ${Math.round(atFooter.y)} (footer rest ${F0}); links ${links.map((l) => l.text + (l.hits ? ' ok' : ' covered') + (l.inView ? '' : ' (out of view)')).join(', ')}`,
    );
    // arriving: one gesture down from just above the footer rests on it
    await to(F0 - (s.cdp ? 150 : 60), 600);
    await gesture(s, 1);
    const arrived = await settle();
    report(
      'wp67-arrival-rests-at-the-footer-' + size,
      Math.abs(arrived.y - F0) < 1 && arrived.free,
      `from ${F0 - (s.cdp ? 150 : 60)} one gesture down: y ${Math.round(arrived.y)} (footer rest ${F0}, pack rest ${F1})`,
    );
    /**
     * Records every frame (scroll, lap, drawn packs) from now until the flow
     * has moved and then rested for 400 ms (or 5 s): run it, then make the
     * gesture.
     */
    const recordMove = () =>
      page.evaluate(async () => {
        const ps = window.__packStage;
        const head = document.querySelector('[data-stage-head]');
        const out = [];
        const t0 = performance.now();
        let restSince = null;
        let started = false;
        while (performance.now() - t0 < 5000) {
          await new Promise((r) => requestAnimationFrame(r));
          const fl = ps.flow();
          const drawn = (ps.runtime?.()?.drawn ?? []).filter(
            (d) => d.opacity > 0,
          );
          const r3 = (v) => Math.round(v * 1000) / 1000;
          out.push({
            t: performance.now() - t0,
            y: scrollY,
            busy: fl.busy,
            lap: fl.lap,
            headOp: head ? Number(getComputedStyle(head).opacity) : null,
            at: drawn[0]?.at ?? null,
            drawn: drawn.map((d) => ({
              id: d.id,
              o: r3(d.opacity),
              x: r3(d.x),
              y: r3(d.y),
              z: r3(d.z),
              s: r3(d.scale),
            })),
          });
          const moving = out.length > 1 && out.at(-1).y !== out.at(-2).y;
          // the gesture may reach the page a while after the recording starts
          if (fl.busy || moving) started = true;
          if (!started || fl.busy || moving) restSince = null;
          else if ((restSince ??= performance.now()) < performance.now() - 400)
            break;
        }
        return out;
      });
    const gestureRecorded = async (dir) => {
      const rec = recordMove();
      await page.waitForTimeout(50);
      await gesture(s, dir);
      return rec;
    };
    /** The time from the first frame that moved to the first at the end, ms. */
    const moveMs = (fr) => {
      const y0 = fr[0].y;
      const y1 = fr.at(-1).y;
      const a = fr.find((f) => Math.abs(f.y - y0) > 0.5);
      const b = fr.find((f) => Math.abs(f.y - y1) < 0.5);
      return a && b ? Math.round(b.t - a.t) : null;
    };
    // one gesture at the footer: one smooth move to the chosen pack at rest
    const toPack = await gestureRecorded(1);
    const atPack = await settle();
    const riseMid = toPack.find(
      (f) => f.lap && f.lap.rise > 0.2 && f.lap.rise < 0.8,
    );
    const rising = toPack.filter((f) => f.lap && !f.lap.free);
    report(
      'wp67-one-gesture-from-the-footer-to-the-chosen-pack-' + size,
      Math.abs(atPack.y - F1) < 1 &&
        atPack.lap?.rise > 0.99 &&
        !atPack.lap?.ret &&
        atPack.drawn.length === 1 &&
        atPack.drawn[0].id === chosen &&
        rising.every((f, i) => i === 0 || f.y >= rising[i - 1].y),
      `y ${Math.round(atPack.y)} (pack rest ${F1}); lap ${JSON.stringify(atPack.lap)}; drawn ${atPack.drawn.map((d) => d.id).join(',')} (chosen ${chosen}); the move took ${moveMs(toPack)} ms over ${toPack.length} frames`,
    );
    report(
      'wp67-rise-one-pack-' + size,
      !!riseMid &&
        riseMid.drawn.length === 1 &&
        riseMid.drawn[0].id === chosen &&
        riseMid.headOp === 0,
      riseMid
        ? `mid-move: rise ${riseMid.lap.rise.toFixed(3)}; drawn ${riseMid.drawn.map((d) => d.id).join(',')} (chosen ${chosen}); row heading opacity ${riseMid.headOp}`
        : 'no frame mid-rise',
    );
    // up at the chosen pack: one move back to the footer
    const upRec = await gestureRecorded(-1);
    const backUp = await settle();
    const upLinks = await footerHit();
    report(
      'wp67-up-from-the-chosen-pack-to-the-footer-' + size,
      Math.abs(backUp.y - F0) < 1 &&
        backUp.free &&
        upLinks.every((l) => l.inView && l.hits),
      `y ${Math.round(backUp.y)} (footer rest ${F0}); the move took ${moveMs(upRec)} ms; links ${upLinks.map((l) => l.text + (l.hits ? ' ok' : ' covered')).join(', ')}`,
    );
    await gesture(s, 1);
    const atPack2 = await settle();
    // the next gesture: one move back to the full row (Return), ending on the
    // wrap at the row
    const toRow = await gestureRecorded(1);
    const retMid = toRow.find(
      (f) => f.lap && f.lap.ret > 0.3 && f.lap.ret < 0.8,
    );
    report(
      'wp67-return-all-back-' + size,
      !!retMid &&
        retMid.drawn.length >= 2 &&
        retMid.drawn.some((d) => d.id === chosen),
      retMid
        ? `mid-move: return ${retMid.lap.ret.toFixed(3)}; drawn ${retMid.drawn.length}: ${retMid.drawn.map((d) => d.id + '@' + d.o).join(', ')}`
        : 'no frame mid-return',
    );
    // the seam: the last frame before the wrap against the first after it
    const wi = toRow.findIndex(
      (f, i) => i > 0 && toRow[i - 1].y > t2.rise.start && f.y < t2.r0 + 400,
    );
    const seamBefore = wi > 0 ? toRow[wi - 1] : null;
    const seamAfter =
      wi > 0 ? toRow.slice(wi).find((f) => f.at !== seamBefore.at) : null;
    /** The seam frames may be at most this far apart: the idle bob moves about 0.001 per frame. */
    const SEAM_GAP_MS = 250;
    /** The same packs, each within 2% of its offset and 0.01 in height and scale (idle bob). */
    const samePoses = (a, b) => {
      if (a.drawn.length === 0 || a.drawn.length !== b.drawn.length)
        return false;
      return a.drawn.every((p) => {
        const q = b.drawn.find((d) => d.id === p.id);
        return (
          !!q &&
          Math.abs(p.x - q.x) <= 0.02 * Math.abs(p.x) + 0.005 &&
          Math.abs(p.y - q.y) <= 0.01 &&
          Math.abs(p.z - q.z) <= 0.01 &&
          Math.abs(p.s - q.s) <= 0.01
        );
      });
    };
    const poses = (st) =>
      st.drawn
        .map((d) => [d.id, d.x, d.y, d.z, d.s].join(':'))
        .sort()
        .join(' ');
    const seamGap =
      seamBefore?.at != null && seamAfter?.at != null
        ? Math.round(seamAfter.at - seamBefore.at)
        : null;
    report(
      'wp67-seam-no-jump-' + size,
      Math.abs(atPack2.y - F1) < 1 &&
        !!seamBefore &&
        !!seamAfter &&
        seamBefore.lap?.ret >= 0.99 &&
        seamGap !== null &&
        seamGap <= SEAM_GAP_MS &&
        samePoses(seamBefore, seamAfter),
      seamBefore && seamAfter
        ? `last frame before the wrap (y ${Math.round(seamBefore.y)}, return ${seamBefore.lap?.ret}) vs the first after it (y ${Math.round(seamAfter.y)}), ${seamGap ?? 'n/a'} ms apart (at most ${SEAM_GAP_MS}): before [${poses(seamBefore)}] after [${poses(seamAfter)}]; the move took ${moveMs(toRow)} ms`
        : `no wrap seen in ${toRow.length} frames (from y ${Math.round(atPack2.y)})`,
    );
    const landed = await settle();
    report(
      'wp67-wrap-lands-on-the-row-' + size,
      Math.abs(landed.y - t2.r0) < 1 &&
        !landed.on &&
        landed.path === PREVIEW &&
        landed.len === len0 &&
        Math.round(landed.track) === chosenIndex &&
        landed.headOp === 1 &&
        !landed.lapAttr,
      `y ${Math.round(landed.y)} (R0 ${t2.r0}); focus ${landed.on}; address ${landed.path}; history ${landed.len} (start ${len0}); track ${landed.track} (chosen ${chosenIndex}); heading opacity ${landed.headOp}; GPU ${MB(landed.gpu)} MB`,
    );
    // a native jump across Last's top (End, the scrollbar) still wraps with
    // the 1.2 s lock: the wheel is swallowed during it; after it one notch
    // pages to Front
    await page.keyboard.press('End');
    await page.waitForTimeout(200);
    await rest(page);
    await to(F1, 900);
    await page.evaluate((v) => window.scrollTo(0, v), t2.lastTop + 10);
    await page.waitForTimeout(250);
    if (s.cdp) await gesture(s, 1);
    else {
      await page.mouse.move(720, 450);
      await page.mouse.wheel(0, 120);
    }
    const guard = await settle();
    await gesture(s, 1);
    await page.waitForTimeout(200);
    const front = await settle();
    report(
      'wp67-guard-swallows-then-pages-to-front-' + size,
      Math.abs(guard.y - t2.r0) < 1 &&
        !guard.on &&
        front.on &&
        Math.abs(front.y - (front.t.rests[0] ?? -1)) < 1,
      `a gesture 250 ms into the lock: y ${Math.round(guard.y)}, focus ${guard.on}; the next one: y ${Math.round(front.y)}, focus ${front.on} (Front ${front.t.rests[0]})`,
    );
    // lap two, with a different pick at the lineup
    await page.keyboard.press('End');
    await page.waitForTimeout(200);
    await rest(page);
    await page.waitForTimeout(700);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(1500);
    const picked = await lapState();
    await to(picked.t.exitEnd + 40, 600);
    const t3 = (await lapState()).t;
    // the end by keys: the footer, the chosen pack, the row
    await to(t3.ends[0], 800);
    await page.keyboard.press('ArrowDown');
    await settle();
    await page.keyboard.press('ArrowDown');
    const lap2 = await settle();
    report(
      'wp67-two-laps-with-a-pick-' + size,
      picked.index !== chosenIndex &&
        Math.round(lap2.track) === picked.index &&
        !lap2.on &&
        Math.abs(lap2.y - t3.r0) < 1 &&
        lap2.len === len0,
      `picked ${picked.id} (index ${picked.index}, first lap ${chosenIndex}); after the second wrap: track ${lap2.track}, y ${Math.round(lap2.y)}, history ${lap2.len} (start ${len0})`,
    );
    // nothing happens on an upward gesture at the top
    if (s.cdp) await swipe(s, 200, 300, 200, 650);
    else {
      await page.mouse.move(720, 450);
      await page.mouse.wheel(0, -240);
    }
    await page.waitForTimeout(400);
    const top = await settle();
    report(
      'wp67-up-at-the-top-does-nothing-' + size,
      Math.abs(top.y - t3.r0) < 1 && !top.on && !top.busy,
      `y ${Math.round(top.y)}, focus ${top.on}`,
    );
    // Home and Escape at the lineup: back to the row with the chosen pack
    const homes = [];
    for (const k of ['Home', 'Escape']) {
      await page.keyboard.press('End');
      await page.waitForTimeout(200);
      await rest(page);
      await page.waitForTimeout(600);
      const at = await lapState();
      await page.keyboard.press(k);
      await page.waitForTimeout(200);
      const back = await settle();
      homes.push({ k, at, back });
    }
    report(
      'wp67-home-and-escape-at-the-lineup-' + size,
      homes.every(
        (h) =>
          Math.abs(h.back.y - h.at.t.r0) < 1 &&
          !h.back.on &&
          Math.round(h.back.track) === h.at.index &&
          h.back.len === len0,
      ),
      homes
        .map(
          (h) =>
            `${h.k}: from ${Math.round(h.at.y)} to ${Math.round(h.back.y)}, focus ${h.back.on}, track ${h.back.track} (chosen ${h.at.index}), history ${h.back.len}`,
        )
        .join('; '),
    );
    // free touch (phone): follow, glide, a tap during the glide; a diagonal
    // drag that reaches the footer rests there (it does not page on)
    if (s.cdp) {
      await page.keyboard.press('End');
      await page.waitForTimeout(200);
      await rest(page);
      const tt = (await lapState()).t;
      await to(tt.exitEnd + 20, 600);
      const y0 = (await lapState()).y;
      // a point a tap opens nothing at (the footer's links are in view here)
      const calm = await page.evaluate(() => {
        for (let y = innerHeight * 0.3; y < innerHeight * 0.9; y += 10)
          for (const x of [12, innerWidth / 2, innerWidth - 12]) {
            const el = document.elementFromPoint(x, y);
            if (
              el &&
              !el.closest('a,button,[role="button"],input,label,summary')
            )
              return { x, y };
          }
        return { x: 12, y: innerHeight * 0.3 };
      });
      await swipe(s, 200, 650, 200, 530);
      await page.waitForTimeout(80);
      await tap(s, calm.x, calm.y);
      await page.waitForTimeout(100);
      const yA = (await lapState()).y;
      await page.waitForTimeout(1200);
      const yB = (await lapState()).y;
      await swipe(s, 120, 650, 300, 400); // about 36 degrees from vertical
      await page.waitForTimeout(1500);
      const yC = (await lapState()).y;
      report(
        'wp67-free-touch-follows-a-tap-stops-the-glide-the-footer-holds-phone',
        yA > y0 + 80 &&
          yA < tt.ends[0] &&
          Math.abs(yB - yA) < 2 &&
          Math.abs(yC - tt.ends[0]) < 1,
        `start ${Math.round(y0)}; after a 120 px swipe and a tap 80 ms later ${Math.round(yA)}, 1.2 s on ${Math.round(yB)}; a diagonal swipe then ${Math.round(yC)} (footer rest ${tt.ends[0]})`,
      );
    }
    report(
      'errors-wp67-' + size,
      page.errors.length === 0,
      page.errors.join(' | '),
    );
    await s.ctx.close();
  }

  // The Poly tab (5 capsules) through the lap: lean limits in every frame of
  // the lineup, the rise and the return, the free span's memory, the seam, the
  // pick carried through the wrap, and the stops. One lap per capsule index.
  if (part('poly')) {
    const s = await open(size);
    const { page } = s;
    await load(s);
    const DEG = Math.PI / 180;
    const LIM = { yaw: 25 * DEG, away: 15 * DEG, toward: 25 * DEG };
    const EPS = 1e-3;
    const CAPSULE_KINDS = ['front', 'tophits', 'odds', 'pulls', 'closing'];
    const HELD = ['loading', 'compiling', 'built', 'uploaded'];
    const MB = (b) => Math.round((b / 1e6) * 100) / 100;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    await page.getByRole('button', { name: /^Poly$/ }).click();
    await page.waitForFunction(
      () => {
        const t = document.querySelectorAll(
          '[data-stage-panel]:not([hidden]) [data-stage-tile]',
        );
        const fl = window.__packStage.flow();
        return t.length > 0 && fl.bound && !fl.busy;
      },
      null,
      { timeout: 20000 },
    );
    await page.waitForTimeout(2500);
    // Every frame, the composed pose of each visible tile (--m-ry/--m-rx on a
    // phone, --d-ry/--d-rx on a desktop, radians), under the current phase.
    // The debug hook exposes no 3D rotation, so these read the tile pose only:
    // "any" = every tile that is not faded out, "pic" = those whose picture
    // shows (the flat tiles).
    await page.evaluate(() => {
      const num = (v) => {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : null;
      };
      const shown = (el, stop) => {
        let o = 1;
        for (let e = el; e && e !== stop.parentElement; e = e.parentElement) {
          const cs = getComputedStyle(e);
          if (cs.visibility === 'hidden' || cs.display === 'none') return 0;
          o *= Number(cs.opacity);
        }
        return o;
      };
      window.__lean = { on: false, phase: 'load', ph: {} };
      const tick = () => {
        const L = window.__lean;
        if (L.on) {
          const k = innerWidth >= 1024 ? 'd' : 'm';
          const ph = (L.ph[L.phase] ??= {
            frames: 0,
            any: { n: 0, yaw: 0, up: -9, down: 9, ex: null },
            pic: { n: 0, yaw: 0, up: -9, down: 9, ex: null },
          });
          ph.frames++;
          const tiles = document.querySelectorAll(
            '[data-stage-panel]:not([hidden]) [data-stage-tile]',
          );
          for (const t of tiles) {
            const cs = getComputedStyle(t);
            const ry = num(cs.getPropertyValue('--' + k + '-ry'));
            const rx = num(cs.getPropertyValue('--' + k + '-rx'));
            if (ry === null || rx === null) continue;
            const op = num(cs.getPropertyValue('--' + k + '-op'));
            if (op !== null && op <= 0.001) continue;
            const img = t.querySelector('img');
            const pic = img ? shown(img, t) : 0;
            for (const [name, on] of [
              ['any', true],
              ['pic', pic > 0.001],
            ]) {
              if (!on) continue;
              const a = ph[name];
              a.n++;
              a.yaw = Math.max(a.yaw, Math.abs(ry));
              a.up = Math.max(a.up, rx);
              a.down = Math.min(a.down, rx);
              const bad =
                Math.abs(ry) > 25 * (Math.PI / 180) + 1e-3 ||
                rx > 15 * (Math.PI / 180) + 1e-3 ||
                rx < -25 * (Math.PI / 180) - 1e-3;
              if (bad && !a.ex)
                a.ex = {
                  id: t.dataset.packId,
                  yawDeg: Math.round((ry * 1800) / Math.PI) / 10,
                  rotXDeg: Math.round((rx * 1800) / Math.PI) / 10,
                };
            }
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const phase = (p) =>
      page.evaluate((v) => {
        window.__lean.phase = v;
      }, p);
    const pState = () =>
      page.evaluate((held) => {
        const ps = window.__packStage;
        const fl = ps.flow();
        const rt = ps.runtime?.() ?? null;
        const flow = document.querySelector('[data-home-flow]');
        const f = ps.focus?.() ?? null;
        const r3 = (v) => Math.round(v * 1000) / 1000;
        return {
          y: scrollY,
          t: fl.table,
          lap: fl.lap,
          busy: fl.busy,
          on: !!f?.on,
          kinds: f?.kinds ?? [],
          free: flow.hasAttribute('data-flow-free'),
          lapAttr: flow.hasAttribute('data-flow-lap'),
          drawn: (rt?.drawn ?? [])
            .filter((d) => d.opacity > 0)
            .map((d) => ({
              id: d.id,
              x: r3(d.x),
              y: r3(d.y),
              z: r3(d.z),
              s: r3(d.scale),
            })),
          held: (rt?.slots ?? [])
            .filter(
              (sl) =>
                held.includes(sl.half ?? '') || held.includes(sl.full ?? ''),
            )
            .map((sl) => sl.id),
          gpu: ps.stats?.()?.gpuBytesEstimate ?? 0,
          track: ps.state.track,
          index: ps.state.focusOn?.ctx?.index ?? null,
          id: ps.state.focusOn?.id ?? null,
          len: history.length,
        };
      }, HELD);
    const to = async (y, wait = 500) => {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(wait);
      return pState();
    };
    const settle = async () => {
      await rest(page, 8000);
      await page.waitForTimeout(500);
      return pState();
    };
    const pickSettled = async () => {
      await page.waitForTimeout(150);
      await page
        .waitForFunction(
          () => {
            const ln = window.__packStage.flow().line;
            return !(ln?.moving || ln?.pending);
          },
          null,
          { timeout: 15000 },
        )
        .catch(() => {});
      await page.waitForTimeout(300);
      return pState();
    };
    const tol = (p, q) =>
      Math.abs(p.x - q.x) <= 0.02 * Math.abs(p.x) + 0.005 &&
      Math.abs(p.y - q.y) <= 0.01 &&
      Math.abs(p.z - q.z) <= 0.01 &&
      Math.abs(p.s - q.s) <= 0.01;
    /** Two sets of poses, ordered left to right, agree pack for pack (ids ignored). */
    const sameRow = (a, b) => {
      if (a.length === 0 || a.length !== b.length) return false;
      const o = (l) => [...l].sort((m, n) => m.x - n.x);
      const A = o(a);
      const B = o(b);
      return A.every((p, i) => tol(p, B[i]));
    };
    const centred = (st) =>
      [...st.drawn].sort((m, n) => Math.abs(m.x) - Math.abs(n.x))[0]?.id ??
      null;

    const tiles = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '[data-stage-panel]:not([hidden]) [data-stage-tile]',
        ),
      ].map((t) => t.dataset.packId),
    );
    report(
      'poly-tab-has-5-capsules-' + size,
      tiles.length === 5,
      tiles.length + ' tiles: ' + tiles.join(', '),
    );

    await page.evaluate(() => {
      window.__lean.on = true;
    });
    const laps = [];
    let prev = null;
    for (let lap = 0; lap < 5; lap++) {
      const rec = { lap };
      await phase('row');
      await page.waitForTimeout(800);
      // the row to the lineup (the hand-off), then the pick
      await phase('hand-off');
      await page.keyboard.press('End');
      await page.waitForTimeout(200);
      await rest(page);
      await phase('lineup');
      await page.waitForTimeout(800);
      if (lap > 0) {
        await page.keyboard.press('ArrowRight');
        await pickSettled();
      }
      const at = await pState();
      rec.id = at.id;
      rec.index = at.index;
      rec.kinds = at.kinds;
      rec.prevIndex = prev?.index ?? null;
      const t = at.t;
      // the free span: the trimmed middle
      await phase('exit');
      const free = await to(
        (t.exitEnd + Math.min(t.rise.start, t.ends[0])) / 2,
        1800,
      );
      rec.free = {
        y: Math.round(free.y),
        free: free.free,
        lapAttr: free.lapAttr,
        drawn: free.drawn.map((d) => d.id),
        held: free.held,
        gpu: free.gpu,
        gpuLineup: at.gpu,
        fits: trimFits(t, page.viewportSize().height),
        span: spanText(t, page.viewportSize().height),
      };
      // the end, by gestures as a visitor makes them: from the footer's rest
      // one move to the chosen capsule (the rise), then one back to the row
      // (Return), which wraps; the lean monitor samples every frame by phase
      await to(t.ends[0], 800);
      await phase('rise');
      await gesture(s, 1);
      const t2 = (await settle()).t;
      await phase('return');
      // the seam: the last frame drawn before the wrap and the first after it
      const seam = page.evaluate(async (riseStart) => {
        const ps = window.__packStage;
        const r3 = (v) => Math.round(v * 1000) / 1000;
        const read = () =>
          (ps.runtime?.()?.drawn ?? [])
            .filter((d) => d.opacity > 0)
            .map((d) => ({
              id: d.id,
              x: r3(d.x),
              y: r3(d.y),
              z: r3(d.z),
              s: r3(d.scale),
            }));
        let before = null;
        const t0 = performance.now();
        while (performance.now() - t0 < 5000) {
          await new Promise((r) => requestAnimationFrame(r));
          if (scrollY > riseStart) before = read();
          else if (before) {
            await new Promise((r) => requestAnimationFrame(r));
            return { before, after: read() };
          }
        }
        return { before: before ?? [], after: [] };
      }, t2.rise.start);
      await page.waitForTimeout(50);
      await gesture(s, 1);
      const sm = await seam;
      rec.before = { drawn: sm.before };
      rec.after = { drawn: sm.after };
      await phase('row');
      rec.landed = await settle();
      rec.r0 = t2.r0;
      laps.push(rec);
      prev = rec;
    }
    await page.evaluate(() => {
      window.__lean.on = false;
    });
    const ph = await page.evaluate(() => window.__lean.ph);
    const deg = (v) =>
      Math.abs(v) > 8 ? 'n/a' : Math.round((v / DEG) * 10) / 10;
    const within = (a) =>
      a.yaw <= LIM.yaw + EPS &&
      a.up <= LIM.away + EPS &&
      a.down >= -LIM.toward - EPS;
    const leanLine = (names, kind) =>
      names
        .map((n) => {
          const a = ph[n]?.[kind];
          return a && a.n
            ? n +
                ': |yaw| ' +
                deg(a.yaw) +
                ', rotX ' +
                deg(a.down) +
                '..' +
                deg(a.up) +
                ' (' +
                a.n +
                ' tile samples, ' +
                ph[n].frames +
                ' frames' +
                (a.ex ? '; first over-limit ' + JSON.stringify(a.ex) : '') +
                ')'
            : n + ': no ' + kind + ' sample';
        })
        .join('; ');
    /**
     * Every phase in names stays within the limits, and every phase in need
     * has samples of that kind: a phase that saw no tile proves nothing.
     */
    const leanOk = (names, kind, need = names) =>
      need.every((n) => (ph[n]?.[kind]?.n ?? 0) > 0) &&
      names.every((n) => !ph[n]?.[kind]?.n || within(ph[n][kind]));
    const motionPhases = ['rise', 'return'];
    const restPhases = ['row', 'hand-off', 'lineup'];
    // Flat pictures show only for capsules outside the 3D draw range (phone:
    // centre +-1, desktop: centre +-2, so all five on a desktop at the row and
    // the lineup). The flat-tile check needs samples where flat pictures are
    // expected: the hand-off on both sizes, and the lineup on a phone.
    const flatRestPhases =
      size === 'phone' ? ['hand-off', 'lineup'] : ['hand-off'];
    const framesIn = (names) => names.every((n) => (ph[n]?.frames ?? 0) > 0);
    const poseNote =
      " [limits |yaw| <= 25, rotX <= 15 away, >= -25 toward; reads the tiles' CSS pose, not the 3D capsule, whose rotation the debug hook does not expose]";
    report(
      'poly-tile-pose-within-limits-rise-and-return-' + size,
      framesIn(motionPhases) && leanOk(motionPhases, 'any'),
      leanLine(motionPhases, 'any') + poseNote,
    );
    report(
      'poly-lean-flat-tiles-rise-and-return-' + size,
      framesIn(motionPhases) && leanOk(motionPhases, 'pic'),
      leanLine(motionPhases, 'pic'),
    );
    report(
      'poly-tile-pose-within-limits-row-handoff-lineup-' + size,
      framesIn(restPhases) && leanOk(restPhases, 'any'),
      leanLine(restPhases, 'any') + poseNote,
    );
    report(
      'poly-lean-flat-tiles-row-handoff-lineup-' + size,
      framesIn(restPhases) && leanOk(restPhases, 'pic', flatRestPhases),
      leanLine(restPhases, 'pic') +
        ' [samples needed at: ' +
        flatRestPhases.join(', ') +
        ']',
    );
    // (2) the free span draws only the chosen capsule, and holds only it
    // where the span is longer than its two trim margins (shorter, the trim
    // stays off: every capsule stays held, no more GPU than at the lineup,
    // and on the phone under its cap)
    report(
      'poly-free-span-only-the-chosen-capsule-' + size,
      laps.every(
        (l) =>
          l.free.free &&
          !l.free.lapAttr &&
          l.free.drawn.every((d) => d === l.id) &&
          (l.free.fits
            ? l.free.held.length === 1 &&
              l.free.held[0] === l.id &&
              l.free.gpu < l.free.gpuLineup
            : l.free.held.includes(l.id) &&
              l.free.gpu <= l.free.gpuLineup &&
              (size !== 'phone' || l.free.gpu <= FREE_GPU_CAP)),
      ),
      (laps[0]?.free.span ?? '') +
        '; ' +
        laps
          .map(
            (l) =>
              'index ' +
              l.index +
              ' (' +
              l.id +
              '): held [' +
              l.free.held.join(',') +
              '], drawn [' +
              l.free.drawn.join(',') +
              '], GPU ' +
              MB(l.free.gpu) +
              ' MB (lineup ' +
              MB(l.free.gpuLineup) +
              ' MB)',
          )
          .join('; '),
    );
    // the stops, read while focused (at the lineup) on every lap's capsule
    const row0 = { kinds: laps[0]?.kinds ?? [] };
    report(
      'poly-stops-without-buyback-' + size,
      row0.kinds.length === 5 &&
        !row0.kinds.includes('buyback') &&
        row0.kinds.every((k, i) => k === CAPSULE_KINDS[i]) &&
        laps.every(
          (l) => JSON.stringify(l.kinds) === JSON.stringify(row0.kinds),
        ),
      'stop kinds ' +
        JSON.stringify(row0.kinds) +
        ' (want ' +
        CAPSULE_KINDS.join(', ') +
        ')',
    );
    // (3) the pose at the wrap is the same for every index
    const ref = laps[0];
    // Per index: no jump across the seam. Across indexes: the centred pack
    // stands in the same place (x, z, scale); the row at rest has an end, so an
    // end index shows one neighbour, and y carries the live idle bob.
    const mid = (d) =>
      [...d].sort((m, n) => Math.abs(m.x) - Math.abs(n.x))[0] ?? null;
    const samePlace = (p, q) =>
      !!p &&
      !!q &&
      Math.abs(p.x - q.x) <= 0.005 &&
      Math.abs(p.z - q.z) <= 0.01 &&
      Math.abs(p.s - q.s) <= 0.03;
    const seamSame = laps.every(
      (l) =>
        sameRow(l.before.drawn, l.after.drawn) &&
        samePlace(mid(l.before.drawn), mid(ref.before.drawn)) &&
        samePlace(mid(l.landed.drawn), mid(ref.landed.drawn)),
    );
    report(
      'poly-seam-pose-same-for-all-5-indexes-' + size,
      new Set(laps.map((l) => l.index)).size === 5 && seamSame,
      'indexes ' +
        laps.map((l) => l.index).join(',') +
        '; at the seam (left to right x:y:z:s) ' +
        laps
          .map(
            (l) =>
              l.index +
              ' [' +
              [...l.before.drawn]
                .sort((m, n) => m.x - n.x)
                .map((d) => [d.x, d.y, d.z, d.s].join(':'))
                .join(' ') +
              ']',
          )
          .join(' | '),
    );
    // (4) the pick carries through the wrap
    report(
      'poly-pick-carries-through-the-wrap-' + size,
      laps.every(
        (l) =>
          Math.round(l.landed.track) === l.index &&
          centred(l.landed) === l.id &&
          Math.abs(l.landed.y - l.r0) < 1 &&
          !l.landed.on &&
          (l.prevIndex === null || l.index !== l.prevIndex),
      ),
      laps
        .map(
          (l) =>
            'picked ' +
            l.id +
            ' (index ' +
            l.index +
            '): after the wrap track ' +
            r3(l.landed.track) +
            ', centred ' +
            centred(l.landed) +
            ', y ' +
            Math.round(l.landed.y) +
            ' (R0 ' +
            l.r0 +
            ')',
        )
        .join('; '),
    );
    report(
      'errors-poly-' + size,
      page.errors.length === 0,
      page.errors.join(' | '),
    );
    await s.ctx.close();
  }

  if (part('reload')) {
    const s = await open(size);
    const { page } = s;
    await load(s);
    const s0 = await snap(page);
    const reload = async () => {
      const at = new URL(page.url());
      // a pack address (written by the flow without the QA query): its
      // redirect drops the QA switches, so read the redirect from the
      // response alone, then open the flow on that pack with the debug handle
      let served = null;
      if (/^\/slots\//.test(at.pathname)) {
        const res = await page.reload({ waitUntil: 'load' });
        const u = res ? new URL(res.url()) : null;
        served = u && {
          path: u.pathname,
          focus: u.searchParams.get('focus'),
          qa: ['debug', 'stage', 'loader', 'soldout', 'jp'].filter((k) =>
            u.searchParams.has(k),
          ),
        };
        const id = decodeURIComponent(at.pathname.slice('/slots/'.length));
        await page.goto(
          `${BASE}${PREVIEW}?focus=${encodeURIComponent(id)}&stage=3d&debug=1&loader=never`,
          { waitUntil: 'load' },
        );
      } else await page.reload({ waitUntil: 'load' });
      const loadY = await page.evaluate(() => window.__loadY ?? null);
      const path = new URL(page.url()).pathname;
      if (path === PREVIEW) await ready(page);
      else await page.waitForTimeout(2500);
      // a reload of a pack address opens the flow on that pack: give it the
      // loader and the move to Front
      return { loadY, served, r: await rest(page, 12000) };
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
      // under the preview switch a load of the pack's address opens the flow
      // on that pack at Front (a fresh entry: no saved stop)
      x.served?.path === PREVIEW &&
        x.served.focus === SLUG &&
        x.served.qa.length === 0 &&
        x.r.path === `/slots/${SLUG}` &&
        !!x.r.stage &&
        x.r.on &&
        near(x.r.y, x.r.stops[1]) &&
        x.r.block === x.r.kinds[0],
      `resting at ${r.block} (address ${r.path}); its reload redirects to ${x.served?.path}?focus=${x.served?.focus} (QA switches kept: ${x.served?.qa.join(',') || 'none'}); the flow opened there serves ${x.r.path} ${x.r.stage ? 'with the preview stage' : 'as the pack page (not the preview)'}, focused ${x.r.on} at ${x.r.block} (y ${x.r.y}, Front ${x.r.stops?.[1]})`,
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
