// Measure the hero region on ORIG vs CLONE: H1 (+per-line spans), primary CTA
// button, pill/badge above heading, and the main hero image. Dumps JSON so we
// match pixels, not eyeballs. Measured right after content paints to catch slide 0.
import { chromium } from 'playwright';

const SITES = [
  ['https://www.phygitals.com/', 'ORIG'],
  ['http://localhost:4000/', 'CLONE'],
];

const EXTRACT = () => {
  const cs = (el, props) => {
    const s = getComputedStyle(el);
    const o = {};
    props.forEach((p) => (o[p] = s[p]));
    return o;
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };

  // Anchor: an H1 near the top of the page = the hero heading.
  const h1s = [...document.querySelectorAll('h1')].filter(
    (h) => h.getBoundingClientRect().top < 700,
  );
  const h1 = h1s[0] || null;
  let hero = h1 ? h1.closest('section, div') : null;
  // climb a bit to a container that also holds a button + image
  for (let i = 0; i < 4 && hero && hero.parentElement; i++) {
    if (
      hero.querySelector('button, a[role=button]') &&
      hero.querySelector('img')
    )
      break;
    hero = hero.parentElement;
  }
  const scope = hero || document.body;

  const heading = h1
    ? {
        text: h1.textContent.trim().slice(0, 80),
        styles: cs(h1, [
          'fontSize',
          'fontWeight',
          'fontFamily',
          'lineHeight',
          'letterSpacing',
          'color',
          'textTransform',
        ]),
        rect: rect(h1),
        lines: [...h1.children].map((c) => ({
          tag: c.tagName.toLowerCase(),
          text: c.textContent.trim().slice(0, 60),
          color: getComputedStyle(c).color,
          background: getComputedStyle(c).backgroundImage,
          webkitTextFill: getComputedStyle(c).webkitTextFillColor,
        })),
      }
    : null;

  // CTA buttons in hero scope
  const buttons = [...scope.querySelectorAll('button, a')]
    .filter(
      (b) =>
        b.getBoundingClientRect().width > 40 &&
        b.getBoundingClientRect().top < 700 &&
        b.textContent.trim(),
    )
    .slice(0, 6)
    .map((b) => ({
      tag: b.tagName.toLowerCase(),
      text: b.textContent.trim().slice(0, 30),
      styles: cs(b, [
        'backgroundColor',
        'color',
        'borderRadius',
        'padding',
        'fontSize',
        'fontWeight',
        'border',
      ]),
      rect: rect(b),
    }));

  // Pill/badge candidates above the heading (small, rounded, near top)
  const pillCands = [...scope.querySelectorAll('*')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const rad = parseFloat(s.borderRadius) || 0;
      return (
        r.height > 12 &&
        r.height < 48 &&
        r.width > 40 &&
        r.width < 360 &&
        rad >= 8 &&
        (h1 ? r.top <= h1.getBoundingClientRect().top + 4 : r.top < 300) &&
        el.textContent.trim().length > 0 &&
        el.textContent.trim().length < 40
      );
    })
    .slice(0, 4)
    .map((el) => ({
      text: el.textContent.trim().slice(0, 40),
      styles: cs(el, [
        'backgroundColor',
        'color',
        'borderRadius',
        'padding',
        'fontSize',
        'border',
      ]),
      rect: rect(el),
    }));

  // Largest image in hero scope
  const imgs = [...scope.querySelectorAll('img')]
    .map((im) => ({
      el: im,
      area:
        im.getBoundingClientRect().width * im.getBoundingClientRect().height,
    }))
    .sort((a, b) => b.area - a.area);
  const bigImg = imgs[0]
    ? {
        src: (imgs[0].el.currentSrc || imgs[0].el.src).slice(-90),
        natural: { w: imgs[0].el.naturalWidth, h: imgs[0].el.naturalHeight },
        styles: cs(imgs[0].el, [
          'objectFit',
          'objectPosition',
          'width',
          'height',
          'borderRadius',
          'filter',
          'opacity',
        ]),
        rect: rect(imgs[0].el),
      }
    : null;

  return {
    heroRect: rect(scope),
    heroBg: cs(scope, ['backgroundColor', 'borderRadius', 'padding']),
    heading,
    buttons,
    pillCands,
    bigImg,
  };
};

const browser = await chromium.launch();
const out = {};
for (const [url, site] of SITES) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1024 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 25; i++) {
      const ready = await page
        .evaluate(
          () => document.querySelector('h1') && document.images.length > 2,
        )
        .catch(() => false);
      if (ready) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1200); // settle, still early enough for slide 0
    out[site] = await page.evaluate(EXTRACT);
  } catch (e) {
    out[site] = { error: e.message };
  }
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
