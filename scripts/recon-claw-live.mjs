// Recon the LIVE phygitals claw machine: real DOM layers, claw-arm animation mechanism,
// and motion frames. Grounds the rebuild in reality (earlier recon wrongly called it "static").
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const URL = process.argv[2] || 'https://www.phygitals.com/claw/legend-pack';
const OUT = 'docs/research/packdetail';
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});

// log image/json/lottie asset requests (a separate claw sprite/lottie would show here)
const assets = [];
page.on('request', (r) => {
  const u = r.url();
  if (
    /\.(png|webp|avif|svg|json|lottie|gif|mp4|webm)(\?|$)/i.test(u) ||
    /claw|arm|machine|grab/i.test(u)
  )
    assets.push(u);
});

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000); // let it hydrate/animate

  // 1) Dump sizeable visual elements in the upper-left (machine area) with anim/transform info
  const elements = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width < 30 || r.height < 30 || r.top > 760 || r.left > 1200)
        continue;
      const cs = getComputedStyle(el);
      const bg =
        cs.backgroundImage !== 'none' ? cs.backgroundImage.slice(0, 140) : '';
      const src = el.currentSrc || el.getAttribute?.('src') || '';
      if (
        !src &&
        !bg &&
        cs.animationName === 'none' &&
        cs.transform === 'none' &&
        cs.translate === 'none'
      )
        continue;
      out.push({
        tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 90),
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        z: cs.zIndex,
        pos: cs.position,
        animationName: cs.animationName,
        animationDuration: cs.animationDuration,
        animationTimingFunction: cs.animationTimingFunction,
        transform: cs.transform,
        translate: cs.translate,
        transition: cs.transition,
        src: src.slice(0, 160),
        bg,
      });
    }
    return out;
  });
  writeFileSync(
    `${OUT}/recon-claw-elements.json`,
    JSON.stringify(elements, null, 2),
  );

  // 2) Locate biggest <img> top-left (the machine) and dump an ancestor's structure
  const struct = await page.evaluate(() => {
    let best = null,
      area = 0;
    for (const im of document.querySelectorAll('img')) {
      const r = im.getBoundingClientRect();
      if (r.top < 760 && r.width * r.height > area) {
        area = r.width * r.height;
        best = im;
      }
    }
    if (!best) return null;
    let cont = best;
    for (let i = 0; i < 4 && cont.parentElement; i++) cont = cont.parentElement;
    const html = cont.outerHTML.replace(/></g, '>\n<').slice(0, 6000);
    const r = best.getBoundingClientRect();
    return {
      machineSrc: best.currentSrc || best.src,
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
      containerHTML: html,
    };
  });
  writeFileSync(
    `${OUT}/recon-claw-struct.html`,
    struct ? struct.containerHTML : 'no machine img found',
  );
  writeFileSync(
    `${OUT}/recon-claw-struct.json`,
    JSON.stringify(
      { machineSrc: struct?.machineSrc, rect: struct?.rect },
      null,
      2,
    ),
  );

  // 3) Sample horizontal position of every transformed/translated element over 3.2s → find what slides
  const motion = {};
  for (let t = 0; t < 16; t++) {
    const snap = await page.evaluate(() => {
      const m = {};
      let i = 0;
      for (const el of document.querySelectorAll(
        "img, [class*='claw' i], [class*='arm' i], [class*='grab' i], [style*='translate'], [style*='transform']",
      )) {
        const cs = getComputedStyle(el);
        if (cs.transform === 'none' && cs.translate === 'none') continue;
        const r = el.getBoundingClientRect();
        const key =
          (
            el.tagName +
            '.' +
            (el.className || '').toString().split(' ')[0]
          ).slice(0, 50) +
          '#' +
          i++;
        m[key] = {
          x: Math.round(r.x * 10) / 10,
          transform: cs.transform,
          translate: cs.translate,
        };
      }
      return m;
    });
    motion[`t${t}`] = snap;
    await page
      .screenshot({
        path: `${OUT}/recon-frame-${String(t).padStart(2, '0')}.png`,
        clip: {
          x: struct?.rect.x ?? 280,
          y: struct?.rect.y ?? 140,
          width: Math.min(900, struct?.rect.w ?? 880),
          height: Math.min(600, struct?.rect.h ?? 560),
        },
      })
      .catch(() => {});
    await page.waitForTimeout(200);
  }
  writeFileSync(
    `${OUT}/recon-claw-motion.json`,
    JSON.stringify(motion, null, 2),
  );
  writeFileSync(
    `${OUT}/recon-claw-assets.json`,
    JSON.stringify([...new Set(assets)], null, 2),
  );
  console.log(
    `elements=${elements.length} assets=${new Set(assets).size} machineSrc=${struct?.machineSrc?.slice(0, 80)}`,
  );
} catch (e) {
  console.log('RECON ERROR: ' + e.message);
}
await browser.close();
console.log('recon done');
