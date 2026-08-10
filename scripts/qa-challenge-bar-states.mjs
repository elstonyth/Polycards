// scripts/qa-challenge-bar-states.mjs
// Visual preview of the Weekly Pulled Value checkpoint bar at a pool level the
// local DB doesn't have (it sits at ~1%). This does NOT exercise live data: it
// swaps the exact class strings WeeklyChallenge.tsx emits for the complete vs
// locked branch, so the screenshot shows what those branches look like. The
// live-data pass is qa-four-fixes.mjs.
// Usage: node scripts/qa-challenge-bar-states.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.PW_BASE ?? 'http://localhost:4000';
const OUT = 'docs/research';
mkdirSync(OUT, { recursive: true });

// Matches the screenshot the operator sent: 42% pooled, stages 1–2 cleared.
const PCT = 42;
const COMPLETE_COUNT = 2;

const browser = await chromium.launch();
try {
  for (const [name, viewport] of [
    ['challenge-bar-states-desktop', { width: 1440, height: 900 }],
    ['challenge-bar-states-phone', { width: 390, height: 844 }],
  ]) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await page.goto(BASE + '/leaderboard', { waitUntil: 'networkidle' });
    const accept = page.getByRole('button', { name: 'Accept' });
    if (await accept.isVisible().catch(() => false)) await accept.click();

    const panel = page.locator('section[aria-label="Community progress"]');
    await panel.scrollIntoViewIfNeeded();
    const flipped = await panel.evaluate(
      (root, { pct, completeCount }) => {
        const fill = root.querySelector('.challenge-fill');
        if (fill) fill.style.width = `${pct}%`;
        const meter = root.querySelector('[role="meter"]');
        meter?.setAttribute('aria-valuenow', String(pct));
        // Anchor span per stage; the pill and the label are its children.
        const checks = [
          ...root.querySelectorAll('[data-challenge-checkpoint]'),
        ];
        let flipped = 0;
        checks.forEach((anchor, i) => {
          if (i >= completeCount) return;
          const pill = anchor.firstElementChild;
          // Only count a flip when the LOCKED classes were actually there to
          // remove — otherwise the markup changed and the swap means nothing.
          if (!pill?.classList.contains('bg-neutral-600')) return;
          pill.classList.remove(
            'scale-75',
            'bg-neutral-600',
            'text-transparent',
          );
          pill.classList.add(
            'bg-chase',
            'text-neutral-950',
            'shadow-[0_0_10px_rgb(255_176_32_/_0.55)]',
          );
          anchor.lastElementChild?.classList.replace(
            'text-neutral-400',
            'text-chase',
          );
          flipped++;
        });
        return flipped;
      },
      { pct: PCT, completeCount: COMPLETE_COUNT },
    );
    await page.waitForTimeout(300);
    await panel.screenshot({ path: `${OUT}/${name}.png` });
    // Without this the script prints "written (simulated …)" over an unchanged
    // screenshot whenever the selectors drift — a green-looking lie.
    if (flipped !== COMPLETE_COUNT) {
      console.log(
        `[${name}] FAIL — flipped ${flipped}/${COMPLETE_COUNT} checkpoints; selectors drifted?`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        `[${name}] written (simulated ${PCT}%, ${COMPLETE_COUNT} cleared)`,
      );
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
