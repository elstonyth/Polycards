// Verify pack-party ambient animations now run on CLONE + overflow sweep on the
// changed pages + how-it-works video autoplay. Screenshots for proof.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = 'docs/research/pixelmatch/verify2';
mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:4000';

const browser = await chromium.launch();
const report = [];

// pack-party: count infinite animations (ping + gradientShift) + live dots
{
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  await page.goto(BASE + '/pack-party', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(2000);
  const anim = await page.evaluate(() => {
    const m = {};
    for (const el of document.querySelectorAll('*')) {
      const s = getComputedStyle(el);
      if (
        s.animationName &&
        s.animationName !== 'none' &&
        s.animationIterationCount === 'infinite'
      )
        m[s.animationName] = (m[s.animationName] || 0) + 1;
    }
    return m;
  });
  report.push('pack-party infinite anims: ' + JSON.stringify(anim));
  await page.screenshot({ path: `${OUT}/pack-party_1440.png` });
  await ctx.close();
}

// how-it-works: video autoplay attr
{
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  await page.goto(BASE + '/how-it-works', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(1500);
  const v = await page.evaluate(() => {
    const vid = document.querySelector('video');
    return vid
      ? {
          src: vid.getAttribute('src'),
          autoplay: vid.autoplay,
          loop: vid.loop,
          muted: vid.muted,
          playsInline: vid.playsInline,
        }
      : 'NO VIDEO';
  });
  report.push('how-it-works video: ' + JSON.stringify(v));
  await ctx.close();
}

// overflow sweep on changed pages
const WIDTHS = [390, 768, 1024, 1280, 1440, 1920, 2560, 3840];
report.push('\n--- overflow sweep (overflow>1 = FAIL) ---');
for (const route of ['/pack-party', '/claw/pokemon-mythic', '/claw']) {
  for (const w of WIDTHS) {
    const c = await browser.newContext({
      viewport: { width: w, height: 900 },
      deviceScaleFactor: 1,
    });
    const p = await c.newPage();
    try {
      await p.goto(BASE + route, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await p.waitForTimeout(500);
      const m = await p.evaluate(() => ({
        o: document.documentElement.scrollWidth - window.innerWidth,
        b: [...document.querySelectorAll('img')].filter(
          (i) => i.complete && i.naturalWidth === 0,
        ).length,
      }));
      report.push(
        `${route.padEnd(22)} ${String(w).padStart(4)}px  overflow=${String(m.o).padStart(4)}${m.o > 1 ? '  ⚠' : ''}${m.b ? '  ⚠' + m.b + 'broken' : ''}`,
      );
    } catch (e) {
      report.push(`${route} ${w} FAIL ${e.message}`);
    }
    await c.close();
  }
}
// capture mythic pack again
{
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  await page.goto(BASE + '/claw/pokemon-mythic', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/pack-mythic_1440.png` });
  await ctx.close();
}

await browser.close();
console.log(report.join('\n'));
