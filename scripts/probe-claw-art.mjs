// Probe the LIVE /claw tall pack-art image URLs (the 712x1263 renders) to see if
// they're downloadable for the clone's cards.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await ctx.newPage();
await page.goto('https://www.phygitals.com/claw', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});
await page.waitForTimeout(4500);

const arts = await page.evaluate(() => {
  const isOpen = (el) => /^open$/i.test((el.innerText || '').trim());
  const opens = [...document.querySelectorAll('button,a')].filter(isOpen);
  const out = [];
  for (const b of opens) {
    let el = b;
    for (let i = 0; i < 6; i++) {
      el = el.parentElement;
      if (!el) break;
      const img = el.querySelector('img');
      if (img) {
        // pick the tallest img in the card (the pack art, not a tiny badge)
        const imgs = [...el.querySelectorAll('img')].sort(
          (a, b2) => b2.naturalHeight - a.naturalHeight,
        );
        const art = imgs[0];
        const name =
          (el.innerText || '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)[0] || '';
        out.push({
          name: name.slice(0, 30),
          src: (art.currentSrc || art.src || '').slice(0, 160),
          natW: art.naturalWidth,
          natH: art.naturalHeight,
        });
        break;
      }
    }
  }
  // dedupe by src
  const seen = new Set();
  return out.filter((o) => o.src && !seen.has(o.src) && seen.add(o.src));
});

await browser.close();
console.log('count:', arts.length);
console.log(JSON.stringify(arts.slice(0, 8), null, 2));
