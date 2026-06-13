// Recon the live phygitals pack-detail page (/claw/mythic-pack). Identify the
// claw-machine media (video / canvas / iframe / Spline) and dump the right control
// panel's structure + content so we can rebuild it faithfully.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('docs/research/packdetail', { recursive: true });
const URL =
  'https://www.phygitals.com/claw/mythic-pack?quantity=1&autoOpen=true';

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1024 },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();

// collect network media requests (videos, 3d, lottie json)
const media = [];
page.on('response', (r) => {
  const u = r.url();
  if (/\.(mp4|webm|mov|m4v|json|glb|gltf|splinecode|lottie|riv)(\?|$)/i.test(u))
    media.push({
      url: u,
      type: r.request().resourceType(),
      status: r.status(),
    });
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 30; i++) {
  const r = await page
    .evaluate(() => document.images.length > 3)
    .catch(() => false);
  if (r) break;
  await page.waitForTimeout(600);
}
await page.waitForTimeout(4000); // let claw machine / animation start

const info = await page.evaluate(() => {
  const rct = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };
  const videos = [...document.querySelectorAll('video')].map((v) => ({
    src: v.currentSrc || v.src || v.querySelector('source')?.src || null,
    poster: v.poster || null,
    autoplay: v.autoplay,
    loop: v.loop,
    muted: v.muted,
    rect: rct(v),
  }));
  const canvases = [...document.querySelectorAll('canvas')].map((c) => ({
    rect: rct(c),
    w: c.width,
    h: c.height,
  }));
  const iframes = [...document.querySelectorAll('iframe')].map((f) => ({
    src: f.src,
    rect: rct(f),
  }));
  // spline / 3d hints
  const splineEls = [
    ...document.querySelectorAll('[class*=spline], spline-viewer, canvas'),
  ].length;
  // big left-panel media: largest element in left 65%
  const bigImgs = [...document.querySelectorAll('img')]
    .filter(
      (im) =>
        im.getBoundingClientRect().left < 950 &&
        im.getBoundingClientRect().width > 120,
    )
    .map((im) => ({ src: (im.currentSrc || im.src).slice(-80), rect: rct(im) }))
    .sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)
    .slice(0, 5);

  // Right panel = elements with left > 1150
  const rightTexts = [
    ...document.querySelectorAll('button, h1, h2, h3, p, span, div'),
  ]
    .filter((e) => {
      const r = e.getBoundingClientRect();
      return (
        r.left > 1140 &&
        r.width > 20 &&
        r.height > 8 &&
        e.children.length <= 2 &&
        e.textContent.trim() &&
        e.textContent.trim().length < 50
      );
    })
    .map((e) => ({
      tag: e.tagName.toLowerCase(),
      text: e.textContent.trim(),
      y: Math.round(e.getBoundingClientRect().top),
      x: Math.round(e.getBoundingClientRect().left),
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  // de-dup consecutive identical texts
  const seen = new Set();
  const right = [];
  for (const t of rightTexts) {
    const k = t.text + '@' + t.y;
    if (!seen.has(k)) {
      seen.add(k);
      right.push(t);
    }
  }

  return { videos, canvases, iframes, splineEls, bigImgs, right };
});

await page.screenshot({ path: 'docs/research/packdetail/ORIG_full.png' });
await page.screenshot({
  path: 'docs/research/packdetail/ORIG_left.png',
  clip: { x: 270, y: 140, width: 900, height: 580 },
});

console.log('=== NETWORK MEDIA ===');
console.log(JSON.stringify(media.slice(0, 20), null, 2));
console.log('\n=== DOM MEDIA + RIGHT PANEL ===');
console.log(JSON.stringify(info, null, 2));

await browser.close();
