import { chromium } from 'playwright';
const b = await chromium.launch();
for (const w of [360, 768, 1280, 1920, 2560, 3840]) {
  const p = await b.newPage({ viewport: { width: w, height: 900 } });
  await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
  await p.waitForTimeout(1200);
  const d = await p.evaluate(() => {
    const hero = document
      .querySelector("a[href='/claw']")
      ?.getBoundingClientRect();
    const docW = document.documentElement.scrollWidth,
      vw = innerWidth;
    const sidePad = hero ? Math.round(hero.x) : null;
    return {
      heroW: hero ? Math.round(hero.width) : null,
      sidePad,
      overflowX: docW > vw + 2 ? docW - vw : 0,
    };
  });
  console.log(
    `[${w}] heroW=${d.heroW} sidePad=${d.sidePad}px overflowX=${d.overflowX}`,
  );
  await p.close();
}
await b.close();
