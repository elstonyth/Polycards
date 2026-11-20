// scripts/qa-home-stage.mjs
// QA for the homepage pack stage's 3D layer on /home-preview (plan section 9,
// docs/research/home-3d/pack-stage/plan.md), on top of the flat-page checks.
//
// Runs against an ALREADY-RUNNING production server (`next build` then
// `HOME_PREVIEW=1 next start`); it never starts one.
//
// Usage:
//   node scripts/qa-home-stage.mjs [baseUrl]      (default http://localhost:4300, or PW_BASE)
//   ONLY=align,context-loss node scripts/qa-home-stage.mjs
//   HEADED=1 node scripts/qa-home-stage.mjs       (visitor pass in system Chrome, no ?stage=)
//   SHOTS=0 / VIDEO=0                             (skip the owner's screenshots / recordings)
//   node scripts/qa-home-stage.mjs --self-test    (pixel maths only, no server)
//
// Headless runs force `?stage=3d` (headless Chromium renders WebGL in software,
// which fails the gate's GPU-caveat probe). HEADED=1 lets the real gate decide,
// logs what it picked and UNMASKED_RENDERER, and records the owner's shots and
// videos from what a visitor would see.
//
// Every check prints one line: PASS / FAIL / SKIP name: detail. Exit code 1 on
// any FAIL.
import { chromium, webkit } from 'playwright';
import sharp from 'sharp';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS =
  process.env.SHOTS_DIR ??
  join(ROOT, 'docs/research/home-3d/pack-stage/shots-3d');
const FILTER_SHOTS =
  process.env.FILTER_SHOTS_DIR ??
  join(ROOT, 'docs/research/home-3d/pack-stage/shots-filter');
const args = process.argv.slice(2);
const SELF_TEST = args.includes('--self-test');
const BASE = (
  args.find((a) => /^https?:/.test(a)) ??
  process.env.PW_BASE ??
  'http://localhost:4300'
).replace(/\/$/, '');
const URL = `${BASE}/home-preview`;
/**
 * `HEADED=1`: a real (GPU) window, parked off screen so nobody sees the key
 * colours of the layer masks flash; `HEADED=visible` puts it on screen.
 */
const HEADED = process.env.HEADED === '1' || process.env.HEADED === 'visible';
/** `BROWSER=webkit`: run the suite in WebKit (headless). */
const WEBKIT = process.env.BROWSER === 'webkit';
const HEADED_ARGS =
  process.env.HEADED === 'visible'
    ? []
    : [
        '--window-position=-32000,-32000',
        '--window-size=1600,1000',
        // An off-screen window must keep painting at the display rate.
        '--disable-features=CalculateNativeWinOcclusion',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ];
const ONLY = new Set((process.env.ONLY ?? '').split(',').filter(Boolean));
const WANT_SHOTS = process.env.SHOTS !== '0';
const WANT_VIDEO = process.env.VIDEO !== '0';
/** Alignment tolerance, CSS px (plan section 8 risk 5). */
const TOL = 4;
/** Plan section 4: GPU estimate caps. */
const CAPS = { phone: 40e6, desktop: 96e6 };
/** stage-pose.ts IDLE_BOB_ART: the canvas bobs, the flat tiles do not. */
const IDLE_BOB_ART = 0.006;
const CHUNK = /pack-stage-3d/;
const SOFTWARE_GPU =
  /SwiftShader|llvmpipe|softpipe|Software|Basic Render|Microsoft Basic/i;

const PROFILES = {
  desktop: {
    kind: 'desktop',
    // DESKTOP_DPR=2: a retina desktop (full-front promotion, the tightest cap).
    context: {
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: Number(process.env.DESKTOP_DPR) || 1,
    },
  },
  phone: {
    kind: 'phone',
    context: {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
  },
};

// ---------------------------------------------------------------------------
// Reporting

const results = [];
function report(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`${status} ${name}: ${detail}`);
}
const pass = (n, ok, d) => report(n, ok ? 'PASS' : 'FAIL', d);
const skip = (n, d) => report(n, 'SKIP', d);
const wanted = (group) => ONLY.size === 0 || ONLY.has(group);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (v) => Math.round(v * 10) / 10;

async function run(group, name, fn) {
  if (!wanted(group)) return;
  try {
    await fn();
  } catch (e) {
    report(name, 'FAIL', `threw ${String(e?.message ?? e).split('\n')[0]}`);
  }
}

// ---------------------------------------------------------------------------
// Pixel maths (as the runtime bench, docs/research/home-3d/pack-stage/bench/run.cjs)

/**
 * Pack mask from one layer shot over magenta and over green: a pixel belongs
 * to a pack when it does not change with the key colour (at least ~10% opaque).
 */
async function keyedMask(bufA, bufB) {
  const load = (b) =>
    sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const A = await load(bufA);
  const B = await load(bufB);
  const W = A.info.width;
  const H = A.info.height;
  const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    const d =
      Math.abs(A.data[p] - B.data[p]) +
      Math.abs(A.data[p + 1] - B.data[p + 1]) +
      Math.abs(A.data[p + 2] - B.data[p + 2]);
    m[i] = d < 0.9 * 765 ? 1 : 0;
  }
  return maskOf(W, H, m);
}

function maskOf(W, H, m) {
  return {
    W,
    H,
    on: (x, y) => m[y * W + x] === 1,
    count: () => m.reduce((s, v) => s + v, 0),
  };
}

/** One box per horizontal run of pack columns, in CSS px of the clip. */
function boxes(M, dpr) {
  const { W, H, on } = M;
  const col = new Array(W).fill(0);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) if (on(x, y)) col[x]++;
  const runs = [];
  let start = -1;
  let gap = 0;
  for (let x = 0; x <= W; x++) {
    const filled = x < W && col[x] > 1;
    if (filled) {
      if (start < 0) start = x;
      gap = 0;
    } else if (start >= 0 && ++gap >= 3) {
      runs.push([start, x - gap]);
      start = -1;
      gap = 0;
    }
  }
  if (start >= 0) {
    let end = W - 1;
    while (end > start && col[end] <= 1) end--;
    runs.push([start, end]);
  }
  return runs
    .filter(([a, b]) => b - a > 8 * dpr)
    .map(([x0, x1]) => {
      let y0 = H;
      let y1 = -1;
      for (let y = 0; y < H; y++)
        for (let x = x0; x <= x1; x++)
          if (on(x, y)) {
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
            break;
          }
      const c = (v) => Math.round((v / dpr) * 100) / 100;
      return {
        x0: c(x0),
        x1: c(x1 + 1),
        cx: c((x0 + x1 + 1) / 2),
        cy: c((y0 + y1 + 1) / 2),
        w: c(x1 + 1 - x0),
        h: c(y1 + 1 - y0),
      };
    });
}

function iou(A, B) {
  let inter = 0;
  let union = 0;
  for (let y = 0; y < A.H; y++)
    for (let x = 0; x < A.W; x++) {
      const a = A.on(x, y);
      const b = B.on(x, y);
      if (a && b) inter++;
      if (a || b) union++;
    }
  return Math.round((inter / Math.max(1, union)) * 1000) / 1000;
}

/**
 * The centred pack and its nearest neighbour: each tile box against the canvas
 * box nearest its centre. `extraDy` widens the vertical tolerance (idle bob).
 */
function comparePacks(canvasBoxes, tileBoxes, centreX, extraDy = 0) {
  const tiles = [...tileBoxes]
    .sort((a, b) => Math.abs(a.cx - centreX) - Math.abs(b.cx - centreX))
    .slice(0, 2);
  const pairs = tiles.map((t) => {
    const c = [...canvasBoxes].sort(
      (a, b) => Math.abs(a.cx - t.cx) - Math.abs(b.cx - t.cx),
    )[0];
    if (!c) return { ok: false, tile: t, canvas: null };
    const dCx = r1(c.cx - t.cx);
    const dCy = r1(c.cy - t.cy);
    const dH = r1(c.h - t.h);
    return {
      ok:
        Math.abs(dCx) <= TOL &&
        Math.abs(dCy) <= TOL + extraDy &&
        Math.abs(dH) <= TOL,
      dCx,
      dCy,
      dH,
      tileCx: t.cx,
    };
  });
  // Both layers must hold the same packs; at least the centred one, or none
  // in either (faded out together).
  const same = canvasBoxes.length === tileBoxes.length;
  return {
    ok: same && pairs.every((p) => p.ok),
    pairsOk: pairs.every((p) => p.ok),
    empty: tileBoxes.length === 0 && canvasBoxes.length === 0,
    pairs,
  };
}

function selfTest() {
  // Two packs drawn as rectangles in both layers, one shifted 3 px: within tolerance.
  const W = 400;
  const H = 300;
  const draw = (shift) => {
    const m = new Uint8Array(W * H);
    const rect = (x0, y0, w, h) => {
      for (let y = y0; y < y0 + h; y++)
        for (let x = x0; x < x0 + w; x++) m[y * W + x] = 1;
    };
    rect(150 + shift, 40, 100, 200);
    rect(300, 70, 60, 140);
    return maskOf(W, H, m);
  };
  const a = boxes(draw(0), 1);
  const b = boxes(draw(3), 1);
  const ok3 = comparePacks(b, a, 200).ok;
  const bad = comparePacks(boxes(draw(6), 1), a, 200).ok;
  const io = iou(draw(0), draw(3));
  pass(
    'self-test-boxes',
    a.length === 2 && a[0].w === 100 && a[0].h === 200,
    JSON.stringify(a),
  );
  pass(
    'self-test-tolerance',
    ok3 && !bad,
    `3 px shift within ${TOL}: ${ok3}; 6 px shift rejected: ${!bad}; IoU at 3 px ${io}`,
  );
  pass(
    'self-test-prepaint-url',
    new globalThis.URL(`${URL}?stage=3d`).pathname === '/home-preview',
    URL,
  );
}

// ---------------------------------------------------------------------------
// Page helpers

let browser;
let softwareGpu = true;

// ---------------------------------------------------------------------------
// Audio: every run is silent, always (the site plays music). Chromium gets
// --mute-audio at launch; every context also gets this init script, which
// keeps media elements muted and Web Audio silent before any page script runs.
// There is deliberately no switch to turn either off.

function muteMediaScript() {
  try {
    const proto = HTMLMediaElement.prototype;
    const mutedDesc = Object.getOwnPropertyDescriptor(proto, 'muted');
    const volumeDesc = Object.getOwnPropertyDescriptor(proto, 'volume');
    if (mutedDesc?.set) {
      Object.defineProperty(proto, 'muted', {
        configurable: true,
        get() {
          return mutedDesc.get.call(this);
        },
        set() {
          mutedDesc.set.call(this, true);
        },
      });
    }
    if (volumeDesc?.set) {
      Object.defineProperty(proto, 'volume', {
        configurable: true,
        get() {
          return volumeDesc.get.call(this);
        },
        set() {
          volumeDesc.set.call(this, 0);
        },
      });
    }
    const play = proto.play;
    proto.play = function (...a) {
      try {
        mutedDesc?.set?.call(this, true);
        volumeDesc?.set?.call(this, 0);
      } catch {
        /* ignore */
      }
      return play.apply(this, a);
    };
    for (const name of ['AudioContext', 'webkitAudioContext']) {
      const Real = window[name];
      if (typeof Real !== 'function') continue;
      const Silent = function (...a) {
        const ctx = new Real(...a);
        try {
          ctx.suspend();
        } catch {
          /* ignore */
        }
        ctx.resume = () => Promise.resolve();
        return ctx;
      };
      Silent.prototype = Real.prototype;
      window[name] = Silent;
    }
  } catch {
    /* never break the page under test */
  }
}

const MUTE_ARGS = ['--mute-audio'];

/** Chromium / Chrome, always muted (headed or not). */
function launchChromium(opts = {}) {
  return chromium.launch({
    ...opts,
    args: [...MUTE_ARGS, ...(opts.args ?? [])],
  });
}

async function newPage(profile, extra = {}, b = browser) {
  const ctx = await b.newContext({ ...profile.context, ...extra });
  await ctx.addInitScript(muteMediaScript); // always: second guard after --mute-audio
  const page = await ctx.newPage();
  page.errors = [];
  page.chunkRequests = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // WebKit reports the site's report-only CSP header (no report-to) as a
    // console error; it is a header notice, not a page error.
    if (/delivered in report-only mode/.test(m.text())) return;
    page.errors.push(m.text());
  });
  page.on(
    'request',
    (r) => CHUNK.test(r.url()) && page.chunkRequests.push(r.url()),
  );
  return { ctx, page };
}

const stageUrl = (params) => `${URL}?${new URLSearchParams(params).toString()}`;
const forced = (more = {}) => ({
  ...(HEADED ? { debug: '1' } : { stage: '3d', debug: '1' }),
  ...more,
});
/** Owner shots of the sorting control: `closed-phone` etc. */
const lookShot = (base, label) =>
  label.endsWith('-webkit')
    ? `webkit-${base}-${label.replace('-webkit', '')}`
    : `${base}-${label}`;

/** Declines the cookie banner (the privacy-preserving choice); it shows a moment after load. */
async function dismissChrome(page, waitMs = 3000) {
  const b = page.getByRole('button', { name: /^(reject|decline)/i }).first();
  const shown = await b
    .waitFor({ state: 'visible', timeout: waitMs })
    .then(() => true)
    .catch(() => false);
  if (shown) {
    await b.click().catch(() => {});
    await sleep(300);
  }
}

const stageInfo = (page) =>
  page.evaluate(() => {
    const s = window.__packStage;
    if (!s) return null;
    return {
      mode: s.mode(),
      ready: s.ready(),
      tier: s.tier(),
      running: s.running(),
      live: s.live(),
      layout: s.layout(),
      state: { ...s.state },
      stats: s.stats(),
    };
  });

/** Visible panel's tiles: live flag and picture opacity. */
const tileStates = (page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-stage-panel]:not([hidden]) [data-stage-tile]',
      ),
    ].map((li) => {
      const art = li.querySelector('[data-stage-art]');
      const img = art?.querySelector('img');
      return {
        id: li.getAttribute('data-pack-id'),
        index: Number(li.getAttribute('data-index')),
        live: art?.getAttribute('data-live') ?? null,
        opacity: img ? getComputedStyle(img).opacity : null,
      };
    }),
  );

async function waitLive(page, min, timeout = 30000) {
  await page.waitForFunction(
    (n) => window.__packStage?.ready() && window.__packStage.live().length >= n,
    min,
    { timeout, polling: 100 },
  );
}

/** Idle motion eased to rest and the loop asleep (the flat tiles never bob). */
async function waitRest(page, timeout = 25000) {
  try {
    await page.waitForFunction(
      () => window.__packStage && !window.__packStage.running(),
      null,
      { timeout, polling: 200 },
    );
  } catch {
    const s = await page.evaluate(() => ({
      idle: window.__packStage?.state.idle,
      pointer: [
        window.__packStage?.state.pointerX,
        window.__packStage?.state.pointerY,
      ],
      hidden: document.hidden,
      focus: document.hasFocus(),
    }));
    throw new Error(
      `the loop never came to rest in ${timeout / 1000} s: ${JSON.stringify(s)}`,
    );
  }
}

/** The host's visible rectangle (CSS px, viewport coordinates) and its pack centre x. */
async function hostClip(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-stage-canvas]');
    const r = host.getBoundingClientRect();
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    const w = Math.min(innerWidth, r.right) - x;
    const h = Math.min(innerHeight, r.bottom) - y;
    const l = window.__packStage?.layout();
    return {
      clip: { x, y, width: Math.floor(w), height: Math.floor(h) },
      centreX: (l ? r.left + l.cx : r.left + r.width / 2) - x,
      artCy: l ? r.top + l.cy : null,
      step: l?.step ?? null,
      artH: l?.artH ?? null,
      artW: l?.artW ?? null,
    };
  });
}

/**
 * One layer over a key colour. Tiles: only the pictures of LIVE packs (the
 * ones the canvas says it drew), forced opaque, so both layers hold the same
 * packs.
 */
function layerCss(layer, color) {
  const base = `html,body{background:${color}!important}body *{visibility:hidden!important;transition:none!important}`;
  return layer === 'canvas'
    ? `${base}[data-stage-canvas],[data-stage-canvas] canvas{visibility:visible!important}`
    : `${base}[data-stage-panel]:not([hidden]) [data-stage-art][data-live="1"] img{visibility:visible!important;opacity:1!important}`;
}

