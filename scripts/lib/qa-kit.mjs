// qa-kit.mjs: one shared harness for the browser scripts that check, verify and diagnose pages.
// Plain Node ESM, no dependencies beyond the repo's own playwright. Import it by a relative path:
//
//   import * as qa from './lib/qa-kit.mjs';   (from a script in scripts/)
//
// Nothing here names a machine path. The server under test comes from --base, QA_BASE, or a test-server.json
// (QA_TEST_SERVER, else docs/research/home-3d/tools/test-server.json under the working directory, the repo, or a
// sibling worktree named pack-3d-prototype). Outputs go to --out, QA_OUT, QA_KIT_OUT_ROOT/<script name>, or the
// system temp folder.
//
// Run from a worktree root (playwright is resolved from process.cwd()), always through the queue:
//   node docs/research/home-3d/tools/qa-with-lock.mjs --runner=<lane> -- node <script>.mjs [--base=URL] [--out=DIR] [--only=phone|desktop] [--gl=swiftshader]
//
// Output lines are what docs/research/home-3d/tools/qa-parse.mjs reads:
//   "PASS name: detail" / "FAIL name: detail" / "SKIP name: detail" / "INFO name: detail", then "N passed, N failed, N skipped".
// Check names never hold ": " or " - " and details are one line (the kit cleans both).
//
// Page-agnostic. Everything that knows the 3D stage (window.__packStage, rests, stops, tiles) is under the "stage" export.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const require = createRequire(join(process.cwd(), 'package.json'));
let pw;
try {
  pw = require('playwright');
} catch (e) {
  throw new Error(
    'qa-kit: playwright not found from ' +
      process.cwd() +
      ' (run the script from a worktree root that has node_modules/playwright)',
  );
}

/** The repo this file lives in (scripts/lib/ -> two folders up). */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_SERVER_REL = 'docs/research/home-3d/tools/test-server.json';
/** Where a test-server.json may be, first match wins. The research folder is gitignored and kept in one worktree. */
const TEST_SERVER_FILES = [
  process.env.QA_TEST_SERVER || '',
  join(process.cwd(), TEST_SERVER_REL),
  join(REPO, TEST_SERVER_REL),
  join(REPO, '..', 'pack-3d-prototype', TEST_SERVER_REL),
].filter(Boolean);

// ---------- arguments ----------
const argv = process.argv.slice(2);
const flag = (k, d) => {
  const a = argv.find((x) => x.startsWith('--' + k + '='));
  return a ? a.slice(k.length + 3) : d;
};
/** Common flags: --base, --out, --only (phone|desktop|phone,desktop), --gl (gpu|swiftshader). Raw argv too. */
export const args = {
  argv,
  flag,
  has: (k) => argv.includes('--' + k),
  only: (flag('only', '') || '').split(',').filter(Boolean),
  gl: flag('gl', process.env.QA_GL || 'gpu'),
};
/** The profiles this run covers: --only=phone, --only=desktop, else both. */
export const sizes = (all = ['phone', 'desktop']) =>
  args.only.length ? all.filter((s) => args.only.includes(s)) : all;

function readBase() {
  const b = flag('base', process.env.QA_BASE || '');
  if (b) return b.replace(/\/$/, '');
  for (const p of TEST_SERVER_FILES) {
    if (existsSync(p))
      return JSON.parse(readFileSync(p, 'utf8')).base.replace(/\/$/, '');
  }
  throw new Error('qa-kit: no --base and no tools/test-server.json');
}
/** The server under test: --base, else QA_BASE, else the tests-only server in tools/test-server.json. Port 4320 is refused. */
export const BASE = readBase();
const baseUrl = new URL(BASE);
if (baseUrl.port === '4320')
  throw new Error(
    "qa-kit: 4320 is the owner's viewing link, never a test target",
  );
