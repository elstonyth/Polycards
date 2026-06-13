// Task E v2 Phase 0 — capture the two missing pokemon tiers (Sealed $100,
// Base Set $500) from live phygitals.com/claw: exact titles, prices, OOS
// state, tile order within the Pokémon row, and icon URLs. Downloads the
// icons to docs/research/missing-tiers/ (staging — NOT public/ until the
// watermark check passes).
//
// Lessons baked in: the live SPA scrolls inside main.overflow-y-auto
// (document scroll is a no-op), networkidle never fires (fixed waits), and
// per-category pack rows are horizontal carousels whose offscreen tiles
// lazy-load — so every overflowing row is scrolled to the end and back.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, createWriteStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const LIVE = 'https://www.phygitals.com';
const OUT = 'docs/research/missing-tiers';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

mkdirSync(OUT, { recursive: true });

async function dl(url, dest) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.phygitals.com/' },
  });
  if (!res.ok) {
    console.log('DL FAIL', res.status, url);
    return false;
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  console.log('DL OK ', dest, `(${statSync(dest).size}b)`);
  return true;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  userAgent: UA,
});
const page = await ctx.newPage();

await page.goto(`${LIVE}/claw`, {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
await page.waitForTimeout(8000);

// 1) Vertical scroll of the real container to force lazy section renders.
await page.evaluate(async () => {
  const main = document.querySelector('main');
  const el =
    main && main.scrollHeight > main.clientHeight + 50
      ? main
      : (document.scrollingElement ?? document.documentElement);
  await new Promise((res) => {
    let ticks = 0;
    const t = setInterval(() => {
      el.scrollBy(0, 600);
      ticks += 1;
      if (
        ticks >= 40 ||
        el.scrollTop + el.clientHeight >= el.scrollHeight - 5
      ) {
        clearInterval(t);
        res(null);
      }
    }, 80);
  });
  el.scrollTop = 0;
});
await page.waitForTimeout(2000);

// 2) Horizontal-scroll every overflowing row (carousels) to lazy-load tiles,
//    then snap back to the start so positions reflect natural order.
await page.evaluate(async () => {
  const rows = [...document.querySelectorAll('*')].filter(
    (e) =>
      e.scrollWidth > e.clientWidth + 80 &&
      e.clientWidth > 300 &&
      e.clientHeight > 100,
  );
  for (const row of rows) {
    for (let x = 0; x <= row.scrollWidth; x += 500) {
      row.scrollLeft = x;
      await new Promise((r) => setTimeout(r, 120));
    }
    row.scrollLeft = 0;
  }
});
await page.waitForTimeout(2000);

// 3) Extract the Pokémon row: every claw-pack img with its card's texts.
const data = await page.evaluate(() => {
  const main = document.querySelector('main') ?? document.body;
  const headings = [...main.querySelectorAll('*')]
    .filter(
      (e) =>
        /Packs$/.test((e.childNodes[0]?.textContent ?? '').trim()) &&
        e.children.length === 0,
    )
    .map((e) => ({
      text: e.textContent.trim(),
      top:
        e.getBoundingClientRect().top +
        (document.querySelector('main')?.scrollTop ?? 0),
    }));

  const packImgs = [...main.querySelectorAll('img')].filter((i) =>
    (i.currentSrc || i.src || '').includes('images/claw'),
  );
  const tiles = packImgs.map((img) => {
    // climb to the card: nearest ancestor whose text includes a $ price
    let card = img.parentElement;
    for (let i = 0; i < 8 && card; i++) {
      if (/\$\s?[\d,]+/.test(card.textContent ?? '')) break;
      card = card.parentElement;
    }
    const txt = (card?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const r = (card ?? img).getBoundingClientRect();
    const scrollTop = document.querySelector('main')?.scrollTop ?? 0;
    return {
      src: img.currentSrc || img.src,
      cardText: txt.slice(0, 220),
      price: (txt.match(/\$\s?[\d,]+(\.\d+)?/) ?? [null])[0],
      soldOut: /sold\s*out|out\s*of\s*stock/i.test(txt),
      x: Math.round(r.x),
      top: Math.round(r.top + scrollTop),
      w: Math.round(r.width),
    };
  });
  return { headings, tiles };
});

// 4) Slice tiles to the Pokémon section's vertical band.
const heads = data.headings.filter((h) => /Packs$/.test(h.text));
const pkIdx = heads.findIndex((h) => /pok[ée]mon/i.test(h.text));
const pkTop = pkIdx >= 0 ? heads[pkIdx].top : -Infinity;
const nextTop =
  pkIdx >= 0 && heads[pkIdx + 1] ? heads[pkIdx + 1].top : Infinity;
const pokemonTiles = data.tiles
  .filter((t) => t.top >= pkTop - 40 && t.top < nextTop - 40)
  .sort((a, b) => a.x - b.x);

const result = {
  capturedAt: new Date().toISOString(),
  headings: heads.map((h) => h.text),
  pokemonRowOrder: pokemonTiles.map((t) => ({
    name: t.cardText.replace(/\$.*$/, '').trim().slice(0, 60),
    price: t.price,
    soldOut: t.soldOut,
    icon: t.src,
  })),
  allTiles: data.tiles,
};
writeFileSync(`${OUT}/pokemon-row.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.pokemonRowOrder, null, 2));

// 5) Screenshot the Pokémon section for the visual record.
await page.evaluate((top) => {
  const main = document.querySelector('main');
  if (main) main.scrollTop = Math.max(0, top - 80);
}, pkTop);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/live-pokemon-section.png` });

// 6) Download the Sealed / Base Set icons (staging dir only).
const targets = result.pokemonRowOrder.filter((t) =>
  /sealed|base\s*set/i.test(t.name + ' ' + t.icon),
);
for (const t of targets) {
  const base = decodeURIComponent(
    new URL(t.icon).pathname.split('/').pop() ?? 'tile.webp',
  );
  await dl(t.icon, `${OUT}/${base}`);
}
if (!targets.length)
  console.log(
    'WARN: no Sealed/Base Set tiles matched — inspect pokemon-row.json + screenshot',
  );

await browser.close();
console.log('done');
