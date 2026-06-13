// Motion recon of LIVE phygitals.com at requestAnimationFrame resolution.
// Produces numeric curves (transform/opacity per rAF tick) so the Framer Motion
// rebuild derives duration/easing/springs from DATA, not eyeballing.
//
// Phases (each guarded; partial output is still written):
//   A  home    — hero carousel curve, scroll-entry curve, card hover probe
//   B  /claw   — catalog row CSS (snap/overflow/arrows), card hover, row entry
//   C  /claw/black-pack demo — cylinder idle / drag+snap / shuffle, then the full
//      reveal (slab → metadata → pull → card) with per-frame movers + stage text.
//
// Output: docs/research/openpack-live/*.json (+ shot-*.png), docs/research/motion-live/*.json
import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT_PACK = 'docs/research/openpack-live';
const OUT_PAGE = 'docs/research/motion-live';
fs.mkdirSync(OUT_PACK, { recursive: true });
fs.mkdirSync(OUT_PAGE, { recursive: true });

const save = (dir, name, data) => {
  fs.writeFileSync(`${dir}/${name}`, JSON.stringify(data));
  console.log(
    'WROTE',
    `${dir}/${name}`,
    Array.isArray(data?.frames) ? `${data.frames.length} frames` : '',
  );
};

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
page.setDefaultTimeout(30000);

// ---- in-page rAF recorder ---------------------------------------------------
// Modes resolve their own targets every frame (elements appear/disappear mid-flow).
const installRecorder = () =>
  page.evaluate(() => {
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
    const MODES = {
      // hero card wrappers: climb from the big hero imgs to the transformed ancestor
      hero() {
        const wraps = new Set();
        [...document.querySelectorAll('img')].forEach((im) => {
          const r = im.getBoundingClientRect();
          if (!(r.top < 560 && r.bottom > 40 && r.x > 560 && r.width > 50))
            return;
          let w = im.parentElement,
            d = 0;
          while (
            w &&
            d < 4 &&
            getComputedStyle(w).transform === 'none' &&
            getComputedStyle(w).opacity === '1'
          ) {
            w = w.parentElement;
            d++;
          }
          if (w) wraps.add(w);
        });
        return [...wraps];
      },
      // everything that moves inside the fixed overlay (reveal flow)
      overlay() {
        const o = findOverlay();
        if (!o) return [];
        window.__overlayEl = o;
        return [...o.querySelectorAll('*')]
          .filter((el) => {
            if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return false;
            const r = el.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) return false;
            const cs = getComputedStyle(el);
            return (
              cs.transform !== 'none' ||
              +cs.opacity < 1 ||
              cs.animationName !== 'none' ||
              cs.translate !== 'none' ||
              cs.scale !== 'none' ||
              cs.rotate !== 'none'
            );
          })
          .slice(0, 36);
      },
      // the preserve-3d cylinder inside the overlay
      cylinder() {
        const o = findOverlay();
        if (!o) return [];
        const cyl = [...o.querySelectorAll('*')].find(
          (el) => getComputedStyle(el).transformStyle === 'preserve-3d',
        );
        return cyl ? [cyl] : [];
      },
      // a CSS selector + its element children (entry/stagger)
      selector(arg) {
        const t = document.querySelector(arg);
        return t ? [t, ...[...t.children].slice(0, 8)] : [];
      },
      // explicit element registered beforehand
      pinned() {
        return (window.__pinned || []).filter(Boolean);
      },
    };
    window.__recStart = (mode, arg) => {
      const data = {
        mode,
        arg: arg || null,
        t0: performance.now(),
        frames: [],
        stopped: false,
      };
      window.__recData = data;
      const tick = () => {
        if (data.stopped) return;
        const t = +(performance.now() - data.t0).toFixed(1);
        let els = [];
        try {
          els = MODES[mode](arg) || [];
        } catch {
          /* targets gone mid-flow */
        }
        const fr = { t, n: [] };
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
            if (cs.translate !== 'none') rec.tl = cs.translate;
            if (cs.scale !== 'none') rec.sc = cs.scale;
            if (cs.rotate !== 'none') rec.ro = cs.rotate;
            if (cs.filter !== 'none') rec.f = cs.filter.slice(0, 60);
            if (cs.animationName !== 'none')
              rec.an = `${cs.animationName.slice(0, 28)}|${cs.animationDuration}|${cs.animationTimingFunction.slice(0, 40)}`;
            fr.n.push(rec);
          } catch {
            /* detached */
          }
        }
        if (mode === 'overlay' && window.__overlayEl) {
          fr.txt = (window.__overlayEl.innerText || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 90);
        }
        data.frames.push(fr);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    };
    window.__recStop = () => {
      const d = window.__recData;
      if (d) d.stopped = true;
      window.__recData = null;
      if (d) return { mode: d.mode, arg: d.arg, frames: d.frames };
      return null;
    };
    return true;
  });