/** Where frames, sheets and notes go: --out, else QA_OUT, else <QA_KIT_OUT_ROOT or the temp folder>/<script name>. Never cwd-relative. */
export const OUT = (
  flag('out', process.env.QA_OUT || '') ||
  join(
    process.env.QA_KIT_OUT_ROOT || join(tmpdir(), 'qa-kit'),
    basename(process.argv[1] || 'script').replace(/\.m?js$/, ''),
  )
).replace(/\\/g, '/');
mkdirSync(OUT, { recursive: true });

// ---------- results ----------
const one = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const cleanName = (n) =>
  one(n).replace(/: /g, ' ').replace(/ - /g, ' ').replace(/:$/, '');
const tallies = { pass: 0, fail: 0, skip: 0 };
const T0 = Date.now();
/** A timing line on stderr ("[qa-kit +12.3s] msg"); qa-parse ignores it. */
export const trace = (msg) =>
  console.error(
    '[qa-kit +' + ((Date.now() - T0) / 1000).toFixed(1) + 's] ' + msg,
  );
const results = [];
/** Prints "PASS name: detail" or "FAIL name: detail". Returns ok. */
export function check(name, ok, detail = '') {
  const st = ok ? 'PASS' : 'FAIL';
  ok ? tallies.pass++ : tallies.fail++;
  results.push({ status: st, name: cleanName(name), detail: one(detail) });
  console.log(st + ' ' + cleanName(name) + ': ' + one(detail));
  return !!ok;
}
export function skip(name, detail = '') {
  tallies.skip++;
  results.push({ status: 'SKIP', name: cleanName(name), detail: one(detail) });
  console.log('SKIP ' + cleanName(name) + ': ' + one(detail));
}
/** A note, not a check. */
export function info(name, detail = '') {
  console.log('INFO ' + cleanName(name) + ': ' + one(detail));
}
/** Closes the browser, writes results.json, prints "N passed, N failed, N skipped" and sets the exit code. */
export async function done() {
  if (watchdog) clearTimeout(watchdog);
  info('elapsed', ((Date.now() - T0) / 1000).toFixed(1) + ' s');
  if (_browser) await _browser.close().catch(() => {});
  writeFileSync(
    join(OUT, 'results.json'),
    JSON.stringify({ base: BASE, renderer: _renderer, results }, null, 1),
  );
  console.log(
    tallies.pass +
      ' passed, ' +
      tallies.fail +
      ' failed, ' +
      tallies.skip +
      ' skipped',
  );
  process.exitCode = tallies.fail ? 1 : 0;
}
let watchdog = null;
/** A hard stop so a stuck script never holds a queue slot: prints a FAIL and exits. Default 170 s; 0 turns it off. */
export function deadline(ms = 170000) {
  if (watchdog) clearTimeout(watchdog);
  if (!ms) return;
  watchdog = setTimeout(() => {
    check(
      'deadline',
      false,
      'script still running after ' + Math.round(ms / 1000) + ' s; stopped',
    );
    console.log(
      tallies.pass +
        ' passed, ' +
        tallies.fail +
        ' failed, ' +
        tallies.skip +
        ' skipped',
    );
    try {
      _browser?.process?.()?.kill();
    } catch {}
    process.exit(1);
  }, ms);
  watchdog.unref?.();
}

// ---------- launch ----------
let _browser = null;
let _renderer = null;
const GPU_ARGS = [
  '--use-angle=d3d11',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
];
const SW_ARGS = [
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--ignore-gpu-blocklist',
];
// --disable-smooth-scrolling: the browser's own key and wheel scrolls land at once (the canonical qa-home-* scripts use it).
const BASE_ARGS = ['--mute-audio', '--disable-smooth-scrolling'];
const SOFTWARE = /swiftshader|basic render|llvmpipe|software|no webgl/i;

async function readRenderer(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const r = await page
    .evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return 'no webgl';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(
        ext
          ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
      );
    })
    .catch((e) => 'no webgl (' + String(e).slice(0, 80) + ')');
  await ctx.close();
  return r;
}

