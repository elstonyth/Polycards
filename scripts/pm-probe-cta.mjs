// Targeted probe: the hero "Open Packs" CTA + header "How it works" link,
// matched by exact text, on ORIG vs CLONE. These are non-animation elements.
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
    'color',
    'borderRadius',
    'padding',
    'fontSize',
    'fontWeight',
    'border',
    'boxShadow',
    'backgroundImage',
  ];

  const byText = (re, tags = ['button', 'a']) => {
    const els = [...document.querySelectorAll(tags.join(','))].filter((e) =>
      re.test(e.textContent.trim()),
    );
    // smallest matching element (the actual control, not a wrapper)
    els.sort(
      (a, b) =>
        a.getBoundingClientRect().width * a.getBoundingClientRect().height -
        b.getBoundingClientRect().width * b.getBoundingClientRect().height,
    );
    return els[0] || null;
  };

  const openPacks = byText(/^open packs$/i);
  const howItWorks = byText(/^how it works$/i);

  return {
    openPacks: openPacks
      ? {
          text: openPacks.textContent.trim(),
          tag: openPacks.tagName.toLowerCase(),
          styles: cs(openPacks, P),
          rect: rct(openPacks),
        }
      : 'NOT FOUND',
    howItWorks: howItWorks
      ? {
          text: howItWorks.textContent.trim(),
          tag: howItWorks.tagName.toLowerCase(),
          styles: cs(howItWorks, P),
          rect: rct(howItWorks),
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
