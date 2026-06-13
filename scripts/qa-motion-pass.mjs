// QA the motion-fidelity pass on prod :4000.
//  1. Cylinder: drag rotates (imperative), release snaps to a 60° slot (FM spring),
//     shuffle spins ≥60°.
//  2. Select-tap does NOT leak to tap-to-advance (slab stage is reachable and holds —
//     regression test for the AnimatePresence click-bubble bug).
//  3. Full flow reaches the card; tap-to-advance still skips ahead.
//  4. prefers-reduced-motion: overlay jumps straight to the card; hero does not rotate.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const results = [];
const pass = (n, ok, note) => results.push({ name: n, ok: !!ok, note });

// read the cylinder's rotation in degrees: prefer the imperative inline style
// ("rotateY(-52.8deg)"), fall back to decomposing the computed matrix3d
const cylRotY = (page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find(
      (d) => getComputedStyle(d).transformStyle === 'preserve-3d',
    );
    if (!el) return null;
    const inline = el.style.transform;
    const m1 = inline && inline.match(/rotateY\((-?[\d.]+)deg\)/);
    if (m1) return +m1[1];
    const tr = getComputedStyle(el).transform;
    if (!tr || tr === 'none') return 0;
    const m = tr.match(/-?[\d.e]+/g)?.map(Number) || [];
    if (tr.startsWith('matrix3d'))
      return (Math.atan2(m[8], m[0]) * 180) / Math.PI;
    return 0;
  });

const browser = await chromium.launch();
try {
  // ---------- motion-enabled context ----------
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/claw/pokemon-mythic`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  });
  await page.getByRole('button', { name: /Try a free demo spin/i }).click();
  await page.waitForTimeout(900);
  // ALL stage text lives inside the overlay dialog — scope there, or Playwright
  // "sees" the page behind it (isVisible ignores occlusion).
  const dialog = page.locator('[role="dialog"]');

  // 1a. drag rotates (retry once — first interaction can race the mount)
  let during = 0;
  for (let attempt = 0; attempt < 2 && Math.abs(during) < 20; attempt++) {
    await page.mouse.move(720, 450);
    await page.mouse.down();
    await page.mouse.move(560, 450, { steps: 10 });
    during = (await cylRotY(page)) ?? 0;
    await page.mouse.up();
    if (Math.abs(during) < 20) await page.waitForTimeout(600);
  }
  pass(
    'drag rotates the cylinder',
    Math.abs(during) > 20,
    `rotY≈${during.toFixed(1)}° during drag`,
  );

  // 1b. release snaps to a 60° slot (spring settle)
  await page.waitForTimeout(1100);
  const settled = (await cylRotY(page)) ?? 0;
  const snapErr = Math.abs(settled / 60 - Math.round(settled / 60)) * 60;
  pass(
    'release snaps to a 60° slot',
    Math.abs(during) > 20 && snapErr < 2,
    `settled ${settled.toFixed(1)}° (err ${snapErr.toFixed(1)}°)`,
  );

  // 1c. shuffle spins
  await dialog.getByRole('button', { name: /Shuffle/i }).click();
  await page.waitForTimeout(1400);
  const afterShuffle = (await cylRotY(page)) ?? 0;
  pass(
    'shuffle spins the cylinder',
    Math.abs(afterShuffle - settled) > 30,
    `${settled.toFixed(0)}° -> ${afterShuffle.toFixed(0)}°`,
  );

  // 2. select-tap -> slab holds (no instant skip to metadata)
  await page.mouse.click(720, 450);
  await page.waitForTimeout(700); // packs still exiting / slab rising
  const earlyMeta = await dialog
    .getByText(/^(Year|Value|Grade)$/)
    .first()
    .isVisible()
    .catch(() => false);
  pass('select-tap does not skip the slab stage', !earlyMeta);
  await page.waitForTimeout(900);
  pass(
    'slab visible (Tap to reveal)',
    await dialog
      .getByText(/Tap to reveal/i)
      .first()
      .isVisible()
      .catch(() => false),
  );

  // 3. advance: slab -> metadata -> (pull?) -> card via taps
  await page.mouse.click(720, 500);
  await page.waitForTimeout(400);
  pass(
    'metadata stage shows (Year/Value row)',
    await dialog
      .getByText(/^(Year|Value)$/)
      .first()
      .isVisible()
      .catch(() => false),
  );
  await page.mouse.click(720, 500);
  await page.waitForTimeout(300);
  await page.mouse.click(720, 500); // in case a pull stage was in between
  await page.waitForTimeout(600);
  pass(
    'card stage reached (Continue)',
    await dialog
      .getByRole('button', { name: /^Continue$/ })
      .first()
      .isVisible()
      .catch(() => false),
  );
  const imgOk = await page.evaluate(() =>
    [...document.querySelectorAll('img')].some(
      (i) => i.src.includes('/cdn/cards/') && i.naturalWidth > 50,
    ),
  );
  pass('won card image rendered', imgOk);
  await ctx.close();

  // ---------- reduced-motion context ----------
  const rctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  const rpage = await rctx.newPage();
  await rpage.goto(`${BASE}/claw/pokemon-mythic`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  });
  await rpage.getByRole('button', { name: /Try a free demo spin/i }).click();
  await rpage.waitForTimeout(500);
  pass(
    'reduced-motion: jumps straight to the card',
    await rpage
      .getByRole('button', { name: /^Continue$/ })
      .first()
      .isVisible()
      .catch(() => false),
  );
  pass(
    'reduced-motion: no cylinder stage',
    !(await rpage
      .getByText(/Drag to spin/i)
      .first()
      .isVisible()
      .catch(() => false)),
  );

  // hero does not rotate under reduced motion
  await rpage.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 60000 });
  await rpage.waitForTimeout(600);
  const snap = () =>
    rpage.evaluate(() =>
      [...document.querySelectorAll('img')]
        .filter((im) => {
          const r = im.getBoundingClientRect();
          return r.top < 560 && r.x > 560 && r.width > 50;
        })
        .map((im) => {
          let w = im.parentElement,
            d = 0;
          while (
            w &&
            d < 4 &&
            getComputedStyle(w).opacity === '1' &&
            getComputedStyle(w).transform === 'none'
          ) {
            w = w.parentElement;
            d++;
          }
          return `${(im.src || '').split('/').pop()}:${getComputedStyle(w).opacity}`;
        })
        .sort()
        .join('|'),
    );
  const a = await snap();
  await rpage.waitForTimeout(5000); // > one rotate period
  const b = await snap();
  pass('reduced-motion: hero static across 5s', a === b);
  await rctx.close();
} finally {
  await browser.close();
}

let ok = 0;
for (const r of results) {
  console.log(
    `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? '  (' + r.note + ')' : ''}`,
  );
  if (r.ok) ok++;
}
console.log(`\n${ok}/${results.length} checks passed`);
process.exit(ok === results.length ? 0 : 1);
