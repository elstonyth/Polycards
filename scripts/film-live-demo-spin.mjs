// Film the LIVE phygitals "Try a free demo spin" reveal animation (free, no
// login) frame-by-frame, and probe the DOM mechanism during it (roulette strip?
// card flip? burst overlay?). This is the ground truth for the clone's reveal.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'docs/design-references/phygitals-open/demo';
mkdirSync(OUT, { recursive: true });
const URL = 'https://www.phygitals.com/claw/black-pack';

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await ctx.newPage();

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(5000);

// probe the DOM right before the spin
const probe = async (tag) =>
  page.evaluate((t) => {
    // look for a horizontal strip of card-ish items (roulette), a flipping card,
    // a full-screen overlay, etc.
    const all = [...document.querySelectorAll('*')];
    const wideScrollers = all
      .filter((el) => {
        const s = getComputedStyle(el);
        return (
          el.scrollWidth > el.clientWidth * 2 &&
          el.querySelectorAll('img').length > 6
        );
      })
      .map((el) => ({
        cls: (el.className || '').toString().slice(0, 40),
        imgs: el.querySelectorAll('img').length,
        sw: el.scrollWidth,
        cw: el.clientWidth,
      }));
    const overlays = all
      .filter((el) => {
        const s = getComputedStyle(el);
        return (
          s.position === 'fixed' &&
          el.getBoundingClientRect().width > window.innerWidth * 0.6 &&
          el.getBoundingClientRect().height > window.innerHeight * 0.6
        );
      })
      .map((el) => ({
        cls: (el.className || '').toString().slice(0, 50),
        z: getComputedStyle(el).zIndex,
      }));
    const transformed = all.filter((el) => {
      const tr = getComputedStyle(el).transform;
      return tr && tr !== 'none' && /matrix/.test(tr);
    }).length;
    return {
      tag: t,
      wideScrollers: wideScrollers.slice(0, 4),
      overlays: overlays.slice(0, 4),
      transformedCount: transformed,
      bodySnippet:
        (document.body.innerText || '')
          .replace(/\s+/g, ' ')
          .match(/you (won|pulled|got)[^.]{0,60}/i)?.[0] || null,
    };
  }, tag);

const before = await probe('before');

const demo = page
  .getByRole('button', { name: /try a free demo spin/i })
  .first();
const demoVisible = await demo.isVisible().catch(() => false);
let clicked = false;
if (demoVisible) {
  await demo.scrollIntoViewIfNeeded().catch(() => {});
  await demo.click().catch(() => {});
  clicked = true;
}

// Film the reveal — 14 frames over ~9s (the spin + land).
const frames = [];
for (let i = 0; i < 14; i++) {
  await page.waitForTimeout(650);
  await page.screenshot({
    path: `${OUT}/spin-${String(i).padStart(2, '0')}.png`,
  });
  if (i === 2 || i === 6 || i === 12) frames.push(await probe(`t${i}`));
}

await browser.close();
console.log(
  JSON.stringify({ demoVisible, clicked, before, during: frames }, null, 2),
);
