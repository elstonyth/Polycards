// Resilience QA for the full-page flow on /home-preview, on the production server with
// HOME_PREVIEW=1. Headless, muted (--mute-audio where the engine takes it,
// plus a media guard), logged out; only the cookie banner's "Reject" is ever
// clicked.
//
//   node scripts/qa-home-resilience.mjs [baseUrl] [--only=phone|desktop]
//        [--part=rotate,height,keys,touch,reduced,nojs,lap,trim,touchcancel]
//   BROWSER=webkit node scripts/qa-home-resilience.mjs ...
//
// Writes frames and a JSON log to QA_OUT (default
// docs/research/home-3d/full-flow/checkpoints/wp8/qa).
//
// Checks (each prints PASS, FAIL, PENDING or SKIP with a stable name):
// - rotate: 390x844 to 844x390 and back (desktop: 1440x900 to 1024x700 and
//   back) at the row, each detail stop, the lineup and half-way through the
//   free part. After each change the scroll is on the same rest (or the same
//   place in the same free section), the same pack is focused, the stop text
//   is the same block, and the 3D agrees: the stage's focus, spin and exit
//   values equal the rest's, and the canvas keeps its box's aspect.
// - height: the same at a height-only change 844 to 760 (desktop 900 to 760).
// - keys: a full pass with every key in the plan's key table, down and back.
// - touch (phone): a tap and a reverse swipe during a glide do not freeze the
//   page; diagonal swipes end on a rest in both axes. (desktop) a wheel
//   during a glide is swallowed and the next one still pages.
// - reduced: a plain document ending with the footer; a tap opens the pack.
// - nojs: exactly one footer and no spacer with height.
// - lap: a turn of the phone at the rise, in Return and at Last keeps the
//   lap's place; End and PageDown at Last wrap to the row.
// - trim: scrolling normally (wheel notches, or one-finger swipes) through
//   every stop and the lineup's exit to the middle of the free span, only the
//   chosen pack is kept (lap.trim, at most one pack drawn) and, on the phone,
//   the GPU estimate's peak stays under 40 MB; scrolling back up to the exit
//   restores the row (no trim, more than one pack drawn).
// - touchcancel (phone): a drag ended by touchCancel at a stop leaves the page
//   on that stop; in the free span it leaves no glide.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';

const args = process.argv.slice(2);
const BASE =
  args.find((a) => !a.startsWith('--')) ??
  process.env.PW_BASE ??
  'http://localhost:4300';
const ONLY = (args.find((a) => a.startsWith('--only=')) ?? '=').split('=')[1];
const PARTS = (args.find((a) => a.startsWith('--part=')) ?? '=')
  .split('=')[1]
  .split(',')
  .filter(Boolean);
const part = (p) => PARTS.length === 0 || PARTS.includes(p);
const ENGINE = process.env.BROWSER === 'webkit' ? 'webkit' : 'chromium';
const OUT =
  process.env.QA_OUT ??
  'docs/research/home-3d/full-flow/checkpoints/wp8/qa' +
    (ENGINE === 'webkit' ? '-webkit' : '');
const SLUG = '151';
const PREVIEW = '/home-preview';
mkdirSync(OUT, { recursive: true });

const results = [];
const report = (name, status, detail) => {
  const s = status === true ? 'PASS' : status === false ? 'FAIL' : status;
  results.push({ name, status: s, detail });
  console.log(s + ' ' + name + ': ' + detail);
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
    isMobile: ENGINE === 'chromium',
    hasTouch: true,
  },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};
/** The turned size and the height-only size, per profile. */
const TURNED = {
  phone: { width: 844, height: 390 },
  desktop: { width: 1024, height: 700 },
};
const SHORT = {
  phone: { width: 390, height: 760 },
  desktop: { width: 1440, height: 760 },
};

const browser =
  ENGINE === 'webkit'
    ? await webkit.launch()
    : await chromium.launch({
        channel: 'chrome',
        // QA_GL=swiftshader (or the older RENDERER=software): SwiftShader;
        // default: the graphics card (d3d11)
        args: [
          '--mute-audio',
          '--disable-smooth-scrolling',
          ...(process.env.QA_GL === 'swiftshader' ||
          process.env.RENDERER === 'software'
            ? ['--enable-unsafe-swiftshader', '--use-angle=swiftshader']
            : ['--use-angle=d3d11', '--enable-gpu']),
          ...(process.env.QA_NETLOG
            ? ['--log-net-log=' + process.env.QA_NETLOG]
            : []),
          '--ignore-gpu-blocklist',
        ],
      });

async function open(size, extra = {}) {
  const ctx = await browser.newContext({ ...PROFILES[size], ...extra });
  await ctx.addInitScript(mute);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  const cdp =
    size === 'phone' && ENGINE === 'chromium'
      ? await ctx.newCDPSession(page)
      : null;
  return { ctx, page, cdp, size };
}

async function reject(page) {
  const b = page.getByRole('button', { name: 'Reject', exact: true });
  await b
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => b.click())
    .catch(() => {});
}

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

async function load(s) {
  await s.page.goto(BASE + PREVIEW + '?stage=3d&debug=1&loader=never', {
    waitUntil: 'load',
  });
  await reject(s.page);
  await ready(s.page);
}

