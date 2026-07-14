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
    const offenders = await page.$$eval('main a[href^="/slots/"]', (as) =>
      as.map((a) => a.getAttribute('href')),
    );
    console.log(
      offenders.length === 0
        ? `[${name}] routing rule OK — no /slots/<pack> links on home`
        : `[${name}] ROUTING VIOLATIONS: ${offenders.join(', ')}`,
    );
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log('screenshots in', OUT);
