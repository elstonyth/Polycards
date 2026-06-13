// Headed capture: watch the live claw machine actually animate (headless pauses JS rAF/visibility
// -gated motion). Capture frames idle + on hover, and pixel-diff consecutive frames to detect motion.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const URL = process.argv[2] || 'https://www.phygitals.com/claw/legend-pack';
const OUT = 'docs/research/packdetail';
let browser;
try {
  browser = await chromium.launch({ headless: false });
} catch (e) {
  console.log('HEADED LAUNCH FAILED: ' + e.message);
  process.exit(1);
}
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
await page.emulateMedia({ reducedMotion: 'no-preference' });
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);
await page.bringToFront();

const box = await page.evaluate(() => {
  let best = null,
    area = 0;
  for (const im of document.querySelectorAll('img')) {
    const r = im.getBoundingClientRect();
    if (r.top < 760 && r.width * r.height > area) {
      area = r.width * r.height;
      best = im;
    }
  }
  const r = best.getBoundingClientRect();
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
});
const clip = { x: box.x, y: box.y, width: box.w, height: box.h };

const rects = [];
const grab = async (phase, i) => {
  const r = await page.evaluate(() => {
    let b = null,
      a = 0;
    for (const im of document.querySelectorAll('img')) {
      const rr = im.getBoundingClientRect();
      if (rr.top < 760 && rr.width * rr.height > a) {
        a = rr.width * rr.height;
        b = im;
      }
    }
    const rr = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    const w = b.closest('[class*="relative"]');
    return {
      x: Math.round(rr.x * 10) / 10,
      y: Math.round(rr.y * 10) / 10,
      tf: cs.transform,
      parentTf: w ? getComputedStyle(w).transform : '',
    };
  });
  rects.push({ phase, i, ...r });
  await page.screenshot({
    path: `${OUT}/headed-${phase}-${String(i).padStart(2, '0')}.png`,
    clip,
  });
};

// idle
for (let i = 0; i < 8; i++) {
  await grab('idle', i);
  await page.waitForTimeout(500);
}
// hover the machine
await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
await page.waitForTimeout(400);
for (let i = 0; i < 6; i++) {
  await grab('hover', i);
  await page.waitForTimeout(500);
}

writeFileSync(`${OUT}/recon-headed-rects.json`, JSON.stringify(rects, null, 2));
const xs = rects.map((r) => r.x),
  ys = rects.map((r) => r.y);
console.log(
  `img x-range=${(Math.max(...xs) - Math.min(...xs)).toFixed(1)} y-range=${(Math.max(...ys) - Math.min(...ys)).toFixed(1)} ; transforms seen: ${[...new Set(rects.map((r) => r.tf))].join(' | ').slice(0, 160)}`,
);
await browser.close();
console.log('headed recon done');
