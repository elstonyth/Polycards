// QA: raw-card render inside the tier frame — /slots/bronze-pack pool holds
// one raw card (grader '') among slabs locally, so its tile shows the new
// raw-frames band while neighbours show slabs. Asserts the data-slab box
// still measures SLAB_ASPECT, then screenshots the pool section.
// usage: node scripts/qa-raw-frame.mjs [base]
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(`${BASE}/slots/bronze-pack`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// Every slab box must still hold the SLAB_ASPECT contract.
const boxes = await page.$$eval('[data-slab]', (els) =>
  els.slice(0, 40).map((el) => {
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, ratio: r.width / r.height };
  }),
);
const bad = boxes.filter((b) => Math.abs(b.ratio - 1600 / 2700) > 0.01);
console.log(
  `data-slab boxes: ${boxes.length}, aspect violations: ${bad.length}`,
);

// Raw tile present? (an <img> whose src is the bare card photo inside a
// framed span — detect via the raw-frames band asset having loaded)
const rawBands = await page.$$eval('img[src*="raw-frames"]', (els) =>
  els.map((el) => el.getAttribute('src')),
);
console.log('raw-frame bands on page:', JSON.stringify(rawBands));

const pool = page.locator('[data-slab]').first();
await pool.scrollIntoViewIfNeeded();
await page.screenshot({
  path: 'docs/research/qa-raw-frame-pool.png',
  fullPage: true,
});
await browser.close();
console.log('done: docs/research/qa-raw-frame-pool.png');
