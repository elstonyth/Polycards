// Visual harness to dial in the "Pokenic" overlay that covers the baked-in
// "phygitals" wordmark. Renders 3 differently-colored machines with the overlay
// at the given %; screenshot, tweak COORDS, repeat. Then port values to the component.
import { chromium } from 'playwright';
import { resolve } from 'node:path';

// ---- tweak these ----
const L = 30,
  T = 15,
  W = 28.5,
  H = 6.7; // overlay box, % of image
const CREAM = 'rgb(214,215,218)';
const PURPLE = 'rgb(104,108,190)';
const FONT_PCT = 3.55; // font-size as % of image width
// ---------------------

const machines = ['mythic-pack', 'legend-pack', 'elite-pack'];
const DISPLAY = 560;
const cell = (b) => `
  <div style="margin:8px">
    <div style="font:12px monospace;color:#fff">${b}</div>
    <div style="position:relative;display:inline-block;background:#777">
      <img src="../../../public/images/claw/${b}-machine.avif" style="display:block;width:${DISPLAY}px"/>
      <div style="position:absolute;left:${L}%;top:${T}%;width:${W}%;height:${H}%;background:${CREAM};border-radius:3px;display:flex;align-items:center;justify-content:center;overflow:hidden">
        <span style="color:${PURPLE};font-family:'Arial Rounded MT Bold','Segoe UI',sans-serif;font-weight:800;font-size:${((FONT_PCT / 100) * DISPLAY).toFixed(1)}px;letter-spacing:-0.3px;line-height:1">Pokenic</span>
      </div>
    </div>
  </div>`;
const html = `<!doctype html><body style="margin:0;background:#222;display:flex;flex-wrap:wrap">${machines.map(cell).join('')}</body>`;

import { writeFileSync } from 'node:fs';
writeFileSync('docs/research/packdetail/overlay-test.html', html);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1820, height: 760 },
  deviceScaleFactor: 1.6,
});
await page.goto(
  'file:///' +
    resolve('docs/research/packdetail/overlay-test.html').replace(/\\/g, '/'),
  { waitUntil: 'load' },
);
await page.waitForTimeout(1200);
// banner band across all three machines
await page.screenshot({
  path: 'docs/research/packdetail/overlay-test.png',
  clip: { x: 0, y: 16, width: 1760, height: 175 },
});
await browser.close();
console.log(`coords L=${L} T=${T} W=${W} H=${H} font%=${FONT_PCT}`);
