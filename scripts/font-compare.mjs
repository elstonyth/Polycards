// Identify the phygitals wordmark font: crop the REAL wordmark from a clean original and
// render "phygitals"/"pokenic" in candidate web fonts at the same scale to find the match.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const origB =
  'data:image/png;base64,' +
  (await readFile('docs/research/packdetail/lama-in/legend-pack.png')).toString(
    'base64',
  );
const CANDIDATES = [
  'Poppins',
  'Montserrat',
  'Outfit',
  'Urbanist',
  'Nunito',
  'Quicksand',
  'Baloo 2',
  'Comfortaa',
  'DM Sans',
  'Manrope',
];
const fams = CANDIDATES.map(
  (c) => `family=${c.replace(/ /g, '+')}:wght@600;700`,
).join('&');

const rows = CANDIDATES.map(
  (c) => `
  <div style="display:flex;align-items:center;gap:18px;border-top:1px solid #333;padding:6px 0">
    <div style="width:120px;font:11px monospace;color:#9cf">${c}</div>
    <div style="font-family:'${c}';font-weight:700;font-size:54px;color:#111">phygitals</div>
    <div style="font-family:'${c}';font-weight:700;font-size:54px;color:#b8003a">pokenic</div>
  </div>`,
).join('');

const html = `<!doctype html><head><link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?${fams}&display=swap" rel="stylesheet"></head>
<body style="margin:0;background:#cdb87a;padding:16px;font:13px monospace">
  <div style="color:#111;font-weight:bold">REAL phygitals wordmark (legend-pack original, cropped + zoomed):</div>
  <div style="width:760px;height:150px;overflow:hidden;background:#cdb87a;margin:6px 0 14px">
    <img src="${origB}" style="width:2600px;margin-left:-940px;margin-top:-220px;display:block"/>
  </div>
  <div style="background:#e9e3cf;border-radius:8px;padding:8px 14px">${rows}</div>
</body>`;
const f = resolve('docs/research/packdetail/_fontcmp.html').replace(/\\/g, '/');
writeFileSync(f, html);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 900, height: 1000 },
  deviceScaleFactor: 2,
});
await page.goto('file:///' + f, { waitUntil: 'load' });
await page.waitForTimeout(2500);
await page.screenshot({
  path: 'docs/research/packdetail/fontcmp.png',
  fullPage: true,
});
await browser.close();
console.log('font comparison rendered');
