// Focused recon v2: dump the EXACT carousel geometry (pack transforms, perspective,
// count), test drag-to-rotate on a tracked pack, then tap a pack and film the full
// reveal (slab -> metadata -> card) frame-by-frame. Targets the real overlay (the node
// containing "TAP TO SELECT").
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const SLUG = process.argv[2] || 'legend-pack';
const OUT = 'docs/research/openpack-live';
mkdirSync(OUT, { recursive: true });
const log = {};
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  userAgent: 'Mozilla/5.0',
});
const page = await ctx.newPage();
await page.goto(`https://www.phygitals.com/claw/${SLUG}`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
await page.waitForTimeout(5000);
{
  const demos = page.getByText(/try a free demo/i);
  const n = await demos.count();
  let clicked = false;
  for (let i = 0; i < n; i++) {
    const el = demos.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.click();
      clicked = true;
      break;
    }
  }
  if (!clicked) await demos.first().click({ force: true });
}
await page.waitForTimeout(2500);

// helper: dump the overlay that contains the SHUFFLE/TAP caption
const dumpCarousel = () =>
  page.evaluate(() => {
    const all = [...document.querySelectorAll('div')];
    const overlay = all.find((d) => {
      const t = (d.textContent || '').toUpperCase();
      const s = getComputedStyle(d);
      return s.position === 'fixed' && t.includes('TAP TO SELECT');
    });
    if (!overlay) return { found: false };
    // packs: descendants whose computed transform is a 3D matrix or have an <img>
    const cand = [...overlay.querySelectorAll('*')].filter((el) => {
      const s = getComputedStyle(el);
      return (
        s.transformStyle === 'preserve-3d' ||
        (s.transform && s.transform !== 'none')
      );
    });
    const packs = cand
      .map((el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const img = el.tagName === 'IMG' ? el : el.querySelector('img');
        return {
          tag: el.tagName,
          cls: (el.className || '').toString().slice(0, 50),
          transform: s.transform,
          inline: el.getAttribute('style')?.slice(0, 120) || '',
          perspParent: getComputedStyle(el.parentElement).perspective,
          w: Math.round(r.width),
          h: Math.round(r.height),
          x: Math.round(r.x),
          hasImg: !!img,
          src: img?.getAttribute('src')?.split('/').pop()?.slice(0, 40) || '',
        };
      })
      .filter((p) => p.hasImg && p.w > 40);
    // the cylinder container (preserve-3d)
    const cyl = cand.find(
      (el) => getComputedStyle(el).transformStyle === 'preserve-3d',
    );
    return {
      found: true,
      perspectiveOnOverlay: getComputedStyle(overlay).perspective,
      cylinderTransform: cyl ? getComputedStyle(cyl).transform : null,
      cylinderInline: cyl?.getAttribute('style')?.slice(0, 160) || '',
      packCount: packs.length,
      packs: packs.slice(0, 8),
    };
  });

log.before = await dumpCarousel();

// deliberate drag to test rotate; capture cylinder transform after
await page.mouse.move(720, 440);
await page.mouse.down();
for (let i = 1; i <= 14; i++) {
  await page.mouse.move(720 - i * 26, 440);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.waitForTimeout(700);
log.afterDragCyl = await page.evaluate(() => {
  const all = [...document.querySelectorAll('div')];
  const overlay = all.find(
    (d) =>
      getComputedStyle(d).position === 'fixed' &&
      (d.textContent || '').toUpperCase().includes('TAP TO SELECT'),
  );
  const cyl =
    overlay &&
    [...overlay.querySelectorAll('*')].find(
      (el) => getComputedStyle(el).transformStyle === 'preserve-3d',
    );
  return cyl ? getComputedStyle(cyl).transform : 'no-cyl';
});
await page.screenshot({ path: `${OUT}/v2-after-drag.png` });

// TAP a pack to open, then film the reveal sequence
await page.mouse.click(720, 430);
log.reveal_frames = [];
for (let i = 0; i < 22; i++) {
  await page.screenshot({
    path: `${OUT}/reveal-${String(i).padStart(2, '0')}.png`,
  });
  const txt = await page.evaluate(() => {
    const all = [...document.querySelectorAll('div')];
    const o = all.find(
      (d) =>
        getComputedStyle(d).position === 'fixed' &&
        d.getBoundingClientRect().width > window.innerWidth * 0.8,
    );
    return o
      ? [...o.querySelectorAll('*')]
          .filter((e) => e.childElementCount === 0)
          .map((e) => (e.textContent || '').trim())
          .filter((t) => t && t.length < 30)
          .slice(0, 12)
      : [];
  });
  log.reveal_frames.push({ i, txt: [...new Set(txt)] });
  await page.waitForTimeout(220);
}
writeFileSync(`${OUT}/recon2.json`, JSON.stringify(log, null, 2));
console.log(
  JSON.stringify(
    {
      before: log.before,
      afterDragCyl: log.afterDragCyl,
      frames: log.reveal_frames.map((f) => f.txt.join('|')),
    },
    null,
    2,
  ),
);
await browser.close();
