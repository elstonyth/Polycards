// Download the real /claw pack artwork + category icons from phygitals.com to public/.
import { mkdirSync, createWriteStream, existsSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const PACK_ART = [
  'mythic-pack-icon',
  'legend-pack-icon',
  'elite-pack-icon',
  'platinum-pack-icon',
  'rookie-pack-icon',
  'legend-one-piece-pack-icon',
  'one-piece-platinum-pack-icon',
  'elite-one-piece-pack-icon',
  'starter-one-piece-pack-icon',
  'black-pack-jjnfuk-icon',
  'legend-pack-1dpaec-icon',
  'modern-grails-noafw0-icon',
  'pro-baseball-pack-icon',
  'legend-baseball-pack-icon',
  'starter-baseball-pack-icon',
  'elite-football-pack-icon',
  'starter-football-pack-icon',
  'platinum-football-pack-icon',
  'pro-soccer-pack-icon',
  'yugioh-pro-pack-icon',
  'starter-riftbound-pack-icon',
];
const CAT_ICONS = [
  'pokemon',
  'onepiece',
  'nba',
  'mlb',
  'nfl',
  'soccer',
  'yugioh',
  'riftbound',
];

mkdirSync('public/images/claw', { recursive: true });
mkdirSync('public/pack-index-icons', { recursive: true });

async function dl(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 1000) {
    console.log('skip', dest);
    return;
  }
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://www.phygitals.com/',
    },
  });
  if (!res.ok) {
    console.log('FAIL', res.status, url);
    return;
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  console.log('OK  ', dest, `(${statSync(dest).size}b)`);
}

const jobs = [
  ...PACK_ART.map((n) => [
    `https://www.phygitals.com/images/claw/${n}.webp`,
    `public/images/claw/${n}.webp`,
  ]),
  ...CAT_ICONS.map((n) => [
    `https://www.phygitals.com/pack%20index%20icons/${n}.webp`,
    `public/pack-index-icons/${n}.webp`,
  ]),
];

// 4 at a time
for (let i = 0; i < jobs.length; i += 4) {
  await Promise.all(
    jobs
      .slice(i, i + 4)
      .map(([u, d]) => dl(u, d).catch((e) => console.log('ERR', d, e.message))),
  );
}
console.log('done');
