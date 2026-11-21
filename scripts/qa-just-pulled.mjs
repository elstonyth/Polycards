// QA for the Just Pulled drawer on /home-preview, on the production server
// with HOME_PREVIEW=1. Headless Chrome, muted, logged out; only the cookie
// banner's "Reject" and the section's own controls are ever clicked. The feed
// routes are fulfilled from bodies captured once at the start, so no real pull
// arrives mid-check; arrivals are synthetic.
//
//   node scripts/qa-just-pulled.mjs [baseUrl] [--only=phone|desktop]
//                                           (default http://localhost:4302)
//
// NEXT_DIST_DIR names the build folder of the server under test (js-size).
// Writes frames to QA_OUT (default
// docs/research/home-3d/full-flow/checkpoints/wp11) and the check lines to
// QA_OUT/qa/qa-just-pulled-<size>.txt.
//
// Checks, on a phone (390x844, touch) and a desktop (1440x900, wheel):
// 1 lazy: the drawer chunk is not an initial script tag; it is requested once
//   the section nears the viewport; data-jp-live becomes "1".
// 2 swap-no-shift: with the chunk held back, then released, the section and
//   the Telegram section do not move.
// 3 scroll-no-change: scrolling through the section and back leaves every
//   card (id, stack index, transform, opacity) as it was, per frame.
// 4 arrival: a single, a double and a back-to-back arrival: front card, stack
//   index, the oldest tab leaving, no page or layout shift, live cards capped.
// 5 tabs: Immortal, Legendary, Mythical (empty), Stats, then All.
// 6 no-js: a plain list of every pull.
// 7 reduced-motion: the same plain list, before and after the drawer mounts.
// 8 js-size: first-load JS of /home-preview against /.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const BASE = (
  args.find((a) => /^https?:/.test(a)) ??
  process.env.PW_BASE ??
  'http://localhost:4302'
).replace(/\/$/, '');
const ONLY = (args.find((a) => a.startsWith('--only=')) ?? '=').split('=')[1];
const SIZES = ONLY ? [ONLY] : ['phone', 'desktop'];
const OUT =
  process.env.QA_OUT ??
  join(ROOT, 'docs/research/home-3d/full-flow/checkpoints/wp11');
const QA_DIR = join(OUT, 'qa');
mkdirSync(QA_DIR, { recursive: true });

const PREVIEW = '/home-preview';
const URL_3D = `${BASE}${PREVIEW}?stage=3d&debug=1&loader=never`;
const SEC = '[data-flow-section="just-pulled"]';
const TG = '[data-flow-section="telegram"]';
const CARD = 'li[data-jp-card]';
const FRONT = 'li[data-jp-card][data-d="0"]:not([data-leave])';
const LIVE_ATTR = SEC + ' > [data-jp][data-jp-live="1"]';
const EMPTY_TEXT = 'No Mythical pulls yet — the next rip could be the one.';
const TIERS = ['Immortal', 'Legendary', 'Mythical'];

const PROFILES = {
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};
const TABS = { phone: 2, desktop: 3 };
/** Live cards allowed at any frame of an arrival: front + tabs + one leaving. */
const CAP = { phone: 4, desktop: 5 };

let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mute() {
  const proto = HTMLMediaElement.prototype;
  const play = proto.play;
  proto.play = function (...a) {
    this.muted = true;
    this.volume = 0;
    return play.apply(this, a);
  };
}

function makeRun(size) {
  const lines = [];
  const report = (name, ok, detail) => {
    if (!ok) failures++;
    const line = `${ok ? 'PASS' : 'FAIL'} ${name} [${size}]: ${detail}`;
    console.log(line);
    lines.push(line);
  };
  const check = async (name, fn) => {
    try {
      const [ok, detail] = await fn();
      report(name, ok, detail);
    } catch (e) {
      report(name, false, `error: ${String(e?.message ?? e).split('\n')[0]}`);
    }
  };
  return { lines, report, check };
}

