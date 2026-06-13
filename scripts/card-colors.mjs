import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1500);
const themes = [
  ['pokemon', '/home/hero/ripped-packs/pokemon.webp'],
  ['onepiece', '/home/hero/ripped-packs/onepiece.webp'],
  ['basketball', '/home/hero/ripped-packs/basketball.webp'],
  ['football', '/home/hero/ripped-packs/football.webp'],
  ['baseball', '/home/hero/ripped-packs/baseball.webp'],
  ['yugioh', '/home/hero/ripped-packs/yugioh.webp'],
];
for (const [name, src] of themes) {
  const rgb = await p.evaluate(async (src) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 60;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 40, 60);
    const d = ctx.getImageData(0, 0, 40, 60).data;
    let r = 0,
      g = 0,
      bl = 0,
      n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i],
        G = d[i + 1],
        B = d[i + 2];
      const mx = Math.max(R, G, B),
        mn = Math.min(R, G, B);
      const sat = mx - mn;
      // weight by saturation so we capture the vivid hue, not the white/grey packaging
      const w = sat * sat;
      r += R * w;
      g += G * w;
      bl += B * w;
      n += w;
    }
    if (n === 0) return [120, 120, 120];
    return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
  }, src);
  console.log(`${name}: rgb(${rgb.join(', ')})`);
}
await b.close();
