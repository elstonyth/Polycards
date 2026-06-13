import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/how-it-works', {
  waitUntil: 'load',
  timeout: 60000,
});
await p.waitForTimeout(1500);
// scroll the 3 steps into view
await p.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find(
    (e) => e.textContent.trim() === 'How It Works',
  );
  h && h.scrollIntoView({ block: 'center' });
});
await p.waitForTimeout(1200);
// screenshot the 3 cards
await p.screenshot({ path: 'docs/research/PILLS_cards.png' });
// click the buyback "?" button
const clicked = await p.evaluate(() => {
  const btn = [
    ...document.querySelectorAll(
      "button[aria-label='How instant buyback works']",
    ),
  ][0];
  if (btn) {
    btn.click();
    return true;
  }
  return false;
});
console.log('buyback button found+clicked:', clicked);
await p.waitForTimeout(600);
// verify modal open + content
const modal = await p.evaluate(() => {
  const d = document.querySelector("[role='dialog']");
  if (!d) return { open: false };
  const t = d.querySelector('#buyback-title')?.textContent;
  const txt = d.innerText.replace(/\n+/g, ' ');
  const broken = [...d.querySelectorAll('img')].filter(
    (i) => i.complete && i.naturalWidth === 0,
  ).length;
  return {
    open: true,
    title: t,
    hasFMV: /Card FMV/.test(txt) && /\$85\.00 - \$90\.00/.test(txt),
    hasMini:
      /Open a pack/.test(txt) &&
      /Pull a card/.test(txt) &&
      /Sell instantly/.test(txt),
    gotIt: /Got it/.test(txt),
    broken,
  };
});
console.log('MODAL:', JSON.stringify(modal));
await p.screenshot({ path: 'docs/research/PILLS_modal.png' });
await b.close();
