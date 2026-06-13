import { chromium } from 'playwright';
const b = await chromium.launch();

async function modalCheck(url, label) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto(url, { waitUntil: 'load', timeout: 60000 });
  await p.waitForTimeout(900);
  await p.evaluate(() => {
    const h = [...document.querySelectorAll('h2')].find(
      (e) => e.textContent.trim() === 'How It Works',
    );
    h && h.scrollIntoView({ block: 'center' });
  });
  await p.waitForTimeout(900);
  await p.evaluate(() =>
    document
      .querySelector("button[aria-label='How instant buyback works']")
      ?.click(),
  );
  await p.waitForTimeout(500);
  const m = await p.evaluate(() => {
    const d = document.querySelector("[role='dialog']");
    const panel = d.children[1];
    const r = panel.getBoundingClientRect();
    const overlay = d.children[0];
    return {
      panelW: Math.round(r.width),
      panelH: Math.round(r.height),
      parent: d.parentElement.tagName,
      overlayBg: getComputedStyle(overlay).backgroundColor,
      onScreen: r.top >= 0 && r.bottom <= 900,
    };
  });
  await p.screenshot({ path: `docs/research/FINAL_modal_${label}.png` });
  await p.close();
  return m;
}

// card parity: capture the 3 step-card titles + heights on each page
async function cardCheck(url, label) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto(url, { waitUntil: 'load', timeout: 60000 });
  await p.waitForTimeout(900);
  await p.evaluate(() => {
    const h = [...document.querySelectorAll('h2')].find(
      (e) => e.textContent.trim() === 'How It Works',
    );
    h && h.scrollIntoView({ block: 'start' });
  });
  await p.waitForTimeout(1200);
  const d = await p.evaluate(() => {
    const h = [...document.querySelectorAll('h2')].find(
      (e) => e.textContent.trim() === 'How It Works',
    );
    const grid = h.closest('section').querySelector('.grid');
    const cards = [...grid.children];
    return cards.map((c) => {
      const r = c.getBoundingClientRect();
      return {
        h: Math.round(r.height),
        title: c.querySelector('h3')?.textContent?.trim(),
        hasBody: !!c.querySelector('p'),
        hasPill: !!c.querySelector('.mt-auto'),
      };
    });
  });
  await p.screenshot({ path: `docs/research/FINAL_cards_${label}.png` });
  await p.close();
  return d;
}

const mHome = await modalCheck('http://localhost:4000/', 'HOME');
const mPage = await modalCheck('http://localhost:4000/how-it-works', 'PAGE');
console.log('MODAL HOME:', JSON.stringify(mHome));
console.log('MODAL PAGE:', JSON.stringify(mPage));
console.log(
  'MODAL match orig (480w, rgba0.8):',
  mHome.panelW === 480 &&
    mPage.panelW === 480 &&
    mHome.overlayBg.includes('0.8'),
);

const cHome = await cardCheck('http://localhost:4000/', 'HOME');
const cPage = await cardCheck('http://localhost:4000/how-it-works', 'PAGE');
console.log(
  'CARDS HOME:',
  JSON.stringify(
    cHome.map((c) => ({
      h: c.h,
      t: c.title?.slice(0, 18),
      body: c.hasBody,
      pill: c.hasPill,
    })),
  ),
);
console.log(
  'CARDS PAGE:',
  JSON.stringify(
    cPage.map((c) => ({
      h: c.h,
      t: c.title?.slice(0, 18),
      body: c.hasBody,
      pill: c.hasPill,
    })),
  ),
);
const titlesMatch =
  JSON.stringify(cHome.map((c) => c.title)) ===
  JSON.stringify(cPage.map((c) => c.title));
const bodiesMatch =
  cHome.every((c) => c.hasBody) && cPage.every((c) => c.hasBody);
console.log(
  'CARDS identical (titles+body+pill):',
  titlesMatch &&
    bodiesMatch &&
    cHome.every((c) => c.hasPill) &&
    cPage.every((c) => c.hasPill),
);
await b.close();
