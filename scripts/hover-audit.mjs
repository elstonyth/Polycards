import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1500);

// helper: scroll a heading into view, find a target element under its section, measure
// its bounding-rect + key computed styles before vs during hover.
async function audit(label, findFn) {
  await p.mouse.move(5, 5);
  await p.waitForTimeout(250);
  const target = await p.evaluateHandle(findFn);
  if (!target) {
    console.log(`${label}: TARGET NOT FOUND`);
    return;
  }
  await p.evaluate((el) => el.scrollIntoView({ block: 'center' }), target);
  await p.waitForTimeout(400);
  const snap = async () =>
    p.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        top: +r.top.toFixed(1),
        transform: cs.transform,
        boxShadow: cs.boxShadow.slice(0, 30),
        bg: cs.backgroundColor,
        scale: cs.scale,
      };
    }, target);
  const before = await snap();
  const box = await p.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, target);
  await p.mouse.move(box.x, box.y);
  await p.waitForTimeout(450);
  const after = await snap();
  const moved = Math.abs(after.top - before.top) > 0.5;
  const tChanged = after.transform !== before.transform;
  const shadowChanged = after.boxShadow !== before.boxShadow;
  const bgChanged = after.bg !== before.bg;
  const any = moved || tChanged || shadowChanged || bgChanged;
  console.log(
    `${label}: ${any ? 'HOVER OK' : 'NO HOVER EFFECT'} | move=${(after.top - before.top).toFixed(1)}px transform:${tChanged} shadow:${shadowChanged} bg:${bgChanged}`,
  );
}

await audit('RecentPulls card', () => {
  const h = [...document.querySelectorAll('*')].find(
    (e) => e.textContent?.trim() === 'Recent Pulls',
  );
  const sec = h.closest('section') || h.parentElement.parentElement;
  return sec.querySelector(
    '[class*="group/card"], .group, a, div[class*="rounded-2xl"]',
  );
});
await audit('RecentPulls card img', () => {
  const h = [...document.querySelectorAll('*')].find(
    (e) => e.textContent?.trim() === 'Recent Pulls',
  );
  const sec = h.closest('section') || h.parentElement.parentElement;
  return sec.querySelector('img');
});
await audit('HowItWorks(home) card', () => {
  const h = [...document.querySelectorAll('h2')].find((e) =>
    e.textContent?.includes('How It Works'),
  );
  const sec = h.closest('section') || h.parentElement;
  return sec.querySelector('.group');
});
await audit('Community card', () => {
  const h = [...document.querySelectorAll('*')].find(
    (e) => e.textContent?.trim() === 'Our Community',
  );
  const sec = h?.closest('section') || h?.parentElement?.parentElement;
  return sec?.querySelector('a, .group\/card, [class*=group]');
});
await audit('Leaderboard row', () => {
  const h = [...document.querySelectorAll('h2')].find((e) =>
    e.textContent?.includes('Leaderboard'),
  );
  const sec = h.closest('section') || h.parentElement;
  const rows = sec.querySelectorAll('tbody tr, [class*=grid] > div, li');
  return rows[1] || rows[0];
});
await audit('Header nav link', () => document.querySelector('header nav a'));
await audit('Footer link', () => document.querySelector('footer a'));

await b.close();
