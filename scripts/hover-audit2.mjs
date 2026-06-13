import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1500);

async function audit(label, sel, scrollText) {
  await p.mouse.move(5, 5);
  await p.waitForTimeout(200);
  if (scrollText)
    await p.evaluate((t) => {
      const h = [...document.querySelectorAll('h2,h3')].find((e) =>
        e.textContent?.includes(t),
      );
      h && h.scrollIntoView({ block: 'center' });
    }, scrollText);
  await p.waitForTimeout(400);
  const el = await p.$(sel);
  if (!el) {
    console.log(`${label}: NOT FOUND (${sel})`);
    return;
  }
  const snap = async () =>
    el.evaluate((n) => {
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      return {
        top: +r.top.toFixed(1),
        tf: cs.transform,
        sh: cs.boxShadow.slice(0, 20),
        bg: cs.backgroundColor,
      };
    });
  const before = await snap();
  await el.hover();
  await p.waitForTimeout(450);
  const after = await snap();
  const d = (after.top - before.top).toFixed(1);
  const fx = [];
  if (Math.abs(after.top - before.top) > 0.5) fx.push(`lift ${d}px`);
  if (after.tf !== before.tf) fx.push('transform');
  if (after.sh !== before.sh) fx.push('shadow');
  if (after.bg !== before.bg) fx.push('bg');
  console.log(
    `${label}: ${fx.length ? 'OK [' + fx.join(', ') + ']' : 'NO EFFECT'}`,
  );
}

await audit('Open Packs card', 'section .group:has(img)', 'Open Packs');
await audit('RecentPulls card', "[class*='group/card']", 'Recent Pulls');
await audit('HowItWorks card', 'section .group', 'How It Works');
await audit(
  'Community card',
  "[class*='group/card'] , a[class*=group]",
  'Our Community',
);
await audit('Leaderboard row', 'tbody tr:nth-child(2)', 'Leaderboard');
await audit(
  'CTA fan',
  "a:has(img) .group\/x , div:has(> img[class*='group-hover'])",
  'Ready to start',
);
await audit('Header nav link', 'header nav a');
await audit('Footer link', 'footer a');
const broken = await p.evaluate(
  () =>
    [...document.images].filter((x) => x.complete && x.naturalWidth === 0)
      .length,
);
console.log('broken images:', broken);
await b.close();