/**
 * Headless Chrome, muted, on the graphics card (d3d11). Reads the WebGL renderer back; when it is software
 * (Remote Desktop, a driver problem) it relaunches on SwiftShader and prints an INFO note.
 * opts: { gl: 'gpu'|'swiftshader' (default --gl), engine: 'chromium'|'webkit', headless, args: [] }
 * QA_KIT_GPU_EXTRA (space-separated) adds flags to the GPU attempt only: a way to test the fallback.
 */
export async function launch(opts = {}) {
  const engine = opts.engine ?? process.env.BROWSER ?? 'chromium';
  const headless = opts.headless ?? !args.has('headed');
  if (engine === 'webkit') {
    _browser = await pw.webkit.launch({ headless });
    _renderer = 'webkit';
    info(
      'renderer',
      'webkit (no CDP touch: tap uses the touchscreen, swipes are unavailable)',
    );
    _browser.__engine = 'webkit';
    return _browser;
  }
  const want = /^(swiftshader|software|sw)$/i.test(opts.gl ?? args.gl)
    ? 'swiftshader'
    : 'gpu';
  const extra = opts.args ?? [];
  if (want === 'gpu') {
    const gpuExtra = (process.env.QA_KIT_GPU_EXTRA || '')
      .split(' ')
      .filter(Boolean);
    const b = await pw.chromium.launch({
      channel: 'chrome',
      headless,
      args: [...BASE_ARGS, ...GPU_ARGS, ...gpuExtra, ...extra],
    });
    const r = await readRenderer(b);
    if (!SOFTWARE.test(r)) {
      _browser = b;
      _renderer = r;
      b.__engine = 'chromium';
      info('renderer', 'gpu ' + r);
      return b;
    }
    await b.close();
    info(
      'renderer',
      'FALLBACK to software: the GPU launch read "' +
        r +
        '"; relaunched on SwiftShader. Timing checks are not comparable with GPU runs; run one job at a time',
    );
  }
  _browser = await pw.chromium.launch({
    channel: 'chrome',
    headless,
    args: [...BASE_ARGS, ...SW_ARGS, ...extra],
  });
  _browser.__engine = 'chromium';
  _renderer = await readRenderer(_browser);
  info(
    'renderer',
    'software ' +
      _renderer +
      (want === 'swiftshader' ? ' (asked for with --gl=swiftshader)' : ''),
  );
  return _browser;
}
/** The renderer string read at launch. */
export const renderer = () => _renderer;

// ---------- profiles ----------
export const profiles = {
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};

function muteInit() {
  const p = HTMLMediaElement.prototype;
  const play = p.play;
  p.play = function (...a) {
    this.muted = true;
    this.volume = 0;
    return play.apply(this, a);
  };
}

/**
 * WebKit has no --mute-audio: every Web Audio connection to the speakers goes
 * through a gain of 0 instead, so a WebKit run is as silent as Chromium's.
 */
function webAudioMuteInit() {
  if (typeof AudioNode === 'undefined') return;
  const connect = AudioNode.prototype.connect;
  const silent = new WeakMap();
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (
      typeof AudioDestinationNode !== 'undefined' &&
      dest instanceof AudioDestinationNode
    ) {
      let gain = silent.get(dest.context);
      if (!gain) {
        gain = dest.context.createGain();
        gain.gain.value = 0;
        connect.call(gain, dest);
        silent.set(dest.context, gain);
      }
      connect.call(this, gain, ...rest);
      return dest;
    }
    return connect.call(this, dest, ...rest);
  };
}

/** The base URL plus a path and an optional query (string "?a=1" or object). */
export function url(path = '/', query) {
  const u = new URL(path, BASE + '/');
  if (typeof query === 'string') {
    const q = query.replace(/^\?/, '');
    if (q) u.search = (u.search ? u.search + '&' : '?') + q;
  } else if (query)
    for (const [k, v] of Object.entries(query))
      u.searchParams.set(k, String(v));
  return u.toString();
}

