// Verify the two user-reported fixes on prod :4000:
//  1. Card stage shows the slab photo RAW (no white holder chrome), live-sized,
//     with a 300px Continue.
//  2. Drag release FLINGS with momentum (carries past the nearest slot on a fast
//     swipe, still settles on a 60° slot) and shuffle decelerates long.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const OUT = 'docs/research/clone-film/v2';
mkdirSync(OUT, { recursive: true });
const results = [];
const pass = (n, ok, note) => results.push({ name: n, ok: !!ok, note });

const rotY = (page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find(
      (d) => getComputedStyle(d).transformStyle === 'preserve-3d',
    );
    if (!el) return null;
    const m1 = el.style.transform?.match(/rotateY\((-?[\d.]+)deg\)/);
    if (m1) return +m1[1];
    const tr = getComputedStyle(el).transform;
    const m = tr.match(/-?[\d.e]+/g)?.map(Number) || [];
    return tr.startsWith('matrix3d')
      ? (Math.atan2(m[8], m[0]) * 180) / Math.PI
      : 0;
  });

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto(`${BASE}/claw/pokemon-mythic`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  });
  await page.getByRole('button', { name: /Try a free demo spin/i }).click();
  await page.waitForTimeout(900);
  const dialog = page.locator('[role="dialog"]');

  // ---- 2a. FAST drag -> fling carries past the nearest slot ----
  await page.mouse.move(760, 450);
  await page.mouse.down();
  for (const x of [740, 700, 640, 560, 470]) {
    await page.mouse.move(x, 450);
    await page.waitForTimeout(12);
  } // fast swipe
  const atRelease = await rotY(page);
  await page.mouse.up();
  await page.waitForTimeout(120);
  const shortly = await rotY(page); // must still be moving in the same direction
  await page.waitForTimeout(1600);
  const settled = await rotY(page);
  const snapErr = Math.abs(settled / 60 - Math.round(settled / 60)) * 60;
  const carried = Math.abs(settled - atRelease);
  pass(
    'fling keeps moving after release (no dead stop)',
    Math.abs(shortly - atRelease) > 8,
    `release ${atRelease?.toFixed(1)}° -> +120ms ${shortly?.toFixed(1)}°`,
  );
  pass(
    'fling carries past the nearest slot (momentum)',
    carried > 35,
    `travelled ${carried.toFixed(0)}° after release`,
  );
  pass(
    'fling still settles on a 60° slot',
    snapErr < 2,
    `settled ${settled?.toFixed(1)}°`,
  );

  // ---- 2b. shuffle: long deceleration (still moving at +500ms, settled by 1.4s) ----
  const s0 = await rotY(page);
  await dialog.getByRole('button', { name: /Shuffle/i }).click();
  await page.waitForTimeout(500);
  const sMid = await rotY(page);
  await page.waitForTimeout(950);
  const sEnd = await rotY(page);
  await page.waitForTimeout(350);
  const sEnd2 = await rotY(page);
  pass(
    'shuffle still spinning at +500ms (long decel)',
    Math.abs(sMid - s0) > 60 && Math.abs(sEnd - sMid) > 5,
    `${s0?.toFixed(0)}° -> ${sMid?.toFixed(0)}° -> ${sEnd?.toFixed(0)}°`,
  );
  pass(
    'shuffle settled by ~1.5s',
    Math.abs(sEnd2 - sEnd) < 3,
    `${sEnd?.toFixed(1)}° -> ${sEnd2?.toFixed(1)}°`,
  );

  // ---- 1. card stage presentation ----
  await page.mouse.click(720, 450); // select
  await page.waitForTimeout(1900);
  await page.mouse.click(720, 500); // slab -> metadata
  await page.waitForTimeout(250);
  await page.mouse.click(720, 500); // metadata -> (pull|card)
  await page.waitForTimeout(250);
  await page.mouse.click(720, 500); // ensure card
  await page.waitForTimeout(900);

  const card = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { found: false };
    const img = [...dlg.querySelectorAll('img')].find((i) =>
      i.src.includes('/cdn/cards/'),
    );
    if (!img) return { found: false };
    const r = img.getBoundingClientRect();
    // any LIGHT chrome around the card? (the old holder was bg-neutral-100/white)
    let chrome = null;
    for (let el = img.parentElement; el && el !== dlg; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg.match(/\d+/g)?.map(Number);
      if (m && m.length >= 3 && m[0] > 200 && m[1] > 200 && m[2] > 200) {
        chrome = bg;
        break;
      }
    }
    const btn = [...dlg.querySelectorAll('button')].find((b) =>
      /^Continue$/.test(b.textContent.trim()),
    );
    return {
      found: true,
      imgW: Math.round(r.width),
      imgH: Math.round(r.height),
      chrome,
      btnW: btn ? Math.round(btn.getBoundingClientRect().width) : null,
    };
  });
  pass(
    'card stage reached + card img rendered',
    card.found,
    JSON.stringify(card),
  );
  pass(
    'no white holder chrome around the card',
    card.found && !card.chrome,
    card.chrome ?? 'raw image',
  );
  pass(
    'card sized like live (~560px tall at 1440)',
    card.found && card.imgH >= 520 && card.imgH <= 600,
    `img ${card.imgW}x${card.imgH} (live 330x569)`,
  );
  pass(
    'Continue is 300px wide (live)',
    card.btnW === 300,
    `btn ${card.btnW}px`,
  );
  await page.screenshot({ path: `${OUT}/card-fixed.png` });
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
