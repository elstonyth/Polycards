// Measure the rendered width of the claw-machine <img> across breakpoints, to decide
// whether the baked "phygitals.com" url (native ~12px in a 1000px frame) is legible at any
// supported size. URL CSS height ≈ 0.0083 × rendered machine width. <3px → banner-only scope.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4000';
const URL = `${BASE}/claw/pokemon-mythic`; // shows mythic-pack animated machine
const WIDTHS = [390, 768, 1024, 1440, 1920, 2560, 3840];

const browser = await chromium.launch();
const rows = [];
for (const w of WIDTHS) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const box = await page
    .locator('img[alt*="claw machine"]')
    .first()
    .boundingBox()
    .catch(() => null);
  if (box) {
    const mw = box.width;
    // displayed machine: object-contain in aspect-36/25 box; source 1440x1000.
    // displayed height fits; url text native ~12px of 1000 → css height:
    const urlCss = (12 * ((mw * 25) / 36)) / 1000;
    rows.push({
      vw: w,
      machineW: Math.round(mw),
      machineH: Math.round(box.height),
      urlTextCssPx: +urlCss.toFixed(2),
    });
  } else {
    rows.push({ vw: w, machineW: null });
  }
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(rows, null, 2));