/** Clicks the cookie banner's "Reject" if it shows within timeout. Returns whether it clicked. */
export async function rejectCookies(page, timeout = 8000) {
  const b = page.getByRole('button', { name: 'Reject', exact: true });
  return b
    .waitFor({ state: 'visible', timeout })
    .then(() => b.click())
    .then(() => true)
    .catch(() => false);
}

/**
 * A new context + page on a profile, navigated to path. Returns a session s with
 * { ctx, page, cdp, size, errors, failed, ...input helpers }.
 * opts: { query, before(ctx, page) (runs before the first load: signInLocal, s.logEvents init), init: [fn] (more init
 *         scripts), context: {} (extra context options), reject: true|false|ms, wait: 'load', navigate: true }
 */
export async function open(browser, size, path = '/', opts = {}) {
  if (!profiles[size]) throw new Error('qa-kit: unknown profile ' + size);
  const ctx = await browser.newContext({
    ...profiles[size],
    ...(browser.__engine === 'webkit' ? { isMobile: false } : {}),
    ...(opts.context ?? {}),
  });
  await ctx.addInitScript(muteInit);
  if (browser.__engine === 'webkit') await ctx.addInitScript(webAudioMuteInit);
  for (const f of opts.init ?? []) await ctx.addInitScript(f);
  const page = await ctx.newPage();
  const s = { ctx, page, size, errors: [], failed: [], cdp: null, browser };
  page.on('pageerror', (e) => s.errors.push(one(String(e)).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error')
      s.errors.push('console: ' + one(m.text()).slice(0, 300));
  });
  page.on('requestfailed', (r) => {
    const t = r.failure()?.errorText ?? '';
    if (!/ERR_ABORTED/.test(t)) s.failed.push(t + ' ' + r.url().slice(0, 160));
  });
  page.on('response', (r) => {
    if (r.status() >= 400)
      s.failed.push(r.status() + ' ' + r.url().slice(0, 160));
  });
  if (profiles[size].hasTouch && browser.__engine !== 'webkit')
    s.cdp = await ctx.newCDPSession(page);
  bindInput(s);
  if (opts.before) await opts.before(ctx, page, s);
  if (opts.navigate !== false) await s.goto(path, opts);
  return s;
}

// ---------- input ----------
const pause = (page, ms) => page.waitForTimeout(ms);
async function touch(s, type, pts) {
  await s.cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })),
  });
}
function needTouch(s, what) {
  if (!s.cdp)
    throw new Error(
      'qa-kit: ' + what + ' needs CDP touch (phone profile on Chromium)',
    );
}