/**
 * The page's own clock for frame-exact holds: motion and the provider time
 * everything from performance.now(), so freezing it freezes the float-in and
 * the switch while frames (and the canvas) keep drawing. Playwright's
 * page.clock is not used: its performance.now() starts at install, which makes
 * a first visit look late to the loader.
 */
function qaClockScript() {
  const real = performance.now.bind(performance);
  const q = { paused: false, frozen: 0, offset: 0 };
  performance.now = () => (q.paused ? q.frozen : real() - q.offset);
  window.__qaClock = {
    pause() {
      if (q.paused) return;
      q.frozen = real() - q.offset;
      q.paused = true;
    },
    advance(ms) {
      q.frozen += ms;
    },
    resume() {
      if (!q.paused) return;
      q.offset = real() - q.frozen;
      q.paused = false;
    },
  };
}

async function setStyle(page, id, css) {
  await page.evaluate(
    ([sid, text]) => {
      let s = document.getElementById(sid);
      if (text === null) return s?.remove();
      if (!s) {
        s = document.createElement('style');
        s.id = sid;
        document.head.appendChild(s);
      }
      s.textContent = text;
    },
    [id, css],
  );
}

async function layerMask(page, layer, clip, dpr) {
  const shots = [];
  for (const color of ['#ff00ff', '#00ff00']) {
    await setStyle(page, 'qa-layer', layerCss(layer, color));
    await sleep(150);
    shots.push(await page.screenshot({ clip }));
  }
  await setStyle(page, 'qa-layer', null);
  const mask = await keyedMask(shots[0], shots[1]);
  return { mask, boxes: boxes(mask, dpr) };
}

/**
 * The centred pack's extent (CSS px) in each layer, read only from the columns
 * of the centre tile's art box (its width around the centre x, plus a margin);
 * returns the differences canvas minus tiles, or null if either is empty.
 */
function centreExtent(A, B, centreX, artW, dpr) {
  const half = ((artW ?? 230) / 2 + 6) * dpr;
  const cx = centreX * dpr;
  const x0 = Math.max(0, Math.floor(cx - half));
  const x1 = Math.min(A.W - 1, Math.ceil(cx + half));
  const extent = (M) => {
    let top = Infinity;
    let bottom = -1;
    let left = Infinity;
    let right = -1;
    for (let y = 0; y < M.H; y++)
      for (let x = x0; x <= x1; x++)
        if (M.on(x, y)) {
          if (y < top) top = y;
          if (y > bottom) bottom = y;
          if (x < left) left = x;
          if (x > right) right = x;
        }
    return bottom < 0 ? null : { top, bottom, left, right };
  };
  const a = extent(A);
  const b = extent(B);
  if (!a || !b) return null;
  const d = (k) => r1((a[k] - b[k]) / dpr);
  return {
    dTop: d('top'),
    dBottom: d('bottom'),
    dLeft: d('left'),
    dRight: d('right'),
  };
}

/** Canvas vs tiles for the centred pack and a neighbour. */ async function align(
  page,
  profile,
  extraDy = 0,
) {
  const dpr = profile.context.deviceScaleFactor ?? 1;
  const h = await hostClip(page);
  const c = await layerMask(page, 'canvas', h.clip, dpr);
  const t = await layerMask(page, 'tiles', h.clip, dpr);
  const cmp = comparePacks(c.boxes, t.boxes, h.centreX, extraDy);
  const io = iou(c.mask, t.mask);
  // The centred pack on its own: its silhouette inside the centre tile's
  // column range, in both layers. Unlike the column-run boxes it cannot be
  // thrown by a neighbour touching it, or by a few translucent foil columns
  // splitting one pack into two runs (seen once in 12 headed runs, IoU 0.993).
  const centre = centreExtent(c.mask, t.mask, h.centreX, h.artW, dpr);
  const centreOk =
    centre !== null &&
    Math.abs(centre.dTop) <= TOL + extraDy &&
    Math.abs(centre.dBottom) <= TOL + extraDy &&
    Math.abs(centre.dLeft) <= TOL &&
    Math.abs(centre.dRight) <= TOL;
  return {
    ...cmp,
    // Box counts can differ when two packs nearly touch (one layer merges
    // them into one run); the whole silhouette (IoU) and the centred pack's
    // own extent then vouch.
    ok: cmp.ok || (io >= 0.97 && centreOk),
    iou: io,
    detail: `${cmp.empty ? 'both layers empty (faded out together)' : ''}${cmp.pairs.map((p) => (p.canvas === null ? 'no canvas pack' : `dCx ${p.dCx} dCy ${p.dCy} dH ${p.dH}`)).join('; ')}; IoU ${io}; packs drawn ${c.boxes.length}, tiles ${t.boxes.length}${cmp.ok ? '' : `; centred pack alone: ${centre ? `top ${centre.dTop} bottom ${centre.dBottom} left ${centre.dLeft} right ${centre.dRight}` : 'not found'}`}`,
  };
}

function bobPx(info) {
  if (!info) return 0;
  const idle = info.state.idle;
  if (!idle) return 0;
  return (
    Math.abs(Math.sin((4 * Math.PI * idle) / 6)) *
      IDLE_BOB_ART *
      (info.layout?.artH ?? 0) *
      Math.min(1, idle) +
    0.5
  );
}

/** Press and drag the track by `steps` packs (negative = toward the next pack), held. */
async function holdDrag(page, profile, steps) {
  const h = await hostClip(page);
  const x0 = h.clip.x + h.centreX;
  const y = h.artCy ?? h.clip.y + h.clip.height * 0.4;
  const dx = steps * (h.step ?? 200);
  const n = 12;
  if (
    profile.kind === 'phone' &&
    page.context().browser()?.browserType().name() === 'chromium'
  ) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: x0, y }],
    });
    for (let i = 1; i <= n; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x0 + (dx * i) / n, y }],
      });
      await sleep(16);
    }
    return async () => {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await cdp.detach().catch(() => {});
    };
  }
  await page.mouse.move(x0, y);
  await page.mouse.down();
  for (let i = 1; i <= n; i++) {
    await page.mouse.move(x0 + (dx * i) / n, y);
    await sleep(16);
  }
  return async () => page.mouse.up();
}

async function swipe(page, profile, steps) {
  const release = await holdDrag(page, profile, steps);
  await release();
}

async function shot(page, name) {
  if (!WANT_SHOTS) return;
  await setStyle(
    page,
    'qa-hide-debug',
    '[data-stage-root] > p.fixed{display:none!important}',
  );
  await page.screenshot({
    path: join(SHOTS, `${name.replace('-headed', '')}.png`),
  });
  await setStyle(page, 'qa-hide-debug', null);
}

async function renderer(page) {
  return page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    if (!gl) return 'no WebGL';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = ext
      ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return String(r);
  });
}

