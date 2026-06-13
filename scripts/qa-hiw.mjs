import { chromium } from 'playwright';
const b = await chromium.launch();

async function test(w, h, label) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
  await p.waitForTimeout(800);
  // BEFORE scroll: cards should be hidden (opacity ~0) if not yet in view
  const before = await p.evaluate(() => {
    const h = [...document.querySelectorAll('h2')].find(
      (e) => e.textContent.trim() === 'How It Works',
    );
    if (!h) return { err: 'no HIW' };
    const sec = h.closest('section');
    const cards = [...sec.querySelectorAll('.grid > div')];
    return {
      count: cards.length,
      op: cards.map((c) => +(+getComputedStyle(c).opacity).toFixed(2)),
    };
  });
  // scroll HIW into view
  await p.evaluate(() => {
    const h = [...document.querySelectorAll('h2')].find(
      (e) => e.textContent.trim() === 'How It Works',
    );
    h.closest('section').scrollIntoView({ block: 'center' });
  });
  await p.waitForTimeout(1200);
  const after = await p.evaluate(() => {
    const h = [...document.querySelectorAll('h2')].find(
      (e) => e.textContent.trim() === 'How It Works',
    );
    const sec = h.closest('section');
    const cards = [...sec.querySelectorAll('.grid > div')];
    const txt = sec.innerText.replace(/\n+/g, ' ').slice(0, 160);
    const broken = [...sec.querySelectorAll('img')].filter(
      (i) => i.complete && i.naturalWidth === 0,
    ).length;
    return {
      op: cards.map((c) => +(+getComputedStyle(c).opacity).toFixed(2)),
      txt,
      broken,
      secW: Math.round(sec.getBoundingClientRect().width),
    };
  });
  console.log(`\n[${label} ${w}x${h}]`);
  console.log('  before-scroll card opacities:', JSON.stringify(before.op));
  console.log(
    '  after-scroll  card opacities:',
    JSON.stringify(after.op),
    '(should be ~1)',
  );
  console.log('  broken imgs:', after.broken, '| secW:', after.secW);
  console.log('  content:', after.txt);
  await p.screenshot({ path: `docs/research/HIW_${w}.png`, fullPage: false });
  await p.close();
}

await test(1920, 1080, 'desktop-wide');
await test(1440, 900, 'desktop');
await test(768, 1024, 'tablet');
await test(390, 844, 'mobile');
await b.close();