function bindInput(s) {
  const { page } = s;
  /** Navigates within the base; clicks "Reject" unless reject:false. */
  s.goto = async (path = '/', o = {}) => {
    await page.goto(url(path, o.query), { waitUntil: o.wait ?? 'load' });
    if (o.reject !== false)
      await rejectCookies(page, typeof o.reject === 'number' ? o.reject : 8000);
  };
  /** A tap: CDP touch on the phone (touchStart, hold, touchEnd), a mouse click on the desktop. */
  s.tap = async (x, y, { hold = 60 } = {}) => {
    if (s.cdp) {
      await touch(s, 'touchStart', [[x, y]]);
      await pause(page, hold);
      await touch(s, 'touchEnd', []);
    } else if (s.browser.__engine === 'webkit' && profiles[s.size].hasTouch)
      await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
  };
  /** A finger drag from (x0,y0) to (x1,y1): steps moves, dt ms apart, then hold ms still before lifting (0 = lift at once). */
  s.swipe = async (x0, y0, x1, y1, { steps = 8, dt = 16, hold = 0 } = {}) => {
    needTouch(s, 'swipe');
    await touch(s, 'touchStart', [[x0, y0]]);
    for (let i = 1; i <= steps; i++) {
      await touch(s, 'touchMove', [
        [x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps],
      ]);
      await pause(page, dt);
    }
    if (hold) await pause(page, hold);
    await touch(s, 'touchEnd', []);
  };
  /** A fast flick: few moves, short gaps, lifted while moving. */
  s.fling = (x0, y0, x1, y1, { steps = 4, dt = 8 } = {}) =>
    s.swipe(x0, y0, x1, y1, { steps, dt, hold: 0 });
  /** A diagonal swipe from the viewport centre: dx, dy in px (e.g. 120, -220 = up and right). */
  s.diagonal = (dx, dy, o = {}) => {
    const { width, height } = page.viewportSize();
    const x = width / 2,
      y = height / 2;
    return s.swipe(x - dx / 2, y - dy / 2, x + dx / 2, y + dy / 2, o);
  };
  /** Two fingers apart (pinch out) or together (spread < 0) around (x, y). */
  s.pinch = async (x, y, spread = 40, { steps = 4, dt = 16 } = {}) => {
    needTouch(s, 'pinch');
    await touch(s, 'touchStart', [
      [x - 50, y],
      [x + 50, y],
    ]);
    for (let i = 1; i <= steps; i++) {
      const d = 50 + (spread * i) / steps;
      await touch(s, 'touchMove', [
        [x - d, y],
        [x + d, y],
      ]);
      await pause(page, dt);
    }
    await touch(s, 'touchEnd', []);
  };
  /** Mouse wheel at (x, y) (default: viewport centre). dy > 0 scrolls down, dx > 0 right. One notch = 120. */
  s.wheel = async (dy, dx = 0, at) => {
    const { width, height } = page.viewportSize();
    const [x, y] = at ?? [width / 2, height / 2];
    await page.mouse.move(x, y);
    await page.mouse.wheel(dx, dy);
  };
  /** Sideways wheel: dx > 0 right. */
  s.wheelX = (dx, at) => s.wheel(0, dx, at);
  /** Presses keys in order, gap ms apart: s.keys('ArrowDown', 'End'). */
  s.keys = async (...ks) => {
    for (const k of ks) {
      await page.keyboard.press(k);
      await pause(page, 120);
    }
  };
  /** A mouse drag with the button held: steps moves dt ms apart, hold ms before release (0 = a mouse fling). */
  s.drag = async (x0, y0, x1, y1, { steps = 12, dt = 16, hold = 0 } = {}) => {
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(
        x0 + ((x1 - x0) * i) / steps,
        y0 + ((y1 - y0) * i) / steps,
      );
      await pause(page, dt);
    }
    if (hold) await pause(page, hold);
    await page.mouse.up();
  };
  /** The visitor's "next/previous" gesture: one swipe on a touch profile, one wheel notch on the desktop. dir 1 = down. */
  s.step = async (dir = 1) => {
    const { width, height } = page.viewportSize();
    if (s.cdp) {
      const x = width / 2,
        a = height * 0.7,
        b = height * 0.45;
      return dir > 0 ? s.swipe(x, a, x, b) : s.swipe(x, b, x, a);
    }
    return s.wheel(dir * 120);
  };
  /** Polls a page function until it returns truthy. */
  s.waitPage = (fn, arg, { timeout = 10000, label = 'page condition' } = {}) =>
    page.waitForFunction(fn, arg, { timeout, polling: 100 }).catch((e) => {
      throw new Error('timeout waiting for ' + label + ' (' + timeout + ' ms)');
    });
  /** Waits until scrollY and the given values (a page function's JSON) hold still for quiet ms. Returns the last value. */
  s.settle = (o = {}) => settle(s, o);
  /** Waits n animation frames. */
  s.frames = (n = 2) =>
    page.evaluate(
      (n) =>
        new Promise((r) => {
          let i = 0;
          const f = () => (++i >= n ? r() : requestAnimationFrame(f));
          requestAnimationFrame(f);
        }),
      n,
    );
  s.hitTest = (x, y, depth) => hitTest(page, x, y, depth);
  s.logEvents = (types) => logEvents(s, types);
  s.readEvents = () => readEvents(page);
  s.capture = (label, o) => capture(s, label, o);
  /** "PASS no-page-errors [size]" unless the page threw or logged console errors. */
  s.checkNoErrors = (name = 'no-page-errors') =>
    check(
      name + ' [' + s.size + ']',
      s.errors.length === 0,
      s.errors.length
        ? s.errors.length + ': ' + s.errors.slice(0, 3).join(' | ')
        : 'none',
    );
}