async function centreOn(page, packId) {
  for (let k = 0; k < 12; k++) {
    const st = await page.evaluate((id) => {
      const li = document.querySelector(
        `[data-stage-panel]:not([hidden]) [data-stage-tile][data-pack-id="${id}"]`,
      );
      return {
        want: li ? Number(li.getAttribute('data-index')) : null,
        at: Math.round(window.__packStage?.state.track ?? -1),
      };
    }, packId);
    if (st.want === null) return false;
    if (st.want === st.at) return true;
    await page
      .getByRole('button', {
        name:
          st.want < st.at
            ? /^Previous (pack|capsule)$/
            : /^Next (pack|capsule)$/,
      })
      .first()
      .click();
    await sleep(700);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Checks

async function checkChunkAndLive(label, profile) {
  const { ctx, page } = await newPage(profile);
  await page.goto(stageUrl(forced({ loader: 'never' })), { waitUntil: 'load' });
  const ren = await renderer(page);
  await dismissChrome(page);
  softwareGpu = SOFTWARE_GPU.test(ren);
  report(
    `renderer-${label}`,
    'PASS',
    `UNMASKED_RENDERER ${ren}${softwareGpu ? ' (software: frame times not measured)' : ''}`,
  );
  const guard = await page.evaluate(() => {
    const a = new Audio();
    a.muted = false;
    a.volume = 1;
    return a.muted === true && a.volume === 0;
  });
  pass(
    `audio-muted-${label}`,
    guard,
    `${WEBKIT ? 'WebKit takes no --mute-audio: the init script mutes media and holds AudioContext suspended' : 'browser launched with --mute-audio (Chromium)'}; media guard keeps a new Audio() muted at volume 0 after unmuting: ${guard}`,
  );
  try {
    await waitLive(page, profile.kind === 'desktop' ? 3 : 2);
  } catch {
    /* reported below */
  }
  await sleep(500); // the 200 ms picture fade
  const info = await stageInfo(page);
  const tiles = await tileStates(page);
  const live = tiles.filter((t) => t.live === '1');
  const hidden = live.every((t) => t.opacity === '0');
  const notLiveShown = tiles
    .filter((t) => t.live !== '1')
    .every((t) => t.opacity === '1');
  const want = HEADED ? ['3d', 'lite'] : ['3d'];
  pass(
    `3d-live-${label}`,
    page.chunkRequests.length > 0 &&
      want.includes(info?.mode) &&
      live.length >= 2 &&
      hidden &&
      notLiveShown,
    `chunk requests ${page.chunkRequests.length}; mode ${info?.mode} tier ${info?.tier} ready ${info?.ready}; live ${live.map((t) => t.id).join(',')} (pictures hidden: ${hidden}); other pictures visible: ${notLiveShown}; layout ${JSON.stringify(info?.layout)}; errors ${page.errors.length} ${page.errors.slice(0, 2).join(' | ')}`,
  );
  if (info?.stats) {
    const cap = CAPS[profile.kind];
    await waitRest(page).catch(() => {});
    await waitLive(page, 2, 10000).catch(() => {});
    const rest = await stageInfo(page);
    pass(
      `gpu-rest-${label}`,
      rest.stats.gpuBytesEstimate <= cap && rest.live.length >= 2,
      `at rest (mode ${rest.mode}, tier ${rest.tier}, live ${rest.live.length}) gpuBytesEstimate ${(rest.stats.gpuBytesEstimate / 1e6).toFixed(1)} MB (cap ${cap / 1e6}); textures ${rest.stats.textures}, geometries ${rest.stats.geometries}, programs ${rest.stats.programs}`,
    );
    await shot(page, `rest-${label}`);
  }
  await ctx.close();
}

async function checkAlign(label, profile) {
  const { ctx, page } = await newPage(profile);
  await page.goto(stageUrl(forced({ loader: 'never' })), { waitUntil: 'load' });
  await dismissChrome(page);
  await waitLive(page, 2);
  // FULL_CANVAS=1: draw on the whole host instead of the band (diagnosis).
  if (process.env.FULL_CANVAS === '1')
    await page.evaluate(() => window.__packStage.fullCanvas(true));
  await page.mouse.move(2, 2); // the pointer off the stage: no lean
  await waitRest(page);
  const rest = await align(page, profile);
  pass(`align-rest-${label}`, rest.ok && rest.pairs.length === 2, rest.detail);

  const before = (await stageInfo(page)).state.track;
  const release = await holdDrag(page, profile, -0.4);
  await sleep(300);
  await waitRest(page).catch(() => {});
  const held = await stageInfo(page);
  const frac = r1((held.state.track - before) * 100) / 100;
  await shot(page, `mid-swipe-${label}`);
  const mid = await align(page, profile, bobPx(held));
  await release();
  pass(
    `align-drag40-${label}`,
    mid.ok && mid.pairs.length === 2 && Math.abs(frac - 0.4) <= 0.1,
    `held at track ${r1(held.state.track * 100) / 100} (moved ${frac} of a step); ${mid.detail}`,
  );
  await ctx.close();
}

/** Float-in, then the category sink, each frozen at three points with the page clock. */
async function checkMotion(label, profile) {
  const { ctx, page } = await newPage(profile);
  await page.addInitScript(qaClockScript);
  // The float-in only plays when the page hydrates in time (a late page shows
  // at once, by design: StageLoader's late cut). The server renders from the
  // live catalogue with a 30 s memo, so a cold memo can make one load late;
  // warm it first so the check measures the poses, not the backend.
  await fetch(stageUrl(forced({ loader: 'always' }))).catch(() => {});
  await page.goto(stageUrl(forced({ loader: 'always' })), {
    waitUntil: 'commit',
  });
  // Pause the moment the float-in has started (checked inside the page every frame).
  const started = await page
    .waitForFunction(
      () => {
        const s = window.__packStage;
        if (!s || !(s.state.intro > 0.02 && s.state.intro < 0.3)) return false;
        window.__qaClock.pause();
        return true;
      },
      null,
      { timeout: 20000, polling: 'raf' },
    )
    .then(() => true)
    .catch(() => false);
  if (!started) {
    const seen = await stageInfo(page).catch(() => null);
    const nav = await page
      .evaluate(() => {
        const n = performance.getEntriesByType('navigation')[0];
        return n
          ? `server answered at ${Math.round(n.responseStart)} ms, DOM ready at ${Math.round(n.domContentLoadedEventEnd)} ms`
          : 'no navigation timing';
      })
      .catch(() => 'no navigation timing');
    pass(
      `float-in-${label}`,
      false,
      `the float-in never started within 20 s (mode ${seen?.mode}, intro ${seen?.state.intro}, live ${seen?.live.length}; ${nav})`,
    );
    await ctx.close();
    return;
  }
  await sleep(900); // the CSS picture fade-in (real time) completes
  const points = [];
  for (let k = 0; k < 3; k++) {
    const info = await stageInfo(page);
    if (!info)
      throw new Error(
        `window.__packStage is gone during the float-in: url ${page.url()}; errors ${page.errors.slice(0, 3).join(' | ') || 'none'}`,
      );
    if (k === 1) {
      await dismissChrome(page, 1500);
      await shot(page, `float-in-mid-${label}`);
    }
    const a =
      info.live.length > 0 ? await align(page, profile, bobPx(info)) : null;
    points.push({
      intro: r1(info.state.intro * 100) / 100,
      live: info.live.length,
      a,
      at: `mode ${info.mode} tier ${info.tier}`,
    });
    await page.evaluate(() => window.__qaClock.advance(220));
    await sleep(250);
  }
  const allLive = points.every((p) => p.live > 0);
  pass(
    `float-in-${label}`,
    allLive && points.every((p) => p.a?.ok),
    points
      .map(
        (p) =>
          `intro ${p.intro} (${p.at}): ${p.a ? p.a.detail : `no pack live (3D not ready when the loader left: flat fallback)`}`,
      )
      .join(' || '),
  );

  // Category sink: Pokemon -> Poly, frozen 70 / 110 / 150 ms in (both layers
  // fade as they sink; later they are nearly transparent).
  await page.evaluate(() => window.__qaClock.resume());
  await waitLive(page, 2).catch(() => {});
  await waitRest(page).catch(() => {});
  await page.evaluate(() => window.__qaClock.pause());
  await page.getByRole('button', { name: /^Poly$/ }).click();
  await sleep(200);
  const sink = [];
  for (const ms of [50, 40, 40]) {
    await page.evaluate((v) => window.__qaClock.advance(v), ms);
    await sleep(250);
    const info = await stageInfo(page);
    if (!info)
      throw new Error(
        `window.__packStage is gone during the sink: url ${page.url()}; errors ${page.errors.slice(0, 3).join(' | ') || 'none'}`,
      );
    const a =
      info.live.length > 0 ? await align(page, profile, bobPx(info)) : null;
    sink.push({
      swap: r1(info.state.swap * 100) / 100,
      a,
      at: `mode ${info.mode} tier ${info.tier}`,
    });
  }
  await page.evaluate(() => window.__qaClock.resume());
  pass(
    `swap-sink-${label}`,
    sink.every((p) => p.a?.ok) && sink.some((p) => p.swap > 0.05),
    sink
      .map(
        (p) => `swap ${p.swap} (${p.at}): ${p.a ? p.a.detail : 'no pack live'}`,
      )
      .join(' || '),
  );
  await ctx.close();
}

async function checkContextLoss(label, profile) {
  const { ctx, page } = await newPage(profile);
  await page.goto(stageUrl(forced({ loader: 'never' })), { waitUntil: 'load' });
  await waitLive(page, 2);
  const lost = await page.evaluate(() => {
    const c = document.querySelector('[data-stage-canvas] canvas');
    const gl = c?.getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_lose_context');
    ext?.loseContext();
    return !!ext;
  });
  await sleep(800);
  const info = await stageInfo(page);
  const tiles = await tileStates(page);
  const canvases = await page.locator('[data-stage-canvas] canvas').count();
  const flag = await page.evaluate(() =>
    sessionStorage.getItem('polycards:pack-stage-3d'),
  );
  const allBack = tiles.every((t) => t.live === '0' && t.opacity === '1');
  pass(
    `context-loss-${label}`,
    lost &&
      info.mode === 'flat' &&
      allBack &&
      canvases === 0 &&
      flag === 'crashed',
    `lost ${lost}; mode ${info.mode}; every tile data-live=0 with its picture opaque: ${allBack}; canvases left ${canvases}; crash flag ${flag}`,
  );
  page.chunkRequests.length = 0;
  await page.reload({ waitUntil: 'load' });
  await sleep(3000);
  const after = await stageInfo(page);
  const entries = await page.evaluate(
    () =>
      performance
        .getEntriesByType('resource')
        .filter((e) => /pack-stage-3d/.test(e.name)).length,
  );
  const canv = await page.locator('[data-stage-canvas] canvas').count();
  pass(
    `crash-flag-reload-${label}`,
    after?.mode === 'flat' &&
      page.chunkRequests.length === 0 &&
      entries === 0 &&
      canv === 0,
    `reload in the same session: mode ${after?.mode}; chunk requests ${page.chunkRequests.length} (resource entries ${entries}); canvases ${canv}`,
  );
  await ctx.close();
}

async function checkNever3d(label, profile, name, extra, b = browser) {
  const { ctx, page } = await newPage(profile, extra, b);
  await page.goto(stageUrl({ stage: '3d', debug: '1', loader: 'never' }), {
    waitUntil: 'load',
  });
  await sleep(4000);
  const info = await stageInfo(page);
  const tiles = await tileStates(page);
  const visible =
    tiles.length > 0 && tiles.every((t) => t.live === '0' && t.opacity === '1');
  const canv = await page.locator('[data-stage-canvas] canvas').count();
  pass(
    `${name}-${label}`,
    page.chunkRequests.length === 0 &&
      info?.mode === 'flat' &&
      visible &&
      canv === 0,
    `?stage=3d: chunk requests ${page.chunkRequests.length}; mode ${info?.mode}; ${tiles.length} pictures all visible: ${visible}; canvases ${canv}`,
  );
  await ctx.close();
}

async function checkTabs(label, profile) {
  const { ctx, page } = await newPage(profile);
  await page.goto(stageUrl(forced({ loader: 'never' })), { waitUntil: 'load' });
  await dismissChrome(page);
  await waitLive(page, 2);
  await sleep(800);
  const base = (await stageInfo(page)).stats;
  const poly = [];
  const pokemon = [base];
  let maxBytes = base.gpuBytesEstimate;
  for (let k = 0; k < 20; k++) {
    await page.getByRole('button', { name: /^Poly$/ }).click();
    await sleep(1000);
    const p = await stageInfo(page);
    poly.push({ ...p.stats, running: p.running, live: p.live.length });
    maxBytes = Math.max(maxBytes, p.stats.gpuBytesEstimate);
    await page.getByRole('button', { name: /^Pok/ }).click();
    await waitLive(page, 1, 10000).catch(() => {});
    await sleep(800);
    const s = (await stageInfo(page)).stats;
    pokemon.push(s);
    maxBytes = Math.max(maxBytes, s.gpuBytesEstimate);
  }
  const p0 = poly[0];
  const polyFlat = poly.every(
    (p) =>
      p.textures === p0.textures &&
      p.geometries === p0.geometries &&
      p.live === 0 &&
      !p.running,
  );
  const maxTex = Math.max(...pokemon.map((s) => s.textures));
  const maxGeo = Math.max(...pokemon.map((s) => s.geometries));
  const bounded = maxTex <= base.textures + 2 && maxGeo <= base.geometries + 2;
  const last = pokemon.at(-1);
  const cap = CAPS[profile.kind];
  pass(
    `tabs-x20-${label}`,
    polyFlat &&
      bounded &&
      maxBytes <= cap &&
      last.textures <= base.textures + 2,
    `Pokemon start: textures ${base.textures} geometries ${base.geometries} ${(base.gpuBytesEstimate / 1e6).toFixed(1)} MB; Poly every time: textures ${p0.textures} geometries ${p0.geometries} ${(p0.gpuBytesEstimate / 1e6).toFixed(1)} MB, loop asleep, none live: ${polyFlat}; Pokemon max textures ${maxTex} geometries ${maxGeo}, after 20 ${last.textures}/${last.geometries}; max gpuBytesEstimate ${(maxBytes / 1e6).toFixed(1)} MB (cap ${cap / 1e6})`,
  );
  await page.getByRole('button', { name: /^Poly$/ }).click();
  await sleep(1200);
  await shot(page, `poly-${label}`);
  await ctx.close();
}

async function checkRelease(label) {
  // The provider releases textures from a private 60 s timer after the page is
  // hidden or the stage leaves the view; window.__packStage exposes no way in.
  skip(
    `release-hidden-${label}`,
    'not reachable from window.__packStage (the 60 s release timer is private to the provider); the same setPacks(null) path is covered by the Poly tab check',
  );
}

async function checkLoader(label, profile) {
  const { ctx, page } = await newPage(profile);
  await page.addInitScript(() => {
    window.__qa = { seen: false, goneAt: null, liveAt: null, intro: [] };
    const tick = () => {
      const q = window.__qa;
      const up = document.documentElement?.hasAttribute('data-stage-loader');
      if (up) q.seen = true;
      if (q.seen && !up && q.goneAt === null) q.goneAt = performance.now();
      if (
        q.liveAt === null &&
        document.querySelector('[data-stage-art][data-live="1"]')
      )
        q.liveAt = performance.now();
      const s = window.__packStage;
      if (s && q.intro.length < 400)
        q.intro.push(Math.round(s.state.intro * 1000) / 1000);
    };
    setInterval(tick, 20);
  });
  await page.goto(stageUrl(forced()), { waitUntil: 'commit' });
  await sleep(950);
  await shot(page, `loader-mid-${label}`);
  await sleep(5000);
  const q = await page.evaluate(() => window.__qa);
  const played =
    q.intro.some((v) => v > 0.05 && v < 0.95) && q.intro.at(-1) === 1;
  const end = await stageInfo(page);
  const live = end?.live.length ?? 0;
  const ttfb = await page.evaluate(
    () => performance.getEntriesByType('navigation')[0]?.responseStart ?? null,
  );
  pass(
    `loader-first-${label}`,
    q.seen && q.goneAt !== null && played && live > 0,
    `loader seen ${q.seen}; float-in played ${played}; first pack live at ${q.liveAt?.toFixed(0)} ms from navigation (server answered at ${ttfb?.toFixed(0)} ms); at 6 s: mode ${end?.mode}, tier ${end?.tier}, live ${live}, page hidden ${await page.evaluate(() => document.hidden)}`,
  );
  pass(
    `loader-cap-${label}`,
    q.goneAt !== null && q.goneAt < 3700,
    `attribute removed ${q.goneAt?.toFixed(0)} ms from navigation (cap 3000 + 400 exit + 300 margin), ${(q.goneAt - (ttfb ?? 0)).toFixed(0)} ms after the server answered${softwareGpu ? ' (software renderer: the main thread is far slower than a real device)' : ''}`,
  );
  await page.goto(stageUrl(forced()), { waitUntil: 'load' });
  await sleep(300);
  const again = await page.evaluate(() =>
    document.documentElement.hasAttribute('data-stage-loader'),
  );
  const overlay = await page.locator('[data-brand-loader]').count();
  pass(
    `loader-second-${label}`,
    !again && overlay === 0,
    `second visit: attribute ${again}, loader overlay ${overlay}`,
  );
  await ctx.close();
}

/** Every Pokemon pack, centred in turn, is drawn live by the canvas. */
async function checkAllPacks(label, profile) {
  const { ctx, page } = await newPage(profile);
  await page.goto(stageUrl(forced({ loader: 'never' })), { waitUntil: 'load' });
  await dismissChrome(page);
  await waitLive(page, 1);
  const ids = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-stage-panel]:not([hidden]) [data-stage-tile]',
      ),
    ].map((li) => li.getAttribute('data-pack-id')),
  );
  const results = [];
  for (const id of [...ids.slice(0, 3).reverse(), ...ids.slice(3)]) {
    const centred = await centreOn(page, id);
    const live = await page
      .waitForFunction((pid) => window.__packStage?.live().includes(pid), id, {
        timeout: 8000,
        polling: 100,
      })
      .then(() => true)
      .catch(() => false);
    results.push({ id, centred, live });
  }
  const s = (await stageInfo(page)).stats;
  const missing = results.filter((r) => !r.centred || !r.live).map((r) => r.id);
  pass(
    `all-packs-live-${label}`,
    ids.length > 0 &&
      missing.length === 0 &&
      s.gpuBytesEstimate <= CAPS[profile.kind],
    `${results.filter((r) => r.live).length}/${ids.length} Pokemon packs centred and drawn live (${ids.join(', ')})${missing.length ? `; not live: ${missing.join(', ')}` : ''}; after the walk textures ${s.textures}, ${(s.gpuBytesEstimate / 1e6).toFixed(1)} MB`,
  );
  await ctx.close();
}

async function checkSoldOut(label, profile) {
  if (!WANT_SHOTS) return;
  const { ctx, page } = await newPage(profile);
  await page.goto(stageUrl(forced({ loader: 'never', soldout: '151' })), {
    waitUntil: 'load',
  });
  await dismissChrome(page);
  await waitLive(page, 1).catch(() => {});
  const ok = await centreOn(page, '151');
  await sleep(1200);
  const info = await stageInfo(page);
  const text = await page
    .locator('[data-stage-info]')
    .innerText()
    .catch(() => '');
  await shot(page, `soldout-${label}`);
  pass(
    `soldout-shot-${label}`,
    ok && /Sold out/.test(text),
    `151 forced sold out, centred: ${ok}; live ${info?.live.join(',')}; info "${text.replace(/\s+/g, ' ').slice(0, 80)}"`,
  );
  await ctx.close();
}

async function checkFrameTimes(label, profile) {
  if (WEBKIT) {
    skip(
      `frame-times-${label}`,
      'not measured: Playwright WebKit reports a masked `Apple GPU` but renders without the real graphics card here',
    );
    return;
  }
  if (softwareGpu) {
    skip(`frame-times-${label}`, 'not measured (software renderer)');
    return;
  }
  const { ctx, page } = await newPage(profile);
  await page.goto(stageUrl(forced({ loader: 'never' })), { waitUntil: 'load' });
  await waitLive(page, 2);
  await waitRest(page).catch(() => {});
  const sample = async (work) => {
    await page.evaluate(() => {
      window.__rafs = [];
      let prev = null;
      const f = (t) => {
        if (prev !== null) window.__rafs.push(t - prev);
        prev = t;
        if (window.__rafs.length < 2000 && !window.__rafStop)
          requestAnimationFrame(f);
      };
      window.__rafStop = false;
      requestAnimationFrame(f);
    });
    await work();
    await page.evaluate(() => (window.__rafStop = true));
    const s = (await page.evaluate(() => window.__rafs)).sort((a, b) => a - b);
    const p = (f) =>
      r1(s[Math.min(s.length - 1, Math.floor(f * s.length))] ?? 0);
    return { n: s.length, p50: p(0.5), p95: p(0.95) };
  };
  // The display's own frame interval with the stage asleep (a remote desktop
  // session or a 30 Hz panel caps rAF whatever the GPU does).
  const idle = await sample(() => sleep(1500));
  const drag = await sample(async () => {
    for (let k = 0; k < 4; k++) await swipe(page, profile, k % 2 ? 0.7 : -0.7);
    await sleep(600);
  });
  const target = Math.max(18, idle.p50 * 1.15);
  pass(
    `frame-times-${label}`,
    drag.p95 <= target,
    `display frame interval at idle p50 ${idle.p50} ms (${(1000 / idle.p50).toFixed(0)} Hz); during scripted drags ${drag.n} frames p50 ${drag.p50} ms, p95 ${drag.p95} ms (target <= ${r1(target)}: 18 ms, or the display's own interval + 15%)`,
  );
  await ctx.close();
}

async function recordVisit(label, profile) {
  if (!WANT_VIDEO) return;
  const dir = join(SHOTS, `.video-${label}`);
  mkdirSync(dir, { recursive: true });
  const { ctx, page } = await newPage(profile, {
    recordVideo: { dir, size: profile.context.viewport },
  });
  // The owner sees the page, not the ?debug=1 status line.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = '[data-stage-root] > p.fixed{display:none!important}';
      document.head.appendChild(s);
    });
  });
  await page.goto(stageUrl(forced()), { waitUntil: 'commit' });
  await sleep(5200);
  await dismissChrome(page);
  for (let k = 0; k < 3; k++) {
    await swipe(page, profile, -0.75);
    await sleep(1100);
  }
  if (profile.kind === 'desktop') {
    const h = await hostClip(page);
    const cx = h.clip.x + h.centreX;
    const cy = h.artCy ?? 400;
    for (let a = 0; a <= Math.PI * 4; a += 0.12) {
      await page.mouse.move(cx + Math.cos(a) * 160, cy + Math.sin(a) * 200);
      await sleep(30);
    }
    await page.mouse.move(2, 2, { steps: 8 });
    await sleep(600);
  }
  await page.getByRole('button', { name: /^Poly$/ }).click();
  await sleep(1800);
  await page.getByRole('button', { name: /^Pok/ }).click();
  await sleep(2500);
  const video = page.video();
  await ctx.close();
  if (video) {
    const out = join(SHOTS, `first-visit-${label.replace('-headed', '')}.webm`);
    renameSync(await video.path(), out);
    rmSync(dir, { recursive: true, force: true });
    report(
      `video-${label}`,
      'PASS',
      `${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`,
    );
  } else skip(`video-${label}`, 'Playwright video not available');
}

async function jsSizes() {
  const nextDir = join(ROOT, '.next');
  if (!existsSync(nextDir)) {
    skip('js-size', 'no .next folder next to this script');
    return;
  }
  const size = async (path) => {
    const html = await (await fetch(`${BASE}${path}`)).text();
    const srcs = [
      ...new Set(
        [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]),
      ),
    ].filter((s) => s.startsWith('/_next/static/'));
    let gz = 0;
    for (const s of srcs) {
      const file = join(nextDir, s.replace('/_next/', '').split('?')[0]);
      if (existsSync(file))
        gz += gzipSync(readFileSync(file), { level: 9 }).length;
    }
    return { n: srcs.length, gz };
  };
  const home = await size('/');
  const preview = await size('/home-preview?loader=never');
  const chunkDir = join(nextDir, 'static', 'chunks');
  const { readdirSync } = await import('node:fs');
  const chunk = readdirSync(chunkDir).find((f) => CHUNK.test(f));
  const chunkGz = chunk
    ? gzipSync(readFileSync(join(chunkDir, chunk)), { level: 9 }).length
    : 0;
  const delta = (preview.gz - home.gz) / 1024;
  pass(
    'js-size',
    delta <= 15 && !!chunk,
    `first-load JS gz: / ${(home.gz / 1024).toFixed(1)} KB (${home.n} scripts), /home-preview ${(preview.gz / 1024).toFixed(1)} KB (${preview.n}), +${delta.toFixed(1)} KB (target <= 15); ${chunk ?? 'no pack-stage-3d chunk'} ${(chunkGz / 1024).toFixed(1)} KB gz`,
  );
}

// ---------------------------------------------------------------------------
// Pack type chips and the hand-off (shots-filter/)

/**
 * Per-frame hand-off sampler, run inside the page every animation frame. Per
 * visible tile it compares what the canvas says it drew (`live()`) with what
 * the tile shows:
 * - doubled: the canvas drew the pack AND its picture is showing (opacity > 0)
 *   while the tile itself is visible;
 * - hole: the tile says data-live=1 but the canvas did not draw that pack;
 * - flash: a tile is visible while the switch is fully sunk (swap ~ 1);
 * - flat: a 3D-capable tile is visible but not drawn (late, or not ready).
 */
