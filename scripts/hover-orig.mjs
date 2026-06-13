import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('https://www.phygitals.com/', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
for (let i = 0; i < 20; i++) {
  if (await p.evaluate(() => document.querySelectorAll('img').length > 5))
    break;
  await p.waitForTimeout(1000);
}
await p.waitForTimeout(2500);

async function audit(label, findFn) {
  await p.mouse.move(5, 5);
  await p.waitForTimeout(250);
  const target = await p.evaluateHandle(findFn);
  const exists = await p.evaluate((el) => !!el, target);
  if (!exists) {
    console.log(`${label}: NOT FOUND`);
    return;
  }
  await p.evaluate((el) => el.scrollIntoView({ block: 'center' }), target);
  await p.waitForTimeout(500);
  const snap = async () =>
    p.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        top: +r.top.toFixed(1),
        transform: cs.transform,
        boxShadow: cs.boxShadow.slice(0, 24),
        bg: cs.backgroundColor,
      };
    }, target);
  const before = await snap();
  const box = await p.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, target);
  await p.mouse.move(box.x, box.y);
  await p.waitForTimeout(500);
  const after = await snap();
  console.log(
    `${label}: move=${(after.top - before.top).toFixed(1)}px transformΔ=${after.transform !== before.transform} shadowΔ=${after.boxShadow !== before.boxShadow} bgΔ=${after.bg !== before.bg}`,
  );
}

// RecentPulls card
await audit('ORIG RecentPulls card', () => {
  const h = [...document.querySelectorAll('*')].find(
    (e) => e.children.length === 0 && e.textContent?.trim() === 'Recent Pulls',
  );
  let sec = h;
  for (let i = 0; i < 6; i++) {
    sec = sec.parentElement;
    if (sec.querySelectorAll('img').length > 3) break;
  }
  return sec.querySelector('img')?.closest('div[class*=rounded],a');
});
// Leaderboard row
await audit('ORIG Leaderboard row', () => {
  const h = [...document.querySelectorAll('*')].find(
    (e) =>
      e.children.length === 0 &&
      /Leaderboard/.test(e.textContent?.trim() || ''),
  );
  let sec = h;
  for (let i = 0; i < 7; i++) {
    sec = sec.parentElement;
    if (sec.querySelectorAll('tr,li,[class*=grid]>div').length > 3) break;
  }
  const rows = sec.querySelectorAll('tbody tr, li, [class*=grid]>div');
  return rows[2] || rows[1];
});
await b.close();
