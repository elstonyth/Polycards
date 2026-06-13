// Follow-up to recon-motion-live.mjs:
//  1. HERO at rAF using film-hero's proven per-img extraction (the wrapper-climb
//     recorder caught 0 segments — rect-based tracking is robust to DOM shape).
//  2. The reveal CONTINUATION: tap the slab and film metadata -> pull -> card.
import { chromium } from 'playwright';
import fs from 'node:fs';

const PACK = 'docs/research/openpack-live';
const PAGE = 'docs/research/motion-live';
fs.mkdirSync(PACK, { recursive: true });
fs.mkdirSync(PAGE, { recursive: true });
const save = (d, n, x) => {
  fs.writeFileSync(`${d}/${n}`, JSON.stringify(x));
  console.log('WROTE', `${d}/${n}`, x?.frames?.length ?? '');
};

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});

const settle = async () => {
  for (let i = 0; i < 25; i++) {
    if (await page.evaluate(() => document.querySelectorAll('img').length > 5))
      break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(3000);
};

// ---------------- 1. HERO rAF curve ----------------
try {
  await page.goto('https://www.phygitals.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await settle();
  await page.evaluate(() => {
    const data = { t0: performance.now(), frames: [], stopped: false };
    window.__hero = data;
    const tick = () => {
      if (data.stopped) return;
      const t = +(performance.now() - data.t0).toFixed(1);
      const imgs = [...document.querySelectorAll('img')]
        .filter((im) => {
          const r = im.getBoundingClientRect();
          return (
            r.top < 560 &&
            r.bottom > 40 &&
            r.x > 560 &&
            r.width > 50 &&
            r.height > 50
          );
        })
        .map((im) => {
          let wrap = im.parentElement,
            wcs = getComputedStyle(wrap),
            d = 0;
          while (
            wrap &&
            d < 4 &&
            wcs.transform === 'none' &&
            wcs.opacity === '1'
          ) {
            wrap = wrap.parentElement;
            wcs = getComputedStyle(wrap);
            d++;
          }
          const r = im.getBoundingClientRect();
          return {
            src: (im.currentSrc || im.src || '').split('/').pop().split('?')[0],
            cx: Math.round(r.x + r.width / 2),
            w: Math.round(r.width),
            wo: +(+wcs.opacity).toFixed(3),
            wt: wcs.transform === 'none' ? '' : wcs.transform,
          };
        });
      data.frames.push({ t, imgs });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.waitForTimeout(9000);
  const hero = await page.evaluate(() => {
    const d = window.__hero;
    d.stopped = true;
    return { frames: d.frames };
  });
  save(PAGE, 'hero-curve2.json', hero);
} catch (e) {
  console.error('hero failed:', e.message);
}

// ---------------- 2. Reveal continuation: slab -> metadata -> pull -> card ----------------
try {
  await page.goto('https://www.phygitals.com/claw/black-pack', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await settle();

  const demos = page.getByText(/try a free demo/i);
  const n = await demos.count();
  for (let i = 0; i < n; i++) {
    const el = demos.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.click();
      break;
    }
  }
  await page.waitForTimeout(2500); // carousel fully up, no shuffle in flight

  // tap the front pack, then WAIT until the slab/"TAP TO REVEAL" is up
  await page.mouse.click(720, 430);
  await page.waitForFunction(
    () => /TAP TO REVEAL/i.test(document.body.innerText),
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(700); // slab entrance done, shimmer looping

  // overlay recorder (same shape as run 1, inlined)
  await page.evaluate(() => {
    const sig = (el) => {
      if (el.__sig) return el.__sig;
      const img = el.tagName === 'IMG' ? el : el.querySelector?.(':scope img');
      const src =
        (img?.currentSrc || img?.src || '')
          .split('/')
          .pop()
          ?.split('?')[0]
          ?.slice(-26) || '';
      el.__sig = `${el.tagName}.${('' + (el.className || '')).trim().split(/\s+/).slice(0, 3).join('.').slice(0, 44)}${src ? '#' + src : ''}`;
      return el.__sig;
    };
    const findOverlay = () =>
      [...document.querySelectorAll('div')].find((d) => {
        const s = getComputedStyle(d);
        return (
          s.position === 'fixed' &&
          d.getBoundingClientRect().width > innerWidth * 0.8 &&
          d.querySelector('img,button')
        );
      });
    const data = { t0: performance.now(), frames: [], stopped: false };
    window.__rev = data;
    const tick = () => {
      if (data.stopped) return;
      const t = +(performance.now() - data.t0).toFixed(1);
      const o = findOverlay();
      const fr = { t, n: [] };
      if (o) {
        fr.txt = (o.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 110);
        const els = [...o.querySelectorAll('*')]
          .filter((el) => {
            if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return false;
            const r = el.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) return false;
            const cs = getComputedStyle(el);
            return (
              cs.transform !== 'none' ||
              +cs.opacity < 1 ||
              cs.animationName !== 'none'
            );
          })
          .slice(0, 36);
        for (const el of els) {
          try {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            const rec = {
              s: sig(el),
              tr: cs.transform,
              o: +(+cs.opacity).toFixed(3),
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.width),
              h: Math.round(r.height),
            };
            if (cs.filter !== 'none') rec.f = cs.filter.slice(0, 50);
            if (cs.animationName !== 'none')
              rec.an = `${cs.animationName.slice(0, 30)}|${cs.animationDuration}|${cs.animationTimingFunction.slice(0, 44)}|${cs.animationDelay}`;
            if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)')
              rec.bg = cs.backgroundColor;
            fr.n.push(rec);
          } catch {}
        }
      }
      data.frames.push(fr);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // TAP to reveal -> metadata -> pull -> card (film ~11s, shots every 300ms)
  await page.mouse.click(720, 500);
  for (let i = 0; i < 36; i++) {
    await page
      .screenshot({ path: `${PACK}/reveal2-${String(i).padStart(2, '0')}.png` })
      .catch(() => {});
    await page.waitForTimeout(300);
  }
  const rev = await page.evaluate(() => {
    const d = window.__rev;
    d.stopped = true;
    return { frames: d.frames };
  });
  save(PACK, 'reveal2-track.json', rev);

  // final card-stage DOM (holder, name, buttons, ribbon leftovers)
  const dom = await page.evaluate(() => {
    const o = [...document.querySelectorAll('div')].find((d) => {
      const s = getComputedStyle(d);
      return (
        s.position === 'fixed' &&
        d.getBoundingClientRect().width > innerWidth * 0.8 &&
        d.querySelector('img,button')
      );
    });
    if (!o) return { found: false };
    const grab = (e) => {
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return {
        tag: e.tagName,
        cls: ('' + e.className).slice(0, 70),
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        fs: cs.fontSize,
        fw: cs.fontWeight,
        ff: cs.fontFamily.split(',')[0],
        color: cs.color,
        bg: cs.backgroundColor,
        radius: cs.borderRadius,
        border: cs.border.slice(0, 50),
        shadow: cs.boxShadow.slice(0, 80),
        tr: cs.transform.slice(0, 70),
        text: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 50),
      };
    };
    return {
      found: true,
      text: (o.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
      els: [...o.querySelectorAll('*')]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 14 && r.height > 10;
        })
        .slice(0, 90)
        .map(grab),
    };
  });
  save(PACK, 'card-stage-dom.json', dom);
  await page.screenshot({ path: `${PACK}/reveal2-final.png` }).catch(() => {});
} catch (e) {
  console.error('reveal2 failed:', e.message);
  save(PACK, 'reveal2-error.json', { error: e.message });
}

await browser.close();
console.log('DONE');
