// QA for /home-preview across device sizes: phones, phone landscape, tablets, laptops, desktops and an ultrawide.
// At every size it walks the whole flow forward (row, the detail stops, the lineup with one sideways pick, Just
// Pulled, the footer, the end) and back up to the row, and at every rest checks:
// - the document never scrolls sideways (and no element pokes out past the view unclipped);
// - at the row, the centre pack's art is inside the view;
// - at a detail stop, the pack (read from the canvas alone, keyed over two colours) is inside the view and does not
//   cover the stop text, the buy controls, the icons, the header or the tab bar; the stop text and buy controls are
//   inside the view between the header and the tab bar, and nothing in the block is cut off;
// - on touch sizes, tap targets in view are at least 24 px and text is at least 10 px.
// One contact sheet per size.
//
//   node scripts/qa-home-responsive.mjs --base=http://localhost:4340 [--sizes=p320,d1440] [--engine=webkit]
//                                       [--out=DIR] [--self-test]
import sharp from 'sharp';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as qa from './lib/qa-kit.mjs';

/** Playwright's own device descriptors (for the WebKit pass), resolved from the worktree like the kit's. */
const DEVICES = createRequire(join(process.cwd(), 'package.json'))(
  'playwright',
).devices;

/** name: [width, height, device pixel ratio, touch] */
const SIZES = {
  p320: [320, 568, 2, true],
  p360: [360, 800, 3, true],
  p390: [390, 844, 3, true],
  p430: [430, 932, 3, true],
  land844: [844, 390, 3, true],
  t768: [768, 1024, 2, true],
  t1024: [1024, 768, 2, true],
  t1180: [1180, 820, 2, true],
  l1280s: [1280, 600, 1, false],
  l1366: [1366, 768, 1, false],
  l1440: [1440, 900, 1, false],
  d1920: [1920, 1080, 1, false],
  d2560: [2560, 1440, 1, false],
  uw3440: [3440, 1440, 1, false],
  // the owner's full-screen Chrome window
  o2500: [2500, 1288, 1.5, false],
  // a 4K screen at ratio 1, 1.25 and 1.5 (CSS px)
  k4: [3840, 2160, 1, false],
  k4r125: [2458, 1382, 1.25, false],
  k4r150: [1707, 960, 1.5, false],
};
/** The WebKit pass: Playwright's iPhone and iPad descriptors, portrait and landscape. */
const WEBKIT_DEVICES = [
  'iPhone SE',
  'iPhone 15',
  'iPhone 15 Pro Max',
  'iPad Mini',
  'iPad Pro 11',
  'iPhone SE landscape',
  'iPhone 15 landscape',
  'iPhone 15 Pro Max landscape',
  'iPad Mini landscape',
  'iPad Pro 11 landscape',
];
for (const d of WEBKIT_DEVICES) {
  const v = DEVICES[d];
  if (v)
    SIZES['wk-' + d.replace(/\s+/g, '-')] = [
      v.viewport.width,
      v.viewport.height,
      v.deviceScaleFactor,
      v.hasTouch,
      d,
    ];
}
const wantSizes = (qa.args.flag('sizes', '') || '').split(',').filter(Boolean);
const ENGINE = qa.args.flag('engine', 'chromium');
const MAX_RESTS = 40;
/** Pack pixels allowed inside a text rect before it counts as covered (antialiased edges, a soft glow). */
const COVER_PX = 60;

/** Pack mask (CSS px) from the canvas shot over magenta and over green: a pixel is pack when the key does not show. */
async function keyedMask(a, b) {
  const load = (x) =>
    sharp(x).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const A = await load(a);
  const B = await load(b);
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
  return { W, H, m };
}
/** Bounding box of the mask's pixels, or null when empty. */
function maskBox({ W, H, m }) {
  let x0 = W,
    y0 = H,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (m[y * W + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, r: x1 + 1, b: y1 + 1 };
}
/** Mask pixels inside a rect. */
function maskIn({ W, H, m }, r) {
  let n = 0;
  const xa = Math.max(0, Math.floor(r.x)),
    xb = Math.min(W, Math.ceil(r.r));
  const ya = Math.max(0, Math.floor(r.y)),
    yb = Math.min(H, Math.ceil(r.b));
  for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) n += m[y * W + x];
  return n;
}

