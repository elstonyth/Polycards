// scripts/qa-four-fixes.mjs
// One-off QA for the 2026-08-06 fix batch:
//   1. RIP A PACK ladder rows deep-link to /slots/<slug>?count=1
//   2. Weekly Pulled Value checkpoint bar (desktop + phone + reduced motion)
// Usage: node scripts/qa-four-fixes.mjs   (expects the standalone server)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.PW_BASE ?? 'http://localhost:4000';
const OUT = 'docs/research';
mkdirSync(OUT, { recursive: true });

const dismissCookies = async (page) => {
  const accept = page.getByRole('button', { name: 'Accept' });
  if (await accept.isVisible().catch(() => false)) await accept.click();
};

const browser = await chromium.launch();
try {
  // --- 1. Ladder row hrefs -------------------------------------------------
  {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await dismissCookies(page);

    const hrefs = await page.$$eval(
      'section[aria-labelledby="shelf-heading"] a[href^="/slots/"]',
      (as) => as.map((a) => a.getAttribute('href')),
    );
    const bad = hrefs.filter((h) => !/^\/slots\/[^/?]+\?count=1$/.test(h));
    console.log(
      `[ladder] rows deep-linked: ${hrefs.length} — ${hrefs.join(', ')}`,
    );
    if (hrefs.length === 0 || bad.length > 0) {
      console.log(
        `[ladder] FAIL — bad hrefs: ${bad.join(', ') || '(none found)'}`,
      );
      process.exitCode = 1;
    } else {
      console.log('[ladder] OK — every row → /slots/<slug>?count=1');
    }
    await ctx.close();
  }

  // --- 2. Weekly Pulled Value checkpoint bar -------------------------------
  for (const [name, viewport, reducedMotion] of [
    ['challenge-bar-desktop', { width: 1440, height: 900 }, 'no-preference'],
    ['challenge-bar-phone', { width: 390, height: 844 }, 'no-preference'],
    ['challenge-bar-phone-reduced', { width: 390, height: 844 }, 'reduce'],
  ]) {
    const ctx = await browser.newContext({ viewport, reducedMotion });
    const page = await ctx.newPage();
    await page.goto(BASE + '/leaderboard', { waitUntil: 'networkidle' });
    await dismissCookies(page);

    const panel = page.locator('section[aria-label="Community progress"]');
    if (!(await panel.count())) {
      console.log(`[${name}] SKIP — no community pool row in this DB`);
      await ctx.close();
      continue;
    }
    await panel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await panel.screenshot({ path: `${OUT}/${name}.png` });

    // The meter contract must survive any restructure — this repo's own QA
    // probes the sr-only meter rather than the animated readout. Assert it
    // rather than log it: `getAttribute` on a vanished element returns null,
    // which a log-only check reports as a clean pass.
    const meters = panel.locator('[role="meter"]');
    const meterCount = await meters.count();
    const meterAttrs =
      meterCount === 1
        ? await meters.evaluate((el) => ({
            min: el.getAttribute('aria-valuemin'),
            max: el.getAttribute('aria-valuemax'),
            now: el.getAttribute('aria-valuenow'),
            label: el.getAttribute('aria-label'),
          }))
        : null;
    const now = Number(meterAttrs?.now);
    const meterOk =
      meterCount === 1 &&
      meterAttrs?.min === '0' &&
      meterAttrs?.max === '100' &&
      Number.isFinite(now) &&
      now >= 0 &&
      now <= 100 &&
      !!meterAttrs?.label;
    console.log(
      `[${name}] meters=${meterCount} attrs=${JSON.stringify(meterAttrs)}`,
    );
    if (!meterOk) {
      console.log(`[${name}] FAIL — meter contract missing or out of range`);
      process.exitCode = 1;
    }

    // Checkpoints must not overlap on a narrow bar; every threshold label must
    // render at the same size (a transform on the pill used to shrink its label
    // with it) and stay inside the track (the 100% pill sits on the right edge,
    // so a centred label there would hang past the bar).
    // Guarded: boundingBox() on a missing locator waits out the full 30s
    // timeout and then throws, which turns a clear FAIL into a hung crash and
    // skips the remaining viewports.
    const trackBox =
      meterCount === 1 ? await meters.first().boundingBox() : null;
    const probe = await panel
      .locator('[data-challenge-checkpoint]')
      .evaluateAll((els) =>
        els
          .map((e) => {
            const r = e.getBoundingClientRect();
            const label = e.lastElementChild;
            const lr = label?.getBoundingClientRect();
            return {
              box: [Math.round(r.left), Math.round(r.right)],
              labelH: lr ? Math.round(lr.height * 10) / 10 : 0,
              labelBox: lr ? [Math.round(lr.left), Math.round(lr.right)] : null,
            };
          })
          .sort((a, b) => a.box[0] - b.box[0]),
      );
    const boxes = probe.map((p) => p.box);
    let overlap = false;
    for (let i = 1; i < boxes.length; i++)
      if (boxes[i][0] < boxes[i - 1][1]) overlap = true;
    // Labels are `hidden` below sm, so every height is 0 on the phone passes —
    // uniform, but vacuously so. Only the 1440 pass really tests the label size.
    const labelHeights = [...new Set(probe.map((p) => p.labelH))];
    // Same reason: skip the containment check where the labels aren't rendered.
    const labelOverflow = probe.some(
      (p) =>
        p.labelH > 0 &&
        trackBox &&
        p.labelBox &&
        (p.labelBox[0] < Math.round(trackBox.x) - 1 ||
          p.labelBox[1] > Math.round(trackBox.x + trackBox.width) + 1),
    );
    console.log(
      `[${name}] checkpoints=${boxes.length} overlap=${overlap} labelHeights=${JSON.stringify(labelHeights)} labelOverflow=${labelOverflow} boxes=${JSON.stringify(boxes)}`,
    );
    // An empty match means the selector drifted, not that the bar is clean —
    // fail loudly rather than report a green pass that asserted nothing.
    if (boxes.length === 0) {
      console.log(`[${name}] FAIL — no checkpoints matched; selector drifted?`);
      process.exitCode = 1;
    } else if (overlap || labelHeights.length > 1 || labelOverflow) {
      process.exitCode = 1;
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
