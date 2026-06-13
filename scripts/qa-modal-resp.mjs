import { chromium } from 'playwright';
const b = await chromium.launch();
for (const w of [390, 768, 1920, 3840]) {
  const p = await b.newPage({ viewport: { width: w, height: 900 } });
  await p.goto('http://localhost:4000/how-it-works', {
    waitUntil: 'load',
    timeout: 60000,
  });
  await p.waitForTimeout(900);
  await p.evaluate(() => {
    const h = [...document.querySelectorAll('h2')].find(
      (e) => e.textContent.trim() === 'How It Works',
    );
    h && h.scrollIntoView({ block: 'center' });
  });
  await p.waitForTimeout(700);
  await p.evaluate(() =>
    document
      .querySelector("button[aria-label='How instant buyback works']")
      ?.click(),
  );
  await p.waitForTimeout(400);
  const m = await p.evaluate(() => {
    const d = document.querySelector("[role='dialog']");
    if (!d) return { open: false };
    const panel = d.children[1];
    const r = panel.getBoundingClientRect();
    return {
      panelW: Math.round(r.width),
      onScreen:
        r.top >= 0 &&
        r.bottom <= window.innerHeight &&
        r.left >= 0 &&
        r.right <= window.innerWidth,
      overflowX: Math.max(0, document.documentElement.scrollWidth - w),
    };
  });
  console.log(
    `[${w}] modalW=${m.panelW} onScreen=${m.onScreen} pageOverflowX=${m.overflowX}`,
  );
  await p.close();
}
await b.close();
