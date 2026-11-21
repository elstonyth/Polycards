// Top-row taps on the side packs (side-tap fix): a tap on a visible
// neighbour centres it within 1.5 s and does not open it; a second tap opens
// it; a sideways swipe that starts on a side pack moves the row and opens
// nothing; the discs and ArrowLeft/Right still step; a press on empty ground
// still swipes; the sold-out tile (if any); and the same taps after a lineup
// pick and a return to the row. --flat runs it with reduced motion.
//   node scripts/qa-home-row-tap.mjs <base> [--only=phone|desktop] [--flat]
// "Opens" here means what a tap on the centred pack does on the preview: the
// focus view comes on at /slots/<id>; the check then goes back to the row.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const BASE =
  args.find((a) => !a.startsWith('--')) ??
  process.env.PW_BASE ??
  'http://localhost:4300';
const ONLY = (args.find((a) => a.startsWith('--only=')) ?? '=').split('=')[1];
const FLAT = args.includes('--flat');
const OUT =
  process.env.QA_OUT ?? 'docs/research/home-3d/full-flow/checkpoints/row-tap';
const PREVIEW = '/home-preview';
const CENTRE_MS = 1500;
mkdirSync(OUT, { recursive: true });

let failures = 0;
const rows = [];
const report = (size, name, ok, detail) => {
  if (!ok) failures++;
  rows.push({ size, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${size} ${name}: ${detail}`);
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
  headless: true,
  args: [
    '--mute-audio',
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
  const ctx = await browser.newContext({
    ...PROFILES[size],
    ...(FLAT ? { reducedMotion: 'reduce' } : {}),
  });
  await ctx.addInitScript(mute);
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

/** The stage is ready (and, out of flat mode, the flow is on). */
async function ready(page) {
  await page.waitForFunction(
    (flat) =>
      window.__packStage?.ready?.() &&
      (flat ||
        (typeof window.__packStage.focus === 'function' &&
          window.__packStage.focus() !== null &&
          window.__packStage.flow?.().on)),
    FLAT,
    { timeout: 40000 },
  );
  await page.waitForTimeout(800);
}

async function load(s) {
  await s.page.goto(`${BASE}${PREVIEW}?stage=3d&debug=1&loader=never`, {
    waitUntil: 'load',
  });
  await reject(s.page);
  await ready(s.page);
}

/** The page's state: the row's track, the focus view, the address. */
const snap = (page) =>
  page.evaluate(() => {
    const ps = window.__packStage;
    const f = ps?.focus?.() ?? null;
    const fl = ps?.flow?.() ?? null;
    return {
      track: ps?.state?.track ?? null,
      on: !!f?.on,
      busy: !!fl?.busy,
      path: location.pathname,
      y: scrollY,
    };
  });

/** Waits until the track and the scroll are still (no move for 300 ms). */
async function rest(page, timeout = 6000) {
  const t0 = Date.now();
  let last = null;
  let still = 0;
  while (Date.now() - t0 < timeout) {
    const s = await snap(page);
    if (
      !s.busy &&
      last &&
      Math.abs(s.y - last.y) < 0.5 &&
      Math.abs((s.track ?? 0) - (last.track ?? 0)) < 1e-3
    )
      still++;
    else still = 0;
    last = s;
    if (still >= 3) break;
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(150);
  return snap(page);
}

/** A page-side watch: ms until the track is within 0.02 of index (null: not in ms). */
const watchCentre = (page, index, ms = 4000) =>
  page.evaluate(
    ([i, len]) =>
      new Promise((done) => {
        const t0 = performance.now();
        const tick = () => {
          const t = window.__packStage?.state?.track;
          const dt = performance.now() - t0;
          if (typeof t === 'number' && Math.abs(t - i) < 0.02) done(dt);
          else if (dt > len) done(null);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    [index, ms],
  );

/**
 * The visible tiles of the top row: index, id, sold out, and a point where
 * the tile's own art or label is the topmost element (null: none found).
 */
const tiles = (page) =>
  page.evaluate(() => {
    const vp = document.querySelector(
      '[data-stage-panel]:not([hidden]) [data-stage-viewport]',
    );
    if (!vp) return [];
    const W = innerWidth;
    const H = innerHeight;
    const centreIndex = Math.round(window.__packStage?.state?.track ?? 0);
    const name = (el) => {
      if (!el) return null;
      const t = el.closest('[data-stage-tile]');
      return el.tagName + (t ? '[tile ' + t.dataset.index + ']' : '');
    };
    const all = [...vp.querySelectorAll('[data-stage-tile]')].map((tile) => {
      const art = tile.querySelector('[data-stage-art]');
      const pose = tile.querySelector('[data-stage-pose]');
      // where the pack is drawn: the posed box (the art's own box is the flat slot)
      const r = (pose ?? art)?.getBoundingClientRect() ?? null;
      const op = pose ? Number(getComputedStyle(pose).opacity) : 0;
      const pe = pose ? getComputedStyle(pose).pointerEvents : 'none';
      const onScreen =
        !!r &&
        r.width > 2 &&
        r.right > 0 &&
        r.left < W &&
        r.bottom > 0 &&
        r.top < H;
      return {
        tile,
        art,
        label: tile.querySelector('[data-stage-label]'),
        index: Number(tile.dataset.index),
        r,
        visible: onScreen && op > 0.05 && pe !== 'none',
      };
    });
    const navs = [...vp.querySelectorAll('[data-stage-nav]')].map((n) =>
      n.getBoundingClientRect(),
    );
    const inside = (r, x, y) =>
      x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    return all
      .filter((t) => t.visible)
      .map((t) => {
        const { r } = t;
        // the part of the pack a person sees: not under a nearer pack's box
        const nearer = all.filter(
          (o) =>
            o.visible &&
            o !== t &&
            Math.abs(o.index - centreIndex) < Math.abs(t.index - centreIndex),
        );
        const seen = [];
        for (let gx = 1; gx < 16; gx++)
          for (let gy = 1; gy < 16; gy++) {
            const x = r.x + (r.width * gx) / 16;
            const y = r.y + (r.height * gy) / 16;
            if (x < 2 || y < 2 || x > W - 2 || y > H - 2) continue;
            if (nearer.some((o) => inside(o.r, x, y))) continue;
            if (navs.some((n) => inside(n, x, y))) continue;
            seen.push({ x, y });
          }
        let point = null;
        let hit = null;
        let own = false;
        if (seen.length) {
          const cx = seen.reduce((a, p) => a + p.x, 0) / seen.length;
          const cy = seen.reduce((a, p) => a + p.y, 0) / seen.length;
          const p = seen.reduce((b, q) =>
            Math.hypot(q.x - cx, q.y - cy) < Math.hypot(b.x - cx, b.y - cy)
              ? q
              : b,
          );
          point = { x: Math.round(p.x), y: Math.round(p.y) };
          const el = document.elementFromPoint(point.x, point.y);
          hit = name(el);
          own =
            !!el &&
            ((t.art && t.art.contains(el)) ||
              (t.label && t.label.contains(el)));
        }
        return {
          index: t.index,
          id: t.tile.dataset.packId,
          soldOut: t.tile.querySelector('[data-stage-hit]')?.tagName !== 'A',
          point,
          hit,
          own,
        };
      });
  });

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

/** A sideways drag of dx px from (x0, y0), 10 moves 16 ms apart. */
async function dragX(s, x0, y0, dx, hold = true) {
  const { page } = s;
  const moves = 10;
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
    if (hold) await page.waitForTimeout(200);
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
    if (hold) await page.waitForTimeout(200);
    await page.mouse.up();
  }
}

async function swipeUp(s) {
  const { cdp, page } = s;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 200, y: 380 }],
  });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: 200, y: 380 + (220 * i) / 8 }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
}

const shot = (page, size, name) =>
  page.screenshot({
    path: `${OUT}/${size}${FLAT ? '-flat' : ''}-${name}.png`,
  });
const at0 = (r) => Math.round(r.track ?? 0);
const fx = (v) => (typeof v === 'number' ? v.toFixed(3) : String(v));

/** The tap checks at the row; tag names the pass (row, after-pick). */
async function tapChecks(s, tag) {
  const { page, size } = s;
  let r = await rest(page);
  const centre0 = at0(r);
  let ts = await tiles(page);
  const neighbours = ts.filter((t) => t.index !== centre0);
  const soldOut = await page.evaluate(
    () =>
      document.querySelectorAll(
        '[data-stage-panel]:not([hidden]) [data-stage-tile] div[data-stage-hit]',
      ).length,
  );
  console.log(`INFO ${size} ${tag}: sold-out tiles in the row: ${soldOut}`);
  report(
    size,
    `${tag}: visible neighbours`,
    neighbours.length > 0,
    `centre ${centre0}; ${neighbours
      .map(
        (t) =>
          `${t.index}:${t.id}${t.own ? '' : ' (the seen centre hits ' + t.hit + ')'}`,
      )
      .join(', ')}`,
  );
  // each visible neighbour, nearest first: one tap centres, a second opens
  const order = [...new Set(neighbours.map((t) => t.index))].sort(
    (a, b) => Math.abs(a - centre0) - Math.abs(b - centre0),
  );
  let shotTaken = false;
  for (const idx of order) {
    r = await rest(page);
    const at = at0(r);
    ts = await tiles(page);
    const t = ts.find((x) => x.index === idx);
    if (!t || t.index === at) continue;
    const p = t.point;
    if (!p) continue;
    const w = watchCentre(page, idx);
    await tap(s, p.x, p.y);
    const ms = await w;
    r = await rest(page);
    report(
      size,
      `${tag}: tap neighbour ${idx} (${t.id}${t.soldOut ? ', sold out' : ''}) centres, not opened`,
      ms !== null && ms <= CENTRE_MS && !r.on && r.path === PREVIEW,
      `at (${p.x},${p.y})${t.own ? '' : ' [hits ' + t.hit + ']'} from ${at}: centred in ${ms === null ? 'never' : Math.round(ms) + ' ms'}; track ${fx(r.track)}; focus ${r.on}; ${r.path}`,
    );
    if (!shotTaken) {
      await shot(page, size, `${tag}-after-side-tap`);
      shotTaken = true;
    }
    if (ms === null) continue;
    ts = await tiles(page);
    const c = ts.find((x) => x.index === idx);
    const q = c?.point;
    if (!q) continue;
    await tap(s, q.x, q.y);
    await page.waitForTimeout(300);
    r = await rest(page);
    if (t.soldOut) {
      report(
        size,
        `${tag}: second tap on sold-out ${idx} does not open`,
        !r.on && r.path === PREVIEW,
        `focus ${r.on}; ${r.path}`,
      );
      continue;
    }
    report(
      size,
      `${tag}: second tap opens ${idx}`,
      // flat mode has no focus view: the link itself opens the pack page
      (r.on || FLAT) && r.path === `/slots/${encodeURIComponent(t.id)}`,
      `focus ${r.on}; ${r.path}`,
    );
    if (r.on || r.path !== PREVIEW) {
      await page.goBack();
      await page.waitForTimeout(400);
      r = await rest(page);
      if (r.on || r.path !== PREVIEW) {
        report(size, `${tag}: back to the row`, false, `${r.on} ${r.path}`);
        return;
      }
    }
  }
  // a sideways swipe that starts on a side pack moves the row, opens nothing
  r = await rest(page);
  let at = at0(r);
  ts = await tiles(page);
  const side =
    ts.find((t) => t.index === at + 1 && t.point) ??
    ts.find((t) => t.index === at - 1 && t.point);
  if (side) {
    const dx = (side.index > at ? -1 : 1) * (size === 'phone' ? 90 : 160);
    await dragX(s, side.point.x, side.point.y, dx);
    await page.waitForTimeout(200);
    r = await rest(page);
    report(
      size,
      `${tag}: swipe from side pack ${side.index} moves the row, opens nothing`,
      at0(r) !== at && !r.on && r.path === PREVIEW,
      `from (${side.point.x},${side.point.y}) dx ${dx}: track ${at} -> ${fx(r.track)}; focus ${r.on}; ${r.path}`,
    );
  } else
    report(
      size,
      `${tag}: swipe from a side pack`,
      false,
      'no side pack with its own point',
    );
  // the previous and next discs
  for (const [label, d] of [
    ['Next', 1],
    ['Previous', -1],
  ]) {
    r = await rest(page);
    at = at0(r);
    const btn = page.locator(
      `[data-stage-panel]:not([hidden]) [data-stage-nav][aria-label^="${label}"]`,
    );
    const b = await btn.boundingBox().catch(() => null);
    if (!b) {
      report(size, `${tag}: ${label} disc`, false, 'not found');
      continue;
    }
    const disabled = (await btn.getAttribute('aria-disabled')) === 'true';
    await tap(s, b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(200);
    r = await rest(page);
    const got = at0(r) - at;
    report(
      size,
      `${tag}: ${label} disc steps`,
      disabled ? got === 0 : got === d && !r.on,
      `track ${at} -> ${fx(r.track)}${disabled ? ' (disc disabled)' : ''}; focus ${r.on}`,
    );
  }
  // ArrowLeft/Right on the centred tile
  for (const [k, d] of [
    ['ArrowRight', 1],
    ['ArrowLeft', -1],
  ]) {
    r = await rest(page);
    at = at0(r);
    await page.evaluate((i) => {
      document
        .querySelector(
          `[data-stage-panel]:not([hidden]) [data-stage-tile][data-index="${i}"] [data-stage-hit]`,
        )
        ?.focus({ preventScroll: true });
    }, at);
    await page.keyboard.press(k);
    await page.waitForTimeout(200);
    r = await rest(page);
    report(
      size,
      `${tag}: ${k} steps`,
      at0(r) - at === d && !r.on,
      `track ${at} -> ${fx(r.track)}; focus ${r.on}`,
    );
  }
  // a press on empty ground between packs still swipes the row
  r = await rest(page);
  at = at0(r);
  const ground = await page.evaluate(() => {
    const vp = document.querySelector(
      '[data-stage-panel]:not([hidden]) [data-stage-viewport]',
    );
    const c = vp
      ?.querySelector('[data-stage-tile] [data-stage-art]')
      ?.getBoundingClientRect();
    if (!vp || !c) return null;
    const empty = (el) =>
      !!el &&
      vp.contains(el) &&
      !el.closest('[data-stage-art]') &&
      !el.closest('[data-stage-label]') &&
      !el.closest('[data-stage-nav]');
    for (const y of [c.y + c.height / 2, c.y + c.height * 0.9, c.bottom + 8])
      for (let x = innerWidth * 0.25; x < innerWidth * 0.75; x += 6) {
        const el = document.elementFromPoint(x, y);
        if (empty(el))
          return {
            x: Math.round(x),
            y: Math.round(y),
            mid: x > innerWidth / 2,
            el:
              el.tagName + (el.closest('[data-stage-tile]') ? ' in tile' : ''),
          };
      }
    return null;
  });
  if (ground) {
    const dx = ground.mid ? -160 : 160;
    await dragX(s, ground.x, ground.y, dx);
    await page.waitForTimeout(200);
    r = await rest(page);
    report(
      size,
      `${tag}: press on empty ground swipes the row`,
      at0(r) !== at && !r.on,
      `from (${ground.x},${ground.y}) on ${ground.el}, dx ${dx}: track ${at} -> ${fx(r.track)}; focus ${r.on}`,
    );
  } else
    report(
      size,
      `${tag}: press on empty ground`,
      false,
      'no empty point found in the viewport',
    );
}

/** To the lineup (End), a 200 px pick, then up to the row gesture by gesture. */
async function pickAndReturn(s) {
  const { page, size } = s;
  // a touch leaves focus on a tile, where End would page the row instead
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('End');
  await page.waitForTimeout(200);
  let r = await rest(page);
  await page.waitForTimeout(600);
  const before = await page.evaluate(
    () => window.__packStage.state.focusOn?.ctx?.index ?? null,
  );
  await dragX(
    s,
    size === 'phone' ? 330 : 1100,
    size === 'phone' ? 520 : 470,
    -200,
  );
  const t0 = Date.now();
  let moving = true;
  while (moving && Date.now() - t0 < 15000) {
    await page.waitForTimeout(60);
    moving = await page.evaluate(() => {
      const ln = window.__packStage.flow().line;
      return !!(ln?.moving || ln?.pending);
    });
  }
  await page.waitForTimeout(400);
  const picked = await page.evaluate(() => ({
    index: window.__packStage.state.focusOn?.ctx?.index ?? null,
    id: window.__packStage.state.focusOn?.id ?? null,
  }));
  await shot(page, size, 'lineup-picked');
  for (let k = 0; k < 16; k++) {
    r = await snap(page);
    if (!r.on && r.y < 2) break;
    if (s.cdp) await swipeUp(s);
    else {
      await page.mouse.move(720, 450);
      await page.mouse.wheel(0, -120);
    }
    await page.waitForTimeout(250);
    r = await rest(page);
  }
  r = await rest(page);
  report(
    size,
    'lineup pick, then back to the row: the pick carries',
    !r.on && picked.index !== null && at0(r) === picked.index,
    `lineup ${before} -> ${picked.index} (${picked.id}); row track ${fx(r.track)}; focus ${r.on}; ${r.path}; scrollY ${Math.round(r.y)}`,
  );
  await shot(page, size, 'row-after-pick');
}

const sizes = ONLY ? [ONLY] : ['phone', 'desktop'];
for (const size of sizes) {
  const s = await open(size);
  try {
    await load(s);
    await shot(s.page, size, 'row');
    await tapChecks(s, 'row');
    const flowOn = await s.page.evaluate(
      () => !!window.__packStage.flow?.().on,
    );
    if (FLAT)
      console.log(
        `INFO ${size} flat: ${JSON.stringify(
          await s.page.evaluate(() => ({
            mode: window.__packStage.mode?.(),
            flowOn: !!window.__packStage.flow?.().on,
            focus: window.__packStage.focus?.() ?? null,
            tiles: document.querySelectorAll(
              '[data-stage-panel]:not([hidden]) [data-stage-tile]',
            ).length,
          })),
        )}`,
      );
    if (flowOn) {
      await pickAndReturn(s);
      await tapChecks(s, 'after-pick');
    }
    report(
      size,
      'no page errors',
      s.page.errors.length === 0,
      s.page.errors.join(' / ') || 'none',
    );
  } catch (e) {
    report(size, 'run', false, String(e).slice(0, 300));
  }
  await s.ctx.close();
}
await browser.close();

const md = [
  `base ${BASE}${FLAT ? ' (reduced motion)' : ''}`,
  '',
  '| size | check | result | detail |',
  '|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.size} | ${r.name} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.detail.replaceAll('|', '/')} |`,
  ),
].join('\n');
writeFileSync(`${OUT}/row-tap${FLAT ? '-flat' : ''}.md`, md + '\n');
console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
