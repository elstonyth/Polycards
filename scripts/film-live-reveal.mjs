// Open the live demo -> TAP the center pack in the 3D carousel -> film the actual
// card REVEAL (the 40-card roulette strip) frame-by-frame + probe its DOM.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'docs/design-references/phygitals-open/reveal';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await ctx.newPage();
await page.goto('https://www.phygitals.com/claw/black-pack', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});
await page.waitForTimeout(5000);

await page
  .getByRole('button', { name: /try a free demo spin/i })
  .first()
  .click()
  .catch(() => {});
await page.waitForTimeout(2500); // carousel appears
await page.screenshot({ path: `${OUT}/r00-carousel.png` });

// Tap the center pack (the forward-facing one) to open it.
const tapped = await page.evaluate(() => {
  const cx = window.innerWidth / 2,
    cy = window.innerHeight / 2;
  // the topmost element near center that is an img or has a pack image
  const el = document.elementFromPoint(cx, cy);
  if (el) {
    el.click();
    return el.tagName + '.' + (el.className || '').toString().slice(0, 30);
  }
  return null;
});
// also try a real mouse click at center as fallback
await page.mouse.click(720, 480).catch(() => {});
await page.waitForTimeout(400);

const probeRoulette = () =>
  page.evaluate(() => {
    const strips = [...document.querySelectorAll('*')].filter(
      (el) =>
        el.scrollWidth > el.clientWidth * 1.5 &&
        el.querySelectorAll('img').length > 6,
    );
    const s = strips.sort(
      (a, b) =>
        b.querySelectorAll('img').length - a.querySelectorAll('img').length,
    )[0];
    let info = null;
    if (s) {
      const cs = getComputedStyle(s);
      const first = s.querySelector('img');
      info = {
        cls: (s.className || '').toString().slice(0, 50),
        imgs: s.querySelectorAll('img').length,
        transform: cs.transform.slice(0, 40),
        transition: cs.transition.slice(0, 60),
        itemW: first ? Math.round(first.getBoundingClientRect().width) : null,
        sw: s.scrollWidth,
      };
    }
    // any center marker / pointer line
    const won =
      (document.body.innerText || '').match(
        /you (won|pulled|got|received)[^\n]{0,70}/i,
      )?.[0] || null;
    return {
      roulette: info,
      won,
      h2: [...document.querySelectorAll('h1,h2,h3')]
        .map((h) => h.innerText.trim())
        .filter(Boolean)
        .slice(0, 5),
    };
  });

const during = [];
for (let i = 0; i < 16; i++) {
  await page.waitForTimeout(550);
  await page.screenshot({ path: `${OUT}/r-${String(i).padStart(2, '0')}.png` });
  if ([1, 4, 9, 15].includes(i)) during.push({ i, ...(await probeRoulette()) });
}

await browser.close();
console.log(JSON.stringify({ tapped, during }, null, 2));