function selfTest() {
  const W = 50,
    H = 40,
    m = new Uint8Array(W * H);
  for (let y = 10; y < 20; y++) for (let x = 5; x < 15; x++) m[y * W + x] = 1;
  const M = { W, H, m };
  const box = maskBox(M);
  qa.check(
    'self-test-mask',
    box.x === 5 &&
      box.r === 15 &&
      box.y === 10 &&
      box.b === 20 &&
      maskIn(M, { x: 0, y: 0, r: 10, b: 15 }) === 25 &&
      maskIn(M, { x: 20, y: 0, r: 50, b: 40 }) === 0 &&
      maskBox({ W, H, m: new Uint8Array(W * H) }) === null,
    JSON.stringify(box),
  );
}

const CANVAS_ONLY = (c) =>
  'html,body{background:' +
  c +
  '!important}body *{visibility:hidden!important;transition:none!important}' +
  '[data-stage-canvas],[data-stage-canvas] canvas{visibility:visible!important}';
async function setStyle(page, css) {
  await page.evaluate((t) => {
    let s = document.getElementById('qa-resp');
    if (t === null) return s?.remove();
    if (!s) {
      s = document.createElement('style');
      s.id = 'qa-resp';
      document.head.appendChild(s);
    }
    s.textContent = t;
  }, css);
}
async function packMask(s) {
  await setStyle(s.page, CANVAS_ONLY('#ff00ff'));
  await s.frames(3);
  const a = await s.page.screenshot({ scale: 'css' });
  await setStyle(s.page, CANVAS_ONLY('#00ff00'));
  await s.frames(3);
  const b = await s.page.screenshot({ scale: 'css' });
  await setStyle(s.page, null);
  await s.frames(3);
  return keyedMask(a, b);
}