function handSamplerScript() {
  const q = (window.__qaHand = { frames: [], stop: false, mark: null });
  const f = () => {
    if (q.stop) return;
    const s = window.__packStage;
    if (s) {
      const live = new Set(s.live());
      const swap = s.state.swap;
      const fr = {
        t: performance.now(),
        swap: Math.round(swap * 1000) / 1000,
        doubled: [],
        holes: [],
        flash: [],
        flat: [],
        ids: [],
      };
      for (const li of document.querySelectorAll(
        '[data-stage-panel]:not([hidden]) [data-stage-tile]',
      )) {
        const id = li.getAttribute('data-pack-id');
        const art = li.querySelector('[data-stage-art]');
        const img = art?.querySelector('img');
        const pose = li.querySelector('[data-stage-pose]');
        const po = pose ? Number(getComputedStyle(pose).opacity) : 0;
        const io = img ? Number(getComputedStyle(img).opacity) : 0;
        const drawn = live.has(id);
        if (po > 0.02) fr.ids.push(id);
        if (drawn && io > 0.001 && po > 0.001) fr.doubled.push(id);
        if (art?.getAttribute('data-live') === '1' && !drawn && po > 0.02)
          fr.holes.push(id);
        if (swap > 0.999 && po > 0.02) fr.flash.push(id);
        if (!drawn && po > 0.02 && img?.hasAttribute('crossorigin'))
          fr.flat.push(id);
      }
      q.frames.push(fr);
    }
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
}

/** Starts the sampler (fresh), runs `work`, waits `settleMs`, returns the frames. */
async function sampleHandoff(page, work, settleMs = 1600) {
  await page.evaluate(handSamplerScript);
  await work();
  await sleep(settleMs);
  return page.evaluate(() => {
    window.__qaHand.stop = true;
    return window.__qaHand.frames;
  });
}

/** Summary of a sampled change: doubled / hole / flash frames and the flat tail of the rise. */
function handSummary(frames) {
  const bad = (k) => frames.filter((f) => f[k].length > 0);
  const doubled = bad('doubled');
  const holes = bad('holes');
  const flash = bad('flash');
  // The rise: from the last fully sunk frame on. "Flat" frames in it are
  // 3D tiles showing their picture (not live yet).
  let sunkAt = -1;
  frames.forEach((f, i) => {
    if (f.swap > 0.999) sunkAt = i;
  });
  const rise = sunkAt >= 0 ? frames.slice(sunkAt + 1) : [];
  const flatRise = rise.filter((f) => f.flat.length > 0);
  const lastFlat = flatRise.at(-1);
  const riseMs = lastFlat && rise[0] ? Math.round(lastFlat.t - rise[0].t) : 0;
  const ids = (list, k) => [...new Set(list.flatMap((f) => f[k]))].join(',');
  // No evidence, no pass: the change must have been seen fully sunk and rising.
  const seen = sunkAt >= 0 && rise.length >= 3;
  return {
    ok:
      seen && doubled.length === 0 && holes.length === 0 && flash.length === 0,
    frames: frames.length,
    doubled: doubled.length,
    holes: holes.length,
    flash: flash.length,
    flatRise: flatRise.length,
    riseMs,
    detail: `${frames.length} frames (fully sunk seen: ${sunkAt >= 0}; rise frames ${rise.length}); doubled ${doubled.length}${doubled.length ? ` (${ids(doubled, 'doubled')})` : ''}; holes ${holes.length}${holes.length ? ` (${ids(holes, 'holes')})` : ''}; visible while sunk ${flash.length}; rise frames with a flat 3D tile ${flatRise.length}${flatRise.length ? ` (${ids(flatRise, 'flat')}, last ${riseMs} ms into the rise)` : ''}`,
  };
}

/** The collapsed sorting trigger (names the current choice). */
const trigger = (page) =>
  page.locator('[data-stage-chips]:not([data-off]) button[aria-expanded]');

/** Opens the sorting panel if it is closed (and waits for it to show). */
async function openPanel(page) {
  const t = trigger(page);
  if ((await t.getAttribute('aria-expanded')) !== 'true') await t.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(
          '[data-stage-chips]:not([data-off]) button[aria-expanded]',
        )
        ?.getAttribute('aria-expanded') === 'true',
    null,
    { timeout: 3000 },
  );
  await sleep(280); // its 180-220 ms entrance
}

/** A choice in the panel: .click() opens the panel first, as a visitor would. */
const panelButton = (page, group, name) => {
  const loc = page
    .getByRole('group', { name: group })
    .getByRole('button', { name })
    .first();
  return {
    loc,
    click: async () => {
      await openPanel(page);
      await loc.click();
    },
  };
};
const chip = (page, name) => panelButton(page, 'Pack type', name);
const langBtn = (page, name) => panelButton(page, 'Language', name);

/** The panel's contents load in their own chunk (on intent or when idle): load them. */
async function ensurePanelLoaded(page) {
  await trigger(page)
    .focus()
    .catch(() => {});
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll(
          '[data-stage-chips] [role="group"][aria-label="Pack type"] button',
        ).length > 0,
      null,
      { timeout: 8000 },
    )
    .catch(() => {});
  await page.evaluate(() => document.activeElement?.blur?.());
}

/** The visible row: ids, centred index, counter text, arrows disabled. */
const rowState = (page) =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-stage-panel]:not([hidden])');
    const ids = [...(panel?.querySelectorAll('[data-stage-tile]') ?? [])].map(
      (li) => li.getAttribute('data-pack-id'),
    );
    const navs = [...(panel?.querySelectorAll('[data-stage-nav]') ?? [])];
    const counter = document
      .querySelector('[data-stage-info] p[aria-hidden]')
      ?.textContent?.replace(/\s+/g, '');
    return {
      ids,
      at: Math.round(window.__packStage?.state.track ?? -1),
      counter,
      prevDisabled: navs[0]?.getAttribute('aria-disabled') === 'true',
      nextDisabled: navs[1]?.getAttribute('aria-disabled') === 'true',
      // The control's options (in its panel, or the phone sheet of look b),
      // counted once each; a display:none copy is not on screen.
      ...(() => {
        const on = !document.querySelector('[data-stage-chips]:not([data-off])')
          ? []
          : [
              ...document.querySelectorAll(
                '[role="group"][aria-label="Pack type"] button',
              ),
            ].filter((b) => b.getClientRects().length > 0);
        const uniq = (list) => [...new Set(list)];
        return {
          chips: uniq(
            on
              .filter((b) => !b.closest('[aria-label="Language"]'))
              .map((b) => b.textContent.trim()),
          ),
          langs: uniq(
            on
              .filter((b) => b.closest('[aria-label="Language"]'))
              .map((b) => b.getAttribute('aria-label') ?? b.textContent.trim()),
          ),
        };
      })(),
      trigger:
        document
          .querySelector(
            '[data-stage-chips]:not([data-off]) button[aria-expanded]',
          )
          ?.textContent?.trim() ?? null,
    };
  });

/** Bottom of the Open button and the counter against the tab bar's top (CSS px). */
const openFit = (page) =>
  page.evaluate(() => {
    const info = document.querySelector('[data-stage-info]');
    const open = [...(info?.querySelectorAll('a') ?? [])].find((a) =>
      /^\s*Open/.test(a.textContent ?? ''),
    );
    const counter = info?.querySelector('p[aria-hidden]');
    // The bottom tab bar: a fixed element at the bottom edge (phones only).
    const bar = [...document.querySelectorAll('nav, div, footer')].find(
      (el) => {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed') return false;
        const r = el.getBoundingClientRect();
        return (
          r.bottom >= innerHeight - 1 &&
          r.width >= innerWidth * 0.9 &&
          r.height > 30 &&
          r.height < 160
        );
      },
    );
    const o = open?.getBoundingClientRect();
    const c = counter?.getBoundingClientRect();
    const top = bar ? bar.getBoundingClientRect().top : innerHeight;
    return {
      openTop: o ? Math.round(o.top) : null,
      openBottom: o ? Math.round(o.bottom) : null,
      counterBottom: c ? Math.round(c.bottom) : null,
      barTop: Math.round(top),
      viewport: innerHeight,
      fits: !!o && !!c && o.top >= 0 && o.bottom <= top && c.bottom <= top,
    };
  });

async function filterShot(page, name) {
  if (!WANT_SHOTS) return;
  await setStyle(
    page,
    'qa-hide-debug',
    '[data-stage-root] > p.fixed{display:none!important}',
  );
  await page.screenshot({ path: join(FILTER_SHOTS, `${name}.png`) });
  await setStyle(page, 'qa-hide-debug', null);
}

/** Boxes that must not move when the sorting panel opens or closes. */
const layoutBoxes = (page) =>
  page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height].map(
        (v) => Math.round(v * 10) / 10,
      );
    };
    const info = document.querySelector('[data-stage-info]');
    const open = [...(info?.querySelectorAll('a') ?? [])].find((a) =>
      /^\s*Open/.test(a.textContent ?? ''),
    );
    return {
      row: box(
        document.querySelector(
          '[data-stage-panel]:not([hidden]) [data-stage-row]',
        ),
      ),
      art: box(
        document.querySelector(
          '[data-stage-panel]:not([hidden]) [data-stage-art]',
        ),
      ),
      price: box(info?.querySelector('.font-heading')),
      open: box(open),
      trigger: box(
        document.querySelector('[data-stage-chips] button[aria-expanded]'),
      ),
    };
  });

const triggerFocused = (page) =>
  page.evaluate(
    () =>
      document.activeElement?.matches?.(
        '[data-stage-chips] button[aria-expanded]',
      ) ?? false,
  );
const expanded = async (page) =>
  (await trigger(page).getAttribute('aria-expanded')) === 'true';

/** The trigger and its panel; chips on Pokemon and none on Poly; counter and arrows per chip; Open fits. */
async function checkChips(label, profile) {
  const { ctx, page } = await newPage(profile);
  await page.goto(stageUrl(forced({ loader: 'never' })), { waitUntil: 'load' });
  await dismissChrome(page);
  await waitLive(page, 2).catch(() => {});
  await ensurePanelLoaded(page);
  const all = await rowState(page);
  const fitAll = await openFit(page);
  pass(
    `chips-pokemon-${label}`,
    all.chips.length >= 3 &&
      /^All/.test(all.chips[0] ?? '') &&
      all.langs.length === 0 &&
      all.trigger === 'Pack type: All packs',
    `trigger "${all.trigger}"; chips in its panel ${JSON.stringify(all.chips)}; language control ${all.langs.length ? JSON.stringify(all.langs) : 'absent'}; row ${all.ids.length} packs centred ${all.ids[all.at]} counter ${all.counter}`,
  );
  pass(
    `open-fits-all-${label}`,
    fitAll.fits,
    `Open ${fitAll.openTop}-${fitAll.openBottom}, counter bottom ${fitAll.counterBottom}, tab bar top ${fitAll.barTop} (viewport ${fitAll.viewport})`,
  );
  await page.mouse.move(2, 2);
  await waitRest(page).catch(() => {});
  await filterShot(page, lookShot('closed', label));

  // The trigger's touch target: 44 px tall around its centre (points 21 px
  // above and below land on it), whatever its visible size.
  const hit = await page.evaluate(() => {
    const t = document.querySelector(
      '[data-stage-chips]:not([data-off]) button[aria-expanded]',
    );
    const r = t.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const on = (y) => {
      const el = document.elementFromPoint(cx, y);
      return !!el && (el === t || t.contains(el));
    };
    return { h: Math.round(r.height), up: on(cy - 21), down: on(cy + 21) };
  });
  pass(
    `trigger-target-${label}`,
    hit.up && hit.down,
    `visible ${hit.h} px tall; a tap 21 px above the centre lands on it: ${hit.up}, 21 px below: ${hit.down}`,
  );

  // Open: nothing below moves; Escape closes and focus returns to the trigger.
  const before = await layoutBoxes(page);
  await openPanel(page);
  const opened = await layoutBoxes(page);
  const isOpen = await expanded(page);
  const focusIn = await page.evaluate(
    () => document.activeElement?.getAttribute('aria-pressed') === 'true',
  );
  await filterShot(page, lookShot('open', label));
  await page.keyboard.press('Escape');
  await sleep(250);
  const escClosed = !(await expanded(page));
  const escFocus = await triggerFocused(page);
  const closed = await layoutBoxes(page);
  const still =
    JSON.stringify(before) === JSON.stringify(opened) &&
    JSON.stringify(before) === JSON.stringify(closed);
  pass(
    `panel-open-escape-${label}`,
    isOpen && focusIn && escClosed && escFocus && still,
    `opened (aria-expanded ${isOpen}, focus on the current choice ${focusIn}); Escape closed it ${escClosed}, focus back on the trigger ${escFocus}; row, art, price, Open and trigger boxes unchanged through open and close: ${still}${still ? '' : ` before ${JSON.stringify(before)} open ${JSON.stringify(opened)} closed ${JSON.stringify(closed)}`}`,
  );

  // A tap outside (on the centred pack) only closes: no centring, no navigation.
  await openPanel(page);
  const urlBefore = page.url();
  const trackBefore = (await stageInfo(page))?.state.track;
  const art = await page
    .locator('[data-stage-panel]:not([hidden]) [data-stage-art]')
    .nth(all.at)
    .boundingBox();
  await page.mouse.click(art.x + art.width / 2, art.y + art.height * 0.75);
  await sleep(600);
  const outClosed = !(await expanded(page));
  const trackAfter = (await stageInfo(page))?.state.track;
  pass(
    `panel-outside-tap-${label}`,
    outClosed && page.url() === urlBefore && trackAfter === trackBefore,
    `tap on the centred pack with the panel open: closed ${outClosed}; stayed on ${new globalThis.URL(page.url()).pathname} (${page.url() === urlBefore}); track ${trackBefore} -> ${trackAfter}`,
  );

  // Keyboard: Enter opens, arrows move, Enter chooses, focus returns.
  await trigger(page).focus();
  await page.keyboard.press('Enter');
  await sleep(250);
  await page.keyboard.press('ArrowRight');
  const kFocus = await page.evaluate(() =>
    document.activeElement?.textContent?.trim(),
  );
  await page.keyboard.press('Enter');
  await sleep(1300);
  const kRow = await rowState(page);
  const kBack = await triggerFocused(page);
  pass(
    `panel-keyboard-${label}`,
    /^Classic/.test(kFocus ?? '') &&
      kRow.ids.length === 5 &&
      kBack &&
      !(await expanded(page)),
    `Enter opened, ArrowRight moved to "${kFocus}", Enter chose it: row ${kRow.ids.length} packs (${kRow.counter}), panel closed, focus on the trigger ${kBack}; trigger now "${kRow.trigger}"`,
  );
  await chip(page, /^All/).click();
  await sleep(1300);

  const per = [];
  // The shelves the live catalogue has today (the Special shelf can be absent).
  const hasSpecial = all.chips.some((c) => /^Special/.test(c));
  for (const name of [
    /^Classic/,
    /^Original/,
    ...(hasSpecial ? [/^Special/] : []),
    /^All/,
  ]) {
    await chip(page, name).click();
    await sleep(1300);
    const s = await rowState(page);
    per.push({
      name: String(name),
      ...s,
      centred: s.ids[s.at],
      closed: !(await expanded(page)),
    });
    if (name.source === '^Classic') {
      await page.mouse.move(2, 2);
      await waitRest(page).catch(() => {});
      await filterShot(page, lookShot('chosen', label));
    }
  }
  const sp = hasSpecial ? per[2] : null;
  const special =
    !sp ||
    (sp.ids.length === 1 &&
      sp.at === 0 &&
      sp.counter === '1/1' &&
      sp.prevDisabled &&
      sp.nextDisabled);
  const counters = per.every(
    (p) =>
      p.closed &&
      p.counter === `${p.at + 1}/${p.ids.length}` &&
      p.prevDisabled === (p.at === 0) &&
      p.nextDisabled === (p.at === p.ids.length - 1),
  );
  const labels =
    per[0].trigger === 'Pack type: Classic · Graded' &&
    per[1].trigger === 'Pack type: Original · Raw Cards' &&
    (!hasSpecial || per[2].trigger === 'Pack type: Special · Graded') &&
    per[per.length - 1].trigger === 'Pack type: All packs';
  pass(
    `chips-counter-arrows-${label}`,
    counters && special && labels,
    per
      .map(
        (p) =>
          `${p.name}: panel closed ${p.closed}, trigger "${p.trigger}", ${p.ids.length} packs, centred ${p.centred} (${p.counter}), prev ${p.prevDisabled ? 'off' : 'on'} next ${p.nextDisabled ? 'off' : 'on'}`,
      )
      .join(' | '),
  );
  // The one-pack row: a swipe either way leaves it centred.
  if (!hasSpecial) {
    skip(
      `one-pack-row-${label}`,
      `no Special shelf in today's catalogue (chips ${JSON.stringify(all.chips)})`,
    );
  } else {
    await chip(page, /^Special/).click();
    await sleep(1300);
    await swipe(page, profile, -0.8);
    await sleep(900);
    await swipe(page, profile, 0.8);
    await sleep(900);
    const after = await rowState(page);
    const track = (await stageInfo(page))?.state.track;
    const fitSp = await openFit(page);
    pass(
      `one-pack-row-${label}`,
      after.ids.length === 1 &&
        Math.abs(track) < 0.01 &&
        after.counter === '1/1',
      `after two swipes: track ${track?.toFixed(3)}, counter ${after.counter}; Open ${fitSp.openTop}-${fitSp.openBottom} (tab bar ${fitSp.barTop})`,
    );
    await page.mouse.move(2, 2);
    await waitRest(page).catch(() => {});
    await filterShot(page, lookShot('special', label));
    await chip(page, /^All/).click();
    await sleep(1300);
  }
  await page.getByRole('button', { name: /^Poly$/ }).click();
  await sleep(1300);
  const poly = await rowState(page);
  const faded = await page.evaluate(() => {
    const row = document.querySelector('[data-stage-chips]');
    return row
      ? {
          opacity: getComputedStyle(row).opacity,
          inert: row.inert === true,
          hidden: row.getAttribute('aria-hidden'),
        }
      : null;
  });
  pass(
    `chips-none-on-poly-${label}`,
    poly.chips.length === 0 &&
      poly.trigger === null &&
      (faded === null || (faded.opacity === '0' && faded.inert)),
    `Poly: no trigger on show (${poly.trigger}), ${poly.ids.length} capsules; ${faded ? `the row's room is kept: opacity ${faded.opacity}, inert ${faded.inert}, aria-hidden ${faded.hidden}` : 'no row element'}`,
  );
  await ctx.close();
}

