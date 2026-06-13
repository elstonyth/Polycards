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
  await p.waitForTimeout(1200);
  const data = await p.evaluate(() => {
    const h = [...document.querySelectorAll('h2')].find(
      (e) => e.textContent.trim() === 'How It Works',
    );
    const sec = h.closest('section');
    // step 3 title
    const titles = [...sec.querySelectorAll('h3')].map((e) =>
      e.textContent.trim(),
    );
    // pills: does packs have arrow? does buyback have ? button? does ships have globe + NO arrow?
    const hasBuybackBtn = !!sec.querySelector(
      "button[aria-label='How instant buyback works']",
    );
    // find the ships pill (contains 'Ships worldwide')
    const shipsPill = [...sec.querySelectorAll('div')].find(
      (d) =>
        /Ships worldwide/.test(d.textContent) &&
        d.className.includes('rounded-xl'),
    );
    const shipsHasArrow = shipsPill
      ? !!shipsPill.querySelector('svg.lucide-arrow-right, svg') &&
        /arrow/i.test(shipsPill.innerHTML)
      : null;
    const broken = [...sec.querySelectorAll('img')].filter(
      (i) => i.complete && i.naturalWidth === 0,
    ).length;
    return { titles, hasBuybackBtn, broken };
  });
  // click buyback ? to verify modal
  const modalOK = await p.evaluate(async () => {
    const btn = document.querySelector(
      "button[aria-label='How instant buyback works']",
    );
    if (!btn) return false;
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    const d = document.querySelector("[role='dialog']");
    return !!d && /85-90% Instant Buyback/.test(d.textContent);
  });
  console.log(
    `[${label}] titles=${JSON.stringify(data.titles)} buybackBtn=${data.hasBuybackBtn} modalOpens=${modalOK} broken=${data.broken}`,
  );
  await p.screenshot({ path: `docs/research/HIW_${label}.png` });
  await p.close();
}
await check('http://localhost:4000/', 'HOME');
await check('http://localhost:4000/how-it-works', 'PAGE');
await b.close();