/** One reading of the layout at a rest (CSS px). */
const readLayout = (s) =>
  s.page.evaluate(() => {
    const vw = innerWidth,
      vh = innerHeight;
    const R = (el) => {
      const b = el.getBoundingClientRect();
      return {
        x: Math.round(b.left),
        y: Math.round(b.top),
        r: Math.round(b.right),
        b: Math.round(b.bottom),
      };
    };
    const shown = (el) => {
      if (!el || !el.getClientRects().length) return false;
      for (
        let e = el;
        e && e !== document.documentElement;
        e = e.parentElement
      ) {
        const cs = getComputedStyle(e);
        if (
          cs.display === 'none' ||
          cs.visibility === 'hidden' ||
          Number(cs.opacity) < 0.05
        )
          return false;
      }
      return true;
    };
    const name = (el) =>
      el.tagName.toLowerCase() +
      (el.getAttribute('data-kind')
        ? '[' + el.getAttribute('data-kind') + ']'
        : '') +
      (typeof el.className === 'string' && el.className
        ? '.' +
          el.className
            .split(/\s+/)[0]
            .replace(/^.*__([a-zA-Z]+)__.*$/, '$1')
            .slice(0, 30)
        : '') +
      (el.getAttribute('aria-label')
        ? '"' + el.getAttribute('aria-label').slice(0, 20) + '"'
        : '');
    const header = document.querySelector('header');
    const tab = document.querySelector('nav.fixed.bottom-0');
    const headerR = shown(header) ? R(header) : null;
    const tabR = shown(tab) ? R(tab) : null;
    const top = headerR && headerR.b > 0 ? headerR.b : 0;
    const bottom = tabR ? tabR.y : vh;
    const stops = document.querySelector('[data-testid="focus-stops"]');
    const sec = stops?.querySelector('section[data-on]');
    const parts = [];
    if (sec && shown(sec)) {
      for (const c of sec.children)
        if (shown(c) && c.getBoundingClientRect().height > 0)
          parts.push({ n: name(c), ...R(c) });
      const live = stops.querySelector(':scope > div[class*="live"]');
      if (shown(live)) parts.push({ n: 'buy-dock', ...R(live) });
      const icons = stops.querySelector('nav');
      if (shown(icons)) parts.push({ n: 'icons', ...R(icons) });
    }
    // anything in the block cut off by its own clipping
    const cut = [];
    if (sec)
      for (const el of [sec, ...sec.querySelectorAll('*')]) {
        if (!shown(el)) continue;
        const cs = getComputedStyle(el);
        if (
          (cs.overflowY === 'hidden' || cs.overflow === 'hidden') &&
          el.scrollHeight > el.clientHeight + 4 &&
          el.clientHeight > 30 &&
          !cs.textOverflow.includes('ellipsis') &&
          cs.maskImage === 'none' &&
          cs.webkitLineClamp === 'none'
        )
          cut.push(name(el) + ' ' + el.scrollHeight + '>' + el.clientHeight);
      }
    // elements poking out sideways past the view without a clipping ancestor
    const poke = [];
    for (const el of document.body.querySelectorAll('*')) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.bottom < 0 || b.top > vh) continue;
      if (b.right <= vw + 1 && b.left >= -1) continue;
      let clipped = false;
      for (
        let e = el.parentElement;
        e && e !== document.body;
        e = e.parentElement
      ) {
        const cs = getComputedStyle(e);
        if (cs.overflowX !== 'visible' || cs.position === 'fixed') {
          const pb = e.getBoundingClientRect();
          if (pb.right <= vw + 1 && pb.left >= -1) {
            clipped = true;
            break;
          }
        }
      }
      if (!clipped && shown(el))
        poke.push(
          name(el) + ' ' + Math.round(b.left) + '..' + Math.round(b.right),
        );
      if (poke.length >= 4) break;
    }
    // touch: small tap targets and small text in view
    const small = [];
    for (const el of document.querySelectorAll(
      'a[href], button, [role="button"], input, select',
    )) {
      if (!shown(el) || el.closest('[aria-hidden="true"]')) continue;
      const b = el.getBoundingClientRect();
      if (b.bottom <= top || b.top >= bottom || b.right <= 0 || b.left >= vw)
        continue;
      if (getComputedStyle(el).display === 'inline') continue; // a link inside running text
      if (b.width < 24 || b.height < 24)
        small.push(
          name(el) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height),
        );
    }
    const tiny = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.textContent.trim()) continue;
      const el = t.parentElement;
      if (!el || el.closest('.sr-only, [aria-hidden="true"]') || !shown(el))
        continue;
      const b = el.getBoundingClientRect();
      if (
        b.bottom <= top ||
        b.top >= bottom ||
        b.right <= 0 ||
        b.left >= vw ||
        b.width < 2
      )
        continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      const scale = 1;
      if (fs * scale < 10)
        tiny.push(
          t.textContent.trim().slice(0, 16) +
            ' ' +
            (fs * scale).toFixed(1) +
            'px',
        );
      if (tiny.length >= 4) break;
    }
    // the row: the art nearest the centre
    let centre = null;
    const arts = [
      ...document.querySelectorAll(
        '[data-stage-panel]:not([hidden]) [data-stage-tile][data-pack-id] [data-stage-art]',
      ),
    ]
      .map((a) => ({
        id: a.closest('[data-pack-id]').getAttribute('data-pack-id'),
        ...R(a),
      }))
      .filter((a) => a.r > a.x);
    if (arts.length)
      centre = arts.reduce((p, q) =>
        Math.abs((q.x + q.r) / 2 - vw / 2) < Math.abs((p.x + p.r) / 2 - vw / 2)
          ? q
          : p,
      );
    return {
      vw,
      vh,
      top,
      bottom,
      headerR,
      tabR,
      parts,
      cut,
      poke,
      small: small.slice(0, 6),
      tiny,
      docW: document.documentElement.scrollWidth,
      bodyW: document.body.scrollWidth,
      sx: Math.round(scrollX),
      centre,
    };
  });

const inside = (r, l, top = 0, bottom = l.vh) =>
  r.x >= -1 && r.r <= l.vw + 1 && r.y >= top - 1 && r.b <= bottom + 1;
const fmt = (r) =>
  r ? r.x + ',' + r.y + ' ' + (r.r - r.x) + 'x' + (r.b - r.y) : 'none';

