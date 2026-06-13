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
    sc.scrollTop = h.offsetTop - 150;
  }
});
await p.waitForTimeout(1000);
// click the help button via Playwright (more reliable than evaluate click for some handlers)
const btns = await p.$$('button');
let clicked = false;
for (const btn of btns) {
  const al = await btn.getAttribute('aria-label');
  const tx = await btn.innerText().catch(() => '');
  const box = await btn.boundingBox();
  if (
    box &&
    box.y > 0 &&
    (/\?/.test(tx) || /buyback|help|info|how/i.test(al || ''))
  ) {
    await btn.click().catch(() => {});
    clicked = true;
    break;
  }
}
// fallback: click any small round button near the buyback pill
if (!clicked) {
  const pill = await p.$('text=85-90%');
  if (pill) {
    const box = await pill.boundingBox();
    if (box)
      await p.mouse
        .click(box.x + box.width + 20, box.y + box.height / 2)
        .catch(() => {});
  }
}
await p.waitForTimeout(1000);
const m = await p.evaluate(() => {
  const cand = [...document.querySelectorAll('div')].filter((d) => {
    const t = d.textContent || '';
    return /Instant Buyback/.test(t) && /Card FMV/.test(t) && /Got it/i.test(t);
  });
  cand.sort(
    (a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width,
  );
  const panel = cand[0];
  if (!panel)
    return {
      found: false,
      anyBuyback: [...document.querySelectorAll('*')].some((e) =>
        /Instant Buyback/.test(e.textContent || ''),
      ),
    };
  const r = panel.getBoundingClientRect();
  const cs = getComputedStyle(panel);
  const overlay = [...document.querySelectorAll('div')].find((d) => {
    const s = getComputedStyle(d);
    const rr = d.getBoundingClientRect();
    return (
      s.position === 'fixed' &&
      rr.width >= innerWidth - 2 &&
      rr.height >= innerHeight - 2
    );
  });
  const btn = [...panel.querySelectorAll('button')].find((x) =>
    /got it/i.test(x.textContent),
  );
  return {
    found: true,
    panelW: Math.round(r.width),
    panelH: Math.round(r.height),
    radius: cs.borderRadius,
    padding: cs.padding,
    bg: cs.backgroundColor,
    overlayBg: overlay ? getComputedStyle(overlay).backgroundColor : '(none)',
    overlayBackdrop: overlay
      ? getComputedStyle(overlay).backdropFilter
      : '(none)',
    gotItBg: btn ? getComputedStyle(btn).backgroundColor : null,
    gotItRadius: btn ? getComputedStyle(btn).borderRadius : null,
  };
});
console.log('ORIG MODAL:', JSON.stringify(m, null, 1));
if (m.found) await p.screenshot({ path: 'docs/research/ORIG_MODAL.png' });
await b.close();
