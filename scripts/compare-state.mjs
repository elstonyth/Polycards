import { chromium } from 'playwright';
const b = await chromium.launch();
for (const [url, name] of [
  ['https://www.phygitals.com/', 'ORIG'],
  ['http://localhost:4000/', 'CLONE'],
]) {
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 20; i++) {
    if (await p.evaluate(() => document.images.length > 3)) break;
    await p.waitForTimeout(800);
  }
  await p.waitForTimeout(2000);
  await p.screenshot({
    path: `docs/research/STATE_${name}.png`,
    clip: { x: 0, y: 0, width: 1920, height: 1000 },
  });
  await p.close();
}
await b.close();
console.log('state shots done');