/** What the rest is, for labels: row, a stop's kind, lineup or free part. */
const restLabel = (r, t) => {
  if (r.block && !r.past) return 'stop-' + r.block;
  if (r.y < 2) return 'row';
  if (t && Math.abs(r.y - t.rl) < 2) return 'lineup';
  if (t?.rise && Math.abs(r.y - t.rise.end) < 2) return 'single-pack';
  return 'free-y' + r.y + (r.heading ? ' ' + r.heading : '');
};
/** The flow table and the first section heading in view (labels only). */
const where = (s) =>
  s.page.evaluate(() => {
    const t = window.__packStage?.flow?.()?.table ?? null;
    const h = [...document.querySelectorAll('h2, h3')].find((e) => {
      const b = e.getBoundingClientRect();
      return (
        b.top >= 0 &&
        b.bottom <= innerHeight &&
        b.width > 0 &&
        !e.closest('[data-testid="focus-stops"]')
      );
    });
    return { t, heading: h ? h.textContent.trim().slice(0, 24) : '' };
  });
async function restAt(s) {
  const r = await qa.stage.rest(s);
  // a stop's block fades in 0.6 s after the switch: judge it once it is fully in
  if (r.block && !r.past)
    await s.page
      .waitForFunction(
        () => {
          const sec = document.querySelector(
            '[data-testid="focus-stops"] section[data-on]',
          );
          return sec && Number(getComputedStyle(sec).opacity) > 0.99;
        },
        null,
        { timeout: 3000, polling: 100 },
      )
      .catch(() => {});
  await s.page.waitForTimeout(400);
  const w = await where(s);
  return { ...r, heading: w.heading, t: w.t };
}

async function checkRest(s, key, touch, r, label) {
  const l = await readLayout(s);
  const tag = key + ' ' + label;
  qa.check(
    'no-sideways-scroll ' + tag,
    l.docW <= l.vw + 1 && l.bodyW <= l.vw + 1 && l.sx === 0,
    'doc ' + l.docW + ' body ' + l.bodyW + ' view ' + l.vw + ' scrollX ' + l.sx,
  );
  qa.check(
    'nothing-pokes-out ' + tag,
    l.poke.length === 0,
    l.poke.join(' | ') || 'none',
  );
  if (label === 'row') {
    const c = l.centre;
    qa.check(
      'row-centre-pack-in-view ' + tag,
      !!c && inside(c, l, l.top, l.bottom),
      c ? c.id + ' ' + fmt(c) + ' band ' + l.top + '..' + l.bottom : 'no tile',
    );
  }
  if (
    label.startsWith('row') ||
    label.startsWith('lineup') ||
    label.startsWith('single-pack')
  ) {
    const M = await packMask(s);
    const n = M.m.reduce((a, v) => a + v, 0);
    qa.check('packs-drawn ' + tag, n > 2000, n + ' canvas pack px');
  }
  if (r.block && !r.past) {
    const M = await packMask(s);
    qa.check(
      'packs-drawn ' + tag,
      M.m.reduce((a, v) => a + v, 0) > 2000,
      'the focused pack on the canvas',
    );
    const box = maskBox(M);
    const total = M.m.reduce((a, v) => a + v, 0);
    qa.check(
      'pack-in-view ' + tag,
      !!box && inside(box, l),
      'pack ' + fmt(box) + ' view ' + l.vw + 'x' + l.vh,
    );
    const covered = l.parts
      .map((p) => [p.n, maskIn(M, p)])
      .filter(([, n]) => n > COVER_PX);
    qa.check(
      'pack-clear-of-text ' + tag,
      covered.length === 0,
      covered.length
        ? covered.map(([n, px]) => n + ' ' + px + 'px').join(', ') +
            '; pack ' +
            fmt(box)
        : 'pack ' + fmt(box) + ' vs ' + l.parts.length + ' parts',
    );
    const chrome = [
      ['header', l.headerR],
      ['tab bar', l.tabR],
    ]
      .filter(([, rr]) => rr)
      .map(([n, rr]) => [n, maskIn(M, rr)])
      .filter(([, n]) => n > Math.max(COVER_PX, total * 0.02));
    qa.check(
      'pack-clear-of-chrome ' + tag,
      chrome.length === 0,
      chrome.map(([n, px]) => n + ' ' + px + 'px of ' + total).join(', ') ||
        'clear',
    );
    const out = l.parts.filter((p) => !inside(p, l, l.top, l.bottom));
    qa.check(
      'stop-text-in-view ' + tag,
      l.parts.length > 0 && out.length === 0,
      out.map((p) => p.n + ' ' + fmt(p)).join(' | ') ||
        l.parts.map((p) => p.n).join(', ') +
          ' inside ' +
          l.top +
          '..' +
          l.bottom,
    );
    qa.check(
      'stop-not-cut ' + tag,
      l.cut.length === 0,
      l.cut.join(' | ') || 'none',
    );
  }
  if (touch) {
    qa.check(
      'tap-targets ' + tag,
      l.small.length === 0,
      l.small.join(' | ') || 'all at least 24 px',
    );
    qa.check(
      'text-readable ' + tag,
      l.tiny.length === 0,
      l.tiny.join(' | ') || 'all at least 10 px',
    );
  }
  await s.capture(label);
  return l;
}