/** Everything one assertion needs: the scroll, the flow, the focus, the 3D. */
const probe = (page) =>
  page.evaluate(() => {
    const ps = window.__packStage;
    const f = ps?.focus?.() ?? null;
    const fl = ps?.flow?.() ?? null;
    const sec = document.querySelector(
      '[data-testid="focus-stops"] section[data-on]',
    );
    const cv = [...document.querySelectorAll('canvas')].find(
      (c) => c.clientWidth > 0 && c.clientHeight > 0,
    );
    const root =
      document.querySelector('[data-home-flow]') ??
      document.querySelector('[data-flow-spacer]')?.parentElement ??
      null;
    const mid = innerHeight / 2;
    let anchor = null;
    for (const el of document.querySelectorAll('[data-flow-section]')) {
      const r = el.getBoundingClientRect();
      if (r.top <= mid && r.bottom > mid)
        anchor = {
          name: el.getAttribute('data-flow-section'),
          frac: Math.round(((mid - r.top) / r.height) * 1000) / 1000,
          top: Math.round(r.top),
        };
    }
    const st = ps?.state ?? {};
    return {
      y: Math.round(scrollY * 10) / 10,
      x: scrollX,
      vw: innerWidth,
      vh: innerHeight,
      max: document.documentElement.scrollHeight - innerHeight,
      flowOn: !!fl?.on,
      busy: !!fl?.busy,
      stops: (fl?.stops ?? []).map((v) => Math.round(v * 10) / 10),
      exitEnd: fl?.table?.exitEnd ?? null,
      edge: fl?.table?.edge ?? null,
      rise: fl?.table?.rise ?? null,
      ret: fl?.table?.ret ?? null,
      lastTop: fl?.table?.lastTop ?? null,
      lap: fl?.lap ?? null,
      on: !!f?.on,
      focus: f?.on ? f.focus : 0,
      past: !!f?.past,
      kinds: f?.kinds ?? [],
      block: f?.on ? (sec?.getAttribute('data-kind') ?? null) : null,
      sFocus: st.focus ?? null,
      sSpin: st.spin ?? null,
      sExit: st.exit ?? null,
      id: st.focusOn?.id ?? null,
      track: st.track ?? null,
      line: fl?.line ?? null,
      free: root ? root.hasAttribute('data-flow-free') : null,
      canvas: cv
        ? {
            cw: cv.clientWidth,
            ch: cv.clientHeight,
            bw: cv.width,
            bh: cv.height,
          }
        : null,
      anchor,
      path: location.pathname,
    };
  });

/** The rest index the scroll is on (-1: off every rest). */
const restIndex = (p) => {
  for (let k = 0; k < p.stops.length; k++)
    if (Math.abs(p.stops[k] - p.y) < 1) return k;
  return -1;
};

async function rest(page, timeout = 7000) {
  const t0 = Date.now();
  let last = null;
  let still = 0;
  while (Date.now() - t0 < timeout) {
    const s = await probe(page);
    const lineBusy = !!(s.line && (s.line.moving || s.line.pending));
    if (!s.busy && !lineBusy && last && Math.abs(s.y - last.y) < 0.5) still++;
    else still = 0;
    last = s;
    if (still >= 3) break;
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(150);
  return probe(page);
}

async function swipe(s, x0, y0, x1, y1, steps = 8) {
  const { cdp, page } = s;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: x0, y: y0 }],
  });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps },
      ],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
}

async function tap(s, x, y) {
  await s.cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  await s.cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
}

async function key(page, k) {
  await page.keyboard.press(k);
  await page.waitForTimeout(120);
  return rest(page);
}

const shot = (page, name) =>
  page.screenshot({ path: OUT + '/' + name + '.png' });
const near = (a, b, e = 0.01) =>
  a !== null && b !== null && Math.abs(a - b) <= e;

/** What the stage must show at rest index k (n detail stops). */
function expectAt(p, k) {
  const n = p.stops.length - 2;
  const bad = [];
  if (k < 0) return ['off every rest (scrollY ' + p.y + ')'];
  if (p.x !== 0) bad.push('scrollX ' + p.x);
  if (k === 0) {
    if (p.on) bad.push('focused at the row');
    if (!near(p.sFocus ?? 0, 0)) bad.push('state.focus ' + p.sFocus);
  } else if (k <= n) {
    if (!p.on) bad.push('not focused');
    if (!near(p.focus, k)) bad.push('focus ' + p.focus + ' (want ' + k + ')');
    if (!near(p.sFocus, k)) bad.push('state.focus ' + p.sFocus);
    if (!near(p.sSpin ?? 0, 0)) bad.push('state.spin ' + p.sSpin);
    if (p.block !== p.kinds[k - 1])
      bad.push('block ' + p.block + ' (want ' + p.kinds[k - 1] + ')');
  } else {
    if (!near(p.sSpin, 1)) bad.push('state.spin ' + p.sSpin + ' (want 1)');
    if (!near(p.sFocus, n)) bad.push('state.focus ' + p.sFocus);
    if (!p.past) bad.push('not past');
  }
  if (p.canvas && p.canvas.bh > 0 && p.canvas.ch > 0) {
    const a = p.canvas.bw / p.canvas.bh;
    const b = p.canvas.cw / p.canvas.ch;
    if (Math.abs(a - b) / b > 0.03)
      bad.push(
        'canvas ' +
          p.canvas.bw +
          'x' +
          p.canvas.bh +
          ' in a ' +
          p.canvas.cw +
          'x' +
          p.canvas.ch +
          ' box',
      );
  }
  return bad;
}

const label = (p, k) => {
  const n = p.stops.length - 2;
  return k === 0
    ? 'row'
    : k <= n
      ? 'stop' + k + '-' + p.kinds[k - 1]
      : 'lineup';
};

/** Walks from a fresh load down to rest k with ArrowDown. */
async function walkTo(s, k) {
  await load(s);
  let p = await rest(s.page);
  for (let i = 0; i < k; i++) p = await key(s.page, 'ArrowDown');
  return p;
}

/**
 * One viewport change and back, at the current rest: the state before, after
 * the change and after the way back must agree.
 */