// ---------- waits ----------
/** Polls fn() (Node side, may be async) every interval ms until truthy; returns the value or throws "timeout waiting for label". */
export async function waitFor(
  fn,
  { timeout = 10000, interval = 100, label = 'condition' } = {},
) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('timeout waiting for ' + label + ' (' + timeout + ' ms)');
}
/**
 * Waits for the page to rest: scrollX/scrollY (plus read(), a page function returning JSON, when given) unchanged
 * for quiet ms, sampled every 100 ms, up to timeout. Returns { settled, ms, value }.
 */
export async function settle(s, { quiet = 300, timeout = 6000, read } = {}) {
  const t0 = Date.now();
  let last = null;
  let since = Date.now();
  let v;
  while (Date.now() - t0 < timeout) {
    // two reads, no eval: pages with a strict CSP still work
    const xy = await s.page.evaluate(() => [
      Math.round(scrollX),
      Math.round(scrollY),
    ]);
    v = JSON.stringify([...xy, read ? await s.page.evaluate(read) : null]);
    if (v !== last) {
      last = v;
      since = Date.now();
    } else if (Date.now() - since >= quiet)
      return { settled: true, ms: Date.now() - t0, value: JSON.parse(v)[2] };
    await s.page.waitForTimeout(100);
  }
  return {
    settled: false,
    ms: Date.now() - t0,
    value: v ? JSON.parse(v)[2] : null,
  };
}

// ---------- diagnosis ----------
/** What is under (x, y): the element chain from the hit up (depth levels), each as tag[data-*][class]. */
export function hitTest(page, x, y, depth = 5) {
  return page.evaluate(
    ([x, y, depth]) => {
      const desc = (n) =>
        n.tagName.toLowerCase() +
        (n.id ? '#' + n.id : '') +
        [...n.attributes]
          .filter(
            (a) =>
              a.name.startsWith('data-') ||
              a.name === 'aria-label' ||
              a.name === 'href',
          )
          .map(
            (a) =>
              '[' + a.name + (a.value ? '=' + a.value.slice(0, 24) : '') + ']',
          )
          .join('');
      const out = [];
      let n = document.elementFromPoint(x, y);
      for (let i = 0; n && i < depth; i++, n = n.parentElement)
        out.push(desc(n));
      return out;
    },
    [x, y, depth],
  );
}
const LOG_TYPES = [
  'pointerdown',
  'pointerup',
  'pointercancel',
  'click',
  'touchstart',
  'touchmove',
  'touchend',
  'wheel',
  'keydown',
  'focusin',
];
function eventLoggerInit(types) {
  if (window.__qaLog) return;
  const L = (window.__qaLog = []);
  const desc = (n) =>
    !n || !n.tagName
      ? String(n && n.nodeName)
      : n.tagName.toLowerCase() +
        [...n.attributes]
          .filter((a) => a.name.startsWith('data-'))
          .map((a) => '[' + a.name + ']')
          .join('');
  for (const t of types) {
    addEventListener(
      t,
      (e) =>
        L.push({
          t,
          target: desc(e.target),
          ts: Math.round(performance.now()),
          x: e.clientX ?? e.touches?.[0]?.clientX,
          y: e.clientY ?? e.touches?.[0]?.clientY,
          key: e.key,
        }),
      true,
    );
    addEventListener(
      t,
      (e) => {
        if (e.defaultPrevented) L.push({ t, cancelled: true });
      },
      false,
    );
  }
  const pd = Event.prototype.preventDefault;
  Event.prototype.preventDefault = function () {
    if (types.includes(this.type))
      L.push({
        t: this.type,
        preventDefault: (new Error().stack || '')
          .split('\n')
          .slice(2, 4)
          .map((x) => x.trim())
          .join(' | '),
      });
    return pd.call(this);
  };
}
/** Logs the given event types (capture phase on window, plus who called preventDefault). Call in open({before}) to catch the first load too. */
export async function logEvents(s, types = LOG_TYPES) {
  await s.ctx.addInitScript(eventLoggerInit, types);
  await s.page.evaluate(eventLoggerInit, types).catch(() => {});
}
/** The logged events since the last read (and clears them). */
export const readEvents = (page) =>
  page.evaluate(() => {
    const l = window.__qaLog ?? [];
    window.__qaLog && (window.__qaLog = []);
    return l;
  });

