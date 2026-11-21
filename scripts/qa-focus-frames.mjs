// Per-frame QA of the focused pack view on /home-preview (production server
// with HOME_PREVIEW=1): every animation frame of the enter, every stop move
// and the leave from every stop is sampled in the page, on a phone
// (390x844) and a desktop (1440x900) profile. Headless Chrome, muted
// (--mute-audio plus a media guard), logged out; only the cookie banner's
// "Reject" is ever clicked. The pointer moves before every gesture, as a
// visitor's does.
//
//   node scripts/qa-focus-frames.mjs [baseUrl] [--slug=151] [--tab=Poly] [--only=phone|desktop] [--headed]
//
// --headed: system Chrome on the real GPU, the window parked off-screen and
// kept painting (no ?stage=3d override); adds the frame-time limit.
//
// Fails when, at any sampled frame while a pack is focused:
// - another pack of the row (its picture or its 3D model) has opacity above 0
//   once the focus has left the row (focus >= NEIGHBOUR_GONE_AT), is drawn in
//   front of the focused pack, or any stop text is showing while another
//   pack is;
// - the other packs' opacity steps by more than RAMP_STEP between two frames
//   (they fade with the move, never cut);
// - on the tap and on the leave, the focused pack's scale or centre goes
//   backwards, or steps between two frames by more than the move's curve
//   (1.5 s ease-out cubic) allows for the time that passed;
// - (--headed) a frame of any move takes longer than 33 ms;
// - a block's heading is hidden while the rest of its block still shows
//   (a block fades as one piece, both ways);
// - the Front block shows while leaving from another stop;
// - a scroll entry at the row strays from the tap's curve;
// - past Closing the panel fades, the page's content comes
//   into view over the hand-off, another pack is cut in rather than faded,
//   a stop block still shows at the lineup, or the move does not land on the
//   lineup; an up wheel from the free part does not rest on the lineup, or
//   the next up gesture does not rest on Closing.
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const BASE =
  args.find((a) => !a.startsWith('--')) ??
  process.env.PW_BASE ??
  'http://localhost:4300';
const opt = (k, d) =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split('=')[1];
// --slug defaults to 151, or with --tab to the centred pack of that tab
const SLUG_ARG = opt('slug', '');
let SLUG = SLUG_ARG || '151';
const TAB = opt('tab', '');
const ONLY = opt('only', '');
/** The focus value by which the row's other packs must be gone. */
const NEIGHBOUR_GONE_AT = 0.8;
/** The shortest the other packs may take to go (tap) or come back (leave). */
const RAMP_MS = 450;
/** On the leave the other packs are fully back within this of the pack landing. */
const BACK_AFTER_LAND_MS = 150;
/** Largest change of another pack's opacity between two frames. */
const RAMP_STEP = 0.15;
/** The focus moves' length (focus-poses.json framingChangeMs). */
const MOVE_MS = 1500;
const HEADED = args.includes('--headed');
const FRAME_MS = 33;

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

const PROFILES = {
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};