async function changeAt(s, kind, to, tag) {
  const { page, size } = s;
  const from = PROFILES[size].viewport;
  const p0 = await rest(page);
  const k0 = restIndex(p0);
  const name = kind + '-' + tag + '-' + size;
  await shot(page, name + '-0-before');
  await page.setViewportSize(to);
  await page.waitForTimeout(400);
  const p1 = await rest(page);
  await page.waitForTimeout(400);
  const q1 = await probe(page);
  await shot(page, name + '-1-changed');
  await page.setViewportSize(from);
  await page.waitForTimeout(400);
  await rest(page);
  await page.waitForTimeout(400);
  const q2 = await probe(page);
  await shot(page, name + '-2-back');
  const bad = [];
  const check = (q, when) => {
    const k = restIndex(q);
    if (k !== k0)
      bad.push(
        when +
          ': rest ' +
          k +
          ' (was ' +
          k0 +
          '), scrollY ' +
          q.y +
          ' stops ' +
          q.stops.join('/'),
      );
    if (q.id !== p0.id)
      bad.push(when + ': focused ' + q.id + ' (was ' + p0.id + ')');
    if (q.block !== p0.block)
      bad.push(when + ': block ' + q.block + ' (was ' + p0.block + ')');
    for (const b of expectAt(q, k)) bad.push(when + ': ' + b);
  };
  check(q1, 'changed');
  check(q2, 'back');
  log.push({ name, p0, p1, q1, q2 });
  report(
    name,
    bad.length === 0,
    bad.join('; ') ||
      'rest ' + k0 + ', ' + p0.id + ', block ' + p0.block + ' kept both ways',
  );
  return bad.length === 0;
}

/** The same in the free part: the same section under the viewport's middle. */
async function changeFree(s, kind, to) {
  const { page, size } = s;
  const from = PROFILES[size].viewport;
  const name = kind + '-free-middle-' + size;
  const p0 = await probe(page);
  await shot(page, name + '-0-before');
  await page.setViewportSize(to);
  await page.waitForTimeout(400);
  await rest(page);
  await page.waitForTimeout(400);
  const q1 = await probe(page);
  await shot(page, name + '-1-changed');
  await page.setViewportSize(from);
  await page.waitForTimeout(400);
  await rest(page);
  await page.waitForTimeout(400);
  const q2 = await probe(page);
  await shot(page, name + '-2-back');
  const bad = [];
  const check = (q, when) => {
    if (!q.flowOn) bad.push(when + ': flow off');
    if (q.exitEnd !== null && q.y < q.exitEnd - 1)
      bad.push(
        when +
          ': left the free part (scrollY ' +
          q.y +
          ', exit end ' +
          q.exitEnd +
          ')',
      );
    if (!q.free) bad.push(when + ': panel not in its free state');
    if (q.id !== p0.id)
      bad.push(when + ': focused ' + q.id + ' (was ' + p0.id + ')');
    if (!q.anchor || !p0.anchor || q.anchor.name !== p0.anchor.name)
      bad.push(
        when +
          ': section ' +
          (q.anchor?.name ?? 'none') +
          ' under the middle (was ' +
          (p0.anchor?.name ?? 'none') +
          ')',
      );
    else if (Math.abs(q.anchor.frac - p0.anchor.frac) > 0.1)
      bad.push(
        when +
          ': ' +
          q.anchor.name +
          ' at ' +
          q.anchor.frac +
          ' (was ' +
          p0.anchor.frac +
          ')',
      );
  };
  check(q1, 'changed');
  check(q2, 'back');
  log.push({ name, p0, q1, q2 });
  report(
    name,
    bad.length === 0,
    bad.join('; ') ||
      p0.anchor?.name + ' at ' + p0.anchor?.frac + ' kept both ways',
  );
}

/** From a fresh load to half-way through the free part. */
async function toFreeMiddle(s) {
  const { page } = s;
  await load(s);
  await rest(page);
  await key(page, 'End');
  let p = await key(page, 'ArrowDown');
  // the middle of the free span (between the exit end and the rise)
  const target = p.rise
    ? (p.exitEnd + p.rise.start) / 2
    : p.exitEnd + (p.max - p.exitEnd) / 2;
  await page.evaluate((y) => window.scrollTo(0, y), target);
  await page.waitForTimeout(600);
  p = await rest(page);
  return p;
}

async function viewportPart(size, kind) {
  const to = kind === 'rotate' ? TURNED[size] : SHORT[size];
  const s = await open(size);
  let p = await walkTo(s, 0);
  let total = 2;
  for (let k = 0; k < total; k++) {
    if (k > 0) p = await key(s.page, 'ArrowDown');
    if (restIndex(p) !== k) p = await walkTo(s, k);
    if (k > 0) total = Math.max(total, p.stops.length);
    const ok = await changeAt(s, kind, to, label(p, k));
    if (!ok) p = await walkTo(s, k);
    else p = await rest(s.page);
  }
  await toFreeMiddle(s);
  await changeFree(s, kind, to);
  report(
    'errors-' + kind + '-' + size,
    s.page.errors.length === 0,
    s.page.errors.join(' | ') || 'none',
  );
  await s.ctx.close();
}