// ---------- frames ----------
const frames = [];
/** A CSS-pixel screenshot kept for the contact sheet (and written to OUT as <size>-<nn>-<label>.png). */
export async function capture(s, label, { file = true } = {}) {
  const buf = await s.page.screenshot({ scale: 'css' });
  const n = String(frames.length).padStart(2, '0');
  const lab = '[' + s.size + '] ' + label;
  if (file)
    writeFileSync(
      join(
        OUT,
        s.size +
          '-' +
          n +
          '-' +
          one(label)
            .replace(/[^\w.-]+/g, '_')
            .slice(0, 60) +
          '.png',
      ),
      buf,
    );
  trace('frame ' + lab);
  frames.push({ label: lab, buf, w: s.page.viewportSize().width });
  return lab;
}
/** Writes ONE labelled contact sheet PNG of every frame captured so far (default OUT/SHEET.png). Returns the path. */
export async function sheet(
  path = join(OUT, 'SHEET.png'),
  { width = 240, cols = 6 } = {},
) {
  if (!_browser) throw new Error('qa-kit: sheet() needs launch() first');
  if (!frames.length) return null;
  const ctx = await _browser.newContext({
    viewport: { width: cols * (width + 10) + 10, height: 400 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html =
    '<body style="margin:0;background:#1b1b1b;color:#eee;font:12px/1.3 Segoe UI,sans-serif;display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px;padding:10px">' +
    '<div style="width:100%;font-size:13px">' +
    esc(
      BASE +
        '  |  renderer: ' +
        (_renderer ?? '?') +
        '  |  ' +
        new Date().toISOString(),
    ) +
    '</div>' +
    frames
      .map(
        (f, i) =>
          '<figure style="margin:0;width:' +
          width +
          'px"><figcaption style="min-height:32px">' +
          i +
          '. ' +
          esc(f.label) +
          '</figcaption><img style="width:' +
          width +
          'px;display:block" src="data:image/png;base64,' +
          f.buf.toString('base64') +
          '"></figure>',
      )
      .join('') +
    '</body>';
  await page.setContent(html, { waitUntil: 'load' });
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
  await ctx.close();
  info('sheet', path.replace(/\\/g, '/') + ' (' + frames.length + ' frames)');
  return path;
}

// ---------- local sign-in ----------
/**
 * Sets a session cookie on the context, ONLY when the kit's base is localhost or 127.0.0.1 (never 4320). Throws
 * otherwise: signing in on the live site is forbidden. Call it in open({ before: (ctx) => qa.signInLocal(ctx, {...}) }).
 */
export async function signInLocal(
  context,
  { cookie, value, path = '/', httpOnly = true } = {},
) {
  assertLocalBase(BASE);
  if (!cookie || !value)
    throw new Error('qa-kit: signInLocal needs { cookie, value }');
  await context.addCookies([
    {
      name: cookie,
      value,
      domain: baseUrl.hostname,
      path,
      httpOnly,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
}
/** Throws unless base is a local host on a port other than 4320. Exported for tests. */
export function assertLocalBase(base) {
  const u = new URL(base);
  if (!['localhost', '127.0.0.1'].includes(u.hostname))
    throw new Error(
      'qa-kit: signInLocal refused: ' +
        u.host +
        ' is not localhost or 127.0.0.1',
    );
  if (u.port === '4320')
    throw new Error("qa-kit: signInLocal refused: 4320 is the owner's link");
}

// ---------- the 3D stage (/home-preview and the pack stage) ----------
/** Helpers that know window.__packStage. Keep page-specific reads here so the rest stays page-agnostic. */
export const stage = {
  /** The query that skips the loader and exposes the debug handle. */
  query: '?debug=1&loader=never',
  /** Waits until the stage is ready, has a focus state and the flow is on, then 800 ms more. */
  async ready(s, timeout = 40000) {
    await s.waitPage(
      () =>
        window.__packStage?.ready?.() &&
        window.__packStage.focus?.() !== null &&
        window.__packStage.flow?.().on,
      null,
      { timeout, label: 'stage ready' },
    );
    await s.page.waitForTimeout(800);
  },
  /** Opens /home-preview (or path) on the stage query and waits for ready. */
  async open(browser, size, path = '/home-preview', o = {}) {
    const s = await open(browser, size, path, { query: stage.query, ...o });
    await stage.ready(s);
    return s;
  },
  /** One reading: address, scroll, focus on/index/past, the open block, the flow's stops. */
  snap: (s) =>
    s.page.evaluate(() => {
      const ps = window.__packStage;
      const f = ps?.focus?.() ?? null;
      const fl = ps?.flow?.() ?? null;
      const sec = document.querySelector(
        '[data-testid="focus-stops"] section[data-on]',
      );
      return {
        path: location.pathname + location.search,
        len: history.length,
        y: Math.round(scrollY),
        on: !!f?.on,
        focus: f?.on ? f.focus : 0,
        past: !!f?.past,
        block: f?.on ? (sec?.getAttribute('data-kind') ?? null) : null,
        busy: !!fl?.busy,
        stops: (fl?.stops ?? []).map(Math.round),
      };
    }),
  /** Waits for the flow to rest: not busy and scrollY still for 3 samples. Returns snap. */
  async rest(s, timeout = 7000) {
    const t0 = Date.now();
    let last = null;
    let still = 0;
    while (Date.now() - t0 < timeout) {
      const r = await stage.snap(s);
      if (!r.busy && last && Math.abs(r.y - last.y) < 0.5) still++;
      else still = 0;
      last = r;
      if (still >= 3) break;
      await s.page.waitForTimeout(100);
    }
    await s.page.waitForTimeout(200);
    return stage.snap(s);
  },
  onStop: (r) => r.stops.some((v) => Math.abs(v - r.y) < 2),
  /** The smallest stop below (dir 1) or above (dir -1) the reading's scroll, or null. */
  nextStop: (r, dir = 1) => {
    const c = r.stops.filter((v) => (dir > 0 ? v > r.y + 1 : v < r.y - 1));
    return c.length ? (dir > 0 ? Math.min(...c) : Math.max(...c)) : null;
  },
  /** The visible lineup tiles: { id, x, y, w, vis } at the art's centre. */
  tiles: (s) =>
    s.page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '[data-stage-panel]:not([hidden]) [data-stage-tile][data-pack-id] [data-stage-art]',
        ),
      ].map((a) => {
        const b = a.getBoundingClientRect();
        return {
          id: a.closest('[data-pack-id]').getAttribute('data-pack-id'),
          x: Math.round(b.x + b.width / 2),
          y: Math.round(b.y + b.height / 2),
          w: Math.round(b.width),
          vis: b.right > 0 && b.left < innerWidth && b.width > 0,
        };
      }),
    ),
  /** The visible tile nearest the viewport's horizontal centre. */
  async centreTile(s) {
    const w = s.page.viewportSize().width;
    const t = (await stage.tiles(s)).filter((t) => t.vis);
    return (
      t.reduce(
        (a, b) => (Math.abs(b.x - w / 2) < Math.abs(a.x - w / 2) ? b : a),
        t[0],
      ) ?? null
    );
  },
};