/**
 * The panel's own chunk: when it fails the page must carry on (the tab stays,
 * nothing errors, the next intent retries); when it is slow, a tap shows
 * nothing half-open (the tab stays visible and the pill stays round until the
 * panel can unroll).
 */
async function checkPanelChunk(label, profile) {
  const PANEL = /stage-sort-panel/;
  // Failing.
  {
    const { ctx, page } = await newPage(profile);
    let aborted = 0;
    await page.route(PANEL, (r) => {
      aborted++;
      r.abort().catch(() => {});
    });
    await page.goto(stageUrl(forced({ loader: 'never' })), {
      waitUntil: 'load',
    });
    await dismissChrome(page);
    await sleep(3500); // the idle fetch has run (and failed)
    await trigger(page).click();
    await sleep(800);
    const s = await page.evaluate(() => ({
      expanded: document
        .querySelector('[data-stage-chips] button[aria-expanded]')
        ?.getAttribute('aria-expanded'),
      tiles: document.querySelectorAll(
        '[data-stage-panel]:not([hidden]) [data-stage-tile]',
      ).length,
      heading: document.body.innerText.includes('Open packs. Pull real cards.'),
    }));
    const pageErrors = page.errors.filter(
      (e) => !/Failed to load resource|ChunkLoadError|Loading chunk/i.test(e),
    );
    await page.getByRole('button', { name: 'Next pack' }).click();
    await sleep(900);
    const after = await rowState(page);
    pass(
      `panel-chunk-fails-${label}`,
      aborted > 0 &&
        s.expanded === 'false' &&
        s.tiles > 0 &&
        s.heading &&
        pageErrors.length === 0 &&
        after.counter === `4/${s.tiles}`,
      `panel chunk aborted ${aborted}x: page still the stage (${s.tiles} tiles, heading ${s.heading}), tab tap leaves it closed (aria-expanded ${s.expanded}), carousel still works (${after.counter}); uncaught page errors ${pageErrors.length}${pageErrors.length ? `: ${pageErrors[0]}` : ''}`,
    );
    await ctx.close();
  }
  // Slow.
  {
    const { ctx, page } = await newPage(profile);
    await page.route(PANEL, (r) =>
      setTimeout(() => r.continue().catch(() => {}), 2000),
    );
    await page.goto(stageUrl(forced({ loader: 'never' })), {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('[data-stage-chips] button[aria-expanded]');
    await trigger(page).click();
    await sleep(300);
    const waiting = await page.evaluate(() => {
      const t = document.querySelector(
        '[data-stage-chips] button[aria-expanded]',
      );
      const pill = document.querySelector('[aria-label="Pack categories"]');
      return {
        expanded: t?.getAttribute('aria-expanded'),
        tabOpacity: t ? getComputedStyle(t).opacity : null,
        pillCorner: pill ? getComputedStyle(pill).borderBottomLeftRadius : null,
      };
    });
    await page
      .waitForFunction(
        () =>
          document
            .querySelector('[data-stage-chips] button[aria-expanded]')
            ?.getAttribute('aria-expanded') === 'true',
        null,
        { timeout: 8000 },
      )
      .catch(() => {});
    const opened = await page.evaluate(() =>
      document
        .querySelector('[data-stage-chips] button[aria-expanded]')
        ?.getAttribute('aria-expanded'),
    );
    pass(
      `panel-chunk-slow-${label}`,
      waiting.expanded === 'false' &&
        waiting.tabOpacity === '1' &&
        waiting.pillCorner !== '0px' &&
        opened === 'true',
      `panel chunk held 2 s, tab tapped at once: while waiting aria-expanded ${waiting.expanded}, tab opacity ${waiting.tabOpacity}, pill corner ${waiting.pillCorner} (round); once it arrived the panel opened (aria-expanded ${opened})`,
    );
    await ctx.close();
  }
}

/**
 * Just Pulled follows the category only: a type chip fetches nothing new for
 * the feed; Poly refetches it with `category=poly`, Pokémon without one.
 */
async function checkFeedFollows(label, profile) {
  const { ctx, page } = await newPage(profile);
  const feed = [];
  page.on('request', (r) => {
    if (/\/api\/recent-pulls/.test(r.url())) feed.push(r.url());
  });
  await page.goto(stageUrl(forced({ loader: 'never' })), { waitUntil: 'load' });
  await dismissChrome(page);
  await sleep(1500);
  feed.length = 0;
  await chip(page, /^Classic/).click();
  await sleep(2500);
  const afterChip = [...feed];
  feed.length = 0;
  await page.getByRole('button', { name: /^Poly$/ }).click();
  await page
    .waitForRequest((r) => /\/api\/recent-pulls/.test(r.url()), {
      timeout: 6000,
    })
    .catch(() => {});
  await sleep(300);
  const afterPoly = [...feed];
  feed.length = 0;
  await page.getByRole('button', { name: /^Pok/ }).click();
  await page
    .waitForRequest((r) => /\/api\/recent-pulls/.test(r.url()), {
      timeout: 6000,
    })
    .catch(() => {});
  await sleep(300);
  const afterPokemon = [...feed];
  const q = (u) => new globalThis.URL(u).search || '(no query)';
  pass(
    `feed-follows-category-${label}`,
    afterChip.length === 0 &&
      afterPoly.some((u) => /category=poly/.test(u)) &&
      afterPokemon.length > 0 &&
      afterPokemon.every((u) => !/category=/.test(u)),
    `after a chip: ${afterChip.length} feed requests; after Poly: ${afterPoly.map(q).join(', ') || 'none'}; after Pokemon: ${afterPokemon.map(q).join(', ') || 'none'}`,
  );
  await ctx.close();
}

/** No tile shows its picture and its model together across the changes. */
async function checkHandoff(label, profile) {
  const { ctx, page } = await newPage(profile);
  await page.goto(stageUrl(forced({ loader: 'never' })), { waitUntil: 'load' });
  await dismissChrome(page);
  await waitLive(page, 2);
  await waitRest(page).catch(() => {});
  const cases = [];
  const hasChips = (await rowState(page)).chips.length > 0;
  if (hasChips) {
    for (const name of [/^Classic/, /^All/]) {
      const frames = await sampleHandoff(page, () => chip(page, name).click());
      cases.push({
        name: `chip ${name.source.slice(1)}`,
        ...handSummary(frames),
      });
    }
  }
  await page.getByRole('button', { name: /^Poly$/ }).click();
  await sleep(1500);
  const frames = await sampleHandoff(page, () =>
    page.getByRole('button', { name: /^Pok/ }).click(),
  );
  cases.push({ name: 'Poly -> Pokemon', ...handSummary(frames) });
  for (const c of cases)
    pass(
      `handoff-${c.name.replace(/\W+/g, '-').toLowerCase()}-${label}`,
      c.ok,
      c.detail,
    );
  if (!hasChips) skip(`handoff-chips-${label}`, 'no chip row on this build');
  await ctx.close();
}

/**
 * Arrival orders: the 3D chunk, the first textures and the first taps can
 * land in any order. Each case delays the chunk and/or the pack textures by
 * network interception and taps a chip or a category at a fixed moment, with
 * the per-frame sampler on throughout. Pass: no doubled, hole or sunk-visible
 * frame at any point, and once everything has arrived every visible 3D tile
 * is drawn by the canvas (none stuck flat, none stuck hidden).
 */
async function checkOrders(label, profile) {
  const cases = [
    { name: 'chip-before-chunk', chunk: 1800, tex: 0, at: 400, tap: 'chip' },
    { name: 'chip-during-prepare', chunk: 0, tex: 1500, at: 900, tap: 'chip' },
    {
      name: 'poly-and-back-before-chunk',
      chunk: 1500,
      tex: 600,
      at: 300,
      tap: 'poly-back',
    },
    { name: 'chip-during-float-in', chunk: 0, tex: 0, at: -1, tap: 'chip' },
  ];
  for (const c of cases) {
    const { ctx, page } = await newPage(profile);
    const delay = (ms) => (route) =>
      setTimeout(() => route.continue().catch(() => {}), ms);
    if (c.chunk) await page.route(CHUNK, delay(c.chunk));
    if (c.tex) await page.route(/\/pack-3d\//, delay(c.tex));
    await page.addInitScript(handSamplerScript);
    const t0 = Date.now();
    await page.goto(
      stageUrl(forced({ loader: c.at < 0 ? 'always' : 'never' })),
      { waitUntil: 'commit' },
    );
    if (c.at < 0) {
      // During the float-in: the first frame the intro is under way.
      await page
        .waitForFunction(
          () =>
            (window.__packStage?.state.intro ?? 1) < 0.6 &&
            (window.__packStage?.state.intro ?? 0) > 0.05,
          null,
          { timeout: 20000, polling: 'raf' },
        )
        .catch(() => {});
    } else {
      await page.waitForSelector('[data-stage-chips] button[aria-expanded]', {
        timeout: 15000,
      });
      const wait = c.at - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
    }
    const before = await stageInfo(page).catch(() => null);
    if (c.tap === 'chip') {
      await chip(page, /^Classic/).click();
    } else {
      await page.getByRole('button', { name: /^Poly$/ }).click();
      await sleep(120);
      await page.getByRole('button', { name: /^Pok/ }).click();
    }
    // Everything arrives, the change settles, the loop rests.
    await waitLive(page, profile.kind === 'desktop' ? 3 : 2, 30000).catch(
      () => {},
    );
    await sleep(1500);
    const frames = await page.evaluate(() => {
      window.__qaHand.stop = true;
      return window.__qaHand.frames;
    });
    const end = await page.evaluate(() => {
      const s = window.__packStage;
      const live = new Set(s?.live() ?? []);
      const tiles = [
        ...document.querySelectorAll(
          '[data-stage-panel]:not([hidden]) [data-stage-tile]',
        ),
      ].filter((li) => {
        const pose = li.querySelector('[data-stage-pose]');
        return pose && Number(getComputedStyle(pose).opacity) > 0.5;
      });
      const threeD = tiles.filter((li) =>
        li.querySelector('img')?.hasAttribute('crossorigin'),
      );
      return {
        mode: s?.mode(),
        ids: tiles.map((li) => li.getAttribute('data-pack-id')),
        flat: threeD
          .filter((li) => !live.has(li.getAttribute('data-pack-id')))
          .map((li) => li.getAttribute('data-pack-id')),
        hidden: tiles
          .filter(
            (li) =>
              li
                .querySelector('[data-stage-art]')
                ?.getAttribute('data-live') === '1' &&
              !live.has(li.getAttribute('data-pack-id')),
          )
          .map((li) => li.getAttribute('data-pack-id')),
      };
    });
    const bad = (k) => frames.filter((f) => f[k].length > 0).length;
    const ok =
      end.mode === '3d' &&
      bad('doubled') === 0 &&
      bad('holes') === 0 &&
      bad('flash') === 0 &&
      end.flat.length === 0 &&
      end.hidden.length === 0 &&
      page.errors.length === 0;
    pass(
      `order-${c.name}-${label}`,
      ok,
      `chunk +${c.chunk} ms, textures +${c.tex} ms, tap ${c.tap} ${c.at < 0 ? 'during the float-in' : `at ${c.at} ms`} (mode then ${before?.mode}, ready ${before?.ready}); ${frames.length} frames: doubled ${bad('doubled')}, holes ${bad('holes')}, visible while sunk ${bad('flash')}; settled: mode ${end.mode}, visible ${end.ids.join(',')}, 3D tiles left flat ${end.flat.join(',') || 'none'}, hidden with no model ${end.hidden.join(',') || 'none'}; errors ${page.errors.length}`,
    );
    await ctx.close();
  }
}

/** Negative control: with a picture fade forced back on, the sampler must catch doubling. */
async function checkHandoffControl(label, profile) {
  const { ctx, page } = await newPage(profile);
  await page.goto(stageUrl(forced({ loader: 'never' })), { waitUntil: 'load' });
  await dismissChrome(page);
  await waitLive(page, 2);
  await setStyle(
    page,
    'qa-control',
    '[data-stage-art] img{transition:opacity 200ms linear!important}',
  );
  await page.getByRole('button', { name: /^Poly$/ }).click();
  await sleep(1500);
  const frames = await sampleHandoff(page, () =>
    page.getByRole('button', { name: /^Pok/ }).click(),
  );
  const s = handSummary(frames);
  pass(
    `handoff-control-${label}`,
    s.doubled > 0,
    `with a 200 ms picture fade injected the sampler reports doubled frames (it must): ${s.detail}`,
  );
  await ctx.close();
}

/** GPU estimate across 20 chip changes (and a double tap), back to the start state. */
async function checkChipMemory(label, profile) {
  const { ctx, page } = await newPage(profile);
  await page.goto(stageUrl(forced({ loader: 'never' })), { waitUntil: 'load' });
  await dismissChrome(page);
  await waitLive(page, 2);
  await page.mouse.move(2, 2);
  await waitRest(page).catch(() => {});
  await sleep(800);
  const startRow = await rowState(page);
  const startId = startRow.ids[startRow.at];
  // Warm-up walk out and back, so the resting figure already holds what the
  // residency keeps around the centre after any walk (its hysteresis); the
  // end state is reached by the same kind of walk.
  const bootStats = (await stageInfo(page)).stats;
  await centreOn(page, startRow.ids[Math.min(startRow.ids.length - 1, 8)]);
  await centreOn(page, startId);
  await page.mouse.move(2, 2);
  await waitRest(page).catch(() => {});
  await sleep(1500);
  const base = (await stageInfo(page)).stats;
  const cap = CAPS[profile.kind];
  let max = base.gpuBytesEstimate;
  let maxTex = base.textures;
  const sampleMax = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const s = (await stageInfo(page)).stats;
      max = Math.max(max, s.gpuBytesEstimate);
      maxTex = Math.max(maxTex, s.textures);
      await sleep(60);
    }
  };
  // The shelves the live catalogue has today (the Special shelf can be absent).
  const special = startRow.chips.some((c) => /^Special/.test(c));
  const order = [
    /^Classic/,
    /^All/,
    /^Original/,
    /^All/,
    special ? /^Special/ : /^Classic/,
    /^All/,
  ];
  for (let k = 0; k < 20; k++) {
    if (k === 9) {
      // A double tap: the second supersedes the first mid-sink.
      await chip(page, /^Classic/).click();
      await sleep(90);
    }
    await chip(page, order[k % order.length]).click();
    await sampleMax(1100);
  }
  await chip(page, /^All/).click();
  await sampleMax(1200);
  await centreOn(page, startId);
  await page.mouse.move(2, 2);
  await waitRest(page).catch(() => {});
  await sleep(1500);
  const end = (await stageInfo(page)).stats;
  const endRow = await rowState(page);
  const back = Math.abs(end.gpuBytesEstimate - base.gpuBytesEstimate) <= 0.5e6;
  pass(
    `chips-memory-x20-${label}`,
    max <= cap && back && endRow.ids[endRow.at] === startId,
    `first load ${(bootStats.gpuBytesEstimate / 1e6).toFixed(1)} MB (${bootStats.textures} textures, ${bootStats.geometries} geometries); rest after a walk out and back ${(base.gpuBytesEstimate / 1e6).toFixed(1)} MB (${base.textures} textures, ${base.geometries} geometries); max during 20 changes + a double tap ${(max / 1e6).toFixed(1)} MB (${maxTex} textures, cap ${cap / 1e6}); back on All centred on ${endRow.ids[endRow.at]}: ${(end.gpuBytesEstimate / 1e6).toFixed(1)} MB (${end.textures} textures, ${end.geometries} geometries)`,
  );
  await ctx.close();
}

/** Language control with ?jp= on two original packs (the preview option, not live data). */
async function checkLanguage(label, profile) {
  const { ctx, page } = await newPage(profile);
  await page.goto(stageUrl(forced({ loader: 'never', jp: 'delta-reign,ah' })), {
    waitUntil: 'load',
  });
  await dismissChrome(page);
  await waitLive(page, 2).catch(() => {});
  await ensurePanelLoaded(page);
  const all = await rowState(page);
  await chip(page, /^Original/).click();
  await sleep(1300);
  const orig = await rowState(page);
  const fit = await openFit(page);
  await waitRest(page).catch(() => {});
  // The panel open with its language row (the ?jp= preview option).
  await openPanel(page);
  await filterShot(page, lookShot('language', label));
  await page.keyboard.press('Escape');
  await sleep(250);
  await langBtn(page, /^Japanese$/).click();
  await sleep(1300);
  const jp = await rowState(page);
  await langBtn(page, /^English$/).click();
  await sleep(1300);
  const en = await rowState(page);
  await langBtn(page, /^English$/).click();
  await sleep(1300);
  const cleared = await rowState(page);
  await langBtn(page, /^Japanese$/).click();
  await sleep(1300);
  await chip(page, /^Classic/).click();
  await sleep(1300);
  const classic = await rowState(page);
  await chip(page, /^All/).click();
  await sleep(1300);
  const back = await rowState(page);
  pass(
    `language-${label}`,
    all.langs.length === 2 &&
      orig.langs.length === 2 &&
      jp.ids.length === 2 &&
      en.ids.length === 3 &&
      cleared.ids.length === orig.ids.length &&
      classic.langs.length === 0 &&
      back.langs.length === 2 &&
      back.ids.length === all.ids.length &&
      fit.fits,
    `?jp=delta-reign,ah: All langs ${JSON.stringify(all.langs)}; Original ${orig.ids.length} packs; Japanese -> ${jp.ids.join(',')} (${jp.counter}); English -> ${en.ids.join(',')}; cleared -> ${cleared.ids.length}; Classic (no languages) control ${classic.langs.length ? 'shown' : 'absent'}; back to All ${back.ids.length} packs, language ${back.langs.length ? 'control shown, none pressed' : 'absent'}; Open ${fit.openTop}-${fit.openBottom} tab bar ${fit.barTop}`,
  );
  await ctx.close();
}

/**
 * Frame sheets: the composited page captured by CDP screencast (every frame
 * the browser produces, in real time) across a change, then about 10 frames a
 * second laid out in a grid with their time from the tap.
 */
async function frameSheet(page, name, work, { ms = 1100, clip } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', (f) => {
    frames.push({ t: f.metadata.timestamp * 1000, data: f.data });
    cdp
      .send('Page.screencastFrameAck', { sessionId: f.sessionId })
      .catch(() => {});
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 85,
    everyNthFrame: 1,
  });
  await sleep(400);
  const t0 = Date.now();
  await work();
  await sleep(ms);
  await cdp.send('Page.stopScreencast');
  await cdp.detach().catch(() => {});
  // Wall clock of the tap in the screencast's timebase (both are epoch ms).
  const picked = [];
  const span = Date.now() - t0;
  for (let at = -100; at <= span; at += 100) {
    const want = t0 + at;
    let best = null;
    for (const f of frames)
      if (
        f.t <= want + 50 &&
        (!best || Math.abs(f.t - want) < Math.abs(best.t - want))
      )
        best = f;
    if (best && picked.at(-1)?.f !== best) picked.push({ at, f: best });
  }
  if (picked.length === 0) return { frames: frames.length, picked: 0 };
  const first = await sharp(Buffer.from(picked[0].f.data, 'base64')).metadata();
  // clip is in CSS px; frames come at whatever size the screencast picks.
  const k = clip ? first.width / clip.viewW : 1;
  const c = clip
    ? {
        left: 0,
        top: Math.round(clip.top * k),
        width: first.width,
        height: Math.min(
          first.height - Math.round(clip.top * k),
          Math.round(clip.height * k),
        ),
      }
    : { left: 0, top: 0, width: first.width, height: first.height };
  const cellW = Math.round(Math.min(c.width > c.height ? 520 : 300, c.width));
  const scale = cellW / c.width;
  const cellH = Math.round(c.height * scale);
  const cols = Math.min(c.width > c.height ? 4 : 8, picked.length);
  const rows = Math.ceil(picked.length / cols);
  const pad = 8;
  const labelH = 22;
  const W = cols * (cellW + pad) + pad;
  const H = rows * (cellH + labelH + pad) + pad;
  const composites = [];
  for (let i = 0; i < picked.length; i++) {
    const x = pad + (i % cols) * (cellW + pad);
    const y = pad + Math.floor(i / cols) * (cellH + labelH + pad);
    const img = await sharp(Buffer.from(picked[i].f.data, 'base64'))
      .extract(c)
      .resize(cellW, cellH)
      .png()
      .toBuffer();
    composites.push({ input: img, left: x, top: y + labelH });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${labelH}"><text x="2" y="16" font-family="Arial" font-size="14" fill="#ddd">${picked[i].at >= 0 ? '+' : ''}${picked[i].at} ms</text></svg>`;
    composites.push({ input: Buffer.from(svg), left: x, top: y });
  }
  await sharp({
    create: { width: W, height: H, channels: 3, background: '#111' },
  })
    .composite(composites)
    .png()
    .toFile(join(FILTER_SHOTS, `${name}.png`));
  return { frames: frames.length, picked: picked.length };
}