/** Every key in the plan's key table (2.10), down and back. */
async function keysPart(size) {
  const s = await open(size);
  const { page } = s;
  await load(s);
  let p = await rest(page);
  let n = 0;
  const steps = [];
  const step = async (k, want, note = '') => {
    p = await key(page, k);
    const at = restIndex(p);
    const bad =
      at === want
        ? expectAt(p, at)
        : ['rest ' + at + ' (want ' + want + '), scrollY ' + p.y];
    steps.push({ key: k, want, at, y: p.y, block: p.block, bad, note });
    return bad.length === 0;
  };
  // down: one of each "next" key, then ArrowDown to the lineup
  const downKeys = ['ArrowDown', 'PageDown', ' '];
  await step('ArrowDown', 1);
  n = p.stops.length - 2;
  for (let k = 2; k <= n + 1; k++)
    await step(downKeys[k - 1] ?? 'ArrowDown', k);
  // the pick at the lineup
  const i0 = p.track;
  p = await key(page, 'ArrowRight');
  const iR = p.track;
  p = await key(page, 'ArrowLeft');
  const iL = p.track;
  const pickOk =
    i0 !== null &&
    iR !== i0 &&
    iR !== null &&
    iL === i0 &&
    restIndex(p) === n + 1;
  steps.push({
    key: 'ArrowRight/ArrowLeft',
    want: n + 1,
    at: restIndex(p),
    y: p.y,
    bad: pickOk ? [] : ['line ' + i0 + ' -> ' + iR + ' -> ' + iL],
    note: 'pick',
  });
  // into the free part and the browser's own keys there
  p = await key(page, 'ArrowDown');
  const inFree = p.exitEnd !== null && Math.abs(p.y - p.exitEnd) < 1;
  steps.push({
    key: 'ArrowDown',
    want: 'exit end',
    at: p.y,
    y: p.y,
    bad: inFree ? [] : ['scrollY ' + p.y + ' (exit end ' + p.exitEnd + ')'],
    note: 'exit',
  });
  const yA = p.y;
  p = await key(page, 'PageDown');
  const yB = p.y;
  steps.push({
    key: 'PageDown',
    want: 'native',
    at: yB,
    y: yB,
    bad: yB > yA + 10 ? [] : ['scroll ' + yA + ' -> ' + yB],
    note: 'free',
  });
  p = await key(page, 'PageUp');
  steps.push({
    key: 'PageUp',
    want: 'native',
    at: p.y,
    y: p.y,
    bad: p.y < yB - 10 ? [] : ['scroll ' + yB + ' -> ' + p.y],
    note: 'free',
  });
  // back up into the paged part with the browser's own keys: the snap brings
  // the page to the lineup
  for (let i = 0; i < 4 && restIndex(p) !== n + 1; i++)
    p = await key(page, 'PageUp');
  await page.waitForTimeout(800);
  p = await rest(page);
  steps.push({
    key: 'PageUp (to the paged part)',
    want: n + 1,
    at: restIndex(p),
    y: p.y,
    bad:
      restIndex(p) === n + 1
        ? expectAt(p, n + 1)
        : ['rest ' + restIndex(p) + ', scrollY ' + p.y],
    note: 'snap',
  });
  // up: one of each "previous" key
  const upKeys = ['ArrowUp', 'PageUp', 'Shift+Space'];
  for (let k = n; k >= 1; k--) await step(upKeys[n - k] ?? 'ArrowUp', k);
  await step('ArrowUp', 0, 'leave from the first stop');
  // End from the row, Home and Escape from the details
  await step('End', n + 1, 'row to lineup');
  await step('ArrowUp', n);
  await step('ArrowUp', n - 1);
  await step('Home', 0, 'leave');
  await step('ArrowDown', 1);
  await step('ArrowDown', 2);
  await step('Escape', 0, 'leave');
  // nothing acts while a field has focus
  const field = await page.evaluate(() => {
    const i = document.createElement('input');
    i.id = '__qa_field';
    i.style.position = 'fixed';
    i.style.top = '0';
    document.body.appendChild(i);
    i.focus();
    return true;
  });
  const y0 = p.y;
  p = await key(page, 'ArrowDown');
  await page.evaluate(() => document.getElementById('__qa_field')?.remove());
  steps.push({
    key: 'ArrowDown in a field',
    want: 0,
    at: restIndex(p),
    y: p.y,
    bad:
      field && Math.abs(p.y - y0) < 1 && !p.on
        ? []
        : ['scroll ' + y0 + ' -> ' + p.y + ', focused ' + p.on],
    note: 'guard',
  });
  const bad = steps.filter((x) => x.bad.length);
  writeFileSync(
    OUT + '/keys-' + size + '.json',
    JSON.stringify(steps, null, 1),
  );
  report(
    'keys-full-pass-' + size,
    bad.length === 0,
    bad.length
      ? bad.map((x) => x.key + ' -> ' + x.bad.join(', ')).join('; ')
      : steps.length + ' key steps, every one on its rest',
  );
  report(
    'errors-keys-' + size,
    page.errors.length === 0,
    page.errors.join(' | ') || 'none',
  );
  await s.ctx.close();
}

