// Zoom into the rookie banner (incl. margin above/left) to find the residual
// "phygitals" fragment the user circled. Shows x18-64%, y7-27% enlarged ~2.3x.
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const Z = 2.4; // zoom factor
const cropX = 0.18 * 1440,
  cropY = 0.07 * 1000; // crop origin (px)
const VW = Math.round((0.64 - 0.18) * 1440 * Z); // viewport width
const VH = Math.round((0.27 - 0.07) * 1000 * Z);
const html = `<!doctype html><body style="margin:0;background:#000">
  <div style="width:${VW}px;height:${VH}px;overflow:hidden;position:relative">
    <img src="../../../public/images/claw/rookie-pack-machine.webp"
         style="position:absolute;width:${Math.round(1440 * Z)}px;left:${-Math.round(cropX * Z)}px;top:${-Math.round(cropY * Z)}px"/>
  </div>
</body>`;
writeFileSync('docs/research/packdetail/zoom-rookie.html', html);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: VW, height: VH },
  deviceScaleFactor: 2,
});
await page.goto(
  'file:///' +
    resolve('docs/research/packdetail/zoom-rookie.html').replace(/\\/g, '/'),
  { waitUntil: 'load' },
);
await page.waitForTimeout(900);
await page.screenshot({ path: 'docs/research/packdetail/zoom-rookie.png' });
await browser.close();
console.log(`zoomed ${VW}x${VH}`);
