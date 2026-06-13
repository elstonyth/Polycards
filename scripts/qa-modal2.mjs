import { chromium } from 'playwright';
const b = await chromium.launch();
async function check(url, label) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto(url, { waitUntil: 'load', timeout: 60000 });
  await p.waitForTimeout(1000);
  await p.evaluate(() => {
    const h = [...document.querySelectorAll('h2')].find(
      (e) => e.textContent.trim() === 'How It Works',
    );
    h && h.scrollIntoView({ block: 'center' });
  });
  await p.waitForTimeout(1000);
  await p.evaluate(() =>
    document
      .querySelector("button[aria-label='How instant buyback works']")
      ?.click(),
  );
  await p.waitForTimeout(500);
  const m = await p.evaluate(() => {
    const d = document.querySelector("[role='dialog']");
    if (!d) return { open: false };
    // panel = the second child div (first is overlay)
    const panel = d.children[1] || d.querySelector('div + div');
    const r = panel.getBoundingClientRect();
    const title = d.querySelector('#buyback-title');
    const tTop = title ? Math.round(title.getBoundingClientRect().top) : -999;
    return {
      open: true,
      parentTag: d.parentElement ? d.parentElement.tagName : null,
      panelW: Math.round(r.width),
      panelH: Math.round(r.height),
      panelTop: Math.round(r.top),
      titleTop: tTop,
      onScreen:
        r.top >= 0 &&
        r.bottom <= window.innerHeight &&
        r.left >= 0 &&
        r.right <= window.innerWidth,
    };
  });
  console.log(`[${label}] ${JSON.stringify(m)}`);
  await p.screenshot({ path: `docs/research/MODAL_${label}.png` });
  await p.close();
  return m;
}
const home = await check('http://localhost:4000/', 'HOME');
const page = await check('http://localhost:4000/how-it-works', 'PAGE');
console.log(
  `SAME_SIZE=${home.panelW === page.panelW && home.panelH === page.panelH} (${home.panelW}x${home.panelH} vs ${page.panelW}x${page.panelH})`,
);
console.log(
  `BOTH_PORTALED=${home.parentTag === 'BODY' && page.parentTag === 'BODY'} BOTH_ONSCREEN=${home.onScreen && page.onScreen} BOTH_TITLE_VISIBLE=${home.titleTop > 0 && page.titleTop > 0}`,
);
await b.close();