async function touchPart(size) {
  const s = await open(size);
  const { page } = s;
  if (!s.cdp && size === 'phone') {
    report(
      'touch-during-glide-tap-phone',
      'SKIP',
      'no CDP touch input in ' + ENGINE,
    );
    report(
      'touch-during-glide-swipe-phone',
      'SKIP',
      'no CDP touch input in ' + ENGINE,
    );
    report('diagonal-swipes-phone', 'SKIP', 'no CDP touch input in ' + ENGINE);
    await s.ctx.close();
    return;
  }
  if (size === 'desktop') {
    await load(s);
    await key(page, 'ArrowDown');
    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(300);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(1600);
    let p = await rest(page);
    const k1 = restIndex(p);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(300);
    p = await rest(page);
    const k2 = restIndex(p);
    report(
      'wheel-during-glide-desktop',
      k1 === 2 && k2 === 3 && expectAt(p, k2).length === 0,
      'landed on rest ' +
        k1 +
        ' (want 2); the next notch to ' +
        k2 +
        ' (want 3)',
    );
    report(
      'errors-touch-' + size,
      page.errors.length === 0,
      page.errors.join(' | ') || 'none',
    );
    await s.ctx.close();
    return;
  }
  // a tap 300 ms into a move, then a reverse swipe 300 ms into a move
  for (const kind of ['tap', 'swipe']) {
    await load(s);
    await key(page, 'ArrowDown');
    await swipe(s, 200, 600, 200, 380);
    await page.waitForTimeout(300);
    if (kind === 'tap') await tap(s, 200, 300);
    else await swipe(s, 200, 380, 200, 600);
    await page.waitForTimeout(1600);
    let p = await rest(page);
    const k1 = restIndex(p);
    await swipe(s, 200, 600, 200, 380);
    await page.waitForTimeout(300);
    p = await rest(page);
    const k2 = restIndex(p);
    report(
      'touch-during-glide-' + kind + '-phone',
      k1 === 2 && k2 === 3 && expectAt(p, k2).length === 0,
      'landed on rest ' +
        k1 +
        ' (want 2); the next swipe to ' +
        k2 +
        ' (want 3)' +
        (expectAt(p, k2).length ? '; ' + expectAt(p, k2).join(', ') : ''),
    );
  }
  // diagonal swipes at the row, a detail stop and the lineup
  const out = [];
  for (const where of ['row', 'stop2', 'lineup']) {
    for (const deg of [30, 44, 46, 60]) {
      for (const dir of [1, -1]) {
        await load(s);
        let p = await rest(page);
        if (where === 'stop2') {
          await key(page, 'ArrowDown');
          p = await key(page, 'ArrowDown');
        } else if (where === 'lineup') p = await key(page, 'End');
        const rad = (deg * Math.PI) / 180;
        const dx = Math.round(200 * Math.sin(rad));
        const dy = Math.round(200 * Math.cos(rad)) * dir;
        await swipe(s, 195 - dx / 2, 470 + dy / 2, 195 + dx / 2, 470 - dy / 2);
        await page.waitForTimeout(400);
        p = await rest(page, 9000);
        await page.waitForTimeout(400);
        p = await rest(page);
        const k = restIndex(p);
        const trackOk = p.track === null || Number.isInteger(p.track);
        const atExit =
          k < 0 &&
          p.exitEnd !== null &&
          Math.abs(p.y - p.exitEnd) < 1 &&
          p.past;
        const bad = atExit ? [] : expectAt(p, k);
        if (!trackOk) bad.push('track ' + p.track);
        out.push({ where, deg, dir, k, y: p.y, x: p.x, track: p.track, bad });
      }
    }
  }
  writeFileSync(OUT + '/diagonal-phone.json', JSON.stringify(out, null, 1));
  const badD = out.filter((o) => o.bad.length);
  report(
    'diagonal-swipes-phone',
    badD.length === 0,
    badD.length
      ? badD
          .map(
            (o) =>
              o.where +
              ' ' +
              o.deg +
              'deg ' +
              (o.dir > 0 ? 'up' : 'down') +
              ': ' +
              o.bad.join(', '),
          )
          .join('; ')
      : out.length + ' swipes, each on a rest with scrollX 0 and a whole track',
  );
  report(
    'errors-touch-' + size,
    page.errors.length === 0,
    page.errors.join(' | ') || 'none',
  );
  await s.ctx.close();
}

