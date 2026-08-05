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

    // The meter must survive the restructure — the sr-only probe QA relies on.
    const meter = panel.locator('[role="meter"]');
    console.log(
      `[${name}] meter aria-valuenow=${await meter.getAttribute('aria-valuenow')}`,
    );

    // Checkpoint anchors (one per stage, siblings of the track) must not
    // overlap on a narrow bar, and every threshold label must render at the
    // same size — a transform on the pill used to shrink its label with it.
    const probe = await panel
      .locator('[role="meter"] ~ span')
      .evaluateAll((els) =>
        els
          .map((e) => {
            const r = e.getBoundingClientRect();
            const label = e.lastElementChild;
            return {
              box: [Math.round(r.left), Math.round(r.right)],
              labelH: label
                ? Math.round(label.getBoundingClientRect().height * 10) / 10
                : 0,
            };
          })
          .sort((a, b) => a.box[0] - b.box[0]),
      );
    const boxes = probe.map((p) => p.box);
    let overlap = false;
    for (let i = 1; i < boxes.length; i++)
      if (boxes[i][0] < boxes[i - 1][1]) overlap = true;
    const labelHeights = [...new Set(probe.map((p) => p.labelH))];
    console.log(
      `[${name}] checkpoints=${boxes.length} overlap=${overlap} labelHeights=${JSON.stringify(labelHeights)} boxes=${JSON.stringify(boxes)}`,
    );
    if (overlap || labelHeights.length > 1) process.exitCode = 1;
    await ctx.close();
  }
} finally {
  await browser.close();
}