/** Installed in the page: samples every animation frame into window.__frames. */
function sampler() {
  const w = window;
  w.__frames = [];
  w.__leaveFrom = 0;
  const opacityChain = (el, stop) => {
    let o = 1;
    for (let e = el; e && e !== stop.parentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || cs.display === 'none') return 0;
      o *= Number(cs.opacity);
    }
    return o;
  };
  const tick = (ts) => {
    const ps = w.__packStage;
    const st = ps?.state;
    const fr = ps?.focus?.();
    if (st && fr && w.__sampling) {
      const index = st.focusOn?.ctx?.index ?? w.__focusIndex ?? null;
      const tiles = [
        ...document.querySelectorAll(
          '[data-stage-panel]:not([hidden]) [data-stage-tile]',
        ),
      ];
      const css = [];
      // light (the real-GPU pass): no DOM reads, which would force style and
      // layout every frame and skew the frame times; the canvas packs only
      for (const t of w.__light ? [] : tiles) {
        const i = Number(t.getAttribute('data-index'));
        if (i === index) continue;
        const img = t.querySelector('img');
        const o = img ? opacityChain(img, t) : 0;
        if (o > 0.001)
          css.push([t.getAttribute('data-pack-id'), +o.toFixed(3)]);
      }
      const all = ps.runtime?.()?.drawn ?? [];
      const focused = all.find((d) => d.index === index) ?? null;
      const drawn = all
        .filter((d) => d.index !== index && d.opacity > 0.001)
        .map((d) => [d.id, +d.opacity.toFixed(3), d.z, d.x]);
      const blocks = [];
      for (const s of w.__light
        ? []
        : document.querySelectorAll(
            '[data-testid="focus-stops"] > section[data-kind]',
          )) {
        const o = opacityChain(s, s);
        if (o < 0.01) continue;
        const h = s.querySelector('h2');
        const line = h?.firstElementChild;
        // every block's heading is an h2 around a span; missing either reads as hidden
        let head = 0;
        if (h && line) {
          const hb = h.getBoundingClientRect();
          const lb = line.getBoundingClientRect();
          const inside =
            Math.max(
              0,
              Math.min(hb.bottom, lb.bottom) - Math.max(hb.top, lb.top),
            ) / Math.max(1, lb.height);
          head = o * inside;
        }
        blocks.push([
          s.getAttribute('data-kind'),
          +o.toFixed(3),
          +head.toFixed(3),
        ]);
      }
      // the tiles' resting art boxes (they hold their row place in focus):
      // with the drawn x of the same packs they map the canvas to the page
      const rects = [];
      for (const t of w.__light ? [] : tiles) {
        const r = t.querySelector('[data-stage-art]')?.getBoundingClientRect();
        if (r)
          rects.push([
            t.getAttribute('data-pack-id'),
            (r.left + r.right) / 2,
            r.width,
          ]);
      }
      const root = w.__light
        ? null
        : document.querySelector('[data-stage-root]');
      const rcs = root ? getComputedStyle(root) : null;
      w.__frames.push({
        // the panel's own opacity (the fade past Closing), 0 once hidden
        // null when the root is not found (the light pass reads no DOM: 1)
        panelOp: rcs
          ? rcs.visibility === 'hidden'
            ? 0
            : Number(rcs.opacity)
          : w.__light
            ? 1
            : null,
        y: scrollY,
        // the page's first section below the stage, against the viewport
        openTop: w.__light
          ? null
          : (document
              .querySelector('[data-flow-section]')
              ?.getBoundingClientRect().top ?? null),
        vh: innerHeight,
        // the frame time the stage posed this frame with
        t: ts,
        // the frame time the canvas posed what it drew (its own clock)
        at: focused?.at ?? all[0]?.at ?? ts,
        on: !!fr.on,
        f: fr.on ? st.focus : 0,
        foc: focused,
        busy: fr.busy,
        leaveFrom: w.__leaveFrom,
        css,
        drawn,
        blocks,
        rects,
        vw: innerWidth,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const browser = await chromium.launch(
  HEADED
    ? {
        channel: 'chrome',
        headless: false,
        args: [
          '--mute-audio',
          '--window-position=-32000,-32000',
          '--window-size=1600,1000',
          '--disable-features=CalculateNativeWinOcclusion',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
        ],
      }
    : {
        channel: 'chrome',
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
      },
);

async function settle(page, k) {
  await page.waitForFunction(
    (kk) => {
      const f = window.__packStage.focus();
      return f && f.on && !f.busy && Math.abs(f.focus - kk) < 1e-3;
    },
    k,
    { timeout: 10000 },
  );
  await page.waitForTimeout(700);
}
async function left(page) {
  await page.waitForFunction(() => !window.__packStage.focus()?.on, null, {
    timeout: 10000,
  });
  await page.waitForTimeout(400);
}

function judge(name, all, curve = null, blocksExpected = false) {
  const bad = {
    neighbour: [],
    textOverPack: [],
    heading: [],
    front: [],
    ramp: [],
    inFront: [],
    curve: [],
    slow: [],
  };
  // the other packs' opacity, frame to frame (the frame before the focus too)
  const first = Math.max(0, all.findIndex((fr) => fr.on) - 1);
  const seq = all.slice(first);
  const op = (fr) => {
    const m = new Map();
    for (const [id, o] of [...fr.css, ...fr.drawn])
      m.set(id, Math.max(m.get(id) ?? 0, o));
    return m;
  };
  for (let i = 1; i < seq.length; i++) {
    const a = op(seq[i - 1]);
    const b = op(seq[i]);
    // per 60 fps frame of the canvas's own clock (a slow frame may step more)
    const span = Math.max(1, (seq[i].at - seq[i - 1].at) / (1000 / 60));
    for (const id of new Set([...a.keys(), ...b.keys()])) {
      const d = Math.abs((b.get(id) ?? 0) - (a.get(id) ?? 0));
      if (d > RAMP_STEP * span)
        bad.ramp.push(
          `${id} ${(a.get(id) ?? 0).toFixed(2)} -> ${(b.get(id) ?? 0).toFixed(2)} at f=${seq[i].f.toFixed(3)}`,
        );
    }
    const dt = seq[i].t - seq[i - 1].t;
    // frames drawn while the pack moves (the frame after a move lands, where
    // the focus is cleaned up, is reported apart as the end frame)
    if (HEADED && seq[i].busy && dt > FRAME_MS)
      bad.slow.push(`${dt.toFixed(1)} ms at f=${seq[i].f.toFixed(3)}`);
    else if (HEADED && !seq[i].busy && seq[i - 1].busy && dt > FRAME_MS)
      console.log(
        `INFO ${name}-end-frame: ${dt.toFixed(1)} ms, after the move landed`,
      );
  }
  // the focused pack along the tap's or the leave's curve
  if (curve) {
    // one sample per pose the canvas drew, on the canvas's own clock
    const mv = seq.filter(
      (fr, i) => fr.foc && (i === 0 || fr.foc.at !== seq[i - 1].foc?.at),
    );
    const s0 = mv[0]?.foc;
    const s1 = mv.at(-1)?.foc;
    if (s0 && s1) {
      const span = {
        scale: Math.abs(s1.scale - s0.scale),
        pos: Math.hypot(s1.x - s0.x, s1.y - s0.y),
      };
      // ease-out cubic: the steepest slope is 3 / MOVE_MS of the span
      const allow = (dt, v) => ((v * 3 * dt) / MOVE_MS) * 1.3 + v * 0.01;
      for (let i = 1; i < mv.length; i++) {
        const a = mv[i - 1].foc;
        const b = mv[i].foc;
        const dt = mv[i].foc.at - mv[i - 1].foc.at;
        const ds = b.scale - a.scale;
        const want =
          curve === 'enter'
            ? Math.sign(s1.scale - s0.scale)
            : Math.sign(s1.scale - s0.scale);
        if (ds * want < -span.scale * 0.01)
          bad.curve.push(
            `scale went back ${a.scale.toFixed(3)} -> ${b.scale.toFixed(3)}`,
          );
        if (Math.abs(ds) > allow(dt, span.scale))
          bad.curve.push(
            `scale step ${Math.abs(ds).toFixed(3)} in ${dt.toFixed(0)} ms (curve allows ${allow(dt, span.scale).toFixed(3)}) at f=${mv[i].f.toFixed(3)}`,
          );
        const dp = Math.hypot(b.x - a.x, b.y - a.y);
        if (dp > allow(dt, span.pos))
          bad.curve.push(
            `centre step ${dp.toFixed(3)} in ${dt.toFixed(0)} ms (curve allows ${allow(dt, span.pos).toFixed(3)}) at f=${mv[i].f.toFixed(3)}`,
          );
      }
    } else bad.curve.push('the focused pack was not drawn');
  }
  const frames = all.filter((fr) => fr.on);
  for (const fr of frames) {
    const others = [...fr.css, ...fr.drawn];
    for (const [id, o, z] of fr.drawn)
      if (fr.foc && o > 0 && z > fr.foc.z + 1e-6)
        bad.inFront.push(`${id} at f=${fr.f.toFixed(3)}`);
    if (others.length > 0 && fr.f >= NEIGHBOUR_GONE_AT)
      bad.neighbour.push(`f=${fr.f.toFixed(3)} ${JSON.stringify(others)}`);
    if (others.length > 0 && fr.blocks.length > 0)
      bad.textOverPack.push(
        `f=${fr.f.toFixed(3)} ${JSON.stringify(fr.blocks)} over ${JSON.stringify(others)}`,
      );
    for (const [kind, o, head] of fr.blocks)
      // a block that reads (a quarter opacity or more) with its heading
      // less than half shown
      if (o >= 0.25 && head < o * 0.5)
        bad.heading.push(
          `f=${fr.f.toFixed(3)} ${kind} block ${o} heading ${head}`,
        );
    if (fr.leaveFrom > 1 && fr.blocks.some(([k]) => k === 'front'))
      bad.front.push(
        `f=${fr.f.toFixed(3)} from stop ${fr.leaveFrom}: ${JSON.stringify(fr.blocks)}`,
      );
  }
  const n = frames.length;
  // a walk through the stops shows blocks; none sampled means the block selector found nothing (the light pass reads none)
  const noBlocks = !HEADED && !frames.some((fr) => fr.blocks.length > 0);
  const show = (a) =>
    `${a.length}/${n} frames${a.length ? `; first: ${a[0]}` : ''}`;
  report(
    `${name}-no-other-pack`,
    bad.neighbour.length === 0,
    show(bad.neighbour),
  );
  report(
    `${name}-no-text-over-a-pack`,
    bad.textOverPack.length === 0,
    show(bad.textOverPack),
  );
  report(
    `${name}-heading-with-its-block`,
    bad.heading.length === 0 && (!noBlocks || !blocksExpected),
    (blocksExpected && noBlocks
      ? 'no element matches [data-testid="focus-stops"] > section[data-kind]; '
      : '') + show(bad.heading),
  );
  report(
    `${name}-no-front-block-leaving-later`,
    bad.front.length === 0,
    show(bad.front),
  );
  report(`${name}-others-fade-not-cut`, bad.ramp.length === 0, show(bad.ramp));
  report(
    `${name}-nothing-in-front-of-the-pack`,
    bad.inFront.length === 0,
    show(bad.inFront),
  );
  if (curve)
    report(
      `${name}-pack-follows-the-curve`,
      bad.curve.length === 0,
      show(bad.curve),
    );
  // the other packs go (tap) or come back (leave) over a stretch of the move,
  // not in a few frames: at least RAMP_MS from the first frame they change to
  // the frame they are gone (or fully back)
  if (curve) {
    const vis = seq.map((fr) => ({
      t: fr.t,
      v: Math.max(0, ...[...op(fr).values()]),
    }));
    let t0 = null;
    let t1 = null;
    for (const { t, v } of vis) {
      if (t0 === null) {
        if (curve === 'enter' ? v < 0.99 : v > 0.01) t0 = t;
      } else if (curve === 'enter' ? v <= 0.001 : v >= 0.99) {
        t1 = t;
        break;
      }
    }
    const len = t0 !== null && t1 !== null ? t1 - t0 : null;
    report(
      `${name}-others-${curve === 'enter' ? 'leave' : 'return'}-over-${RAMP_MS}-ms-or-more`,
      len !== null && len >= RAMP_MS,
      len === null ? 'no complete ramp seen' : `${Math.round(len)} ms`,
    );
  }
  // the leave: the other packs come back with it, with no beat where the pack
  // is alone. On the canvas's own clock, another pack is first seen on the
  // page no later than the pose that has made 90% of the pack's change of
  // size, and they are all fully back within BACK_AFTER_LAND_MS of the pose
  // that lands (99%).
  if (curve === 'leave') {
    const mv = seq.filter(
      (fr, i) => fr.foc && (i === 0 || fr.foc.at !== seq[i - 1].foc?.at),
    );
    const s0 = mv[0]?.foc.scale;
    const s1 = mv.at(-1)?.foc.scale;
    const span = s0 !== undefined && s1 !== undefined ? Math.abs(s1 - s0) : 0;
    const done = (fr) => Math.abs(fr.foc.scale - s0) / span;
    const at90 = span > 0 ? mv.find((fr) => done(fr) >= 0.9) : undefined;
    const landed = span > 0 ? mv.find((fr) => done(fr) >= 0.99) : undefined;
    const vis = (fr) => Math.max(0, ...[...op(fr).values()]);
    // seen: 16 px or more of another pack inside the page, at a fifth
    // opacity or more. Page x of a drawn pack: a line through the focused
    // pack and a neighbour at rest (drawn x against their tiles' boxes).
    const rest = [...seq]
      .reverse()
      .find((fr) => fr.foc && fr.drawn.some(([, o]) => o >= 0.99));
    const box = new Map((rest?.rects ?? []).map(([id, c, w]) => [id, [c, w]]));
    const fid = rest?.foc.id;
    const nb = rest?.drawn.find(([id, o]) => o >= 0.99 && box.has(id));
    let toPage = null;
    if (rest && box.has(fid) && nb && Math.abs(nb[3] - rest.foc.x) > 1e-6) {
      const k = (box.get(nb[0])[0] - box.get(fid)[0]) / (nb[3] - rest.foc.x);
      const a = box.get(fid)[0] - k * rest.foc.x;
      toPage = (x) => a + k * x;
    }
    const inside = (fr, [id, , , x]) => {
      const b = box.get(id);
      if (!toPage || !b) return 0;
      const c = toPage(x);
      return Math.max(
        0,
        Math.min(fr.vw, c + b[1] / 2) - Math.max(0, c - b[1] / 2),
      );
    };
    const seen = seq.find((fr) =>
      fr.drawn.some((d) => d[1] >= 0.2 && inside(fr, d) >= 16),
    );
    const back = seq.find((fr) => vis(fr) >= 0.99);
    report(
      `${name}-others-seen-by-90-percent-of-the-size-change`,
      !!(at90 && seen && seen.at <= at90.at),
      at90 && seen
        ? `first seen ${Math.round(seen.at - at90.at)} ms from the 90% pose`
        : 'not seen',
    );
    report(
      `${name}-others-back-within-${BACK_AFTER_LAND_MS}-ms-of-landing`,
      !!(landed && back && back.at - landed.at <= BACK_AFTER_LAND_MS),
      landed && back
        ? `fully back ${Math.round(back.at - landed.at)} ms after the pack landed`
        : 'not back',
    );
  }
  // the tap and the leave are held to the limit; stop moves are reported
  if (HEADED && curve)
    report(
      `${name}-frames-under-${FRAME_MS}-ms`,
      bad.slow.length === 0,
      show(bad.slow),
    );
  else if (HEADED)
    console.log(`INFO ${name}-frames-over-${FRAME_MS}-ms: ${show(bad.slow)}`);
}

for (const size of ['phone', 'desktop']) {
  if (ONLY && ONLY !== size) continue;
  const ctx = await browser.newContext(PROFILES[size]);
  await ctx.addInitScript(mute);
  await ctx.addInitScript(sampler);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(
    `${BASE}/home-preview?${HEADED ? '' : 'stage=3d&'}debug=1&loader=never`,
    {
      waitUntil: 'load',
    },
  );
  const rej = page.getByRole('button', { name: 'Reject', exact: true });
  await rej
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => rej.click())
    .catch(() => {});
  await page.waitForFunction(
    () =>
      window.__packStage?.ready?.() &&
      typeof window.__packStage.focus === 'function',
    null,
    { timeout: 40000 },
  );
  await page.waitForTimeout(3200);
  if (TAB) {
    await page.getByRole('button', { name: new RegExp(`^${TAB}$`) }).click();
    await page.waitForTimeout(2500);
    if (!SLUG_ARG) {
      const centred = await page.evaluate(() => {
        const i = Math.round(window.__packStage.state.track);
        return document
          .querySelector(
            `[data-stage-panel]:not([hidden]) [data-stage-tile][data-index="${i}"]`,
          )
          ?.getAttribute('data-pack-id');
      });
      if (!centred) throw new Error(`no centred tile on the ${TAB} tab`);
      SLUG = centred;
    }
  }
  // centre the pack
  for (let i = 0; i < 8; i++) {
    const at = await page.evaluate((s) => {
      const t = document.querySelector(
        `[data-stage-panel]:not([hidden]) [data-stage-tile][data-pack-id="${s}"]`,
      );
      return t
        ? [
            Number(t.getAttribute('data-index')),
            Math.round(window.__packStage.state.track),
          ]
        : null;
    }, SLUG);
    if (!at) throw new Error(`no tile ${SLUG}`);
    if (at[0] === at[1]) break;
    await page.keyboard.press('Escape');
    const label = at[0] > at[1] ? /next/i : /previous/i;
    await page
      .locator('[data-stage-panel]:not([hidden]) button[aria-label]')
      .filter({ has: page.locator(':scope') })
      .evaluateAll((bs, src) => {
        const re = new RegExp(src, 'i');
        bs.find((b) => re.test(b.getAttribute('aria-label') ?? ''))?.click();
      }, label.source);
    await page.waitForTimeout(900);
  }
  const art = page.locator(
    `[data-stage-panel]:not([hidden]) [data-stage-tile][data-pack-id="${SLUG}"] [data-stage-art]`,
  );
  const box = await art.boundingBox();
  const cdp = size === 'phone' ? await ctx.newCDPSession(page) : null;
  const V = PROFILES[size].viewport;
  const wiggle = async () => {
    if (cdp || args.includes('--still')) return;
    await page.mouse.move(V.width * 0.4, V.height * 0.45, { steps: 3 });
    await page.mouse.move(V.width * 0.55, V.height * 0.5, { steps: 3 });
  };
  const next = async () => {
    if (cdp) {
      const [x, y] = [200, 600];
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y }],
      });
      for (let i = 1; i <= 8; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: y - (220 * i) / 8 }],
        });
        await page.waitForTimeout(12);
      }
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
    } else {
      await wiggle();
      await page.mouse.wheel(0, 120);
    }
  };
  const tap = async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  const frames = async (fn) => {
    await page.evaluate((light) => {
      window.__frames = [];
      window.__sampling = true;
      window.__light = light;
    }, HEADED);
    await fn();
    return page.evaluate(() => {
      window.__sampling = false;
      return window.__frames;
    });
  };
  const index = await page.evaluate(
    (s) =>
      Number(
        document
          .querySelector(
            `[data-stage-panel]:not([hidden]) [data-stage-tile][data-pack-id="${s}"]`,
          )
          ?.getAttribute('data-index'),
      ),
    SLUG,
  );
  await page.evaluate((i) => {
    window.__focusIndex = i;
  }, index);

  // enter by scroll: one notch or swipe at the row focuses the centred pack
  // on the tap's curve
  const scrollIn = await frames(async () => {
    await page.waitForTimeout(300);
    await next();
    await page.waitForFunction(() => window.__packStage.focus()?.on, null, {
      timeout: 8000,
    });
    await settle(page, 1);
  });
  judge(`${size}-scroll-entry`, scrollIn, 'enter');
  await wiggle();
  await page.keyboard.press('Escape');
  await left(page);
  await page.waitForTimeout(600);

  // enter and walk every stop by one gesture each
  let kinds = [];
  const zoom = await frames(async () => {
    await page.waitForTimeout(300);
    await tap();
    kinds = await page
      .waitForFunction(
        () =>
          window.__packStage.focus()?.on && window.__packStage.focus().kinds,
        null,
        {
          timeout: 8000,
        },
      )
      .then((h) => h.jsonValue());
    await settle(page, 1);
  });
  judge(`${size}-tap`, zoom, 'enter');
  const walk = await frames(async () => {
    for (let k = 2; k <= kinds.length; k++) {
      await next();
      await settle(page, k);
    }
  });
  judge(`${size}-stops`, walk, null, true);
  // past Closing: one gesture pages to the lineup rest while
  // the pack hands over to the tilted lineup: the panel never fades, the
  // page's content never comes into view over the hand-off, the others fade
  // in (never cut) and the stop text leaves; one more pages through the
  // lineup's exit to the free part's start
  const lineupAt = () =>
    page.evaluate(() => {
      const fl = window.__packStage.flow();
      return !fl.busy && Math.abs(scrollY - fl.stops.at(-1)) < 1;
    });
  const past = await frames(async () => {
    await next();
    await page.waitForFunction(
      () => {
        const fl = window.__packStage.flow();
        return !fl.busy && Math.abs(scrollY - fl.stops.at(-1)) < 1;
      },
      null,
      { timeout: 8000 },
    );
    await page.waitForTimeout(400);
  });
  {
    const moving = past.filter((fr) => fr.on);
    const end = moving.at(-1);
    const flow = await page.evaluate(() => window.__packStage.flow?.());
    const faded = moving.filter((fr) => !(fr.panelOp >= 1));
    report(
      `${size}-past-closing-into-the-lineup`,
      faded.length === 0 &&
        !!end &&
        !!flow?.stops &&
        Math.abs(end.y - flow.stops.at(-1)) < 1 &&
        end.blocks.length === 0,
      `${moving.length} frames, panel below full opacity or [data-stage-root] not found in ${faded.length}; last: scroll ${end?.y} vs lineup ${flow?.stops?.at(-1)}, stop blocks shown ${JSON.stringify(end?.blocks ?? null)}`,
    );
    const over = moving.filter(
      (fr) => fr.panelOp > 0.01 && fr.openTop !== null && fr.openTop < fr.vh,
    );
    // a missing section reads null in every frame: that fails, never passes
    // (the light pass reads no DOM, so it has no reading to judge)
    const measured = HEADED || moving.some((fr) => fr.openTop !== null);
    report(
      `${size}-past-closing-no-content-over-the-pack`,
      over.length === 0 && measured,
      `${measured ? '' : 'no section below the stage found; '}frames with the page's content in view while the pack shows: ${over.length}${over[0] ? `; first: opacity ${over[0].panelOp}, content top ${over[0].openTop}` : ''}`,
    );
    const cuts = [];
    for (let i = 1; i < moving.length; i++) {
      const a = new Map(moving[i - 1].drawn.map(([id, o]) => [id, o]));
      const b = new Map(moving[i].drawn.map(([id, o]) => [id, o]));
      const span = Math.max(1, (moving[i].at - moving[i - 1].at) / (1000 / 60));
      for (const id of new Set([...a.keys(), ...b.keys()])) {
        const d = Math.abs((b.get(id) ?? 0) - (a.get(id) ?? 0));
        if (d > RAMP_STEP * span)
          cuts.push(
            `${id} ${(a.get(id) ?? 0).toFixed(2)} -> ${(b.get(id) ?? 0).toFixed(2)}`,
          );
      }
    }
    report(
      `${size}-past-closing-others-fade-in`,
      cuts.length === 0 && (end?.drawn.length ?? 0) > 0,
      `others drawn at the lineup: ${end?.drawn.length ?? 0}${cuts.length ? '; cuts: ' + cuts.slice(0, 3).join('; ') : ''}`,
    );
  }
  // on through the lineup's exit to the free part's start
  await next();
  await page.waitForFunction(
    () => document.querySelector('[data-home-flow][data-flow-free]'),
    null,
    { timeout: 8000 },
  );
  await page.waitForTimeout(400);
  // the free part's wheel is the browser's own until a notch crosses the
  // paged edge (half a section below the lineup rest), which pages to the
  // lineup: ours stops there, then one more up gesture rests on Closing
  for (let i = 0; i < 30; i++) {
    await page.mouse.move(V.width / 2, V.height / 2);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(250);
    const paging = await page.evaluate(() => {
      const fl = window.__packStage.flow();
      return fl.busy || Math.abs(scrollY - fl.stops.at(-1)) < 1;
    });
    if (paging) break;
  }
  const backAt = await page
    .waitForFunction(
      () => {
        const fl = window.__packStage.flow();
        return !fl.busy && Math.abs(scrollY - fl.stops.at(-1)) < 1;
      },
      null,
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  const at = await page.evaluate(() => ({
    y: scrollY,
    lineup: window.__packStage.flow().stops.at(-1),
  }));
  report(
    `${size}-up-from-the-free-part-rests-on-the-lineup`,
    backAt && (await lineupAt()),
    `scroll ${at.y}, lineup rest ${at.lineup}`,
  );
  await page.keyboard.press('ArrowUp');
  const closingAt = await settle(page, kinds.length)
    .then(() =>
      page.evaluate(
        () =>
          Math.abs(scrollY - window.__packStage.flow().stops.at(-2)) < 1 &&
          !window.__packStage.flow().busy,
      ),
    )
    .catch(() => false);
  report(
    `${size}-up-from-the-lineup-rests-on-closing`,
    closingAt,
    `scroll ${await page.evaluate(() => scrollY)}, Closing rest ${await page.evaluate(() => window.__packStage.flow().stops.at(-2))}`,
  );
  // leave from every stop (the last one with its "All" button)
  for (let k = kinds.length; k >= 1; k--) {
    if (k !== kinds.length) {
      await tap();
      await settle(page, 1);
      for (let j = 2; j <= k; j++) {
        await next();
        await settle(page, j);
      }
    }
    const fr = await frames(async () => {
      await page.evaluate((kk) => {
        window.__leaveFrom = kk;
      }, k);
      await wiggle();
      if (k === kinds.length)
        await page
          .locator('[data-testid="focus-stops"] section[data-on] button', {
            hasText: /^All /,
          })
          .click();
      else await page.keyboard.press('Escape');
      await left(page);
      await page.evaluate(() => {
        window.__leaveFrom = 0;
      });
    });
    judge(`${size}-leave-from-${kinds[k - 1]}`, fr, 'leave');
  }
  report(`errors-${size}`, errors.length === 0, errors.join(' | ') || 'none');
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? 'all passed' : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