/** Reduced motion: a plain document ending with the footer; a tap opens the pack. */
async function reducedPart(size) {
  const s = await open(size, { reducedMotion: 'reduce' });
  const { page } = s;
  await page.goto(BASE + PREVIEW + '?debug=1&loader=never', {
    waitUntil: 'load',
  });
  await reject(page);
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => {
    const shown = (e) => {
      const st = getComputedStyle(e);
      return (
        st.display !== 'none' &&
        st.visibility !== 'hidden' &&
        e.getBoundingClientRect().height > 0
      );
    };
    const feet = [
      ...document.querySelectorAll('footer[data-site-chrome]'),
    ].filter(shown);
    const spacers = [...document.querySelectorAll('[data-flow-spacer]')].map(
      (e) => [
        e.getAttribute('data-flow-spacer'),
        e.getBoundingClientRect().height,
      ],
    );
    window.scrollTo(0, document.documentElement.scrollHeight);
    const f = feet[0];
    const fb = f ? f.getBoundingClientRect().bottom + scrollY : null;
    const after = f
      ? [...document.body.querySelectorAll('*')]
          .filter((e) => {
            const r = e.getBoundingClientRect();
            const st = getComputedStyle(e);
            return (
              !(() => {
                for (let a = e; a; a = a.parentElement)
                  if (getComputedStyle(a).position === 'fixed') return true;
                return false;
              })() &&
              st.visibility !== 'hidden' &&
              r.height > 0 &&
              r.top + scrollY >= fb - 1 &&
              !f.contains(e) &&
              !e.contains(f)
            );
          })
          .map((e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : ''))
          .slice(0, 5)
      : [];
    const nav = document.querySelector('nav.fixed.bottom-0');
    return {
      flowOn: !!document.querySelector('[data-flow-on]'),
      feet: feet.length,
      spacers,
      footBottom: fb,
      docH: document.documentElement.scrollHeight,
      tab: nav && nav.offsetHeight > 0 ? nav.offsetHeight : 0,
      after,
    };
  });
  await page.waitForTimeout(500);
  await shot(page, 'reduced-end-' + size);
  const tall = r.spacers.filter(([, h]) => h > 0);
  const gap = r.footBottom === null ? null : Math.round(r.docH - r.footBottom);
  report(
    'reduced-plain-document-' + size,
    !r.flowOn &&
      r.feet === 1 &&
      tall.length === 0 &&
      gap !== null &&
      r.after.length === 0,
    'flow on ' +
      r.flowOn +
      '; ' +
      r.feet +
      ' footer(s); spacers with height: ' +
      (tall.map(([n, h]) => n + '=' + h).join(',') || 'none') +
      '; page ends ' +
      gap +
      ' px below the footer (tab bar ' +
      r.tab +
      '); laid out below it: ' +
      (r.after.join(',') || 'nothing'),
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  const art = page.locator(
    '[data-stage-panel]:not([hidden]) [data-stage-tile][data-pack-id="' +
      SLUG +
      '"] [data-stage-art]',
  );
  const b = await art.boundingBox().catch(() => null);
  if (b) {
    if (s.cdp) await tap(s, b.x + b.width / 2, b.y + b.height / 2);
    else await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  }
  await page.waitForURL(/\/slots\//, { timeout: 15000 }).catch(() => {});
  const path = new URL(page.url()).pathname;
  report(
    'reduced-tap-opens-pack-' + size,
    path === '/slots/' + SLUG,
    'tile ' + (b ? 'found' : 'missing') + '; now at ' + path,
  );
  await s.ctx.close();
}

async function nojsPart(size) {
  const s = await open(size, { javaScriptEnabled: false });
  const { page } = s;
  await page.goto(BASE + PREVIEW, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const r = await page.evaluate(() => {
    const shown = (e) => {
      const st = getComputedStyle(e);
      return (
        st.display !== 'none' &&
        st.visibility !== 'hidden' &&
        e.getBoundingClientRect().height > 0
      );
    };
    return {
      feet: [...document.querySelectorAll('footer')].filter(shown).length,
      chrome: [...document.querySelectorAll('footer[data-site-chrome]')].filter(
        shown,
      ).length,
      spacers: [...document.querySelectorAll('[data-flow-spacer]')].map((e) => [
        e.getAttribute('data-flow-spacer'),
        e.getBoundingClientRect().height,
      ]),
    };
  });
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await shot(page, 'nojs-end-' + size);
  const tall = r.spacers.filter(([, h]) => h > 0);
  report(
    'nojs-one-footer-' + size,
    r.chrome === 1 && r.feet === 1,
    r.chrome + ' site footer(s) shown, ' + r.feet + ' footer element(s) shown',
  );
  report(
    'nojs-spacers-flat-' + size,
    r.spacers.length > 0 && tall.length === 0,
    r.spacers.length +
      ' spacers; with height: ' +
      (tall.map(([n, h]) => n + '=' + h).join(',') || 'none'),
  );
  await s.ctx.close();
}

/** At the rise, Return and Last. */
async function lapPart(size) {
  const to = TURNED[size];
  const from = PROFILES[size].viewport;
  const s = await open(size);
  const { page } = s;
  /** To the lineup, then to share x of a lap span (rise, ret) or Last's top. */
  const toLap = async (span, x) => {
    await load(s);
    await rest(page);
    await key(page, 'End');
    let p = await probe(page);
    const t = p[span];
    const y =
      span === 'lastTop' ? p.lastTop - 2 : t.start + (t.end - t.start) * x;
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await page.waitForTimeout(800);
    p = await probe(page);
    return p;
  };
  const turnAndBack = async (name, p0, field, tol) => {
    await shot(page, name + '-0-before');
    await page.setViewportSize(to);
    await page.waitForTimeout(800);
    const q1 = await probe(page);
    await shot(page, name + '-1-changed');
    await page.setViewportSize(from);
    await page.waitForTimeout(800);
    const q2 = await probe(page);
    await shot(page, name + '-2-back');
    const bad = [];
    for (const [q, when] of [
      [q1, 'changed'],
      [q2, 'back'],
    ]) {
      if (!q.flowOn) bad.push(when + ': flow off');
      if (!q.lap) bad.push(when + ': not in the lap (scrollY ' + q.y + ')');
      else if (Math.abs(q.lap[field] - p0.lap[field]) > tol)
        bad.push(
          when +
            ': ' +
            field +
            ' ' +
            q.lap[field] +
            ' (was ' +
            p0.lap[field] +
            ')',
        );
      if (q.id !== p0.id)
        bad.push(when + ': focused ' + q.id + ' (was ' + p0.id + ')');
    }
    report(
      name,
      bad.length === 0,
      bad.join('; ') ||
        field +
          ' ' +
          p0.lap[field].toFixed(3) +
          ' kept both ways (' +
          q1.lap[field].toFixed(3) +
          ' turned, ' +
          q2.lap[field].toFixed(3) +
          ' back)',
    );
  };
  let p = await toLap('rise', 0.5);
  await turnAndBack('rotate-in-rise-' + size, p, 'rise', 0.15);
  p = await toLap('ret', 0.5);
  await turnAndBack('rotate-in-return-' + size, p, 'ret', 0.15);
  p = await toLap('lastTop');
  await turnAndBack('rotate-at-last-' + size, p, 'ret', 0.1);
  // End and PageDown at Last are the browser's: they cross Last's top and
  // the page wraps to the row
  const wraps = [];
  for (const k of ['End', 'PageDown']) {
    p = await toLap('lastTop');
    await page.keyboard.press(k);
    await page.waitForTimeout(1800);
    const q = await rest(page);
    wraps.push({ k, ok: restIndex(q) === 0 && !q.on, y: q.y });
  }
  report(
    'keys-wrap-at-last-' + size,
    wraps.every((w) => w.ok),
    wraps
      .map(
        (w) =>
          w.k + ': scrollY ' + w.y + (w.ok ? ', the row' : ', not the row'),
      )
      .join('; '),
  );
  report(
    'errors-lap-' + size,
    s.page.errors.length === 0,
    s.page.errors.join(' | ') || 'none',
  );
  await s.ctx.close();
}

/** A drag that lets go gently (no fling) or ends in the given touch event. */
async function drag(
  s,
  x,
  y0,
  y1,
  { steps = 8, delay = 16, hold = 0, end = 'touchEnd' } = {},
) {
  const { cdp, page } = s;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y: y0 }],
  });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / steps }],
    });
    await page.waitForTimeout(delay);
  }
  if (hold) await page.waitForTimeout(hold);
  await cdp.send('Input.dispatchTouchEvent', { type: end, touchPoints: [] });
}