const sheetName = (base, label) =>
  label === 'desktop' ? base : `${base}-${label}`;

async function checkSheets(label, profile) {
  if (!WANT_SHOTS) return;
  if (WEBKIT) {
    skip(
      `sheets-${label}`,
      'not applicable: the frame sheets use the Chromium-only CDP screencast',
    );
    return;
  }
  const { ctx, page } = await newPage(profile);
  await page.goto(stageUrl(forced({ loader: 'never' })), { waitUntil: 'load' });
  await dismissChrome(page);
  await waitLive(page, 2);
  await page.mouse.move(2, 2);
  await waitRest(page).catch(() => {});
  await setStyle(
    page,
    'qa-hide-debug',
    '[data-stage-root] > p.fixed{display:none!important}',
  );
  const h = await hostClip(page);
  // The stage band only (heading to the info block), in CSS px.
  const clip = {
    viewW: profile.context.viewport.width,
    top: h.clip.y,
    height: Math.min(h.clip.height, profile.context.viewport.height - h.clip.y),
  };
  const a = await frameSheet(
    page,
    sheetName('sheet-all-classic-all', label),
    async () => {
      await chip(page, /^Classic/).click();
      await sleep(1100);
      await chip(page, /^All/).click();
    },
    { ms: 1100, clip },
  );
  await page.getByRole('button', { name: /^Poly$/ }).click();
  await sleep(1500);
  const b = await frameSheet(
    page,
    sheetName('sheet-poly-return', label),
    () => page.getByRole('button', { name: /^Pok/ }).click(),
    { ms: 1000, clip },
  );
  report(
    `sheets-${label}`,
    'PASS',
    `All -> Classic -> All: ${a.picked} frames of ${a.frames} captured; Poly -> Pokemon: ${b.picked} of ${b.frames} (shots-filter/sheet-*-${label}.png)`,
  );
  await ctx.close();
}

/**
 * A returning visit (no loader): the flat pictures paint first and each one
 * hands over to its 3D pack with a hard cut. Frame sheet from navigation on,
 * plus the per-frame sampler: no frame may show a picture and its model.
 */
async function checkReturnVisit(label, profile) {
  if (WEBKIT) {
    skip(
      `return-visit-${label}`,
      'not applicable: uses the Chromium-only CDP screencast',
    );
    return;
  }
  const { ctx, page } = await newPage(profile);
  await page.addInitScript(handSamplerScript);
  const url = stageUrl(forced({ loader: 'never' }));
  await fetch(url).catch(() => {}); // a warm server, as a real return visit
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', (f) => {
    frames.push({ t: f.metadata.timestamp * 1000, data: f.data });
    cdp
      .send('Page.screencastFrameAck', { sessionId: f.sessionId })
      .catch(() => {});
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 85,
    everyNthFrame: 1,
  });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'commit' });
  await waitLive(page, profile.kind === 'desktop' ? 3 : 2, 30000).catch(
    () => {},
  );
  await sleep(1500);
  await cdp.send('Page.stopScreencast');
  await cdp.detach().catch(() => {});
  const sampled = await page.evaluate(() => {
    window.__qaHand.stop = true;
    return window.__qaHand.frames;
  });
  const liveAt = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    return Math.round(performance.now() - (n?.startTime ?? 0));
  });
  // ~10 frames a second over the hand-over, as a sheet.
  if (WANT_SHOTS && frames.length > 0) {
    const first = await sharp(Buffer.from(frames[0].data, 'base64')).metadata();
    const cellW = profile.kind === 'phone' ? 260 : 480;
    const cellH = Math.round((first.height / first.width) * cellW);
    const picked = [];
    const span = Date.now() - t0;
    for (let at = 0; at <= span; at += 100) {
      let best = null;
      for (const f of frames)
        if (
          f.t <= t0 + at + 50 &&
          (!best || Math.abs(f.t - (t0 + at)) < Math.abs(best.t - (t0 + at)))
        )
          best = f;
      if (best && picked.at(-1)?.f !== best) picked.push({ at, f: best });
    }
    const cols = profile.kind === 'phone' ? 8 : 5;
    const rows = Math.ceil(picked.length / cols);
    const pad = 8;
    const labelH = 22;
    const comps = [];
    for (let i = 0; i < picked.length; i++) {
      const x = pad + (i % cols) * (cellW + pad);
      const y = pad + Math.floor(i / cols) * (cellH + labelH + pad);
      comps.push({
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${labelH}"><text x="2" y="16" font-family="Arial" font-size="14" fill="#ddd">+${picked[i].at} ms</text></svg>`,
        ),
        left: x,
        top: y,
      });
      comps.push({
        input: await sharp(Buffer.from(picked[i].f.data, 'base64'))
          .resize(cellW, cellH)
          .png()
          .toBuffer(),
        left: x,
        top: y + labelH,
      });
    }
    await sharp({
      create: {
        width: cols * (cellW + pad) + pad,
        height: rows * (cellH + labelH + pad) + pad,
        channels: 3,
        background: '#111',
      },
    })
      .composite(comps)
      .png()
      .toFile(
        join(
          FILTER_SHOTS,
          profile.kind === 'phone'
            ? 'sheet-return-visit-phone.png'
            : 'sheet-return-visit.png',
        ),
      );
  }
  const doubled = sampled.filter((f) => f.doubled.length > 0).length;
  const holes = sampled.filter((f) => f.holes.length > 0).length;
  pass(
    `return-visit-${label}`,
    doubled === 0 && holes === 0 && sampled.length > 0,
    `${sampled.length} frames sampled from the first paint: picture and model together ${doubled}, hidden picture with no model ${holes}; ${frames.length} screencast frames (sheet-return-visit${profile.kind === 'phone' ? '-phone' : ''}.png); page age at the end ${liveAt} ms`,
  );
  await ctx.close();
}

/** Owner recordings (run HEADED=1 for a real GPU): webm -> mp4 with no sound track. */
async function recordFilter(label, profile, { jp = false } = {}) {
  if (!WANT_VIDEO) return;
  const dir = join(FILTER_SHOTS, `.video-${label}`);
  mkdirSync(dir, { recursive: true });
  const { ctx, page } = await newPage(profile, {
    recordVideo: { dir, size: profile.context.viewport },
  });
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = '[data-stage-root] > p.fixed{display:none!important}';
      document.head.appendChild(s);
    });
  });
  const params = forced({
    loader: 'never',
    ...(jp ? { jp: 'delta-reign,ah' } : {}),
  });
  await page.goto(stageUrl(params), { waitUntil: 'load' });
  await dismissChrome(page);
  await waitLive(page, 2).catch(() => {});
  await page.mouse.move(2, 2);
  await sleep(1200);
  const tap = async (loc, wait = 1500) => {
    await loc.click();
    await page.mouse.move(2, 2);
    await sleep(wait);
  };
  if (jp) {
    await tap(chip(page, /^Original/));
    await tap(langBtn(page, /^Japanese$/));
    await swipe(page, profile, -0.75);
    await sleep(1100);
    await tap(langBtn(page, /^Japanese$/));
    await tap(langBtn(page, /^English$/));
    await tap(langBtn(page, /^English$/));
  } else {
    await tap(chip(page, /^Classic/));
    await swipe(page, profile, -0.75);
    await sleep(1200);
    await tap(chip(page, /^Original/));
    // the Special shelf can be absent from the live catalogue
    if ((await rowState(page)).chips.some((c) => /^Special/.test(c)))
      await tap(chip(page, /^Special/));
    await tap(chip(page, /^All/));
    await swipe(page, profile, 0.75);
    await sleep(1200);
    await tap(page.getByRole('button', { name: /^Poly$/ }), 1800);
    await tap(page.getByRole('button', { name: /^Pok/ }), 2200);
  }
  const video = page.video();
  await ctx.close();
  if (!video) {
    skip(`filter-video-${label}`, 'Playwright video not available');
    return;
  }
  const name = jp ? `language-${profile.kind}` : `sort-${profile.kind}`;
  const webm = join(dir, 'raw.webm');
  renameSync(await video.path(), webm);
  const out = join(FILTER_SHOTS, `${name}.mp4`);
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-i',
      webm,
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      out,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    report(`filter-video-${label}`, 'FAIL', `ffmpeg: ${r.stderr || r.error}`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  report(
    `filter-video-${name}`,
    'PASS',
    `${out} (${(statSync(out).size / 1e6).toFixed(1)} MB, no audio track)`,
  );
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The scroll spin (step 2: Ciao's packshot row, paged; shots-spin/)

const SPIN_SHOTS =
  process.env.SPIN_SHOTS_DIR ??
  join(ROOT, 'docs/research/home-3d/pack-stage/shots-spin');
/** Ciao's paging move (motion sheet 9.2/9.3): 1.5 s ease-out cubic. */
const PAGED_MS = 1500;
const easeOutCubic = (t) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
/** Step 1's document heights (baseline build, reduced motion must equal them). */
const STEP1_DOC_H = { phone: 4052, desktop: 3074 };
const spinMemory = {};

const spinInfo = (page) =>
  page.evaluate(() => {
    const s = window.__packStage;
    const sp = s?.spin?.();
    return {
      kit: !!sp?.kit,
      range: sp?.range ?? null,
      frame: sp?.frame ?? null,
      flags: sp?.flags ?? null,
      y: window.scrollY,
      spin: s?.state.spin ?? null,
      exit: s?.state.exit ?? null,
      stats: s?.stats() ?? null,
      rt: (() => {
        const r = s?.runtime?.();
        return r
          ? {
              copies: r.copies,
              spinBand: r.spinBand,
              bandH: r.bandH,
              textureBytes: r.textureBytes,
              uploaded: r.slots.filter((x) => x.half === 'uploaded').length,
              full: r.slots.filter((x) => x.full === 'uploaded').length,
            }
          : null;
      })(),
    };
  });

async function waitSpinReady(page) {
  await page.waitForFunction(
    () => {
      const sp = window.__packStage?.spin?.();
      return !!sp?.kit && !!sp.range;
    },
    null,
    { timeout: 20000, polling: 100 },
  );
}

/** Per-frame sampler: [ms since start, scrollY, spin, exit]. */
async function startSampler(page) {
  await page.evaluate(() => {
    const out = [];
    window.__spinSamples = out;
    const t0 = performance.now();
    const f = () => {
      const s = window.__packStage?.state;
      out.push([
        performance.now() - t0,
        window.scrollY,
        s?.spin ?? 0,
        s?.exit ?? 0,
      ]);
      if (out.length < 600) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
}
const samples = (page) => page.evaluate(() => window.__spinSamples ?? []);

/** One trusted gesture down (or up): a wheel notch on desktop, a swipe on a phone (CDP touch). */
async function spinGesture(page, profile, dir = 1, px = 120, holdMs = 0) {
  const vw = profile.context.viewport;
  const x = vw.width / 2;
  const y = vw.height * 0.55;
  if (profile.kind === 'phone' && !WEBKIT) {
    const cdp = await page.context().newCDPSession(page);
    const steps = 8;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y }],
    });
    let heldY = null;
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y - (dir * px * i) / steps }],
      });
      await sleep(16);
    }
    if (holdMs) {
      await sleep(holdMs);
      heldY = await page.evaluate(() => window.scrollY);
    }
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await cdp.detach().catch(() => {});
    return { heldY };
  }
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, dir * 100);
  return { heldY: null };
}

