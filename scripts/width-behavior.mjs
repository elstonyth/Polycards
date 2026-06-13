import { chromium } from 'playwright';
const b = await chromium.launch();

async function measure(url, label, sizes) {
  for (const w of sizes) {
    const p = await b.newPage({ viewport: { width: w, height: 900 } });
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 20; i++) {
      if (await p.evaluate(() => document.images.length > 3)) break;
      await p.waitForTimeout(800);
    }
    await p.waitForTimeout(1500);
    const d = await p.evaluate(() => {
      // find the hero/content container (the rounded box near top, or the main content wrapper)
      const h = [...document.querySelectorAll('h1,h2')].find((e) =>
        /rip packs|real cards/i.test(e.textContent),
      );
      let box = null,
        pad = null;
      if (h) {
        // climb to the widest sensible wrapper that has horizontal padding
        let el = h;
        for (let i = 0; i < 10 && el; i++) {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          if (r.width > innerWidth * 0.5) {
            const pl = parseFloat(cs.paddingLeft) || 0;
            if (!box || r.width > box.w)
              box = { w: Math.round(r.width), x: Math.round(r.x), pl };
          }
          el = el.parentElement;
        }
      }
      // the outermost content wrapper
      const main = document.querySelector('main') || document.body;
      const mr = main.getBoundingClientRect();
      const mcs = getComputedStyle(main);
      return {
        hero: box,
        mainW: Math.round(mr.width),
        bodyW: Math.round(document.body.getBoundingClientRect().width),
        vw: innerWidth,
      };
    });
    console.log(
      `[${label} ${w}] heroBox=${d.hero ? JSON.stringify(d.hero) : '?'} mainW=${d.mainW} vw=${d.vw} | sideMargin=${d.hero ? Math.round((d.vw - d.hero.w) / 2) : '?'}`,
    );
    await p.close();
  }
}
await measure('https://www.phygitals.com/', 'ORIG', [1280, 1920, 2560, 3840]);
await measure('http://localhost:4000/', 'CLONE', [1280, 1920, 2560, 3840]);
await b.close();
