import { chromium } from 'playwright';
const b = await chromium.launch();

async function testPage(url, label, sizes) {
  for (const [w, h] of sizes) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    await p.goto(url, { waitUntil: 'load', timeout: 60000 });
    await p.waitForTimeout(700);
    // Find a Reveal element BELOW the fold (should still be opacity 0 on load)
    const before = await p.evaluate(() => {
      const els = [
        ...document.querySelectorAll(
          "[style*='translateY'], [class*='opacity-0']",
        ),
      ];
      // pick ones below viewport
      const below = els.filter(
        (e) => e.getBoundingClientRect().top > window.innerHeight,
      );
      return { belowFoldHidden: below.length, totalReveal: els.length };
    });
    // scroll to bottom progressively to trigger all reveals
    await p.evaluate(async () => {
      const h = document.body.scrollHeight;
      for (let y = 0; y <= h; y += Math.round(window.innerHeight * 0.6)) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, h);
      await new Promise((r) => setTimeout(r, 900));
    });
    const after = await p.evaluate(() => {
      const stillHidden = [...document.querySelectorAll('*')].filter(
        (e) =>
          +getComputedStyle(e).opacity < 0.05 &&
          e.getBoundingClientRect().height > 20,
      ).length;
      const broken = [...document.images].filter(
        (i) => i.complete && i.naturalWidth === 0,
      ).length;
      const docW = document.documentElement.scrollWidth,
        vw = window.innerWidth;
      return { stillHidden, broken, overflowX: docW > vw + 2 ? docW - vw : 0 };
    });
    console.log(
      `[${label} ${w}x${h}] belowFoldHiddenOnLoad=${before.belowFoldHidden} | afterScroll stillHidden=${after.stillHidden} broken=${after.broken} hOverflow=${after.overflowX}px`,
    );
    await p.close();
  }
}

const sizes = [
  [390, 844],
  [768, 1024],
  [1440, 900],
  [1920, 1080],
  [2560, 1440],
  [3840, 2160],
];
await testPage('http://localhost:4000/', 'HOME', sizes);
await testPage('http://localhost:4000/how-it-works', 'HIW', sizes);
await b.close();
