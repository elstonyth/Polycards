// scripts/qa-home-redesign.mjs
// One-off QA: screenshots of the Drop Board home at phone/desktop, plus a
// reduced-motion pass and the routing-rule audit (every product tap → /slots).
// Usage: node scripts/qa-home-redesign.mjs   (expects the standalone server)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.PW_BASE ?? 'http://localhost:4000';
const OUT = 'docs/research';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
try {
  for (const [name, viewport, reducedMotion] of [
    ['home-drop-phone', { width: 390, height: 844 }, 'no-preference'],
    ['home-drop-desktop', { width: 1440, height: 900 }, 'no-preference'],
    ['home-drop-phone-reduced', { width: 390, height: 844 }, 'reduce'],
  ]) {
    const ctx = await browser.newContext({ viewport, reducedMotion });
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });

    // Dismiss the cookie banner so it doesn't overlay the boards.
    const accept = page.getByRole('button', { name: 'Accept' });
    if (await accept.isVisible().catch(() => false)) await accept.click();

    await page.screenshot({ path: `${OUT}/${name}-top.png` });

    // Scroll through the page so every fire-once Reveal (IntersectionObserver)
    // has triggered — otherwise below-the-fold boards capture at opacity-0.
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let y = 0;
        const step = () => {
          y += 600;
          window.scrollTo(0, y);
          if (y < document.body.scrollHeight) setTimeout(step, 120);
          else resolve(undefined);
        };
        step();
      });
    });
    await page.waitForTimeout(900); // let the last reveal transition finish
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    await page.screenshot({ path: `${OUT}/${name}-full.png`, fullPage: true });

    // Routing-rule audit: every anchor inside the six boards that shows a
    // product must point at exactly "/slots".
    // (page.$$eval is Playwright's typed DOM-query helper running a static
    // function in page context — not string eval; no arbitrary code here.)
    // Operator exception (2026-08-06): RIP A PACK ladder rows deep-link to the
    // pack they show (`/slots/<slug>?count=1`). Every other product surface
    // still lands on plain "/slots", so the audit skips that section only.
    const offenders = await page.$$eval('main a[href^="/slots/"]', (as) =>
      as
        .filter((a) => !a.closest('section[aria-labelledby="shelf-heading"]'))
        .map((a) => a.getAttribute('href')),
    );
    if (offenders.length === 0) {
      console.log(`[${name}] routing rule OK — no /slots/<pack> links on home`);
    } else {
      console.log(`[${name}] ROUTING VIOLATIONS: ${offenders.join(', ')}`);
      process.exitCode = 1; // usable as a gate, not just a log
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log('screenshots in', OUT);