/** The paged move's scroll curve against Ciao's (normalised displacement vs easeOutCubic). */
function curveFit(rows, from, to, startKnown = false) {
  const span = to - from;
  const moving = rows.filter((r) => Math.abs(r[1] - from) > 0.5);
  if (!moving.length || !span) return null;
  const i0 = rows.indexOf(moving[0]);
  // a known start (the driver's trace, timed from the gesture) is row 0's time
  const lo = startKnown
    ? rows[0][0]
    : i0 > 0
      ? rows[i0 - 1][0]
      : moving[0][0] - 50;
  const hi = startKnown ? rows[0][0] : moving[0][0];
  const score = (t0) => {
    let se = 0;
    let n = 0;
    let maxErr = 0;
    for (const r of rows.slice(i0)) {
      const t = r[0] - t0;
      if (t > PAGED_MS + 200) break;
      const e = Math.abs((r[1] - from) / span - easeOutCubic(t / PAGED_MS));
      se += e * e;
      n++;
      maxErr = Math.max(maxErr, e);
    }
    return { rms: Math.sqrt(se / Math.max(1, n)), maxErr, n };
  };
  // the move starts (the gesture lands) somewhere between the last still
  // frame and the first moved one: take the start that fits best
  let best = { t0: hi, ...score(hi) };
  for (let t0 = lo; t0 <= hi; t0 += 1) {
    const sc = score(t0);
    if (sc.rms < best.rms) best = { t0, ...sc };
  }
  const t0 = best.t0;
  const at = (frac) => {
    const r = rows.slice(i0).find((x) => (x[1] - from) / span >= frac);
    return r ? Math.round(r[0] - t0) : null;
  };
  const done = rows.slice(i0).find((x) => Math.abs(x[1] - to) < 1);
  return {
    rms: best.rms,
    maxErr: best.maxErr,
    doneAt: done ? Math.round(done[0] - t0) : null,
    t50: at(0.5),
    t90: at(0.9),
    t98: at(0.98),
    frames: best.n,
  };
}

async function spinPage(profile, more = {}, b = browser, extra = {}) {
  const { ctx, page } = await newPage(profile, extra, b);
  await page.goto(stageUrl(forced({ loader: 'never', ...more })), {
    waitUntil: 'load',
  });
  await dismissChrome(page);
  return { ctx, page };
}

async function spinShot(page, name) {
  if (!WANT_SHOTS) return;
  mkdirSync(SPIN_SHOTS, { recursive: true });
  await page.screenshot({
    path: join(SPIN_SHOTS, `${name.replace('-headed', '')}.png`),
  });
}

/** The paged move, the lock, one stop per gesture, the formed row, repeats, exit, memory. */
async function checkSpin(label, profile) {
  const { ctx, page } = await spinPage(profile);
  await waitLive(page, profile.kind === 'desktop' ? 3 : 2);
  await waitSpinReady(page);
  await page.mouse.move(2, 2);
  await waitRest(page).catch(() => {});
  const cap = CAPS[profile.kind];
  const rest = await spinInfo(page);
  const r = rest.range;
  const mem = { rest: rest.stats?.gpuBytesEstimate ?? null };

  // 1. one gesture plays one move: Ciao's curve, input locked meanwhile
  await startSampler(page);
  const g = await spinGesture(
    page,
    profile,
    1,
    120,
    profile.kind === 'phone' ? 400 : 0,
  );
  if (profile.kind === 'phone' && !WEBKIT)
    pass(
      `spin-held-finger-${label}`,
      g.heldY === r.start,
      `a 120 px swipe held 400 ms before release: scrollY while held ${g.heldY} (pin start ${r.start}); the page never follows the finger`,
    );
  // mid-move: extra input is swallowed (wheel again; on a phone a reverse wheel)
  await sleep(300);
  await page.mouse.move(
    profile.context.viewport.width / 2,
    profile.context.viewport.height / 2,
  );
  await page.mouse.wheel(0, profile.kind === 'phone' ? -100 : 100);
  await sleep(PAGED_MS + 600);
  const rows = await samples(page);
  const end = r.start + r.length;
  // The driver's own trace (scrollY read back right after each write, on the
  // frame's clock, from the gesture that started the move): exact even when
  // software frames are slow. The page sampler is the fallback.
  const tr = await page.evaluate(() => window.__packStage?.spinTrace?.());
  let fit = null;
  if (tr?.trace?.length) {
    const firstMoved = tr.trace.find((x) => x[1] > r.start + 0.5);
    const g0 = firstMoved
      ? Math.max(...tr.gestures.filter((t) => t <= firstMoved[0]))
      : null;
    if (firstMoved && Number.isFinite(g0)) {
      const rel = tr.trace
        .filter((x) => x[0] >= g0)
        .map((x) => [x[0] - g0, x[1], x[2], 0]);
      fit = curveFit([[0, r.start, 0, 0], ...rel], r.start, end, true);
    }
  }
  fit ??= curveFit(rows, r.start, end);
  const after = await spinInfo(page);
  pass(
    `spin-paged-curve-${label}`,
    !!fit &&
      fit.rms <= 0.03 &&
      fit.doneAt !== null &&
      fit.doneAt <= PAGED_MS + 120,
    fit
      ? `scroll ${r.start} -> ${end} px: RMS ${(fit.rms * 100).toFixed(2)}% (max ${(fit.maxErr * 100).toFixed(1)}%) against 1.5 s ease-out cubic over ${fit.frames} frames; 50% at ${fit.t50} ms (sheet 0.35 s), 90% at ${fit.t90} ms (0.87 s), 98% at ${fit.t98} ms (1.13 s), landed at ${fit.doneAt} ms (1.43-1.5 s)`
      : `no move recorded (${rows.length} samples)`,
  );
  // spin == scroll progress through the pin at every frame of the move
  const lagFrames = rows.filter((x) => x[1] > r.start && x[1] < end);
  const worst = lagFrames.reduce(
    (m, x) => Math.max(m, Math.abs(x[2] - (x[1] - r.start) / r.length)),
    0,
  );
  pass(
    `spin-is-scroll-${label}`,
    lagFrames.length > 3 && worst <= 0.02,
    `${lagFrames.length} frames inside the pin: worst |spin - scroll progress| ${worst.toFixed(4)} (Ciao's row: the spin is the eased scroll itself)`,
  );
  pass(
    `spin-input-locked-${label}`,
    after.y === end && after.spin === 1 && after.exit === 0,
    `a second ${profile.kind === 'phone' ? 'reverse ' : ''}wheel 300 ms into the move was swallowed: landed on the pin end exactly (scrollY ${after.y}, end ${end}), spin ${after.spin}, exit ${after.exit}`,
  );
  mem.formed = after.stats?.gpuBytesEstimate ?? null;

  // 2. the formed row: canvas and CSS tiles in one place; repeats share textures
  await waitRest(page).catch(() => {});
  await sleep(600);
  const formed = await spinInfo(page);
  await spinShot(page, `formed-${label}`);
  const fAlign = await align(page, profile).catch(() => null);
  const restTex =
    rest.stats && rest.rt
      ? rest.stats.textures - rest.rt.uploaded - rest.rt.full
      : null;
  const formedTex =
    formed.stats && formed.rt
      ? formed.stats.textures - formed.rt.uploaded - formed.rt.full
      : null;
  pass(
    `spin-formed-row-${label}`,
    !!fAlign && fAlign.iou >= 0.9 && formed.flags?.text === true,
    `spin ${formed.spin}: canvas vs tiles IoU ${fAlign?.iou ?? 'n/a'} (${fAlign?.detail ?? ''}); text faded (data-spin-text ${formed.flags?.text}); band ${formed.rt?.bandH} px (whole panel ${formed.rt?.spinBand})`,
  );
  pass(
    `spin-repeats-share-textures-${label}`,
    formed.rt !== null &&
      restTex !== null &&
      restTex === formedTex &&
      (profile.kind === 'phone' || formed.rt.copies > 0),
    `repeats drawn ${formed.rt?.copies}; textures ${formed.stats?.textures} = ${formed.rt?.uploaded} pack fronts + ${formedTex} shared (at rest ${rest.stats?.textures} = ${rest.rt?.uploaded} + ${rest.rt?.full} full + ${restTex}); texture bytes ${((formed.rt?.textureBytes ?? 0) / 1e6).toFixed(2)} MB = the fronts alone (clones add none)`,
  );
  pass(
    `spin-memory-formed-${label}`,
    (formed.stats?.gpuBytesEstimate ?? Infinity) <= cap,
    `formed row ${((formed.stats?.gpuBytesEstimate ?? 0) / 1e6).toFixed(1)} MB (cap ${cap / 1e6}); at rest ${((mem.rest ?? 0) / 1e6).toFixed(1)} MB`,
  );

  // 3. a category change and a sort change mid-spin: the usual sink and rise
  const y0 = (await spinInfo(page)).y;
  await page.getByRole('button', { name: /^Poly$/ }).click();
  await sleep(1200);
  const poly = await spinInfo(page);
  const polyTiles = await page
    .locator('[data-stage-panel]:not([hidden]) [data-stage-tile]')
    .count();
  await spinShot(page, `midspin-poly-${label}`);
  await page.getByRole('button', { name: /^Pok/ }).click();
  await sleep(1200);
  let sortOk = null;
  try {
    await openPanel(page);
    const opt = page
      .locator(
        '[data-stage-chips] [role="radio"], [data-stage-chips] [role="option"], [data-stage-chips] button',
      )
      .filter({ hasText: /Classic|Original|Special/ })
      .first();
    await opt.click({ timeout: 3000 });
    await sleep(1200);
    sortOk = await page
      .locator('[data-stage-panel]:not([hidden]) [data-stage-tile]')
      .count();
  } catch (e) {
    sortOk = `failed: ${String(e?.message ?? e).split('\n')[0]}`;
  }
  const sorted = await spinInfo(page);
  await spinShot(page, `midspin-sort-${label}`);
  pass(
    `spin-midspin-changes-${label}`,
    poly.y === y0 &&
      sorted.y === y0 &&
      poly.spin === 1 &&
      sorted.spin === 1 &&
      polyTiles === 5 &&
      typeof sortOk === 'number',
    `at the formed row: Poly tab -> ${polyTiles} capsules (spin ${poly.spin}, scrollY ${poly.y}), back to Pokemon, then a sort pick -> ${sortOk} packs (spin ${sorted.spin}, scrollY ${sorted.y}); the page never moved (${y0})`,
  );

  // 4. 20 changes mid-spin: memory peak
  let peak = 0;
  const tabs = [/^Poly$/, /^Pok/];
  for (let k = 0; k < 20; k++) {
    await page.getByRole('button', { name: tabs[k % 2] }).click();
    for (let t = 0; t < 4; t++) {
      await sleep(200);
      const s = await page.evaluate(
        () => window.__packStage?.stats()?.gpuBytesEstimate ?? 0,
      );
      peak = Math.max(peak, s);
    }
  }
  await sleep(800);
  mem.changes20Peak = peak;
  pass(
    `spin-memory-20-changes-${label}`,
    peak <= cap,
    `20 category changes at the formed row: peak ${(peak / 1e6).toFixed(1)} MB (cap ${cap / 1e6})`,
  );

  // 5. the exit: Ciao's camera move as the page below rises over the stuck panel
  const exitEnd = r.start + r.length + r.exit;
  if (profile.kind === 'phone' && !WEBKIT) {
    await spinGesture(page, profile, 1);
    await sleep(PAGED_MS + 400);
  } else {
    for (
      let k = 0;
      k < 30 && (await page.evaluate(() => window.scrollY)) < exitEnd;
      k++
    ) {
      await page.mouse.wheel(0, 100);
      await sleep(60);
    }
    await sleep(900);
  }
  const ex = await spinInfo(page);
  const below = await page.evaluate(() => {
    const a = document.querySelector('[data-spin-after]');
    const p = document.querySelector('[data-stage-root]');
    return {
      afterTop: Math.round(a.getBoundingClientRect().top),
      panelTop: Math.round(p.getBoundingClientRect().top),
      head: p.hasAttribute('data-spin-head'),
    };
  });
  await spinShot(page, `exit-${label}`);
  pass(
    `spin-exit-${label}`,
    ex.exit >= 0.999 && below.head && below.afterTop <= below.panelTop + 2,
    `${profile.kind === 'phone' ? 'one swipe paged' : 'free wheel scrubbed'} through the exit: exit ${ex.exit.toFixed(4)}, scrollY ${ex.y} (exit end ${exitEnd}); header faded ${below.head}; the page below tops the panel (${below.afterTop} vs panel ${below.panelTop})`,
  );
  // back up: paging again once the start is nearer
  await page.evaluate((y) => window.scrollTo(0, y), r.start + r.length);
  await sleep(500);
  mem.exit = ex.stats?.gpuBytesEstimate ?? null;
  spinMemory[`${label}-dpr${profile.context.deviceScaleFactor ?? 1}`] = {
    restMB: mem.rest / 1e6,
    formedMB: mem.formed / 1e6,
    changes20PeakMB: peak / 1e6,
    exitMB: (mem.exit ?? 0) / 1e6,
    capMB: cap / 1e6,
    dpr: profile.context.deviceScaleFactor ?? 1,
    mode: (await stageInfo(page))?.mode,
    renderer: await renderer(page),
  };
  await ctx.close();
}

