import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'docs/playwright/carousel';
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1200);

// snapshot: how many card slots are visible (opacity>0.05) + which is center (opacity~1, no blur) + glow color
async function snap() {
  return p.evaluate(() => {
    const right = [...document.querySelectorAll('section a div')].filter(
      (d) =>
        d.style && d.style.transform && d.style.transform.includes('scale'),
    );
    const cards = right
      .map((d) => {
        const cs = getComputedStyle(d);
        const slab = d.querySelector('img[alt]');
        return {
          op: +(+cs.opacity).toFixed(2),
          blur: cs.filter,
          z: cs.zIndex,
          name: (slab && slab.alt) || '',
        };
      })
      .filter((c) => c.op > 0.05);
    const center = cards.find(
      (c) => c.op > 0.9 && (c.blur === 'none' || c.blur === ''),
    );
    // active glow div
    const glows = [
      ...document.querySelectorAll('section a > div[aria-hidden]'),
    ].filter(
      (d) => d.style.background && d.style.background.includes('radial'),
    );
    const activeGlow = glows
      .map((g) => ({
        op: +(+getComputedStyle(g).opacity).toFixed(2),
        bg: g.style.background,
      }))
      .filter((g) => g.op > 0.5)[0];
    return {
      visible: cards.length,
      centerName: center ? center.name : null,
      glow: activeGlow ? activeGlow.bg.match(/rgba?\([^)]+\)/)?.[0] : null,
    };
  });
}

const seq = [];
for (let i = 0; i < 10; i++) {
  const s = await snap();
  seq.push(s);
  await p.screenshot({
    path: `${OUT}/c${i}.png`,
    clip: { x: 620, y: 40, width: 820, height: 520 },
  });
  await p.waitForTimeout(1500);
}
seq.forEach((s, i) =>
  console.log(
    `t${i}: visibleCards=${s.visible} center="${s.centerName}" glow=${s.glow}`,
  ),
);
const broken = await p.evaluate(
  () =>
    [...document.images].filter((x) => x.complete && x.naturalWidth === 0)
      .length,
);
console.log('broken:', broken);
await b.close();
