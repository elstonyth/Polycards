import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('https://www.phygitals.com/', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
for (let i = 0; i < 25; i++) {
  if (await p.evaluate(() => document.images.length > 4)) break;
  await p.waitForTimeout(1000);
}
await p.waitForTimeout(2500);

// scroll How It Works into view (inside the real scroller)
await p.evaluate(() => {
  const sc = [...document.querySelectorAll('*')].find((el) => {
    const s = getComputedStyle(el);
    return (
      (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
      el.scrollHeight > el.clientHeight + 100
    );
  });
  const h = [...document.querySelectorAll('h1,h2,h3')].find((e) =>
    /how it works/i.test(e.textContent),
  );
  if (h && sc) {
    sc.scrollTop = h.offsetTop - 200;
  }
});
await p.waitForTimeout(1200);

// find and click a "?" / help button near the buyback pill
const opened = await p.evaluate(() => {
  // look for a button inside the "85-90%" pill area
  const pill = [...document.querySelectorAll('*')].find(
    (e) => /85-90%/.test(e.textContent || '') && e.querySelector('button'),
  );
  const btn = pill
    ? pill.querySelector('button')
    : [...document.querySelectorAll('button')].find(
        (b) =>
          /\?/.test(b.textContent) ||
          /help|buyback|info/i.test(b.getAttribute('aria-label') || ''),
      );
  if (btn) {
    btn.click();
    return true;
  }
  return false;
});
await p.waitForTimeout(900);

const m = await p.evaluate(() => {
  // the modal is likely a fixed/absolute panel that just appeared with "Instant Buyback"
  const cand = [...document.querySelectorAll('div')].filter(
    (d) =>
      /Instant Buyback/.test(d.textContent) && /Card FMV/.test(d.textContent),
  );
  // pick the smallest such container (the panel itself)
  cand.sort(
    (a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width,
  );
  const panel = cand[0];
  if (!panel) return { found: false };
  const r = panel.getBoundingClientRect();
  const cs = getComputedStyle(panel);
  // backdrop: find a fixed full-screen element behind it
  const overlay = [...document.querySelectorAll('div')].find((d) => {
    const s = getComputedStyle(d);
    const rr = d.getBoundingClientRect();
    return (
      s.position === 'fixed' &&
      rr.width >= window.innerWidth - 2 &&
      rr.height >= window.innerHeight - 2 &&
      s.backgroundColor !== 'rgba(0, 0, 0, 0)'
    );
  });
  return {
    found: true,
    panelW: Math.round(r.width),
    panelH: Math.round(r.height),
    radius: cs.borderRadius,
    padding: cs.padding,
    bg: cs.backgroundColor,
    border: cs.border,
    overlayBg: overlay ? getComputedStyle(overlay).backgroundColor : null,
    overlayBackdrop: overlay ? getComputedStyle(overlay).backdropFilter : null,
  };
});
console.log('ORIGINAL MODAL:', JSON.stringify(m, null, 1));
await p.screenshot({ path: 'docs/research/ORIG_MODAL.png' });
await b.close();