async function advance(s, touch, dir, r) {
  const vh = s.page.viewportSize().height;
  const inFlow =
    dir > 0
      ? qa.stage.nextStop(r, 1) !== null
      : r.y <= Math.max(0, ...r.stops) + 2 ||
        (qa.stage.nextStop(r, -1) !== null &&
          r.y - qa.stage.nextStop(r, -1) < vh * 1.2);
  if (touch && s.cdp) {
    if (inFlow) return s.step(dir);
    const x = s.page.viewportSize().width / 2;
    return dir > 0
      ? s.swipe(x, vh * 0.85, x, vh * 0.2, { steps: 12 })
      : s.swipe(x, vh * 0.2, x, vh * 0.85, { steps: 12 });
  }
  return inFlow ? s.wheel(dir * 120) : s.keys(dir > 0 ? 'PageDown' : 'PageUp');
}

async function sideways(s, touch, key) {
  const before = await qa.stage.centreTile(s);
  const { width, height } = s.page.viewportSize();
  if (touch && s.cdp)
    await s.swipe(width * 0.7, height * 0.5, width * 0.3, height * 0.5, {
      steps: 10,
    });
  else await s.wheelX(120); // a mouse, or WebKit (no CDP touch)
  const r = await qa.stage.rest(s);
  const after = await qa.stage.centreTile(s);
  const l = await readLayout(s);
  qa.check(
    'lineup-sideways ' + key,
    l.docW <= l.vw + 1 && l.sx === 0 && r.y === (await qa.stage.snap(s)).y,
    'pick ' +
      (before?.id ?? '?') +
      ' to ' +
      (after?.id ?? '?') +
      '; doc ' +
      l.docW +
      ' view ' +
      l.vw +
      ' scrollX ' +
      l.sx,
  );
  await s.capture('lineup-after-sideways');
}

/** A phone on its side gets the plain page (FLOW_OFF_QUERY): check that, page through it, then turn it upright. */
async function plainWalk(browser, key, touch) {
  const s = await qa.open(browser, key, '/home-preview', {
    query: qa.stage.query,
  });
  await s.waitPage(() => window.__packStage?.ready?.(), null, {
    timeout: 40000,
    label: 'stage ready',
  });
  await s.page.waitForTimeout(1500);
  const off = await s.page.evaluate(
    () => window.__packStage?.flow?.()?.on === false,
  );
  qa.check(
    'flow-off-on-its-side ' + key,
    off,
    off ? 'plain page' : 'the flow is on',
  );
  let y = -1;
  for (let i = 0; i < 16; i++) {
    const ny = await s.page.evaluate(() => Math.round(scrollY));
    if (ny === y) break;
    y = ny;
    await checkRest(s, key, touch, { block: null, y }, 'plain-y' + y);
    await s.keys('PageDown');
    await s.page.waitForTimeout(500);
  }
  // turned upright at the top: the flow comes back
  await s.page.evaluate(() => scrollTo(0, 0));
  const { width, height } = s.page.viewportSize();
  await s.page.setViewportSize({ width: height, height: width });
  const back = await s.page
    .waitForFunction(() => window.__packStage?.flow?.()?.on === true, null, {
      timeout: 8000,
    })
    .then(() => true)
    .catch(() => false);
  qa.check(
    'flow-back-upright ' + key,
    back,
    back ? 'flow on at ' + height + 'x' + width : 'still off',
  );
  await s.page.waitForTimeout(800);
  await s.capture('upright');
  s.checkNoErrors('no-page-errors ' + key);
  return s;
}

