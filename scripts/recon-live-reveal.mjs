// Capture the LIVE reveal tail: open demo -> tap a pack (slab) -> tap slab -> film the
// metadata + card reveal frame-by-frame with the per-frame text labels.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
const SLUG = process.argv[2] || 'legend-pack';
const OUT = 'docs/research/openpack-live';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  userAgent: 'Mozilla/5.0',
});
const page = await ctx.newPage();
await page.goto(`https://www.phygitals.com/claw/${SLUG}`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
await page.waitForTimeout(5000);
{
  const demos = page.getByText(/try a free demo/i);
  const n = await demos.count();
  for (let i = 0; i < n; i++) {
    const el = demos.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.click();
      break;
    }
  }
}
await page.waitForTimeout(2500);
await page.mouse.click(720, 430); // select a pack -> slab
await page.waitForTimeout(1500);
await page.mouse.click(720, 460); // tap slab -> reveal
const frames = [];
for (let i = 0; i < 26; i++) {
  await page.screenshot({
    path: `${OUT}/rev2-${String(i).padStart(2, '0')}.png`,
  });
  const txt = await page.evaluate(() => {
    const all = [...document.querySelectorAll('div')];
    const o = all.find(
      (d) =>
        getComputedStyle(d).position === 'fixed' &&
        d.getBoundingClientRect().width > window.innerWidth * 0.8,
    );
    return o
      ? [
          ...new Set(
            [...o.querySelectorAll('*')]
              .filter((e) => e.childElementCount === 0)
              .map((e) => (e.textContent || '').trim())
              .filter((t) => t && t.length < 40),
          ),
        ]
      : [];
  });
  frames.push(txt.join(' | '));
  await page.waitForTimeout(200);
}
writeFileSync(`${OUT}/reveal-text.json`, JSON.stringify(frames, null, 2));
console.log(frames.map((f, i) => `${i}: ${f}`).join('\n'));
await browser.close();
