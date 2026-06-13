// Exact-text probe across ALL element types (the hero CTA is a span, not a button).
// Captures "Open Packs" CTA + "Packs available now" eyebrow on ORIG vs CLONE.
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
  const P = [
    'backgroundColor',
    'backgroundImage',
    'color',
    'borderRadius',
    'padding',
    'fontSize',
    'fontWeight',
    'letterSpacing',
    'textTransform',
    'border',
    'boxShadow',
  ];

  // exact innermost element with this trimmed text
  const exact = (txt) => {
    const all = [...document.querySelectorAll('button,a,span,div,p')].filter(
      (e) => e.textContent.trim().toLowerCase() === txt.toLowerCase(),
    );
    // innermost = the one with no child also matching (fewest descendants)
    all.sort(
      (a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length,
    );
    return all[0] || null;
  };

  const cta = exact('Open Packs');
  const eyebrow = exact('Packs available now');

  return {
    openPacks: cta
      ? { tag: cta.tagName.toLowerCase(), styles: cs(cta, P), rect: rct(cta) }
      : 'NOT FOUND',
    eyebrow: eyebrow
      ? {
          tag: eyebrow.tagName.toLowerCase(),
          text: eyebrow.textContent.trim(),
          styles: cs(eyebrow, P),
          rect: rct(eyebrow),
        }
      : 'NOT FOUND',
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
      const r = await page
        .evaluate(() => document.images.length > 2)
        .catch(() => false);
      if (r) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1500);
    out[site] = await page.evaluate(EXTRACT);
  } catch (e) {
    out[site] = { error: e.message };
  }
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