async function walk(browser, key) {
  const [w, h, dpr, touch, device] = SIZES[key];
  const webkit = browser.__engine === 'webkit';
  qa.profiles[key] = device
    ? { ...DEVICES[device], defaultBrowserType: undefined }
    : {
        viewport: { width: w, height: h },
        deviceScaleFactor: dpr,
        ...(touch ? { isMobile: !webkit, hasTouch: true } : {}),
      };
  if (w > h && h <= 500) return plainWalk(browser, key, touch);
  const s = await qa.stage.open(browser, key);
  let r = await restAt(s);
  await checkRest(s, key, touch, r, restLabel(r, r.t));
  const seen = [];
  let swiped = false;
  let wrapped = false;
  // forward: row, the stops, the lineup (one sideways pick), the free part, the single pack, the wrap to the row
  for (let i = 0; i < MAX_RESTS && !wrapped; i++) {
    const prev = r;
    await advance(s, touch, 1, r);
    r = await restAt(s);
    if (Math.abs(r.y - prev.y) < 2) break;
    wrapped = r.y < prev.y - 2;
    const label = restLabel(r, r.t) + (wrapped ? ' wrapped' : '');
    seen.push(label);
    await checkRest(s, key, touch, r, label);
    if (!swiped && label === 'lineup') {
      swiped = true;
      await sideways(s, touch, key);
      r = await restAt(s);
    }
  }
  // back: from the end of the page up to the row
  await s.keys('End');
  r = await restAt(s);
  const up = [];
  await checkRest(s, key, touch, r, restLabel(r, r.t) + ' end');
  for (let i = 0; i < MAX_RESTS && r.y > 1; i++) {
    const prev = r;
    await advance(s, touch, -1, r);
    r = await restAt(s);
    if (Math.abs(r.y - prev.y) < 2) break;
    const label = restLabel(r, r.t) + ' up';
    up.push(label);
    await checkRest(s, key, touch, r, label);
  }
  qa.info('walk ' + key, seen.join(' > ') + ' || ' + up.join(' > '));
  qa.check(
    'walk-covers-the-flow ' + key,
    ['stop-front', 'stop-closing', 'lineup', 'single-pack'].every((x) =>
      seen.includes(x),
    ) &&
      wrapped &&
      swiped &&
      r.y < 2 &&
      up.includes('stop-front up'),
    'forward ' +
      seen.length +
      ' rests, wrapped ' +
      wrapped +
      ', sideways ' +
      swiped +
      ', back ' +
      up.length +
      ' rests to y ' +
      r.y,
  );
  s.checkNoErrors('no-page-errors ' + key);
  if (s.failed.length)
    qa.info('failed-requests ' + key, s.failed.slice(0, 4).join(' | '));
  return s;
}

selfTest();
if (!qa.args.has('self-test')) {
  qa.deadline(0);
  const browser = await qa.launch({ engine: ENGINE });
  const keys = wantSizes.length
    ? wantSizes
    : Object.keys(SIZES).filter(
        (k) => (ENGINE === 'webkit') === k.startsWith('wk-'),
      );
  for (const key of keys) {
    if (!SIZES[key]) {
      qa.check('size ' + key, false, 'unknown size');
      continue;
    }
    try {
      const s = await walk(browser, key);
      await qa.sheet(
        join(
          qa.OUT,
          'SHEET-' + key + (ENGINE === 'webkit' ? '-webkit' : '') + '.png',
        ),
        {
          width: Math.min(
            320,
            Math.round(240 * Math.max(1, SIZES[key][0] / SIZES[key][1])),
          ),
          cols: 6,
        },
      );
      await s.ctx.close();
    } catch (e) {
      qa.check(
        'walk ' + key,
        false,
        'threw ' + String(e?.message ?? e).split('\n')[0],
      );
    }
    qa.clearFrames();
  }
}
await qa.done();