/** A long fast swipe or a burst of notches still plays one stop only. */
async function checkSpinOneStop(label, profile) {
  const { ctx, page } = await spinPage(profile);
  await waitLive(page, 1).catch(() => {});
  await waitSpinReady(page);
  const r = (await spinInfo(page)).range;
  const end = r.start + r.length;
  await startSampler(page);
  const t0 = Date.now();
  let notches = 0;
  if (profile.kind === 'phone' && !WEBKIT)
    await spinGesture(page, profile, 1, 420);
  else {
    await page.mouse.move(profile.context.viewport.width / 2, 400);
    for (let k = 0; k < 10; k++) {
      await page.mouse.wheel(0, 100);
      notches++;
      if (Date.now() - t0 > 1200) break; // stay inside the lock window
    }
  }
  const burstMs = Date.now() - t0;
  await sleep(PAGED_MS + 500);
  const rows = await samples(page);
  const s = await spinInfo(page);
  const first = rows.find((x) => x[1] > r.start + 0.5);
  const inLock = first
    ? rows.filter((x) => x[0] - first[0] < PAGED_MS - 50)
    : [];
  const maxInLock = inLock.reduce((m, x) => Math.max(m, x[1]), 0);
  pass(
    `spin-one-stop-${label}`,
    s.y === end && maxInLock <= end + 1,
    `${profile.kind === 'phone' ? 'a 420 px swipe' : `${notches} wheel notches in ${burstMs} ms`}: never past the pin end during the move (max ${Math.round(maxInLock)}), landed at ${s.y} (pin end ${end}, exit end ${end + r.exit})`,
  );
  await ctx.close();
}

/** Reduced motion: no pin, no scrub, no spin chunk; the page reads as step 1. */
async function checkSpinReduced(label, profile) {
  const { ctx, page } = await spinPage(profile, {}, browser, {
    reducedMotion: 'reduce',
  });
  await sleep(2500);
  const info = await page.evaluate(() => {
    const w = document.querySelector('[data-spin-wrap]');
    const p = document.querySelector('[data-stage-root]');
    return {
      wrapH: Math.round(w.getBoundingClientRect().height),
      panelH: Math.round(p.getBoundingClientRect().height),
      pos: getComputedStyle(p).position,
      docH: document.documentElement.scrollHeight,
      gap: Math.round(
        document.querySelector('[data-spin-after]').getBoundingClientRect()
          .top - w.getBoundingClientRect().bottom,
      ),
      kit: !!window.__packStage?.spin,
      chunk: performance
        .getEntriesByType('resource')
        .some((e) => /pack-stage-spin/.test(e.name)),
    };
  });
  await page.mouse.move(200, 400);
  await page.mouse.wheel(0, 300);
  await sleep(700);
  const y = await page.evaluate(() => window.scrollY);
  const base = STEP1_DOC_H[profile.kind];
  pass(
    `spin-reduced-motion-${label}`,
    info.wrapH === info.panelH &&
      info.pos !== 'sticky' &&
      !info.kit &&
      !info.chunk &&
      y > 0 &&
      info.gap === 0,
    `wrapper ${info.wrapH} px = panel ${info.panelH} px (position ${info.pos}); spin chunk requested ${info.chunk}; a wheel scrolled natively to ${y}; the page below follows the panel (gap ${info.gap} px); document ${info.docH} px (step 1 measured ${base} with that day's feed)`,
  );
  await ctx.close();
}

/** The flat tier (no WebGL): the CSS tiles page into the same row. */
async function checkSpinFlat(label, profile) {
  const { ctx, page } = await newPage(profile);
  await page.goto(stageUrl({ stage: 'flat', debug: '1', loader: 'never' }), {
    waitUntil: 'load',
  });
  await dismissChrome(page);
  await waitSpinReady(page);
  const r = (await spinInfo(page)).range;
  await spinGesture(page, profile, 1);
  await sleep(PAGED_MS + 600);
  const s = await spinInfo(page);
  const tiles = await page.evaluate(() => {
    const prefix = window.matchMedia('(min-width: 1024px)').matches ? 'd' : 'm';
    return [
      ...document.querySelectorAll(
        '[data-stage-panel]:not([hidden]) [data-stage-tile]',
      ),
    ].map((li) => ({
      rz: Number(li.style.getPropertyValue(`--${prefix}-rz`)),
      op: Number(li.style.getPropertyValue(`--${prefix}-op`)),
    }));
  });
  await spinShot(page, `flat-formed-${label}`);
  const shown = tiles.filter((t) => t.op > 0.05);
  pass(
    `spin-flat-${label}`,
    s.y === r.start + r.length &&
      s.spin === 1 &&
      shown.length >= (profile.kind === 'phone' ? 3 : 7) &&
      shown.every((t) => t.rz !== 0),
    `no canvas (mode ${(await stageInfo(page))?.mode}): one gesture paged to ${s.y} (end ${r.start + r.length}), spin ${s.spin}; ${shown.length} CSS tiles shown in the row, all rolled (rz ${shown.map((t) => t.rz.toFixed(2)).join(', ')})`,
  );
  await ctx.close();
}

/** WebKit: the row at both sizes, paged by the wheel (no CDP touch there). */
async function checkSpinWebkit(label, profile) {
  const { ctx, page } = await spinPage(profile);
  await waitLive(page, 1).catch(() => {});
  await waitSpinReady(page);
  const r = (await spinInfo(page)).range;
  await page.mouse.move(profile.context.viewport.width / 2, 400);
  await page.mouse.wheel(0, 100);
  await sleep(PAGED_MS + 800);
  const s = await spinInfo(page);
  if (profile.kind === 'phone' && WANT_SHOTS) {
    mkdirSync(SPIN_SHOTS, { recursive: true });
    await page.screenshot({ path: join(SPIN_SHOTS, 'webkit-spin-phone.png') });
  } else await spinShot(page, `webkit-spin-${profile.kind}`);
  pass(
    `spin-webkit-${label}`,
    s.y === r.start + r.length &&
      s.spin === 1 &&
      (s.stats?.gpuBytesEstimate ?? 0) <= CAPS[profile.kind],
    `WebKit: a wheel notch paged to ${s.y} (end ${r.start + r.length}), spin ${s.spin}; mode ${(await stageInfo(page))?.mode}; ${((s.stats?.gpuBytesEstimate ?? 0) / 1e6).toFixed(1)} MB; touch paging not run (WebKit has no CDP touch)`,
  );
  await ctx.close();
}

/** The panel is one screen at every width: heading, tabs, row and Open fit above the tab bar. */
async function checkSpinFit() {
  const sizes = [
    {
      name: '375x667',
      viewport: { width: 375, height: 667 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    },
    {
      name: '390x844',
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    },
    {
      name: '430x932',
      viewport: { width: 430, height: 932 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    },
    {
      name: '1280x720',
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    },
    {
      name: '1440x900',
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    },
    {
      name: '1920x1080',
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    },
  ];
  const rows = [];
  for (const s of sizes) {
    const { ctx, page } = await newPage({ kind: 'fit', context: s });
    await page.goto(stageUrl({ stage: 'flat', loader: 'never' }), {
      waitUntil: 'load',
    });
    await dismissChrome(page);
    await sleep(1200);
    const m = await page.evaluate(() => {
      const panel = document
        .querySelector('[data-stage-root]')
        .getBoundingClientRect();
      const open = [
        ...document.querySelectorAll(
          '[data-stage-info] a, [data-stage-info] span',
        ),
      ].find((e) => /^(Open|Sold out)/.test(e.textContent ?? ''));
      const o = open?.getBoundingClientRect();
      const bar = document.querySelector('nav.fixed.bottom-0');
      const barTop =
        bar && bar.offsetHeight > 0
          ? bar.getBoundingClientRect().top
          : innerHeight;
      return {
        panelTop: Math.round(panel.top),
        panelBottom: Math.round(panel.bottom),
        openBottom: o ? Math.round(o.bottom) : null,
        barTop: Math.round(barTop),
        art: Math.round(
          document
            .querySelector('[data-stage-panel]:not([hidden]) [data-stage-art]')
            .getBoundingClientRect().height,
        ),
      };
    });
    rows.push({
      name: s.name,
      ...m,
      ok:
        m.openBottom !== null &&
        m.openBottom <= Math.min(m.panelBottom, m.barTop) &&
        m.panelBottom <= m.barTop + 1,
    });
    await ctx.close();
  }
  pass(
    'spin-panel-fits',
    rows.every((r) => r.ok),
    rows
      .map(
        (r) =>
          `${r.name}: panel ${r.panelTop}-${r.panelBottom}, Open ends ${r.openBottom} (tab bar ${r.barTop}), art ${r.art} px${r.ok ? '' : ' OVERFLOW'}`,
      )
      .join('; '),
  );
}

/** Sold-out packs and the one-pack Special row in the formed row (shots for the owner). */
async function checkSpinRows(label, profile) {
  const { ctx, page } = await spinPage(profile, { soldout: '151,ah' });
  await waitLive(page, 1).catch(() => {});
  await waitSpinReady(page);
  const r = (await spinInfo(page)).range;
  await spinGesture(page, profile, 1);
  await sleep(PAGED_MS + 900);
  await spinShot(page, `formed-soldout-${label}`);
  let special = "no Special shelf in today's catalogue";
  try {
    await openPanel(page);
    const sp = page
      .locator('[data-stage-chips] [aria-pressed]')
      .filter({ hasText: /^Special/ });
    if ((await sp.count()) > 0) {
      await sp.first().click({ timeout: 3000 });
      await sleep(1600);
      special = await page
        .locator('[data-stage-panel]:not([hidden]) [data-stage-tile]')
        .count();
    } else await page.keyboard.press('Escape');
  } catch (e) {
    special = `failed: ${String(e?.message ?? e).split('\n')[0]}`;
  }
  const s = await spinInfo(page);
  await spinShot(page, `formed-special-${label}`);
  pass(
    `spin-rows-${label}`,
    s.y === r.start + r.length &&
      (special === 1 || /^no Special/.test(String(special))) &&
      (profile.kind === 'phone' || (s.rt?.copies ?? 1) > 0 || s.rt === null),
    `formed row with 151 and AH sold out (shot formed-soldout-${label}); the Special row: ${special} pack, ${s.rt?.copies ?? 'n/a'} repeats fill the row (shot formed-special-${label}); scrollY ${s.y}`,
  );
  await ctx.close();
}

function writeSpinMemory() {
  if (Object.keys(spinMemory).length === 0) return;
  mkdirSync(SPIN_SHOTS, { recursive: true });
  const file = join(SPIN_SHOTS, 'memory.json');
  let prev = {};
  try {
    prev = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    prev = {};
  }
  writeFileSync(file, JSON.stringify({ ...prev, ...spinMemory }, null, 2));
}

async function main() {
  if (SELF_TEST) {
    selfTest();
    return;
  }
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(FILTER_SHOTS, { recursive: true });
  const up = await fetch(URL, { method: 'GET' })
    .then((r) => r.status)
    .catch(() => 0);
  if (up !== 200) {
    report(
      'server',
      'FAIL',
      `${URL} answered ${up || 'nothing'}; start the production server with HOME_PREVIEW=1 first`,
    );
    return;
  }
  // `BROWSER=webkit`: the whole suite in Playwright's WebKit (the Safari
  // engine, not Safari on an iPhone), headless; it takes no --mute-audio, so
  // the init script (muteMediaScript) mutes every context.
  browser = WEBKIT
    ? await webkit.launch({ headless: true })
    : await launchChromium(
        HEADED
          ? { channel: 'chrome', headless: false, args: HEADED_ARGS }
          : {
              channel: 'chrome',
              args: [
                '--enable-unsafe-swiftshader',
                '--use-angle=swiftshader',
                '--ignore-gpu-blocklist',
              ],
            },
      );
  const label = (k) => (HEADED ? `${k}-headed` : WEBKIT ? `${k}-webkit` : k);
  try {
    for (const [key, profile] of Object.entries(PROFILES)) {
      const l = label(key);
      await run('live', `3d-live-${l}`, () => checkChunkAndLive(l, profile));
      if (!HEADED) {
        await run('never', `reduced-motion-${l}`, () =>
          checkNever3d(l, profile, 'reduced-motion', {
            reducedMotion: 'reduce',
          }),
        );
        await run('align', `align-${l}`, () => checkAlign(l, profile));
        await run('motion', `motion-${l}`, () => checkMotion(l, profile));
        await run('context-loss', `context-loss-${l}`, () =>
          checkContextLoss(l, profile),
        );
        await run('tabs', `tabs-${l}`, () => checkTabs(l, profile));
        await run('release', `release-${l}`, () => checkRelease(l));
      }
      await run('loader', `loader-${l}`, () => checkLoader(l, profile));
      await run('frames', `frame-times-${l}`, () =>
        checkFrameTimes(l, profile),
      );
      if (HEADED) {
        await run('motion', `motion-${l}`, () => checkMotion(l, profile));
        await run('align', `align-${l}`, () => checkAlign(l, profile));
        await run('tabs', `tabs-${l}`, () => checkTabs(l, profile));
        await run('handoff', `handoff-${l}`, () => checkHandoff(l, profile));
        await run('orders', `orders-${l}`, () => checkOrders(l, profile));
        await run('return-visit', `return-visit-${l}`, () =>
          checkReturnVisit(l, profile),
        );
      }
      await run('allpacks', `all-packs-live-${l}`, () =>
        checkAllPacks(l, profile),
      );
      await run('soldout', `soldout-${l}`, () => checkSoldOut(l, profile));
      // The scroll spin (step 2): Ciao's paged packshot row.
      if (WEBKIT) {
        await run('spin', `spin-webkit-${l}`, () =>
          checkSpinWebkit(l, profile),
        );
      } else {
        await run('spin', `spin-${l}`, () => checkSpin(l, profile));
        await run('spin', `spin-rows-${l}`, () => checkSpinRows(l, profile));
        await run('spin', `spin-one-stop-${l}`, () =>
          checkSpinOneStop(l, profile),
        );
        if (!HEADED) {
          await run('spin', `spin-reduced-motion-${l}`, () =>
            checkSpinReduced(l, profile),
          );
          await run('spin', `spin-flat-${l}`, () => checkSpinFlat(l, profile));
        }
      }
      if (!HEADED) {
        await run('chips', `chips-${l}`, () => checkChips(l, profile));
        await run('feed', `feed-${l}`, () => checkFeedFollows(l, profile));
        await run('panel-chunk', `panel-chunk-${l}`, () =>
          checkPanelChunk(l, profile),
        );
        await run('handoff', `handoff-${l}`, () => checkHandoff(l, profile));
        await run('orders', `orders-${l}`, () => checkOrders(l, profile));
        await run('handoff-control', `handoff-control-${l}`, () =>
          checkHandoffControl(l, profile),
        );
        await run('chip-memory', `chips-memory-${l}`, () =>
          checkChipMemory(l, profile),
        );
        await run('language', `language-${l}`, () => checkLanguage(l, profile));
        await run('sheets', `sheets-${l}`, () => checkSheets(l, profile));
      }
      await run('filter-video', `filter-video-${l}`, () =>
        recordFilter(l, profile),
      );
      if (profile.kind === 'phone')
        await run('filter-video', `language-video-${l}`, () =>
          recordFilter(l, profile, { jp: true }),
        );
      await run('video', `video-${l}`, () => recordVisit(l, profile));
    }
    if (!HEADED && !WEBKIT) {
      await run('never', 'no-webgl-desktop', async () => {
        const nogl = await launchChromium({
          channel: 'chrome',
          args: ['--disable-webgl', '--disable-3d-apis'],
        });
        try {
          await checkNever3d('desktop', PROFILES.desktop, 'no-webgl', {}, nogl);
        } finally {
          await nogl.close();
        }
      });
      await run('webkit', 'webkit-phone', async () => {
        let path = '';
        try {
          path = webkit.executablePath();
        } catch {
          path = '';
        }
        if (!path || !existsSync(path)) {
          skip(
            'webkit-phone',
            'not run: no WebKit build installed for Playwright (no downloads)',
          );
          return;
        }
        // WebKit has no --mute-audio: every context gets muteMediaScript (newPage).
        const wk = await webkit.launch();
        try {
          const prev = browser;
          browser = wk;
          await checkChunkAndLive('phone-webkit', PROFILES.phone);
          await checkAlign('phone-webkit', PROFILES.phone);
          await checkContextLoss('phone-webkit', PROFILES.phone);
          browser = prev;
        } finally {
          await wk.close();
        }
      });
      await run('spin', 'spin-panel-fits', () => checkSpinFit());
      await run('js', 'js-size', () => jsSizes());
    }
  } finally {
    writeSpinMemory();
    await browser.close();
  }
}

await main();
const failed = results.filter((r) => r.status === 'FAIL');
console.log(
  `\n${results.filter((r) => r.status === 'PASS').length} passed, ${failed.length} failed, ${results.filter((r) => r.status === 'SKIP').length} skipped`,
);
process.exit(failed.length > 0 ? 1 : 0);