/** The lap and what the 3D engine draws, as numbers. */
const trimProbe = (page) =>
  page.evaluate(() => {
    const ps = window.__packStage;
    const lap = ps?.flow?.()?.lap ?? null;
    const d = ps?.runtime?.()?.drawn ?? [];
    const list = Array.isArray(d) ? d : [];
    return {
      lap,
      drawn: Array.isArray(d) ? d.length : Number(d),
      ids: list.map((e) => (typeof e === 'string' ? e : (e?.id ?? '?'))),
      free: !!document.querySelector('[data-flow-free]'),
      y: Math.round(scrollY * 10) / 10,
    };
  });

/** Normal scrolling only: one notch (desktop) or one swipe (phone) per step. */
async function driveStep(s, p, dir) {
  const { page } = s;
  const paged = p.exitEnd === null || p.y < p.exitEnd - 1;
  if (s.size === 'phone') {
    const len = paged ? 300 : 220;
    const [a, b] = dir > 0 ? [640, 640 - len] : [300, 300 + len];
    await drag(s, 195, a, b, { steps: 10, delay: 30, hold: paged ? 0 : 120 });
  } else {
    await page.mouse.move(720, 450);
    // small notches in the free part: its trimmed middle is about a third of
    // a viewport long
    await page.mouse.wheel(0, dir * (paged ? 120 : 100));
    await page.waitForTimeout(paged ? 1600 : 250);
  }
  return rest(page);
}

/** Scroll down normally until goal(p), recording the rest indexes passed. */
async function driveDown(s, p, goal, visited) {
  for (let i = 0; i < 150 && !goal(p); i++) {
    p = await driveStep(s, p, 1);
    const k = restIndex(p);
    if (k >= 0) visited.add(k);
  }
  return p;
}

/** The middle of the free span (between the lineup exit and the rise). */
const freeMiddle = (p) =>
  p.exitEnd === null
    ? Infinity
    : p.rise
      ? (p.exitEnd + p.rise.start) / 2
      : p.exitEnd + (p.max - p.exitEnd) / 2;

