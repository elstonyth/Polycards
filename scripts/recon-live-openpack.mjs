// Deep recon of the LIVE phygitals pack-opening (the free "demo spin", no login).
// Goal: capture the REAL interaction model + 3D structure so the clone can match 100%.
// Drives www.phygitals.com/claw/<slug>, opens the demo, dumps the carousel DOM + per-pack
// transforms, tests drag-to-rotate, and films the carousel -> slab -> reveal sequence.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const SLUG = process.argv[2] || 'legend-pack';
const LIVE = `https://www.phygitals.com/claw/${SLUG}`;
const OUT = 'docs/research/openpack-live';
mkdirSync(OUT, { recursive: true });

const log = {};
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  userAgent: 'Mozilla/5.0',
});
const page = await ctx.newPage();

await page.goto(LIVE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/00-detail.png` });

// list candidate buttons
log.buttons = await page.evaluate(() =>
  [...document.querySelectorAll('button, a, [role=button]')]
    .map((b) => (b.textContent || '').trim())
    .filter((t) => t && t.length < 40),
);

// click the demo-spin trigger
const demo = page
  .getByText(/free demo|demo spin|try a free|free spin/i)
  .first();
let opened = false;
try {
  await demo.click({ timeout: 8000 });
  opened = true;
} catch {
  // fallback: any button containing "demo"
  try {
    await page
      .getByRole('button', { name: /demo/i })
      .first()
      .click({ timeout: 5000 });
    opened = true;
  } catch {}
}
log.demo_opened = opened;
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/01-carousel.png` });

// Identify the overlay + the carousel container, dump structure + per-child transforms
log.overlay = await page.evaluate(() => {
  // the overlay is typically a fixed full-screen node
  const fixed = [...document.querySelectorAll('div')].filter((d) => {
    const s = getComputedStyle(d);
    return (
      s.position === 'fixed' &&
      d.getBoundingClientRect().width > window.innerWidth * 0.8 &&
      d.getBoundingClientRect().height > window.innerHeight * 0.8
    );
  });
  const overlay = fixed[fixed.length - 1];
  if (!overlay) return null;
  // find elements that look like the carousel packs (images / 3d transformed)
  const transformed = [...overlay.querySelectorAll('*')]
    .map((el) => {
      const s = getComputedStyle(el);
      const tr = s.transform;
      if (tr && tr !== 'none' && tr.includes('matrix3d')) {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          cls: (el.className || '').toString().slice(0, 60),
          transform: tr,
          perspective: getComputedStyle(el.parentElement).perspective,
          w: Math.round(r.width),
          h: Math.round(r.height),
          x: Math.round(r.x),
          y: Math.round(r.y),
        };
      }
      return null;
    })
    .filter(Boolean);
  // captions / pills text in overlay
  const texts = [...overlay.querySelectorAll('*')]
    .map((e) => (e.childElementCount === 0 ? (e.textContent || '').trim() : ''))
    .filter((t) => t && t.length < 40);
  return {
    transformedCount: transformed.length,
    transformed: transformed.slice(0, 12),
    texts: [...new Set(texts)].slice(0, 20),
  };
});

// Test drag-to-rotate: drag horizontally across the center and screenshot before/after
const cx = 720,
  cy = 460;
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(cx - i * 28, cy);
  await page.waitForTimeout(20);
}
await page.mouse.up();
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/02-after-drag.png` });
log.afterDrag = await page.evaluate(() => {
  const fixed = [...document.querySelectorAll('div')].filter(
    (d) => getComputedStyle(d).position === 'fixed',
  );
  const o = fixed[fixed.length - 1];
  const t = [...(o?.querySelectorAll('*') || [])]
    .map((el) => getComputedStyle(el).transform)
    .filter((x) => x && x.includes('matrix3d'));
  return { matrix3dCount: t.length, sample: t[0] };
});

// Film the carousel area for ~2s (in case it auto-rotates)
for (let i = 0; i < 12; i++) {
  await page.screenshot({
    path: `${OUT}/film-${String(i).padStart(2, '0')}.png`,
    clip: { x: 360, y: 180, width: 720, height: 560 },
  });
  await page.waitForTimeout(130);
}

writeFileSync(`${OUT}/recon.json`, JSON.stringify(log, null, 2));
console.log(JSON.stringify(log, null, 2));
await browser.close();
