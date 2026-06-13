// Settle the claw mechanism: dump the FULL machine-container subtree (unfiltered) and track
// every descendant's bounding-rect over 6s to find ANY motion (transform, left, margin, etc.)
// and any separate claw layer. Animations forced on.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const URL = process.argv[2] || 'https://www.phygitals.com/claw/legend-pack';
const OUT = 'docs/research/packdetail';
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
await page.emulateMedia({ reducedMotion: 'no-preference' });
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);

// tag the machine wrapper so we can query its subtree repeatedly
const found = await page.evaluate(() => {
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
  cont.setAttribute('data-recon', 'machine');
  // full subtree dump
  const dump = [];
  const walk = (el, depth) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    dump.push({
      depth,
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 70),
      w: Math.round(r.width),
      h: Math.round(r.height),
      src: (el.currentSrc || el.getAttribute?.('src') || '').slice(0, 70),
      anim: cs.animationName,
      tf: cs.transform === 'none' ? '' : cs.transform,
    });
    for (const c of el.children) walk(c, depth + 1);
  };
  walk(cont, 0);
  return { count: dump.length, dump };
});
writeFileSync(`${OUT}/recon-subtree.json`, JSON.stringify(found, null, 2));

// track positions of every descendant over 6s
const series = [];
for (let t = 0; t < 24; t++) {
  const snap = await page.evaluate(() => {
    const cont = document.querySelector('[data-recon="machine"]');
    const arr = [];
    const all = cont ? cont.querySelectorAll('*') : [];
    let i = 0;
    for (const el of all) {
      const r = el.getBoundingClientRect();
      arr.push([i++, Math.round(r.x * 10) / 10, Math.round(r.y * 10) / 10]);
    }
    return arr;
  });
  series.push(snap);
  await page.waitForTimeout(250);
}
// compute per-index x/y range
const n = Math.max(...series.map((s) => s.length));
const movers = [];
for (let i = 0; i < n; i++) {
  const xs = series.map((s) => s[i]?.[1]).filter((v) => v != null);
  const ys = series.map((s) => s[i]?.[2]).filter((v) => v != null);
  if (!xs.length) continue;
  const xr = Math.max(...xs) - Math.min(...xs),
    yr = Math.max(...ys) - Math.min(...ys);
  if (xr > 1.5 || yr > 1.5)
    movers.push({ index: i, xRange: +xr.toFixed(1), yRange: +yr.toFixed(1) });
}
writeFileSync(
  `${OUT}/recon-movers.json`,
  JSON.stringify({ totalTracked: n, movers }, null, 2),
);
console.log(`subtree=${found?.count} tracked=${n} movers=${movers.length}`);
await browser.close();
