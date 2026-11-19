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
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'docs/research/home-3d/pack-stage/shots-3d');
const args = process.argv.slice(2);
const SELF_TEST = args.includes('--self-test');
const BASE = (
  args.find((a) => /^https?:/.test(a)) ??
  process.env.PW_BASE ??
  'http://localhost:4300'
).replace(/\/$/, '');
const URL = `${BASE}/home-preview`;
const HEADED = process.env.HEADED === '1';
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
    context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
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
  page.on('console', (m) => m.type() === 'error' && page.errors.push(m.text()));
  page.on(
    'request',
    (r) => CHUNK.test(r.url()) && page.chunkRequests.push(r.url()),
  );
  return { ctx, page };
}

const stageUrl = (params) => `${URL}?${new URLSearchParams(params).toString()}`;
const forced = (more = {}) =>
  HEADED ? { debug: '1', ...more } : { stage: '3d', debug: '1', ...more };

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

/** Canvas vs tiles for the centred pack and a neighbour. */
async function align(page, profile, extraDy = 0) {
  const dpr = profile.context.deviceScaleFactor ?? 1;
  const h = await hostClip(page);
  const c = await layerMask(page, 'canvas', h.clip, dpr);
  const t = await layerMask(page, 'tiles', h.clip, dpr);
  const cmp = comparePacks(c.boxes, t.boxes, h.centreX, extraDy);
  const io = iou(c.mask, t.mask);
  return {
    ...cmp,
    // Box counts can differ when two packs nearly touch (one layer merges
    // them into one run); the whole-silhouette IoU then has to vouch.
    ok: cmp.ok || (cmp.pairsOk && cmp.pairs.length > 0 && io >= 0.97),
    iou: io,
    detail: `${cmp.empty ? 'both layers empty (faded out together)' : ''}${cmp.pairs.map((p) => (p.canvas === null ? 'no canvas pack' : `dCx ${p.dCx} dCy ${p.dCy} dH ${p.dH}`)).join('; ')}; IoU ${iou(c.mask, t.mask)}; packs drawn ${c.boxes.length}, tiles ${t.boxes.length}`,
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
    `browser launched with --mute-audio (Chromium); media guard keeps a new Audio() muted at volume 0 after unmuting: ${guard}`,
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
    pass(
      `float-in-${label}`,
      false,
      `the float-in never started within 20 s (mode ${seen?.mode}, intro ${seen?.state.intro}, live ${seen?.live.length})`,
    );
    await ctx.close();
    return;
  }
  await sleep(900); // the CSS picture fade-in (real time) completes
  const points = [];
  for (let k = 0; k < 3; k++) {
    const info = await stageInfo(page);
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
          `intro ${p.intro}: ${p.a ? p.a.detail : `no pack live (3D not ready when the loader left: flat fallback)`}`,
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
    const a =
      info.live.length > 0 ? await align(page, profile, bobPx(info)) : null;
    sink.push({ swap: r1(info.state.swap * 100) / 100, a });
  }
  await page.evaluate(() => window.__qaClock.resume());
  pass(
    `swap-sink-${label}`,
    sink.every((p) => p.a?.ok) && sink.some((p) => p.swap > 0.05),
    sink
      .map((p) => `swap ${p.swap}: ${p.a ? p.a.detail : 'no pack live'}`)
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

async function main() {
  if (SELF_TEST) {
    selfTest();
    return;
  }
  mkdirSync(SHOTS, { recursive: true });
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
  browser = await launchChromium(
    HEADED
      ? { channel: 'chrome', headless: false }
      : {
          channel: 'chrome',
          args: [
            '--enable-unsafe-swiftshader',
            '--use-angle=swiftshader',
            '--ignore-gpu-blocklist',
          ],
        },
  );
  const label = (k) => (HEADED ? `${k}-headed` : k);
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
      }
      await run('allpacks', `all-packs-live-${l}`, () =>
        checkAllPacks(l, profile),
      );
      await run('soldout', `soldout-${l}`, () => checkSoldOut(l, profile));
      await run('video', `video-${l}`, () => recordVisit(l, profile));
    }
    if (!HEADED) {
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
      await run('js', 'js-size', () => jsSizes());
    }
  } finally {
    await browser.close();
  }
}

await main();
const failed = results.filter((r) => r.status === 'FAIL');
console.log(
  `\n${results.filter((r) => r.status === 'PASS').length} passed, ${failed.length} failed, ${results.filter((r) => r.status === 'SKIP').length} skipped`,
);
process.exit(failed.length > 0 ? 1 : 0);
