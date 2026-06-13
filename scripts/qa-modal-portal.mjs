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
    // the dialog panel (the centered card)
    const panel = d.querySelector('.max-w-\[560px\]') || d.children[1];
    const r = panel.getBoundingClientRect();
    // parent of the fixed overlay — should be BODY (portal), proving it escaped the card
    const parentTag = d.parentElement?.tagName;
    // is it fully on-screen (not clipped)?
    const onScreen =
      r.top >= 0 &&
      r.left >= 0 &&
      r.bottom <= innerHeight &&
      r.right <= innerWidth;
    const titleVisible =
      /85-90% Instant Buyback/.test(d.textContent) &&
      (d.querySelector('#buyback-title')?.getBoundingClientRect().top || 0) > 0;
    return {
      open: true,
      parentTag,
      panelW: Math.round(r.width),
      panelH: Math.round(r.height),
      panelTop: Math.round(r.top),
      onScreen,
      titleVisible,
    };
  });
  console.log(`[${label}] ${JSON.stringify(m)}`);
  await p.screenshot({ path: `docs/research/MODAL_${label}.png` });
  await p.close();
  return m;
}
const home = await check('http://localhost:4000/', 'HOME');
const page = await check('http://localhost:4000/how-it-works', 'PAGE');
const sameSize = home.panelW === page.panelW && home.panelH === page.panelH;
console.log(
  `SAME SIZE: ${sameSize} (home ${home.panelW}x${home.panelH} vs page ${page.panelW}x${page.panelH}) | both portaled to body: ${home.parentTag === 'BODY' && page.parentTag === 'BODY'} | both onScreen: ${home.onScreen && page.onScreen}`,
);
await b.close();
