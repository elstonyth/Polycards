// Per-frame QA of the focused pack view on /home-preview (production server
// with HOME_PREVIEW=1): every animation frame of the enter, every stop move
// and the leave from every stop is sampled in the page, on a phone
// (390x844) and a desktop (1440x900) profile. Headless Chrome, muted
// (--mute-audio plus a media guard), logged out; only the cookie banner's
// "Reject" is ever clicked. The pointer moves before every gesture, as a
// visitor's does.
//
//   node scripts/qa-focus-frames.mjs [baseUrl] [--slug=151] [--tab=Poly] [--only=phone|desktop]
//
// Fails when, at any sampled frame while a pack is focused:
// - another pack of the row (its picture or its 3D model) has opacity above 0
//   once the focus has left the row (focus >= NEIGHBOUR_GONE_AT), or any
//   stop text is showing while another pack is;
// - a block's heading is hidden while the rest of its block still shows
//   (a block fades as one piece, both ways);
// - the Front block shows while leaving from another stop.
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const BASE =
  args.find((a) => !a.startsWith('--')) ??
  process.env.PW_BASE ??
  'http://localhost:4300';
const opt = (k, d) =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split('=')[1];
const SLUG = opt('slug', '151');
const TAB = opt('tab', '');
const ONLY = opt('only', '');
/** The focus value by which the row's other packs must be gone. */
const NEIGHBOUR_GONE_AT = 0.1;

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
  const tick = () => {
    const ps = w.__packStage;
    const st = ps?.state;
    const fr = ps?.focus?.();
    if (st && fr?.on) {
      const index = st.focusOn?.ctx?.index ?? null;
      const tiles = [
        ...document.querySelectorAll(
          '[data-stage-panel]:not([hidden]) [data-stage-tile]',
        ),
      ];
      const css = [];
      for (const t of tiles) {
        const i = Number(t.getAttribute('data-index'));
        if (i === index) continue;
        const img = t.querySelector('img');
        const o = img ? opacityChain(img, t) : 0;
        if (o > 0.001)
          css.push([t.getAttribute('data-pack-id'), +o.toFixed(3)]);
      }
      const drawn = (ps.runtime?.()?.drawn ?? [])
        .filter((d) => d.index !== index && d.opacity > 0.001)
        .map((d) => [d.id, +d.opacity.toFixed(3)]);
      const blocks = [];
      for (const s of document.querySelectorAll(
        '[data-testid="focus-stops"] > section[data-kind]',
      )) {
        const o = opacityChain(s, s);
        if (o < 0.01) continue;
        const h = s.querySelector('h2');
        const line = h?.firstElementChild;
        let head = o;
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
      w.__frames.push({
        t: performance.now(),
        f: st.focus,
        busy: fr.busy,
        leaveFrom: w.__leaveFrom,
        css,
        drawn,
        blocks,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const browser = await chromium.launch({
  channel: 'chrome',
  args: [
    '--mute-audio',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--ignore-gpu-blocklist',
  ],
});

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

function judge(name, frames) {
  const bad = { neighbour: [], textOverPack: [], heading: [], front: [] };
  for (const fr of frames) {
    const others = [...fr.css, ...fr.drawn];
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
    bad.heading.length === 0,
    show(bad.heading),
  );
  report(
    `${name}-no-front-block-leaving-later`,
    bad.front.length === 0,
    show(bad.front),
  );
}

for (const size of ['phone', 'desktop']) {
  if (ONLY && ONLY !== size) continue;
  const ctx = await browser.newContext(PROFILES[size]);
  await ctx.addInitScript(mute);
  await ctx.addInitScript(sampler);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/home-preview?stage=3d&debug=1&loader=never`, {
    waitUntil: 'load',
  });
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
    await page.evaluate(() => {
      window.__frames = [];
    });
    await fn();
    return page.evaluate(() => window.__frames);
  };

  // enter and walk every stop by one gesture each
  let kinds = [];
  const walk = await frames(async () => {
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
    for (let k = 2; k <= kinds.length; k++) {
      await next();
      await settle(page, k);
    }
  });
  judge(`${size}-enter-and-stops`, walk);
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
    judge(`${size}-leave-from-${kinds[k - 1]}`, fr);
  }
  report(`errors-${size}`, errors.length === 0, errors.join(' | ') || 'none');
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? 'all passed' : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
