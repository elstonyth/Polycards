// QA for the home-hero + card-page entrance choreography (globals.css
// "Shared first-paint entrance"). Run against the standalone build:
//
//   npm run build && pwsh scripts/serve-standalone.ps1 -Port 4100
//   BASE_URL=http://localhost:4100 node scripts/qa-motion-entrances.mjs
//
// Three passes, because a screenshot alone can't tell "still animating" from
// "shipped blank":
//
//   reduced  — context-level reducedMotion:'reduce'. The globals.css backstop
//              zeroes duration AND delay, so every element must already be at
//              its end state on the first frame. This is also the pass whose
//              PNGs are comparable to older captures taken before any of this
//              existed, and the mode any geometry/measure script should use.
//   settled  — normal motion, then await every running animation's .finished
//              before shooting. Without this the shot lands mid-flight and
//              reads exactly like the classic "Reveal never fired" blank.
//   film     — deliberate mid-flight frames, the only pass that shows whether
//              the choreography actually reads as choreography.
//
// The opacity assertions are the real gate; the PNGs are for eyeballing.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:4100';
// A real slabbed card (rarity + slab_image set) — the unframed branch would
// skip the tier frame and glow entirely and verify nothing.
const CARD = process.env.QA_CARD ?? 'mega-charizard-x-ex-125-psa-10-11069001';
const OUT = 'docs/research';

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
];

const PAGES = [
  {
    name: 'home',
    path: '/',
    // Every element the hero choreography touches must end up visible. Each
    // selector must name the element that ACTUALLY carries the animation —
    // probing an un-animated child reports opacity 1 unconditionally and
    // passes no matter how broken the entrance is.
    probes: {
      kicker: '#hero-heading',
      headline:
        'section[aria-labelledby="hero-heading"] .chase-land, section[aria-labelledby="hero-heading"] .rise-in.font-heading',
      window: 'section[aria-labelledby="hero-heading"] .window-in',
      cta: 'section[aria-labelledby="hero-heading"] a.rise-in[href="/slots"]',
    },
  },
  {
    name: 'card',
    path: `/card/${encodeURIComponent(CARD)}`,
    probes: {
      slab: '.slab-arrive',
      name: 'h1',
      // The value BLOCK, not the <p> inside it — the <p> carries no entrance,
      // so probing it reports opacity 1 no matter what and passes vacuously.
      valueBlock: 'div.rise-in.flex-wrap',
    },
  },
];

/**
 * Wait out every FINITE animation so a screenshot lands on the end state.
 * Infinite ones are skipped deliberately — the live-pulls marquee
 * (`sp-scroll-x`) and friends loop forever, and awaiting their `.finished`
 * hangs the run rather than settling it.
 */
// Overridable so the give-up path itself can be exercised:
// QA_SETTLE_MS=1 node scripts/qa-motion-entrances.mjs  →  must FAIL.
const SETTLE_CEILING_MS = Number(process.env.QA_SETTLE_MS ?? 5000);

const settle = (page) =>
  page.evaluate((ms) => {
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => {}));
    // Hard ceiling: a long-but-finite animation, or one paused by a throttled
    // tab, would otherwise hang the whole run with no output. The longest
    // entrance here is 900ms + 350ms of stagger.
    //
    // The ceiling resolves FALSE so the caller can tell "everything finished"
    // from "we gave up waiting". Resolving both the same way would let a page
    // that never settles get screenshotted mid-flight and reported as settled —
    // the exact silent-pass this whole script exists to prevent.
    const ceiling = new Promise((r) => setTimeout(() => r(false), ms));
    return Promise.race([Promise.all(finite).then(() => true), ceiling]);
  }, SETTLE_CEILING_MS);

/**
 * One full frame. The `load` event can fire before the compositor has run a
 * single animation frame, so measuring straight off `load` reads the backwards
 * fill (opacity 0) and reports a phantom failure even when the backstop has
 * already collapsed the animation to ~0s. Two rAFs make the reduced pass
 * deterministic without waiting on anything.
 */
const nextFrame = (page) =>
  page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );

/** Computed animation-duration of a probe, to prove the backstop is applying. */
const durationOf = (page, sel) =>
  page.evaluate((q) => {
    const el = document.querySelector(q);
    return el ? getComputedStyle(el).animationDuration : null;
  }, sel);

/** Computed opacity + whether the box has real size, per probe selector. */
const measure = (page, probes) =>
  page.evaluate((sel) => {
    const out = {};
    for (const [key, q] of Object.entries(sel)) {
      const el = document.querySelector(q);
      if (!el) {
        out[key] = null;
        continue;
      }
      const r = el.getBoundingClientRect();
      out[key] = {
        opacity: Number(getComputedStyle(el).opacity),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    }
    return out;
  }, probes);

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const failures = [];

// try/finally so an unguarded throw can't skip browser.close() and strand a
// chromium process — this repo has a documented runaway-node history.
try {
  await run();
} catch (err) {
  failures.push(`threw before finishing: ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error('\nFAIL:');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('\nOK — every probed element ends fully visible in both modes.');

async function run() {
  for (const vp of VIEWPORTS) {
    for (const mode of ['reduced', 'settled']) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference',
      });
      const page = await ctx.newPage();

      for (const p of PAGES) {
        await page.goto(`${BASE}${p.path}`, { waitUntil: 'load' });
        if (mode === 'settled') {
          if (!(await settle(page))) {
            failures.push(
              `${p.name}/${vp.name}/settled: animations did not finish within ${SETTLE_CEILING_MS}ms — everything measured below was taken mid-flight`,
            );
          }
        } else {
          await nextFrame(page);
        }

        // Reduced motion must not merely end up visible — it must never spend
        // real time animating. If the globals.css backstop stops applying, this
        // is the assertion that notices. Checked on EVERY probe, not just the
        // first: a new animation added to any one element would otherwise escape
        // the backstop unnoticed. Probes carrying no animation at all report
        // `0s` and pass, which is correct — the check is "no animation runs for
        // real time", not "an animation exists".
        if (mode === 'reduced') {
          for (const [key, sel] of Object.entries(p.probes)) {
            const d = await durationOf(page, sel);
            const secs = parseFloat(d ?? 'NaN');
            if (!(secs <= 0.001)) {
              failures.push(
                `${p.name}/${vp.name}/reduced: "${key}" animation-duration ${d} — reduced-motion backstop not applying`,
              );
            }
          }
        }

        const m = await measure(page, p.probes);
        for (const [key, v] of Object.entries(m)) {
          if (!v) {
            failures.push(
              `${p.name}/${vp.name}/${mode}: probe "${key}" missing`,
            );
          } else if (v.opacity < 0.99) {
            failures.push(
              `${p.name}/${vp.name}/${mode}: "${key}" opacity ${v.opacity} (want 1)`,
            );
          } else if (v.w === 0 || v.h === 0) {
            failures.push(
              `${p.name}/${vp.name}/${mode}: "${key}" has zero size`,
            );
          }
        }
        console.log(`${p.name} ${vp.name} ${mode}`, JSON.stringify(m));
        await page.screenshot({
          path: `${OUT}/motion-${p.name}-${vp.name}-${mode}.png`,
        });
      }
      await ctx.close();
    }

    // Filmstrip — mid-flight frames of the home hero only (the card page's
    // entrance is a plain fade and has nothing to read frame by frame).
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'commit' });
    // t is an absolute offset from navigation. Measure against a real clock
    // rather than accumulating the requested waits: a screenshot takes real time,
    // so summing the gaps makes every later frame land progressively earlier than
    // its own filename claims.
    const t0 = Date.now();
    for (const t of [180, 420, 700, 1100]) {
      const remaining = t - (Date.now() - t0);
      if (remaining > 0) await page.waitForTimeout(remaining);
      await page.screenshot({
        path: `${OUT}/motion-home-${vp.name}-t${t}.png`,
      });
    }
    await ctx.close();
  }
}

await browser.close();

if (failures.length) {
  console.error('\nFAIL:');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('\nOK — every probed element ends fully visible in both modes.');