// ---------------------------------------------------------------------------
// The frozen feed

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36',
      referer: `${BASE}${PREVIEW}`,
    },
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function captureBodies() {
  const all = await getJson('/api/recent-pulls');
  if (!Array.isArray(all.pulls) || all.pulls.length === 0)
    throw new Error('/api/recent-pulls has no pulls array to freeze');
  const tier = {};
  const gaps = {};
  for (const t of TIERS) {
    tier[t] = await getJson(`/api/recent-pulls?rarity=${t}`);
    gaps[t] = await getJson(`/api/pull-gaps?rarity=${t}`);
  }
  return { all, tier, gaps };
}

/** Fulfils the feed routes of a context from the captured bodies. */
async function freezeFeed(ctx, bodies, state) {
  const handler = async (route) => {
    const u = new URL(route.request().url());
    const t = u.searchParams.get('rarity');
    let body;
    if (u.pathname.endsWith('/api/pull-gaps'))
      body = bodies.gaps[t ?? 'Immortal'];
    else if (t === 'Mythical') body = { ...bodies.tier.Mythical, pulls: [] };
    else if (t) body = bodies.tier[t];
    else body = state.all;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    });
  };
  await ctx.route('**/api/recent-pulls**', handler);
  await ctx.route('**/api/pull-gaps**', handler);
}

// ---------------------------------------------------------------------------
// Page helpers

let browser;

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

/** A context + page with the muted media guard, the frozen feed, and the cdp session on a phone. */
async function openPage(size, bodies, state, extra = {}) {
  const ctx = await browser.newContext({ ...PROFILES[size], ...extra });
  await ctx.addInitScript(mute);
  if (extra.javaScriptEnabled !== false) await freezeFeed(ctx, bodies, state);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.jpReqs = [];
  page.on('request', (r) => {
    if (/jp-drawer/.test(r.url())) page.jpReqs.push(r.url());
  });
  const cdp = size === 'phone' ? await ctx.newCDPSession(page) : null;
  return { ctx, page, cdp, size };
}

/** Loads the page in 3D mode, past the cookie banner, with the flow on. */
async function loadFlow(s) {
  await s.page.goto(URL_3D, { waitUntil: 'load' });
  await reject(s.page);
  await ready(s.page);
}

const intoFree = (page) =>
  page.evaluate(() => {
    const edge = window.__packStage.flow().table.edge;
    window.scrollTo(0, edge + 40);
    return edge;
  });

async function putInView(page, sel = '[data-jp-drawer]') {
  await page.evaluate(
    ([q, sec]) => {
      const el = document.querySelector(q) ?? document.querySelector(sec);
      if (!el) return;
      const r = el.getBoundingClientRect();
      window.scrollBy(0, r.top + r.height / 2 - innerHeight / 2);
    },
    [sel, SEC],
  );
  await page.waitForTimeout(400);
}

const waitLive = (page, timeout = 20000) =>
  page.waitForSelector(LIVE_ATTR, { state: 'attached', timeout });

const measure = (page) =>
  page.evaluate(
    ([sec, tg]) => {
      const s = document.querySelector(sec).getBoundingClientRect();
      const t = document.querySelector(tg).getBoundingClientRect();
      return {
        y: scrollY,
        top: s.top + scrollY,
        h: s.height,
        tg: t.top + scrollY,
      };
    },
    [SEC, TG],
  );

const liveCards = (page) =>
  page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)]
        .filter((el) => getComputedStyle(el).display !== 'none')
        .map((el) => ({
          id: el.dataset.id,
          d: el.dataset.d,
          leave: el.hasAttribute('data-leave'),
        })),
    CARD,
  );

const frontId = (page) =>
  page.evaluate(
    (sel) => document.querySelector(sel)?.dataset.id ?? null,
    FRONT,
  );

const waitFront = (page, id, timeout = 5000) =>
  page.waitForFunction(
    ([sel, want]) => {
      const el = document.querySelector(sel);
      return (
        !!el &&
        el.dataset.id === want &&
        getComputedStyle(el).display !== 'none'
      );
    },
    [FRONT, String(id)],
    { timeout },
  );

