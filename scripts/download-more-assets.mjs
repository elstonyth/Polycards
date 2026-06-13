// Wave 0 asset pass: (1) probe + download more pfp avatars, (2) harvest real graded-card
// images from the live site's feeds, into public/ — so mock grids look full and never 404.
import { chromium } from 'playwright';
import {
  createWriteStream,
  existsSync,
  statSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

mkdirSync('public/images/pfps', { recursive: true });
mkdirSync('public/cdn/cards', { recursive: true });

async function dl(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 800) return true;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://www.phygitals.com/',
      },
    });
    if (!r.ok) return false;
    await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
    return statSync(dest).size > 800;
  } catch {
    return false;
  }
}

// 1) PFPS — probe pfp-1..160, keep the ones that exist.
const pfpIds = [];
for (let i = 1; i <= 160; i += 8) {
  const batch = [];
  for (let n = i; n < i + 8 && n <= 160; n++) {
    batch.push(
      dl(
        `https://www.phygitals.com/images/pfps/pfp-${n}.webp`,
        `public/images/pfps/pfp-${n}.webp`,
      ).then((ok) => ok && pfpIds.push(n)),
    );
  }
  await Promise.all(batch);
}
console.log(
  `pfps available: ${pfpIds.sort((a, b) => a - b).length} ->`,
  pfpIds.sort((a, b) => a - b).join(','),
);

// 2) CARD IMAGES — harvest from live feeds.
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 4000 } });
const urls = new Set();
for (const route of ['/', '/pack-party']) {
  try {
    await page
      .goto('https://www.phygitals.com' + route, {
        waitUntil: 'networkidle',
        timeout: 40000,
      })
      .catch(() => {});
    await page.waitForTimeout(2500);
    const found = await page.evaluate(() =>
      [...document.querySelectorAll('img')]
        .map((i) => i.currentSrc || i.src)
        .filter((s) =>
          /cdn-cgi\/image|img\.phygitals\.com|arweave\.net/.test(s),
        ),
    );
    found.forEach((u) => urls.add(u));
  } catch {}
}
await browser.close();

const cardUrls = [...urls].slice(0, 48);
console.log(`harvested ${cardUrls.length} card image URLs`);
const manifest = [];
let idx = 0;
for (let i = 0; i < cardUrls.length; i += 5) {
  await Promise.all(
    cardUrls.slice(i, i + 5).map(async (u) => {
      const id = `h-${String(++idx).padStart(3, '0')}`;
      const ok = await dl(u, `public/cdn/cards/${id}.webp`);
      if (ok) manifest.push(id);
    }),
  );
}
writeFileSync(
  'docs/research/harvested-cards.json',
  JSON.stringify(
    { pfps: pfpIds.sort((a, b) => a - b), cards: manifest },
    null,
    2,
  ),
);
console.log(
  `downloaded ${manifest.length} card images -> public/cdn/cards/h-*.webp`,
);
console.log('manifest -> docs/research/harvested-cards.json');
