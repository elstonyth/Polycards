import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(2000);
await p.screenshot({
  path: 'docs/research/CLONE_CARD_FIXED.png',
  clip: { x: 0, y: 0, width: 1440, height: 560 },
});

const slabTop = () =>
  p.evaluate(() => {
    const im = [...document.querySelectorAll('img')]
      .filter((i) => /slabs/.test(i.src))
      .map((i) => ({
        t: i.getBoundingClientRect().top,
        o: +getComputedStyle(i.closest('div').parentElement).opacity,
      }))
      .sort((a, b) => b.o - a.o)[0];
    return im ? Math.round(im.t) : null;
  });

// 1) hover LEFT-side empty hero area (text side) → card should NOT move
await p.mouse.move(200, 300);
await p.waitForTimeout(400);
const beforeText = await slabTop();
// 2) hover the CARD (right side center) → card SHOULD lift
await p.mouse.move(1080, 320);
await p.waitForTimeout(400);
const onCard = await slabTop();
console.log(
  'hover text-area slabTop:',
  beforeText,
  '| hover card slabTop:',
  onCard,
  '| lift:',
  beforeText != null && onCard != null ? onCard - beforeText : 'n/a',
);
await b.close();
