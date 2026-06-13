// Hero CONTENT measurement (heading isn't an <h1>). Anchor on the hero band
// (below the ~70px header, above 700px) on the left. Report: largest-font heading
// + per-line span color/gradient, the CTA button, any pill above the heading, and
// EVERY image layer (foreground pack vs blurred bg) with opacity/filter/zIndex.
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
  const rct = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };
  const inBand = (el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 60 && r.top < 700 && r.width > 0 && r.height > 0;
  };

  // Heading = largest font-size text element in the band, left half.
  let heading = null,
    maxFs = 0;
  for (const el of document.querySelectorAll('h1,h2,h3,div,span,p')) {
    if (!inBand(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.left > 760) continue;
    const txt =
      el.childNodes.length &&
      [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
        ? el.textContent.trim()
        : [...el.children].every((c) =>
              ['SPAN', 'BR', 'EM', 'B'].includes(c.tagName),
            )
          ? el.textContent.trim()
          : '';
    if (!txt || txt.length > 60) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs > maxFs) {
      maxFs = fs;
      heading = el;
    }
  }
  const headingInfo = heading
    ? {
        text: heading.textContent.trim().slice(0, 80),
        styles: cs(heading, [
          'fontSize',
          'fontWeight',
          'fontFamily',
          'lineHeight',
          'letterSpacing',
          'color',
          'textTransform',
          'backgroundImage',
          'webkitTextFillColor',
        ]),
        rect: rct(heading),
        lines: [...heading.children].map((c) => ({
          tag: c.tagName.toLowerCase(),
          text: c.textContent.trim().slice(0, 40),
          color: getComputedStyle(c).color,
          backgroundImage: getComputedStyle(c).backgroundImage,
          webkitTextFillColor: getComputedStyle(c).webkitTextFillColor,
          opacity: getComputedStyle(c).opacity,
        })),
      }
    : null;

  // CTA = button/link in band, left side, that looks like a button (bg or border or padding) — prefer text match.
  const ctaCands = [...document.querySelectorAll('button, a')].filter((b) => {
    const r = b.getBoundingClientRect();
    return (
      r.top >= 80 &&
      r.top < 700 &&
      r.left < 760 &&
      r.width > 60 &&
      r.height > 28 &&
      b.textContent.trim()
    );
  });
  const cta = ctaCands.sort((a, b) => {
    const score = (e) =>
      (/open pack|shop|explore|rip|pull|view/i.test(e.textContent) ? 100 : 0) +
      (parseFloat(getComputedStyle(e).backgroundColor.split(',')[3] || '1') > 0
        ? 10
        : 0);
    return score(b) - score(a);
  })[0];
  const ctaInfo = cta
    ? {
        text: cta.textContent.trim().slice(0, 30),
        styles: cs(cta, [
          'backgroundColor',
          'color',
          'borderRadius',
          'padding',
          'fontSize',
          'fontWeight',
          'border',
          'boxShadow',
        ]),
        rect: rct(cta),
      }
    : null;

  // Pill above heading
  const headTop = heading ? heading.getBoundingClientRect().top : 300;
  const pill =
    [...document.querySelectorAll('*')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        const rad = parseFloat(s.borderRadius) || 0;
        const t = el.textContent.trim();
        return (
          r.top >= 70 &&
          r.top < headTop + 2 &&
          r.left < 760 &&
          r.height > 14 &&
          r.height < 50 &&
          r.width > 60 &&
          r.width < 380 &&
          rad >= 8 &&
          t.length > 2 &&
          t.length < 36 &&
          [...el.children].length < 5
        );
      })
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
        rect: rct(el),
      }))[0] || null;

  // All image layers in band
  const layers = [...document.querySelectorAll('img')]
    .filter(inBand)
    .map((im) => ({
      src: (im.currentSrc || im.src).split('/').slice(-2).join('/'),
      natural: { w: im.naturalWidth, h: im.naturalHeight },
      styles: cs(im, [
        'objectFit',
        'objectPosition',
        'opacity',
        'filter',
        'zIndex',
        'borderRadius',
        'transform',
      ]),
      rect: rct(im),
    }))
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);

  return { headingInfo, ctaInfo, pill, layers };
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
      const r = await page
        .evaluate(() => document.images.length > 2)
        .catch(() => false);
      if (r) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1200);
    out[site] = await page.evaluate(EXTRACT);
  } catch (e) {
    out[site] = { error: e.message };
  }
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
