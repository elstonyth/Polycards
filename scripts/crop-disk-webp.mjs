// Render a disk webp (post-compose, pre-rebuild) at high zoom: banner crop + full machine,
// so we can judge the bake without rebuilding the server.
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';

const bases = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1200, height: 1000 },
  deviceScaleFactor: 1.5,
});
for (const base of bases) {
  const buf = await readFile(`public/images/claw/${base}-machine.webp`);
  const dataUrl = 'data:image/webp;base64,' + buf.toString('base64');
  await page.setContent(
    `<body style="margin:0;background:#888"><img id="m" src="${dataUrl}" style="width:1100px;display:block"/></body>`,
  );
  await page
    .waitForFunction(
      () => {
        const im = document.getElementById('m');
        return im && im.complete && im.naturalWidth > 0;
      },
      { timeout: 8000 },
    )
    .catch(() => {});
  await page.waitForTimeout(200);
  const box = await page.locator('#m').boundingBox();
  await page.screenshot({
    path: `docs/research/packdetail/disk_${base}_banner.png`,
    clip: { x: box.x, y: box.y, width: box.width, height: box.height * 0.27 },
  });
  await page.screenshot({
    path: `docs/research/packdetail/disk_${base}_bottom.png`,
    clip: {
      x: box.x,
      y: box.y + box.height * 0.66,
      width: box.width,
      height: box.height * 0.34,
    },
  });
  await writeFile(
    `docs/research/packdetail/disk_${base}_full.png`,
    await page.locator('#m').screenshot(),
  );
  console.log(`${base} done`);
}
await browser.close();
