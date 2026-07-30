// Capture the LIVE "Pull Odds (by rarity)" panel from the production build, to
// verify each published tier row now carries its own card-value range.
// Serve first:  npm run build && pwsh scripts/serve-standalone.ps1 -Port 4000
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.PW_BASE ?? 'http://localhost:4000';
const SLUG = process.env.QA_PACK ?? 'bronze-pack';
const OUT = 'docs/research/tier-value-ranges';

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [name, viewport] of [
    ['desktop', { width: 1280, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
    await page.goto(`${BASE}/slots/${SLUG}`, { waitUntil: 'networkidle' });
    // Cookie banner would overlay the panel in the screenshot.
    const reject = page
      .getByRole('button', { name: /reject|decline/i })
      .first();
    if (await reject.isVisible().catch(() => false)) await reject.click();

    const heading = page.getByRole('heading', { name: /Pull Odds/i }).first();
    if (!(await heading.isVisible().catch(() => false))) {
      console.log(
        `[${name}] Pull Odds panel not rendered — pack has no published odds?`,
      );
      await page.screenshot({
        path: `${OUT}/${name}-page.png`,
        fullPage: true,
      });
      await page.close();
      continue;
    }
    // The panel = heading + the <ul> that follows it.
    const panel = heading.locator('xpath=..').locator('xpath=..');
    // <Reveal> fades this section in on scroll-into-view; screenshotting before
    // the IntersectionObserver fires captures it at opacity ~0 (see CLAUDE.md).
    await panel.scrollIntoViewIfNeeded();
    // elementHandle() is null if the selector stopped matching (a re-render
    // between locating and resolving). Passing that straight to waitForFunction
    // fails inside getComputedStyle with an opaque error, so say what happened
    // and still take the shot — a visibly-faded capture beats no capture.
    const panelHandle = await panel.elementHandle();
    if (panelHandle === null) {
      console.log(`[${name}] panel element vanished before the opacity wait`);
    } else {
      await page
        .waitForFunction(
          (el) => Number(getComputedStyle(el).opacity) > 0.99,
          panelHandle,
          { timeout: 5000 },
        )
        .catch(() =>
          console.log(`[${name}] Reveal never reached full opacity`),
        );
    }
    await page.waitForTimeout(400);
    await panel.screenshot({ path: `${OUT}/${name}.png` });

    // Read the rows back as text so the numbers are checkable, not just pretty.
    const rows = await panel.locator('li').allInnerTexts();
    console.log(`[${name}] rows:`);
    for (const r of rows) console.log('  ' + r.replace(/\n/g, ' | '));

    // "Published" must never reach a player: it implies a second, unpublished
    // set of odds. Covers aria-labels too, which screen readers do read out.
    const leaked = await page.evaluate(() => {
      const found = [];
      if (/publish/i.test(document.body.innerText)) found.push('body text');
      for (const el of document.querySelectorAll('[aria-label]')) {
        const v = el.getAttribute('aria-label') ?? '';
        if (/publish/i.test(v)) found.push(`aria-label="${v}"`);
      }
      return found;
    });
    console.log(
      leaked.length
        ? `  [${name}] LEAK: ${leaked.join(', ')}`
        : `  [${name}] no "publish" wording on the page`,
    );
    await page.close();
  }
  console.log(`\nshots → ${OUT}/`);
} finally {
  await browser.close();
}