const record = async (mode, ms, arg) => {
  await page.evaluate(([m, a]) => window.__recStart(m, a), [mode, arg ?? null]);
  await page.waitForTimeout(ms);
  return page.evaluate(() => window.__recStop());
};

const settleImages = async () => {
  for (let i = 0; i < 25; i++) {
    if (await page.evaluate(() => document.querySelectorAll('img').length > 5))
      break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(3000);
};

// Computed-style hover probe (Tailwind v4: translate/scale/rotate are separate props).
const hoverProbe = async (el) => {
  const read = () =>
    el.evaluate((node) => {
      const grab = (e) => {
        const cs = getComputedStyle(e);
        return {
          transform: cs.transform,
          translate: cs.translate,
          scale: cs.scale,
          rotate: cs.rotate,
          boxShadow: cs.boxShadow.slice(0, 90),
          filter: cs.filter.slice(0, 60),
          opacity: cs.opacity,
          transition: cs.transition.slice(0, 160),
          borderColor: cs.borderColor,
          outline: cs.outline.slice(0, 60),
        };
      };
      return {
        self: grab(node),
        kids: [...node.querySelectorAll(':scope > *, :scope img')]
          .slice(0, 5)
          .map((k) => ({
            tag: k.tagName,
            cls: ('' + k.className).slice(0, 40),
            ...grab(k),
          })),
      };
    });
  const before = await read();
  await el.hover().catch(() => {});
  await page.waitForTimeout(450); // let the transition finish
  const after = await read();
  await page.mouse.move(10, 10);
  await page.waitForTimeout(250);
  return { before, after };
};

// ================================ PHASE A: HOME ==============================
try {
  await page.goto('https://www.phygitals.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await settleImages();
  await installRecorder();

  // A1 — hero transition curve (covers ≥2 theme swaps at ~2.8s period)
  save(OUT_PAGE, 'hero-curve.json', await record('hero', 7000));

  // A2 — scroll-entry: find hidden-below-fold candidates, then film one scrolling in
  const scrollerInfo = await page.evaluate(() => {
    const sc = [...document.querySelectorAll('*')].find((el) => {
      const s = getComputedStyle(el);
      return (
        /(auto|scroll)/.test(s.overflowY) &&
        el.scrollHeight > el.clientHeight + 200
      );
    });
    if (!sc) return { found: false };
    window.__scroller = sc;
    const cands = [...sc.querySelectorAll('section,div')]
      .filter((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return (
          r.top > innerHeight &&
          r.top < innerHeight + 3000 &&
          r.height > 120 &&
          (+cs.opacity < 0.05 ||
            (cs.transform !== 'none' &&
              cs.transform !== 'matrix(1, 0, 0, 1, 0, 0)'))
        );
      })
      .slice(0, 6)
      .map((el, i) => {
        el.setAttribute('data-recon', 'entry-' + i);
        const cs = getComputedStyle(el);
        return {
          i,
          cls: ('' + el.className).slice(0, 60),
          top: Math.round(el.getBoundingClientRect().top),
          opacity: cs.opacity,
          transform: cs.transform,
          transition: cs.transition.slice(0, 140),
        };
      });
    return {
      found: true,
      scTag: sc.tagName + '.' + ('' + sc.className).slice(0, 40),
      cands,
    };
  });
  console.log(
    'scroll-entry candidates:',
    JSON.stringify(scrollerInfo).slice(0, 400),
  );
  if (scrollerInfo.found && scrollerInfo.cands.length) {
    const target = scrollerInfo.cands[0];
    await page.evaluate((idx) => {
      const el = document.querySelector(`[data-recon="entry-${idx}"]`);
      window.__pinned = el ? [el, ...[...el.children].slice(0, 7)] : [];
      // park it just below the fold, then nudge past the trigger
      const r = el.getBoundingClientRect();
      window.__scroller.scrollTop += r.top - innerHeight * 1.05;
    }, target.i);
    await page.waitForTimeout(600);
    await page.evaluate(() => window.__recStart('pinned'));
    await page.evaluate(() => {
      window.__scroller.scrollTop += innerHeight * 0.45;
    });
    await page.waitForTimeout(2600);
    const entry = await page.evaluate(() => window.__recStop());
    entry.candidate = target;
    save(OUT_PAGE, 'entry-curve.json', entry);
  } else {
    save(OUT_PAGE, 'entry-curve.json', {
      found: false,
      note: 'no opacity-0 below-fold candidates',
      scrollerInfo,
    });
  }

  // A3 — hover probe on a home card (a link with an image, mid-page)
  await page.evaluate(() => {
    window.__scroller && (window.__scroller.scrollTop = 900);
  });
  await page.waitForTimeout(900);
  const homeCard = page
    .locator('a:has(img)')
    .filter({ hasNot: page.locator('header a') })
    .nth(3);
  if (await homeCard.isVisible().catch(() => false)) {
    save(OUT_PAGE, 'home-hover.json', await hoverProbe(homeCard));
  }
} catch (e) {
  console.error('PHASE A failed:', e.message);
  save(OUT_PAGE, 'phaseA-error.json', { error: e.message });
}

// ================================ PHASE B: /claw =============================
try {
  await page.goto('https://www.phygitals.com/claw', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await settleImages();
  await installRecorder();

  const catalog = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('div,ul')].filter(
      (el) =>
        el.scrollWidth > el.clientWidth * 1.15 &&
        el.querySelectorAll(':scope img').length >= 3,
    );
    return rows.slice(0, 4).map((row) => {
      const cs = getComputedStyle(row);
      const kid = row.children[0];
      const kcs = kid ? getComputedStyle(kid) : null;
      // arrow buttons near the row? (siblings or parent's buttons with svg)
      const near = row.parentElement
        ? [
            ...row.parentElement.querySelectorAll(
              ':scope > button, :scope > div > button',
            ),
          ]
            .map(
              (b) =>
                b.innerText.trim() || b.getAttribute('aria-label') || 'svg-btn',
            )
            .slice(0, 4)
        : [];
      return {
        cls: ('' + row.className).slice(0, 80),
        overflowX: cs.overflowX,
        scrollSnapType: cs.scrollSnapType,
        scrollBehavior: cs.scrollBehavior,
        gap: cs.gap,
        cursor: cs.cursor,
        scrollWidth: row.scrollWidth,
        clientWidth: row.clientWidth,
        childW: kid ? Math.round(kid.getBoundingClientRect().width) : null,
        childSnapAlign: kcs ? kcs.scrollSnapAlign : null,
        arrows: near,
        kids: row.children.length,
      };
    });
  });
  save(OUT_PAGE, 'claw-catalog.json', { rows: catalog });

  const packCard = page
    .locator('a:has(img)')
    .filter({ has: page.locator('img') })
    .nth(4);
  if (await packCard.isVisible().catch(() => false)) {
    save(OUT_PAGE, 'claw-hover.json', await hoverProbe(packCard));
  }
} catch (e) {
  console.error('PHASE B failed:', e.message);
  save(OUT_PAGE, 'phaseB-error.json', { error: e.message });
}