async function trimPart(size) {
  const s = await open(size);
  const { page } = s;
  if (!s.cdp && size === 'phone') {
    report('trim-free-span-phone', 'SKIP', 'no CDP touch input in ' + ENGINE);
    report('trim-restored-phone', 'SKIP', 'no CDP touch input in ' + ENGINE);
    report(
      'trim-gpu-free-span-phone',
      'SKIP',
      'no CDP touch input in ' + ENGINE,
    );
    await s.ctx.close();
    return;
  }
  await load(s);
  let p = await rest(page);
  if (p.exitEnd === null) {
    report('trim-free-span-' + size, false, 'no lineup exit in the flow table');
    await s.ctx.close();
    return;
  }
  const visited = new Set([restIndex(p)]);
  const way = size === 'phone' ? 'swipes' : 'wheel notches';
  p = await driveDown(s, p, (q) => q.free && q.y >= freeMiddle(q), visited);
  await page.waitForTimeout(1200);
  p = await rest(page);
  const t = await trimProbe(page);
  await shot(page, 'trim-free-span-' + size);
  const stopsText =
    'rests passed ' +
    [...visited].sort((a, b) => a - b).join(',') +
    ' of ' +
    p.stops.length;
  report(
    'trim-free-span-' + size,
    !!t.lap &&
      t.lap.free === true &&
      t.lap.trim === true &&
      t.free &&
      t.drawn <= 1,
    'by ' +
      way +
      ' to scrollY ' +
      t.y +
      ' (exit end ' +
      p.exitEnd +
      ', rise ' +
      (p.rise ? p.rise.start : 'none') +
      ', max ' +
      p.max +
      '); lap ' +
      JSON.stringify(t.lap) +
      '; data-flow-free ' +
      t.free +
      '; drawn ' +
      t.drawn +
      (t.ids.length ? ' [' + t.ids.join(',') + ']' : '') +
      '; ' +
      stopsText,
  );
  if (size === 'phone') {
    // the Just Pulled drawer has loaded; the GPU estimate's peak in the free span
    const live = await page
      .waitForSelector('[data-jp-live="1"]', {
        state: 'attached',
        timeout: 20000,
      })
      .then(() => true)
      .catch(() => false);
    await page.evaluate(() => {
      window.__gpuPeak = 0;
      const f = () => {
        const b = window.__packStage?.stats?.()?.gpuBytesEstimate ?? 0;
        window.__gpuPeak = Math.max(window.__gpuPeak, b);
        requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
    });
    await page.waitForTimeout(2000);
    await drag(s, 195, 600, 400, { steps: 10, delay: 30, hold: 120 });
    await rest(page);
    await drag(s, 195, 400, 600, { steps: 10, delay: 30, hold: 120 });
    await rest(page);
    await page.waitForTimeout(1000);
    const g = await page.evaluate(() => ({
      peak: window.__gpuPeak,
      has: typeof window.__packStage?.stats?.()?.gpuBytesEstimate === 'number',
      free: !!document.querySelector('[data-flow-free]'),
    }));
    const mb = Math.round((g.peak / 1048576) * 100) / 100;
    report(
      'trim-gpu-free-span-phone',
      live && g.has && g.free && mb <= 40,
      'peak ' +
        mb +
        ' MB (cap 40); drawer loaded ' +
        live +
        '; estimate present ' +
        g.has +
        '; still in the free span ' +
        g.free,
    );
    p = await rest(page);
  }
  // normally back up to the lineup exit
  for (let i = 0; i < 150 && p.free && p.y > p.exitEnd + 2; i++) {
    p = await driveStep(s, p, -1);
  }
  await page.waitForTimeout(1200);
  p = await rest(page);
  // at the exit's end the trim is off (on the exit's own last pixel there is
  // no lap at all and the packs are drawn); one more gesture up goes back
  // towards the lineup, where the other packs are drawn again
  const atEnd = await trimProbe(page);
  p = await driveStep(s, p, -1);
  await page.waitForTimeout(1800);
  p = await rest(page);
  const u = await trimProbe(page);
  report(
    'trim-restored-' + size,
    (atEnd.lap === null ? atEnd.drawn > 1 : atEnd.lap.trim === false) &&
      (u.lap === null || u.lap.trim !== true) &&
      u.drawn > 1,
    'at the exit end: lap ' +
      JSON.stringify(atEnd.lap) +
      ', drawn ' +
      atEnd.drawn +
      '; then ' +
      'back up by ' +
      way +
      ' to scrollY ' +
      u.y +
      ' (exit end ' +
      p.exitEnd +
      ', rest ' +
      restIndex(p) +
      '); lap ' +
      JSON.stringify(u.lap) +
      '; drawn ' +
      u.drawn +
      '; data-flow-free ' +
      u.free,
  );
  report(
    'errors-trim-' + size,
    page.errors.length === 0,
    page.errors.join(' | ') || 'none',
  );
  await s.ctx.close();
}

async function touchcancelPart(size) {
  if (size !== 'phone') return;
  const s = await open(size);
  const { page } = s;
  if (!s.cdp) {
    report(
      'touchcancel-no-page-phone',
      'SKIP',
      'no CDP touch input in ' + ENGINE,
    );
    report(
      'touchcancel-no-glide-free-span-phone',
      'SKIP',
      'no CDP touch input in ' + ENGINE,
    );
    await s.ctx.close();
    return;
  }
  await load(s);
  let p = await rest(page);
  for (let i = 0; i < 6 && restIndex(p) < 2; i++) {
    await swipe(s, 195, 640, 195, 340);
    p = await rest(page);
  }
  const y0 = p.y;
  const k0 = restIndex(p);
  const f0 = p.focus;
  await drag(s, 195, 600, 520, { steps: 5, delay: 30, end: 'touchCancel' });
  await page.waitForTimeout(2000);
  let q = await rest(page);
  report(
    'touchcancel-no-page-phone',
    k0 >= 1 && Math.abs(q.y - y0) <= 2 && restIndex(q) === k0 && q.focus === f0,
    'before: scrollY ' +
      y0 +
      ', rest ' +
      k0 +
      ', stop ' +
      f0 +
      '; after an 80 px drag ended by touchCancel and 2 s: scrollY ' +
      q.y +
      ', rest ' +
      restIndex(q) +
      ', stop ' +
      q.focus,
  );
  // in the free span: a cancel must leave the page where the finger left it
  q = await driveDown(s, q, (r) => r.free && r.y >= freeMiddle(r), new Set());
  await page.waitForTimeout(800);
  q = await rest(page);
  await drag(s, 195, 650, 500, { steps: 6, delay: 30, end: 'touchCancel' });
  await page.waitForTimeout(100);
  const ya = await page.evaluate(() => scrollY);
  await page.waitForTimeout(1200);
  const yb = await page.evaluate(() => scrollY);
  report(
    'touchcancel-no-glide-free-span-phone',
    q.free && Math.abs(yb - ya) <= 2,
    'free span ' +
      q.free +
      '; a 150 px drag ended by touchCancel: scrollY ' +
      Math.round(ya * 10) / 10 +
      ' at 100 ms, ' +
      Math.round(yb * 10) / 10 +
      ' at 1.3 s (moved ' +
      Math.round(Math.abs(yb - ya) * 10) / 10 +
      ' px, limit 2)',
  );
  report(
    'errors-touchcancel-phone',
    page.errors.length === 0,
    page.errors.join(' | ') || 'none',
  );
  await s.ctx.close();
}

const log = [];
for (const size of ['phone', 'desktop']) {
  if (ONLY && ONLY !== size) continue;
  const run = async (name, fn) => {
    if (!part(name)) return;
    try {
      await fn();
    } catch (e) {
      report(name + '-' + size + '-crashed', false, String(e).split('\n')[0]);
    }
  };
  await run('rotate', () => viewportPart(size, 'rotate'));
  await run('height', () => viewportPart(size, 'height'));
  await run('keys', () => keysPart(size));
  await run('touch', () => touchPart(size));
  await run('reduced', () => reducedPart(size));
  await run('nojs', () => nojsPart(size));
  await run('lap', () => lapPart(size));
  await run('trim', () => trimPart(size));
  await run('touchcancel', () => touchcancelPart(size));
}
await browser.close();
writeFileSync(
  OUT +
    '/log' +
    (ONLY ? '-' + ONLY : '') +
    (PARTS.length ? '-' + PARTS.join('_') : '') +
    '.json',
  JSON.stringify({ results, log }, null, 1),
);
const count = (st) => results.filter((r) => r.status === st).length;
console.log(
  'summary (' +
    ENGINE +
    (ENGINE === 'chromium'
      ? ', ' +
        (process.env.QA_GL === 'swiftshader' ||
        process.env.RENDERER === 'software'
          ? 'software'
          : 'gpu')
      : '') +
    '): ' +
    results.length +
    ' checks, ' +
    count('PASS') +
    ' pass, ' +
    count('FAIL') +
    ' fail, ' +
    count('PENDING') +
    ' pending, ' +
    count('SKIP') +
    ' skipped',
);
process.exit(count('FAIL') === 0 ? 0 : 1);