const diff = (a, b) => ({
  y: Math.abs(a.y - b.y),
  top: Math.abs(a.top - b.top),
  h: Math.abs(a.h - b.h),
  tg: Math.abs(a.tg - b.tg),
});
const fmtDiff = (d) =>
  `scrollY ${d.y.toFixed(1)}, section top ${d.top.toFixed(1)}, height ${d.h.toFixed(1)}, telegram top ${d.tg.toFixed(1)}`;
const within = (d, px) => Math.max(d.y, d.top, d.h, d.tg) <= px;

/** Runs inside the page: one sample per animation frame. */
function samplerScript() {
  const q = (window.__jp = {
    frames: [],
    stop: false,
    phase: '',
    watch: null,
    landedWall: 0,
    goneId: null,
    goneWall: 0,
    leaveSeen: {},
  });
  const tick = () => {
    if (q.stop) return;
    const live = [...document.querySelectorAll('li[data-jp-card]')].filter(
      (el) => getComputedStyle(el).display !== 'none',
    );
    const front = document.querySelector(
      'li[data-jp-card][data-d="0"]:not([data-leave])',
    );
    const fid = front?.dataset.id ?? null;
    for (const el of document.querySelectorAll('li[data-jp-card][data-leave]'))
      q.leaveSeen[el.dataset.id] = true;
    if (q.watch && !q.landedWall && fid === q.watch) q.landedWall = Date.now();
    if (
      q.goneId &&
      q.landedWall &&
      !q.goneWall &&
      !live.some((el) => el.dataset.id === q.goneId)
    )
      q.goneWall = Date.now();
    q.frames.push({
      t: performance.now(),
      y: scrollY,
      phase: q.phase,
      front: fid,
      n: live.length,
      cards: live.map((el) => {
        const cs = getComputedStyle(el);
        return [el.dataset.id, el.dataset.d, cs.transform, cs.opacity];
      }),
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
const startSampler = (page) => page.evaluate(samplerScript);
const stopSampler = (page) =>
  page.evaluate(() => {
    window.__jp.stop = true;
    return window.__jp;
  });

// ---------------------------------------------------------------------------
// Contact sheets

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

async function contactSheet(tiles, outPath, { cols, tw }) {
  const prepared = [];
  for (const t of tiles) {
    const { data, info } = await sharp(t.buf)
      .resize({ width: tw })
      .png()
      .toBuffer({ resolveWithObject: true });
    const label = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="22"><rect width="100%" height="100%" fill="#000" fill-opacity="0.75"/><text x="6" y="16" font-family="sans-serif" font-size="13" fill="#fff">${esc(t.label)}</text></svg>`,
    );
    prepared.push({ data, h: info.height, label });
  }
  const th = Math.max(...prepared.map((p) => p.h));
  const rows = Math.ceil(prepared.length / cols);
  const gap = 6;
  await sharp({
    create: {
      width: cols * tw + (cols + 1) * gap,
      height: rows * th + (rows + 1) * gap,
      channels: 3,
      background: '#222',
    },
  })
    .composite(
      prepared.flatMap((p, i) => {
        const left = gap + (i % cols) * (tw + gap);
        const top = gap + Math.floor(i / cols) * (th + gap);
        return [
          { input: p.data, left, top },
          { input: p.label, left, top },
        ];
      }),
    )
    .png()
    .toFile(outPath);
}

const shot = (page, name, size) =>
  page.screenshot({ path: join(OUT, `${name}-${size}.png`), scale: 'css' });
const secShot = (page, name, size) =>
  page
    .locator(SEC)
    .screenshot({ path: join(OUT, `${name}-${size}.png`), scale: 'css' });

// ---------------------------------------------------------------------------
// Scrolling

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
  // a pause before the lift leaves no fling behind
  await page.waitForTimeout(120);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await page.waitForTimeout(160);
}

/** One step of 100 px (240 px for a swipe) in dir; returns the method used. */
async function step(s, dir, method) {
  const { page } = s;
  if (method === 'wheel') {
    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, dir * 100);
    await page.waitForTimeout(34);
  } else if (method === 'touch') {
    if (dir > 0) await swipe(s, 200, 640, 200, 400);
    else await swipe(s, 200, 400, 200, 640);
  } else {
    await page.evaluate((d) => window.scrollBy(0, d * 100), dir);
    await page.waitForTimeout(34);
  }
}

const scrollY = (page) => page.evaluate(() => window.scrollY);

/** Scrolls from y=from down to y=to and back; returns the method used. */
async function scrollThrough(s, from, to) {
  const { page } = s;
  let method = s.cdp ? 'touch' : 'wheel';
  await page.evaluate((y) => window.scrollTo(0, y), from);
  await page.waitForTimeout(300);
  if (method === 'touch') {
    const y0 = await scrollY(page);
    await step(s, 1, 'touch');
    if ((await scrollY(page)) - y0 < 40) method = 'scrollBy';
  }
  for (const [phase, dir] of [
    ['down', 1],
    ['up', -1],
  ]) {
    await page.evaluate((p) => (window.__jp.phase = p), phase);
    for (let i = 0; i < 120; i++) {
      const y = await scrollY(page);
      if (dir > 0 ? y >= to - 4 : y <= from + 4) break;
      await step(s, dir, method);
    }
  }
  await page.waitForTimeout(200);
  return method;
}

// ---------------------------------------------------------------------------
// js-size

async function jsSizes() {
  const nextDir = join(ROOT, process.env.NEXT_DIST_DIR ?? '.next');
  if (!existsSync(nextDir)) {
    return [false, `no ${nextDir} folder next to this script`];
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
  const delta = (preview.gz - home.gz) / 1024;
  return [
    delta <= 15,
    `first-load JS gz: / ${(home.gz / 1024).toFixed(1)} KB (${home.n} scripts), /home-preview ${(preview.gz / 1024).toFixed(1)} KB (${preview.n}), delta ${delta.toFixed(1)} KB (target <= 15)`,
  ];
}

// ---------------------------------------------------------------------------
// One size

async function runSize(size, bodies) {
  const run = makeRun(size);
  const { report, check } = run;
  const cap = CAP[size];
  const tabsN = TABS[size];
  /** The feed's current All body; arrivals rewrite it. */
  const state = { all: bodies.all, pulls: bodies.all.pulls };
  let seq = 0;
  const arrive = async (page, n, watch = false, from = null) => {
    const src = from ?? state.pulls[0];
    const clones = Array.from({ length: n }, () => ({
      ...structuredClone(src),
      id: `qa-${Date.now()}-${++seq}`,
      rolledAt: new Date().toISOString(),
    }));
    state.pulls = [...clones, ...state.pulls.slice(0, state.pulls.length - n)];
    state.all = { ...bodies.all, pulls: state.pulls };
    if (watch)
      await page.evaluate((id) => (window.__jp.watch = id), clones[0].id);
    await page.evaluate(() =>
      document.dispatchEvent(new Event('visibilitychange')),
    );
    return clones;
  };

  // ---- main page: checks 1, 3, 4, 5
  const s = await openPage(size, bodies, state);
  const { page } = s;
  await loadFlow(s);
  // At the row the section is many screens away: nothing may be fetched yet.
  await page.waitForTimeout(1500);
  const atRow = page.jpReqs.length;
  await check('lazy', async () => {
    const html = await (await fetch(URL_3D)).text();
    const inHtml = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => /jp-drawer/.test(u));
    await intoFree(page);
    await page.waitForTimeout(500);
    const before = page.jpReqs.length;
    await putInView(page, SEC);
    await waitLive(page);
    const urls = [...new Set(page.jpReqs)];
    const name = urls[0]?.split('/').pop() ?? 'none';
    return [
      inHtml.length === 0 && atRow === 0 && urls.length >= 1,
      `initial script tags with jp-drawer: ${inHtml.length}; requested at the row: ${atRow}; requested ${urls.length} url(s) (${name}), ${before} before the section was approached; data-jp-live=1`,
    ];
  });
  await putInView(page);
  await shot(page, 'rest', size);

  await check('scroll-no-change', async () => {
    // The drawer's first rows are the server-rendered feed, which the frozen
    // routes cannot reach; its first poll swaps them for the frozen body. Make
    // that poll happen and land before sampling, so the stack already holds
    // the frozen rows.
    const polled = page
      .waitForResponse((r) => /\/api\/recent-pulls(\?|$)/.test(r.url()), {
        timeout: 15000,
      })
      .catch(() => null);
    await page.evaluate(() =>
      document.dispatchEvent(new Event('visibilitychange')),
    );
    await polled;
    await page.waitForTimeout(1200);
    const g = await page.evaluate(
      ([sec]) => {
        const r = document.querySelector(sec).getBoundingClientRect();
        return {
          top: r.top + scrollY,
          h: r.height,
          vh: innerHeight,
          docH: document.documentElement.scrollHeight,
        };
      },
      [SEC],
    );
    const from = Math.max(0, g.top - g.vh);
    const to = Math.min(g.top + g.h + g.vh, g.docH - g.vh);
    await startSampler(page);
    const method = await scrollThrough(s, from, to);
    const res = await stopSampler(page);
    const fr = res.frames;
    const fronts = {};
    const per = new Map();
    for (const f of fr) {
      (fronts[f.phase] ??= new Set()).add(f.front);
      for (const [id, d, tr, op] of f.cards) {
        if (!per.has(id)) per.set(id, new Set());
        per.get(id).add(`${d}|${tr}|${op}`);
      }
    }
    const changed = [...per].filter(([, v]) => v.size > 1).map(([id]) => id);
    const allFronts = new Set(
      [...Object.values(fronts)].flatMap((v) => [...v]),
    );
    const ys = fr.map((f) => f.y);
    return [
      fr.length >= 10 &&
        !!fronts.down &&
        !!fronts.up &&
        allFronts.size === 1 &&
        !allFronts.has(null) &&
        per.size > 0 &&
        changed.length === 0,
      `method ${method}; ${fr.length} frames, scrollY ${Math.round(Math.min(...ys))}..${Math.round(Math.max(...ys))}; front ids ${allFronts.size} (down ${fronts.down?.size ?? 0}, up ${fronts.up?.size ?? 0}); cards seen ${per.size}; cards that changed ${changed.length}`,
    ];
  });
  // the scroll sheet: 8 viewport shots across the section
  await check('scroll-sheet', async () => {
    const g = await page.evaluate(
      ([sec]) => {
        const r = document.querySelector(sec).getBoundingClientRect();
        return {
          top: r.top + scrollY,
          h: r.height,
          vh: innerHeight,
          docH: document.documentElement.scrollHeight,
        };
      },
      [SEC],
    );
    const from = Math.max(0, g.top - g.vh);
    const to = Math.min(g.top + g.h + g.vh, g.docH - g.vh);
    const tiles = [];
    const fronts = new Set();
    for (let i = 0; i < 8; i++) {
      await page.evaluate(
        (y) => window.scrollTo(0, y),
        from + ((to - from) * i) / 7,
      );
      await page.waitForTimeout(150);
      fronts.add(await frontId(page));
      tiles.push({
        buf: await page.screenshot({ type: 'jpeg', quality: 70, scale: 'css' }),
        label: `scrollY ${Math.round(await scrollY(page))}`,
      });
    }
    await contactSheet(tiles, join(OUT, `sheet-scroll-${size}.png`), {
      cols: 4,
      tw: size === 'phone' ? 195 : 360,
    });
    return [
      fronts.size === 1 && !fronts.has(null),
      `8 shots; front ids across them ${fronts.size}`,
    ];
  });

  await putInView(page);
  const settle = async () => {
    await page.waitForTimeout(1800);
    return liveCards(page);
  };
  const capOf = (res) => Math.max(0, ...res.frames.map((f) => f.n));

  await check('arrival-single', async () => {
    const pre = await liveCards(page);
    const kept = pre.filter((c) => !c.leave).sort((a, b) => a.d - b.d);
    const preFront = kept[0].id;
    const lastTab = kept.at(-1).id;
    const m0 = await measure(page);
    await startSampler(page);
    await page.evaluate((id) => (window.__jp.goneId = id), lastTab);
    // Frames from the page's screencast (every painted frame, wall-clock
    // stamped), cropped to the drawer afterwards.
    const box = await page.locator('[data-jp-drawer]').boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const shots = [];
    cdp.on('Page.screencastFrame', (f) => {
      shots.push({
        t: f.metadata.timestamp * 1000,
        buf: Buffer.from(f.data, 'base64'),
      });
      cdp
        .send('Page.screencastFrameAck', { sessionId: f.sessionId })
        .catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    await sleep(300);
    const fired = Date.now();
    // A pull from another tier, so the drop is visible in the frames.
    const other = Object.values(bodies.tier ?? {})
      .flatMap((b) => b?.pulls ?? [])
      .find((p) => p.id !== state.pulls[0].id);
    const [clone] = await arrive(page, 1, true, other ?? null);
    await sleep(1700);
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
    const vw = await page.evaluate(() => innerWidth);
    for (const s of shots) {
      const meta = await sharp(s.buf).metadata();
      const k = meta.width / vw;
      const pad = 8;
      s.buf = await sharp(s.buf)
        .extract({
          left: Math.max(0, Math.round((box.x - pad) * k)),
          top: Math.max(0, Math.round((box.y - pad) * k)),
          width: Math.min(
            meta.width - Math.max(0, Math.round((box.x - pad) * k)),
            Math.round((box.width + 2 * pad) * k),
          ),
          height: Math.min(
            meta.height - Math.max(0, Math.round((box.y - pad) * k)),
            Math.round((box.height + 2 * pad) * k),
          ),
        })
        .png()
        .toBuffer();
    }
    const res = await stopSampler(page);
    const post = await liveCards(page);
    const m1 = await measure(page);
    const d = diff(m0, m1);
    const front = await frontId(page);
    const prev = post.find((c) => c.id === preFront);
    const goneMs = res.goneWall ? res.goneWall - res.landedWall : -1;
    if (res.landedWall) {
      const targets = [0, 80, 160, 240, 320, 480, 640, 900];
      const tiles = targets.map((tg) => {
        const best = shots.reduce((a, b) =>
          Math.abs(b.t - res.landedWall - tg) <
          Math.abs(a.t - res.landedWall - tg)
            ? b
            : a,
        );
        return {
          buf: best.buf,
          label: `${tg} ms (frame at ${Math.round(best.t - res.landedWall)} ms)`,
        };
      });
      await contactSheet(tiles, join(OUT, `sheet-arrival-${size}.png`), {
        cols: 4,
        tw: size === 'phone' ? 260 : 360,
      });
    }
    return [
      front === clone.id &&
        prev?.d === '1' &&
        !prev.leave &&
        !post.some((c) => c.id === lastTab) &&
        res.goneWall > 0 &&
        goneMs <= 1500 &&
        post.length === pre.length &&
        capOf(res) <= cap &&
        within(d, 1),
      `front ${front === clone.id ? 'new id' : 'NOT the new id'}; old front d=${prev?.d}; oldest tab gone ${goneMs} ms after landing (data-leave seen: ${!!res.leaveSeen[lastTab]}); live ${pre.length} -> ${post.length}, max per frame ${capOf(res)} (cap ${cap}); ${res.frames.length} frames, landed ${res.landedWall ? res.landedWall - fired : 'never'} ms after the event; ${fmtDiff(d)}`,
    ];
  });

  await check('arrival-double', async () => {
    const pre = await settle();
    const m0 = await measure(page);
    await startSampler(page);
    const [c1, c2] = await arrive(page, 2);
    const post = await settle();
    const res = await stopSampler(page);
    const m1 = await measure(page);
    const d = diff(m0, m1);
    const front = await frontId(page);
    const second = post.find((c) => c.id === c2.id);
    return [
      front === c1.id &&
        second?.d === '1' &&
        post.length === pre.length &&
        capOf(res) <= cap &&
        within(d, 1),
      `front ${front === c1.id ? 'newest id' : 'NOT the newest id'}; second clone d=${second?.d}; live ${pre.length} -> ${post.length}, max per frame ${capOf(res)} (cap ${cap}); ${fmtDiff(d)}`,
    ];
  });

  await check('arrival-back-to-back', async () => {
    const pre = await settle();
    const m0 = await measure(page);
    await startSampler(page);
    await arrive(page, 1);
    await page.waitForTimeout(200);
    const [c2] = await arrive(page, 1);
    const post = await settle();
    const res = await stopSampler(page);
    const m1 = await measure(page);
    const d = diff(m0, m1);
    const front = await frontId(page);
    return [
      front === c2.id &&
        post.length === pre.length &&
        capOf(res) <= cap &&
        within(d, 1),
      `front ${front === c2.id ? 'second arrival' : 'NOT the second arrival'}; live ${pre.length} -> ${post.length}, max per frame ${capOf(res)} (cap ${cap}); ${fmtDiff(d)}`,
    ];
  });

  // ---- tabs
  const group = page.locator(
    '[role="group"][aria-label="Filter pulls by tier"]',
  );
  const tierCheck = (tier) =>
    check(`tab-${tier.toLowerCase()}`, async () => {
      await putInView(page);
      await group.getByRole('button', { name: tier, exact: true }).click();
      const pulls = bodies.tier[tier].pulls;
      const want = pulls[0]?.id;
      if (want === undefined) {
        await page.waitForSelector('[data-jp-empty]', { timeout: 5000 });
        return [true, 'the captured body has no pulls; the empty line shows'];
      }
      await waitFront(page, want);
      const live = await liveCards(page);
      const pressed = await group
        .getByRole('button', { name: tier, exact: true })
        .getAttribute('aria-pressed');
      if (tier === 'Immortal') await secShot(page, 'tab-immortal', size);
      return [
        live.length <= cap && pressed === 'true',
        `front is the first ${tier} pull (${want}); live ${live.length} (cap ${cap}); aria-pressed ${pressed}`,
      ];
    });
  await tierCheck('Immortal');
  await tierCheck('Legendary');
  await check('tab-mythical-empty', async () => {
    await group.getByRole('button', { name: 'Mythical', exact: true }).click();
    const empty = page.locator('[data-jp-empty]');
    await empty.waitFor({ state: 'visible', timeout: 5000 });
    const text = (await empty.innerText()).replace(/\s+/g, ' ').trim();
    await secShot(page, 'empty-mythical', size);
    return [text === EMPTY_TEXT, `"${text}"`];
  });
  await check('tab-stats', async () => {
    await group.locator('[aria-label="Stats"]').click();
    const stats = page.locator('[data-jp-stats]');
    await stats.waitFor({ state: 'visible', timeout: 5000 });
    const text = await stats.innerText();
    const live = await liveCards(page);
    await secShot(page, 'stats', size);
    return [
      /Avg:/.test(text) && live.length === 0,
      `stats visible, contains "Avg:" ${/Avg:/.test(text)}; live drawer cards ${live.length}`,
    ];
  });
  await check('tab-all', async () => {
    await group.getByRole('button', { name: 'All', exact: true }).click();
    const want = state.pulls[0].id;
    await waitFront(page, want);
    const live = await liveCards(page);
    const stats = await page.locator('[data-jp-stats]').count();
    return [
      live.length >= 1 && live.length <= cap && stats === 0,
      `drawer back, front ${want}; live ${live.length}; stats nodes ${stats}`,
    ];
  });
  if (s.page.errors.length)
    console.log(
      `page errors (${size}): ${s.page.errors.slice(0, 3).join(' | ')}`,
    );
  await s.ctx.close();

  // ---- check 2: the chunk held back, then released
  await check('swap-no-shift', async () => {
    const t = await openPage(size, bodies, { all: bodies.all });
    try {
      let release;
      const gate = new Promise((r) => (release = r));
      let held = 0;
      await t.ctx.route(/jp-drawer/, async (route) => {
        held++;
        await gate;
        await route.continue();
      });
      await loadFlow(t);
      await intoFree(t.page);
      await putInView(t.page, SEC);
      for (let i = 0; i < 100 && held === 0; i++) await sleep(100);
      if (held === 0) {
        release();
        return [
          false,
          'the chunk was never requested while the section was on screen',
        ];
      }
      await t.page.waitForTimeout(600);
      const m0 = await measure(t.page);
      const liveBefore = await t.page.locator(LIVE_ATTR).count();
      release();
      await waitLive(t.page);
      await t.page.waitForTimeout(400);
      const m1 = await measure(t.page);
      const d = diff(m0, m1);
      return [
        liveBefore === 0 && within(d, 1),
        `held ${held} request(s); live before release ${liveBefore}; ${fmtDiff(d)}`,
      ];
    } finally {
      await t.ctx.close();
    }
  });

  // ---- check 6: no JavaScript
  const plainList = async (t, name, html) => {
    const info = await t.page.evaluate(
      ([sec, card, counter]) => {
        const root = document.querySelector(sec);
        const cards = [...document.querySelectorAll(card)];
        const shown = cards.filter(
          (el) => getComputedStyle(el).display !== 'none',
        );
        const counters = [...document.querySelectorAll(counter)].filter(
          (el) => {
            const r = el.getBoundingClientRect();
            return (
              r.width > 0 &&
              r.height > 0 &&
              getComputedStyle(el).visibility !== 'hidden'
            );
          },
        );
        const r = root?.getBoundingClientRect();
        return {
          exists: !!root,
          total: cards.length,
          shown: shown.length,
          counters: counters.length,
          heading: /just pulled/i.test(root?.innerText ?? ''),
          h: r ? r.height : 0,
        };
      },
      [SEC, CARD, '[data-jp-counter]'],
    );
    const n =
      html === undefined
        ? info.total
        : (html.match(/<li[^>]*data-jp-card/g) ?? []).length;
    return [
      info.exists &&
        info.shown >= 1 &&
        info.shown === info.total &&
        info.total === n &&
        info.counters === 2 &&
        info.heading,
      `${name}: cards displayed ${info.shown} of ${info.total}${html === undefined ? '' : ` (server HTML ${n})`}; counters visible ${info.counters}; heading ${info.heading}; section height ${Math.round(info.h)}`,
    ];
  };
  await check('no-js', async () => {
    const t = await openPage(size, bodies, state, { javaScriptEnabled: false });
    try {
      const resp = await t.page.goto(URL_3D, { waitUntil: 'load' });
      const html = await resp.text();
      await t.page.locator(SEC).scrollIntoViewIfNeeded();
      await t.page.waitForTimeout(500);
      const out = await plainList(t, 'no JavaScript', html);
      await secShot(t.page, 'nojs', size);
      return out;
    } finally {
      await t.ctx.close();
    }
  });

  // ---- check 7: reduced motion
  await check('reduced-motion', async () => {
    const t = await openPage(size, bodies, state, { reducedMotion: 'reduce' });
    try {
      await t.page.goto(URL_3D, { waitUntil: 'load' });
      await reject(t.page);
      await t.page.locator(SEC).waitFor({ state: 'attached', timeout: 20000 });
      await putInView(t.page, SEC);
      const before = await plainList(t, 'before mount', undefined);
      await waitLive(t.page);
      await t.page.waitForTimeout(500);
      const after = await plainList(t, 'after mount', undefined);
      await secShot(t.page, 'reduced-motion', size);
      return [before[0] && after[0], `${before[1]}; ${after[1]}`];
    } finally {
      await t.ctx.close();
    }
  });

  // ---- check 8
  await check('js-size', jsSizes);

  writeFileSync(
    join(QA_DIR, `qa-just-pulled-${size}.txt`),
    run.lines.join('\n') + '\n',
  );
}

// ---------------------------------------------------------------------------

let bodies;
try {
  bodies = await captureBodies();
} catch (e) {
  console.error(`cannot capture the feed from ${BASE}: ${e.message}`);
  process.exit(2);
}
browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--mute-audio',
    '--disable-smooth-scrolling',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
try {
  for (const size of SIZES) await runSize(size, bodies);
} finally {
  await browser.close();
}
process.exitCode = failures ? 1 : 0;