// ====================== PHASE C: /claw/black-pack demo =======================
try {
  await page.goto('https://www.phygitals.com/claw/black-pack', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await settleImages();
  await installRecorder();

  // open the demo (the visible "try a free demo" trigger)
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
  if (!clicked && n) await demos.first().click({ force: true });
  console.log('demo clicked:', clicked || n > 0);
  await page.waitForTimeout(1200);

  // C1 — overlay ENTRANCE (packs flying in?) then idle cylinder
  save(OUT_PACK, 'overlay-entrance.json', await record('overlay', 2200));
  save(OUT_PACK, 'cylinder-idle.json', await record('cylinder', 2400));

  // C2 — drag + release snap
  await page.evaluate(() => window.__recStart('cylinder'));
  await page.mouse.move(720, 440);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) {
    await page.mouse.move(720 - i * 26, 440);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(1500);
  save(
    OUT_PACK,
    'cylinder-drag.json',
    await page.evaluate(() => window.__recStop()),
  );

  // C3 — shuffle
  const shuffle = page.getByText(/shuffle/i).first();
  if (await shuffle.isVisible().catch(() => false)) {
    await page.evaluate(() => window.__recStart('cylinder'));
    await shuffle.click().catch(() => {});
    await page.waitForTimeout(1800);
    save(
      OUT_PACK,
      'cylinder-shuffle.json',
      await page.evaluate(() => window.__recStop()),
    );
  }

  // C4 — TAP the front pack → film the whole reveal at rAF + sparse screenshots
  await page.evaluate(() => window.__recStart('overlay'));
  await page.mouse.click(720, 430);
  for (let i = 0; i < 34; i++) {
    await page
      .screenshot({
        path: `${OUT_PACK}/shot-${String(i).padStart(2, '0')}.png`,
      })
      .catch(() => {});
    await page.waitForTimeout(400);
  }
  save(
    OUT_PACK,
    'reveal-track.json',
    await page.evaluate(() => window.__recStop()),
  );

  // C5 — final DOM dump (card holder, metadata leftovers, buttons, live animations)
  const finalDom = await page.evaluate(() => {
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
        fontSize: cs.fontSize,
        fontFamily: cs.fontFamily.split(',')[0],
        fontWeight: cs.fontWeight,
        color: cs.color,
        bg: cs.backgroundColor,
        radius: cs.borderRadius,
        border: cs.border.slice(0, 60),
        shadow: cs.boxShadow.slice(0, 90),
        transform: cs.transform.slice(0, 80),
        letterSpacing: cs.letterSpacing,
        textTransform: cs.textTransform,
        text: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 60),
      };
    };
    return {
      found: true,
      text: (o.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
      els: [...o.querySelectorAll('*')]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 14 && r.height > 10;
        })
        .slice(0, 80)
        .map(grab),
      animations: document
        .getAnimations()
        .slice(0, 20)
        .map((a) => ({
          type: a.constructor.name,
          name: a.animationName || a.id || '',
          state: a.playState,
          timing: a.effect?.getTiming
            ? {
                duration: a.effect.getTiming().duration,
                delay: a.effect.getTiming().delay,
                easing: a.effect.getTiming().easing,
                iterations: a.effect.getTiming().iterations,
              }
            : null,
        })),
    };
  });
  save(OUT_PACK, 'final-dom.json', finalDom);
  await page.screenshot({ path: `${OUT_PACK}/shot-final.png` }).catch(() => {});
} catch (e) {
  console.error('PHASE C failed:', e.message);
  save(OUT_PACK, 'phaseC-error.json', { error: e.message });
}

await browser.close();
console.log('DONE');
