// scripts/qa-idle-drift.mjs
// Verify the IDLE reel drift on the PROD build (:4000), no login needed:
//   1. the idle strip is exactly periodic (period p cells) -> a wrap is seamless
//   2. it moves, LEFT (cells stream right->left, same travel as a spin)
//   3. at ~20px/s, with no motion blur
//   4. the wrap jumps back by exactly p * pitch (no seam, no drift off the strip end)
//   5. prefers-reduced-motion rests static
// Run: node scripts/qa-idle-drift.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:4000';
const PACK = process.env.QA_PACK ?? 'pokemon-black';
const STRIP = '.will-change-transform';

let failed = false;
const ok = (m) => console.log(`✓ ${m}`);
const fail = (m) => {
  console.error(`✗ ${m}`);
  failed = true;
};

mkdirSync('docs/research', { recursive: true });
const browser = await chromium.launch({ headless: true });

/** Cell fingerprint (sprite + tier color) for every cell on the strip. */
const readCells = (page) =>
  page.evaluate((sel) => {
    const strip = document.querySelector(sel);
    return [...strip.children].map((c) => {
      const tile = c.firstElementChild;
      const img = c.querySelector('img');
      const cs = getComputedStyle(tile);
      return `${img?.getAttribute('src') ?? '?'}|${cs.borderColor}|${cs.boxShadow}`;
    });
  }, STRIP);

const readStrip = (page) =>
  page.evaluate((sel) => {
    const strip = document.querySelector(sel);
    const cs = getComputedStyle(strip);
    const x = new DOMMatrixReadOnly(cs.transform).m41;
    const a = strip.children[0].getBoundingClientRect();
    const b = strip.children[1].getBoundingClientRect();
    return { x, filter: cs.filter, pitch: b.left - a.left };
  }, STRIP);

async function open(page) {
  await page.goto(`${BASE}/slots/${PACK}/spin`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector(STRIP, { timeout: 20_000 });
  await page.waitForTimeout(1500); // let sprites paint
}

// ---- reduced motion: must rest static -------------------------------------
{
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await open(page);
  const a = (await readStrip(page)).x;
  await page.waitForTimeout(2000);
  const b = (await readStrip(page)).x;
  if (a === b) ok(`reduced-motion: static (x=${a.toFixed(1)})`);
  else fail(`reduced-motion drifted: ${a} -> ${b}`);
  await ctx.close();
}

// ---- normal motion ---------------------------------------------------------
const ctx = await browser.newContext({ reducedMotion: 'no-preference' });
const page = await ctx.newPage();
await open(page);
await page.screenshot({ path: 'docs/research/idle-drift-t0.png' });

// 1. periodicity
const cells = await readCells(page);
let period = 0;
// p > len/2 proves nothing (it compares a handful of cells), so cap the search:
// a real period repeats at least twice across the strip.
for (let p = 1; p <= cells.length / 2; p++) {
  let match = true;
  for (let i = 0; i + p < cells.length && match; i++)
    if (cells[i + p] !== cells[i]) match = false;
  if (match) {
    period = p;
    break;
  }
}
if (period > 0) ok(`strip is periodic: ${period} cells (of ${cells.length})`);
else fail('strip is NOT periodic -> the drift wrap would show a seam');

const { pitch } = await readStrip(page);
const wrapPx = period * pitch;
console.log(`  pitch=${pitch.toFixed(1)}px  wrap=${wrapPx.toFixed(1)}px`);

// 2/3. direction + speed + blur, over a 3s window
const s0 = await readStrip(page);
const t0 = Date.now();
await page.waitForTimeout(3000);
const s1 = await readStrip(page);
const dt = Date.now() - t0;
const dx = s1.x - s0.x;
const speed = (-dx / dt) * 1000; // px/s of leftward travel

if (dx < 0) ok(`moves LEFT (cells stream right->left): dx=${dx.toFixed(1)}px`);
else fail(`does not move left: dx=${dx.toFixed(1)}px`);
if (speed > 16 && speed < 24) ok(`speed ${speed.toFixed(1)}px/s (~20 target)`);
else fail(`speed ${speed.toFixed(1)}px/s outside 16-24px/s`);
if (s1.filter === 'none') ok('no motion blur while idling');
else fail(`unexpected filter: ${s1.filter}`);

// 4. the wrap: sample until x jumps back, assert the jump == wrapPx exactly
const budgetMs = (wrapPx / 20) * 1000 + 8000;
let prev = s1.x;
let jump = null;
const deadline = Date.now() + budgetMs;
while (Date.now() < deadline && jump === null) {
  await page.waitForTimeout(120);
  const { x } = await readStrip(page);
  if (x > prev + 1) jump = x - prev; // moved back right => wrapped
  prev = x;
}
// The sample straddling the wrap also contains up to one poll's worth of normal
// leftward drift (~120ms x 20px/s = 2.4px), so allow a few px of slack.
if (jump === null) {
  fail(`no wrap observed within ${(budgetMs / 1000).toFixed(0)}s`);
} else if (Math.abs(jump - wrapPx) < 6) {
  ok(
    `wrap jumps back exactly one period: ${jump.toFixed(1)}px == ${wrapPx.toFixed(1)}px`,
  );
} else {
  fail(
    `wrap jump ${jump.toFixed(1)}px != one period ${wrapPx.toFixed(1)}px (SEAM)`,
  );
}
await page.screenshot({ path: 'docs/research/idle-drift-postwrap.png' });

// 5. cells rendered at the wrap offset are identical (the seam guarantee, in the DOM)
const after = await readCells(page);
if (period > 0 && after.every((c, i) => c === cells[i]))
  ok('cell fingerprints unchanged across the wrap');
else fail('cell content changed across the wrap');

await ctx.close();
await browser.close();
process.exitCode = failed ? 1 : 0;
console.log(failed ? '\nFAILED' : '\nALL PASS');
