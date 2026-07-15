// Shared Playwright helpers for the capture/verify scripts. Encodes the
// web-first waiting the best-practice guide calls for — NO `networkidle` (a flaky
// heuristic) and NO arbitrary `waitForTimeout` settle sleeps:
//
//   - navigation waits for the real `load` event + web-font readiness;
//   - image checks wait on the actual decode state (`HTMLImageElement.complete`);
//   - animations are disabled via `reducedMotion: 'reduce'` so a deterministic
//     steady state is reached without a settle delay (the app honors
//     prefers-reduced-motion — Reveal renders content visible immediately).
import { chromium } from 'playwright';

// Target origin. Defaults to the local prod build; override to hit a deployed
// env, e.g. PW_BASE=https://polycards.gg
export const BASE = process.env.PW_BASE || 'http://localhost:4000';

export function launch(opts = {}) {
  return chromium.launch(opts);
}

// A context with animations disabled (steady-state captures, no settle sleeps).
export function newContext(browser, { viewport, ...rest } = {}) {
  return browser.newContext({ reducedMotion: 'reduce', viewport, ...rest });
}

// Navigate and wait for a deterministic, measurable state: the `load` event
// (fires once the initially-referenced resources, including above-the-fold
// images, have loaded) plus web-font readiness. Replaces
// `waitUntil:'networkidle'` + a fixed `waitForTimeout`. Returns the response.
export async function gotoStable(
  page,
  url,
  { timeout = 30000, waitUntil = 'load' } = {},
) {
  const res = await page.goto(url, { waitUntil, timeout });
  // `.then(() => true)` keeps the resolved value serializable (a FontFaceSet is
  // not). Best-effort: never let font readiness block a measurement.
  await page
    .evaluate(() =>
      document.fonts ? document.fonts.ready.then(() => true) : true,
    )
    .catch(() => {});
  return res;
}

// Wait until every <img> that has actually started loading has finished
// decoding, so `naturalWidth === 0` broken-image checks and screenshots aren't
// racing a decode. Images next/image hasn't triggered yet (lazy, below the fold
// — no `currentSrc`) are skipped, so this resolves promptly instead of hanging
// on content that only loads on scroll. Best-effort: a single stuck image won't
// hang the run (the broken-image assertions still catch genuinely broken art).
export async function settleImages(page, { timeout = 15000 } = {}) {
  await page
    .waitForFunction(
      () => [...document.images].every((i) => !i.currentSrc || i.complete),
      null,
      { timeout },
    )
    .catch(() => {});
}
