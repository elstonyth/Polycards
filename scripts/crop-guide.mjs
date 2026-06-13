// Render a machine banner crop with a RED vertical guide at a candidate centre fraction, to
// eyeball whether that line is the plate's true visual centre and where "pokenic" sits vs it.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2); // base=frac
const DW = 1100;
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1200, height: 1000 },
  deviceScaleFactor: 1.5,
});
for (const a of args) {
  const [base, frac] = a.split('=');
  const data =
    'data:image/webp;base64,' +
    (await readFile(`public/images/claw/${base}-machine.webp`)).toString(
      'base64',
    );
  await page.setContent(`<body style="margin:0;background:#888;position:relative;width:${DW}px">
    <img id="m" src="${data}" style="width:${DW}px;display:block"/>
    <div style="position:absolute;top:0;bottom:0;left:${+frac * DW}px;width:2px;background:red"></div></body>`);
  await page.waitForFunction(() => {
    const i = document.getElementById('m');
    return i && i.complete && i.naturalWidth > 0;
  });
  await page.waitForTimeout(150);
  const box = await page.locator('#m').boundingBox();
  await page.screenshot({
    path: `docs/research/packdetail/guide_${base}.png`,
    clip: { x: box.x, y: box.y, width: box.width, height: box.height * 0.3 },
  });
  console.log(base, 'guide@', frac);
}
await browser.close();
