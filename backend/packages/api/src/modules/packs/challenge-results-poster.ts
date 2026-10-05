import sharp, { type OverlayOptions } from 'sharp';
import { ensureBundledFonts } from '../../api/admin/media/label-font';
import { fetchBytes, MAX_DECODE_PIXELS } from '../../api/utils/image-fetch';
import { capH, POSTER_H, POSTER_W } from './brand-poster';
import { sizeToFit, twoLines } from './challenge-poster';
import { BRAND_LOGO_B64 } from './pull-card-assets';
import {
  baseline,
  body,
  display,
  fit,
  imageSafeName,
  measure,
  textEl,
} from './pull-card';

// Last week's Weekly Challenge result as posting posters for the Growth desk
// (GET /reports/growth/challenge-results-poster and the Monday 9 a.m. drop),
// in the challenge poster's language (ink stage, charcoal panels, Nekst
// claims, chase gold for money). A week is posted as two 1080x1350 images,
// the 4:5 size Facebook and Instagram feeds show whole: 'top', the top 3 with
// every prize card they won side by side and named, what they pulled and
// what they won; 'rest', ranks 4-10 as a ledger. Every figure comes from
// settlement's own rows; nothing is typed in.
//
// Text is SVG rendered by sharp against the bundled fonts, so judge the look
// from a Linux render (the prod container), never a Windows one.

export type ResultsPodiumEntry = {
  rank: number;
  /** Public display name. */
  name: string;
  pulledMyr: number | null;
  prizeMyr: number;
  credits: number;
  /** Every card won, most valuable first, once per pull minted (two
   *  stages can award one card twice); empty = credits only. */
  cards: string[];
};

export type ResultsListEntry = {
  rank: number;
  name: string;
  pulledMyr: number | null;
  prizeMyr: number;
};

export type ResultsPosterInput = {
  /** '28 SEP – 4 OCT' */
  weekLabel: string;
  /** e.g. 'RM 2,317,411 POOLED · 3 STAGES UNLOCKED' */
  headline: string;
  /** Ranks 1-3 that are shown (a hidden winner leaves a gap). */
  podium: ResultsPodiumEntry[];
  /** Ranks 4-10 that are shown. */
  list: ResultsListEntry[];
  /** Bare footer address, e.g. 'polycards.gg/leaderboard'. */
  siteHost: string;
};

/** Which of a week's two result images: the top 3, or ranks 4-10. */
export type ResultsPart = 'top' | 'rest';

const INK = '#0a0a0a';
const CHARCOAL = '#171717';
const GRAPHITE = '#262626';
const HAIRLINE = 'rgba(255,255,255,0.1)';
const WHITE = '#fafafa';
const SILVER = '#a3a3a3';
const SOFT = '#d4d4d4';
const CHASE = '#ffb020';
const RANK_TONE: Record<number, string> = {
  1: CHASE,
  2: '#d4d4d4',
  3: '#f59e0b',
};
const RANK_SUFFIX: Record<number, string> = { 1: 'ST', 2: 'ND', 3: 'RD' };

const W = POSTER_W;
const H = POSTER_H;
const PAD = 64;
const TEXT_W = W - 2 * PAD;
const LOGO_H = 50;
const LOGO_W = Math.round((LOGO_H * 360) / 97); // polycards-logo.png is 360x97
const SLAB = 1600 / 2590;
const PILL_H = 84;
const PILL_Y = H - 56 - PILL_H;

// A row or panel shows at most this many cards; more are counted under what
// the winner won ("+2 MORE CARDS").
export const MAX_ROW_CARDS = 5;
// The winner's row: who on the left, the cards on the right.
const INFO_W = 280;
const ROW_PAD = 24;
const ROW_ROOM = TEXT_W - 2 * 32 - INFO_W - 24;
// Second and third share a row of two panels.
const HALF_W = (TEXT_W - 16) / 2;
const HALF_PAD = 24;
const HALF_ROOM = HALF_W - 2 * HALF_PAD;
// Up to two lines of card name under each slab.
const NAMES_H = 14 + 48;

/** Whole ringgit, as a post reads money: RM 452,123. */
export const rmWhole = (n: number): string =>
  `RM ${Math.round(n).toLocaleString('en-MY')}`;

/** The gold line under the title: the pool and the stages it unlocked. */
export function resultsHeadline(
  poolMyr: number | null,
  unlockedStages: number[],
): string {
  const n = unlockedStages.length;
  const stages =
    n === 0 ? 'NO STAGE UNLOCKED' : `${n} STAGE${n === 1 ? '' : 'S'} UNLOCKED`;
  return poolMyr === null ? stages : `${rmWhole(poolMyr)} POOLED · ${stages}`;
}

/** How wide each of `n` cards is drawn side by side in `room`, `gap` apart:
 *  as big as the room allows, never wider than `max`. */
export function cardWidth(
  n: number,
  room: number,
  max: number,
  gap: number,
): number {
  if (n <= 0) return 0;
  return Math.min(max, Math.floor((room - (n - 1) * gap) / n));
}

const decode = (bytes: Buffer) =>
  sharp(bytes, { limitInputPixels: MAX_DECODE_PIXELS });

/** A card's art contained in a w x h box, or null when it does not decode. */
async function cardPng(
  bytes: Buffer | null,
  w: number,
  h: number,
): Promise<Buffer | null> {
  if (!bytes) return null;
  try {
    return await decode(bytes)
      .resize(w, h, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

/** The tile a card whose art could not be loaded is drawn as. */
const placeholderPng = (w: number, h: number): Promise<Buffer> =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
        `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="16" fill="${GRAPHITE}" stroke="${HAIRLINE}" stroke-width="2"/>` +
        textEl(
          'PRIZE CARD',
          w / 2,
          baseline(h / 2, 16),
          body(16, 3),
          SILVER,
          'middle',
        ) +
        '</svg>',
    ),
  )
    .png()
    .toBuffer();

type Canvas = {
  svg: string[];
  layers: OverlayOptions[];
  placeholders: number[];
};

/** One winner's cards side by side, centred in [x, x + room), tops at `top`,
 *  each named under its slab; or their credits as a plain tile. */
async function drawPrizes(
  c: Canvas,
  winner: ResultsPodiumEntry,
  pics: (Buffer | null)[],
  x: number,
  room: number,
  top: number,
  cardW: number,
  gap: number,
): Promise<void> {
  const n = Math.min(winner.cards.length, MAX_ROW_CARDS);
  if (!n) {
    const tileW = Math.min(300, room);
    const tileH = 160;
    const tileX = x + (room - tileW) / 2;
    const amount = rmWhole(winner.credits);
    const size = await sizeToFit(
      [amount],
      (s) => display(s),
      44,
      22,
      tileW - 40,
    );
    c.svg.push(
      `<rect x="${tileX.toFixed(1)}" y="${top}" width="${tileW}" height="${tileH}" rx="24" ` +
        `fill="${GRAPHITE}" stroke="${HAIRLINE}" stroke-width="2"/>`,
      textEl(
        amount,
        tileX + tileW / 2,
        baseline(top + 64, size),
        display(size),
        CHASE,
        'middle',
      ),
      textEl(
        'CREDITS',
        tileX + tileW / 2,
        baseline(top + 112, 20),
        body(20, 4),
        SILVER,
        'middle',
      ),
    );
    return;
  }
  const cardH = Math.round(cardW / SLAB);
  const total = n * cardW + (n - 1) * gap;
  const x0 = x + (room - total) / 2;
  for (let i = 0; i < n; i++) {
    const cx = Math.round(x0 + i * (cardW + gap));
    let card = await cardPng(pics[i] ?? null, cardW, cardH);
    if (!card) {
      if (!c.placeholders.includes(winner.rank))
        c.placeholders.push(winner.rank);
      card = await placeholderPng(cardW, cardH);
    }
    c.layers.push({ input: card, left: cx, top: Math.round(top) });
    let ny = top + cardH + 14 + capH(18) / 2;
    for (const line of await twoLines(
      winner.cards[i],
      body(18),
      cardW + gap - 4,
    )) {
      c.svg.push(
        textEl(
          line,
          cx + cardW / 2,
          baseline(ny, 18),
          body(18),
          SOFT,
          'middle',
        ),
      );
      ny += 24;
    }
  }
}

/** The height of a winner's prizes: the cards and their names, or the
 *  credits tile. */
const prizesH = (winner: ResultsPodiumEntry, cardW: number): number =>
  winner.cards.length ? Math.round(cardW / SLAB) + NAMES_H : 160;

const extraCards = (winner: ResultsPodiumEntry): number =>
  Math.max(0, winner.cards.length - MAX_ROW_CARDS);

/**
 * Compose one of a week's two result images, 1080x1350. `art` maps a podium
 * rank to its cards' bytes, in the order of its `cards` (null or missing = a
 * placeholder tile, never a failed poster). `placeholders` lists the ranks
 * with a card not shown as its art.
 */
export async function composeResultsPoster(
  input: ResultsPosterInput,
  art: Map<number, (Buffer | null)[]>,
  part: ResultsPart = 'top',
): Promise<{ jpeg: Buffer; placeholders: number[] }> {
  ensureBundledFonts(); // before the first text render in this process
  const mid = W / 2;
  const c: Canvas = {
    layers: [
      {
        input: await sharp(Buffer.from(BRAND_LOGO_B64, 'base64'))
          .resize(LOGO_W, LOGO_H)
          .toBuffer(),
        left: PAD,
        top: PAD,
      },
    ],
    svg: [
      textEl(
        input.weekLabel,
        W - PAD,
        baseline(PAD + LOGO_H / 2, 28),
        body(28, 3),
        SILVER,
        'end',
      ),
    ],
    placeholders: [],
  };
  const panels: string[] = [];

  // ---- the title and the gold line ------------------------------------------
  const title = 'WEEKLY CHALLENGE RESULTS';
  const titleSize = await sizeToFit([title], (s) => display(s), 72, 40, TEXT_W);
  let y = PAD + LOGO_H + 44 + titleSize / 2;
  c.svg.push(
    textEl(
      title,
      mid,
      baseline(y, titleSize),
      display(titleSize),
      WHITE,
      'middle',
    ),
  );
  const headline = input.headline.toUpperCase();
  const headSize = await sizeToFit(
    [headline],
    (s) => display(s),
    40,
    22,
    TEXT_W,
  );
  y += titleSize / 2 + 24 + headSize / 2;
  c.svg.push(
    textEl(
      headline,
      mid,
      baseline(y, headSize),
      display(headSize),
      CHASE,
      'middle',
    ),
  );
  const bodyTop = Math.round(y + headSize / 2 + 36);
  const bodyBottom = part === 'top' ? PILL_Y - 28 : PILL_Y - 96;
  let spotY = (bodyTop + bodyBottom) / 2;

  if (part === 'top') {
    // ---- the top 3: every card they won, whole and named ---------------------
    const podium = [...input.podium].sort((a, b) => a.rank - b.rank);
    const first = podium.find((w) => w.rank === 1);
    const others = podium.filter((w) => w.rank !== 1);
    const n1 = first ? Math.min(first.cards.length, MAX_ROW_CARDS) : 0;
    const nMax = Math.max(
      0,
      ...others.map((w) => Math.min(w.cards.length, MAX_ROW_CARDS)),
    );
    let w1 = cardWidth(n1, ROW_ROOM, 170, 16);
    let w2 = cardWidth(nMax, HALF_ROOM, 140, 12);
    const infoH1 = 150;
    const infoH2 = 76;
    const rowH1 = () =>
      first ? Math.max(infoH1, prizesH(first, w1)) + 2 * ROW_PAD : 0;
    const rowH2 = () =>
      others.length
        ? HALF_PAD +
          infoH2 +
          16 +
          Math.max(...others.map((w) => prizesH(w, w2))) +
          HALF_PAD
        : 0;
    const total = () => rowH1() + (first && others.length ? 16 : 0) + rowH2();
    // Shrink the cards, never the type, until both rows fit the room.
    while (total() > bodyBottom - bodyTop && (w1 > 60 || w2 > 60)) {
      w1 = Math.max(60, w1 - 4);
      w2 = Math.max(60, w2 - 4);
    }
    let ry = bodyTop + Math.max(0, (bodyBottom - bodyTop - total()) / 2);

    if (first) {
      const h = rowH1();
      panels.push(
        `<rect x="${PAD + 1}" y="${ry + 1}" width="${TEXT_W - 2}" height="${h - 2}" rx="32" ` +
          `fill="${CHARCOAL}" stroke="${CHASE}" stroke-width="2"/>`,
      );
      spotY = ry + h / 2;
      // Who: the rank, the name, what they pulled, what they won.
      const infoX = PAD + 40;
      const won = `WON ${rmWhole(first.prizeMyr)}`;
      const wonSize = await sizeToFit([won], (s) => display(s), 34, 20, INFO_W);
      const blocks: [number, number, (m: number) => Promise<string>][] = [
        [
          capH(44),
          22,
          async (m) =>
            textEl('#1ST', infoX, baseline(m, 44), display(44), CHASE),
        ],
        [
          capH(30),
          18,
          async (m) =>
            textEl(
              await fit(imageSafeName(first.name), body(30), INFO_W),
              infoX,
              baseline(m, 30),
              body(30),
              WHITE,
            ),
        ],
        ...(first.pulledMyr !== null
          ? ([
              [
                capH(20),
                18,
                async (m: number) =>
                  textEl(
                    await fit(
                      `PULLED ${rmWhole(first.pulledMyr as number)}`,
                      body(20, 2),
                      INFO_W,
                    ),
                    infoX,
                    baseline(m, 20),
                    body(20, 2),
                    SILVER,
                  ),
              ],
            ] as [number, number, (m: number) => Promise<string>][])
          : []),
        [
          capH(wonSize),
          0,
          async (m) =>
            textEl(won, infoX, baseline(m, wonSize), display(wonSize), CHASE),
        ],
      ];
      if (extraCards(first)) {
        blocks[blocks.length - 1][1] = 16;
        blocks.push([
          capH(20),
          0,
          async (m) =>
            textEl(
              `+${extraCards(first)} MORE CARDS`,
              infoX,
              baseline(m, 20),
              body(20, 2),
              CHASE,
            ),
        ]);
      }
      const blockH = blocks.reduce((s, [bh, gap]) => s + bh + gap, 0);
      let ly = ry + (h - blockH) / 2;
      for (const [bh, gap, el] of blocks) {
        c.svg.push(await el(ly + bh / 2));
        ly += bh + gap;
      }
      const prizesTop = ry + (h - prizesH(first, w1)) / 2;
      await drawPrizes(
        c,
        first,
        art.get(1) ?? [],
        PAD + 32 + INFO_W + 24,
        ROW_ROOM,
        prizesTop,
        w1,
        16,
      );
      ry += h + 16;
    }

    // Second and third, side by side.
    const h2 = rowH2();
    for (const winner of others) {
      const px = PAD + (winner.rank === 2 ? 0 : HALF_W + 16);
      panels.push(
        `<rect x="${px + 1}" y="${ry + 1}" width="${HALF_W - 2}" height="${h2 - 2}" rx="28" ` +
          `fill="${CHARCOAL}" stroke="${HAIRLINE}" stroke-width="2"/>`,
      );
      const ix = px + HALF_PAD;
      // "#2ND  coco" on one line, then what they pulled and what they won.
      const rank = `#${winner.rank}${RANK_SUFFIX[winner.rank] ?? ''}`;
      const rankW = await measure(rank, display(36));
      const line1 = ry + HALF_PAD + capH(36) / 2;
      c.svg.push(
        textEl(
          rank,
          ix,
          baseline(line1, 36),
          display(36),
          RANK_TONE[winner.rank] ?? WHITE,
        ),
        textEl(
          await fit(
            imageSafeName(winner.name),
            body(28),
            HALF_ROOM - rankW - 16,
          ),
          ix + rankW + 16,
          baseline(line1, 28),
          body(28),
          WHITE,
        ),
      );
      const line2 = line1 + capH(36) / 2 + 22 + capH(24) / 2;
      const won = rmWhole(winner.prizeMyr);
      const wonFont = display(26);
      const wonW = await measure(won, wonFont);
      c.svg.push(
        textEl('WON', ix, baseline(line2, 20), body(20, 2), SILVER),
        textEl(won, ix + 62, baseline(line2, 26), wonFont, CHASE),
      );
      if (winner.pulledMyr !== null) {
        c.svg.push(
          textEl(
            await fit(
              `PULLED ${rmWhole(winner.pulledMyr)}`,
              body(18, 1),
              HALF_ROOM - 62 - wonW - 24,
            ),
            px + HALF_W - HALF_PAD,
            baseline(line2, 18),
            body(18, 1),
            SILVER,
            'end',
          ),
        );
      }
      if (extraCards(winner)) {
        c.svg.push(
          textEl(
            `+${extraCards(winner)} MORE CARDS`,
            ix,
            baseline(line2 + 34, 18),
            body(18, 2),
            CHASE,
          ),
        );
      }
      await drawPrizes(
        c,
        winner,
        art.get(winner.rank) ?? [],
        ix,
        HALF_ROOM,
        ry + HALF_PAD + infoH2 + 16,
        w2,
        12,
      );
    }
  } else {
    // ---- ranks 4-10 as a ledger ----------------------------------------------
    const rows = input.list.length;
    if (rows) {
      const headH = 64;
      const rowH = Math.min(
        104,
        Math.floor((bodyBottom - bodyTop - headH - 16) / rows),
      );
      const listH = headH + rows * rowH + 16;
      const listY = Math.round(bodyTop + (bodyBottom - bodyTop - listH) / 2);
      panels.push(
        `<rect x="${PAD + 1}" y="${listY + 1}" width="${TEXT_W - 2}" height="${listH - 2}" rx="32" ` +
          `fill="${CHARCOAL}" stroke="${HAIRLINE}" stroke-width="2"/>`,
      );
      const headY = listY + 40;
      const nameX = PAD + 140;
      const pulledX = PAD + 700;
      const wonX = W - PAD - 40;
      c.svg.push(
        textEl(
          'PULLED',
          pulledX,
          baseline(headY, 20),
          body(20, 3),
          SILVER,
          'end',
        ),
        textEl('WON', wonX, baseline(headY, 20), body(20, 3), SILVER, 'end'),
      );
      let ry = listY + headH;
      for (const [i, row] of input.list.entries()) {
        const cy = ry + rowH / 2;
        if (i > 0) {
          c.svg.push(
            `<line x1="${PAD + 32}" y1="${ry}" x2="${W - PAD - 32}" y2="${ry}" stroke="${HAIRLINE}" stroke-width="2"/>`,
          );
        }
        c.svg.push(
          textEl(
            `#${row.rank}`,
            PAD + 40,
            baseline(cy, 36),
            display(36),
            WHITE,
          ),
          textEl(
            await fit(imageSafeName(row.name), body(32), pulledX - 200 - nameX),
            nameX,
            baseline(cy, 32),
            body(32),
            WHITE,
          ),
          textEl(
            row.pulledMyr === null ? '–' : rmWhole(row.pulledMyr),
            pulledX,
            baseline(cy, 28),
            body(28),
            SILVER,
            'end',
          ),
          textEl(
            rmWhole(row.prizeMyr),
            wonX,
            baseline(cy, 34),
            display(34),
            CHASE,
            'end',
          ),
        );
        ry += rowH;
      }
    }
    c.svg.push(
      textEl(
        'CONGRATULATIONS TO THE TOP 10',
        mid,
        baseline(PILL_Y - 52, 26),
        body(26, 2),
        SILVER,
        'middle',
      ),
    );
  }

  // ---- the address ------------------------------------------------------------
  const pillFont = body(34);
  const pillW = Math.round((await measure(input.siteHost, pillFont)) + 104);
  c.svg.push(
    `<rect x="${(mid - pillW / 2).toFixed(1)}" y="${PILL_Y}" width="${pillW}" height="${PILL_H}" ` +
      `rx="${PILL_H / 2}" fill="${GRAPHITE}"/>`,
    textEl(
      input.siteHost,
      mid,
      baseline(PILL_Y + PILL_H / 2, 34),
      pillFont,
      WHITE,
      'middle',
    ),
  );

  const base = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<defs><radialGradient id="spot" cx="0.5" cy="0.5" r="0.5">` +
      `<stop offset="0" stop-color="${CHASE}" stop-opacity="0.22"/>` +
      `<stop offset="0.5" stop-color="${CHASE}" stop-opacity="0.07"/>` +
      `<stop offset="1" stop-color="${CHASE}" stop-opacity="0"/></radialGradient></defs>` +
      `<rect width="${W}" height="${H}" fill="${INK}"/>${panels.join('')}` +
      `<ellipse cx="${mid}" cy="${Math.round(spotY)}" rx="420" ry="300" fill="url(#spot)"/>` +
      `${c.svg.join('')}</svg>`,
  );
  const jpeg = await sharp(base)
    .composite(c.layers)
    .flatten({ background: INK })
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return { jpeg, placeholders: c.placeholders.sort((a, b) => a - b) };
}

/** Fetch each podium card's art, then compose one of the two images.
 *  `missing` names the ranks whose card could not be fetched or decoded. */
export async function renderResultsPoster(
  input: ResultsPosterInput,
  urls: Map<number, (string | null)[]>,
  part: ResultsPart = 'top',
): Promise<{ jpeg: Buffer; missing: number[] }> {
  const art = new Map<number, (Buffer | null)[]>();
  if (part === 'top') {
    // One fetch per picture: a card won twice is the same picture twice.
    const fetched = new Map<string, Promise<Buffer | null>>();
    const get = (url: string | null) => {
      if (!url) return Promise.resolve(null);
      if (!fetched.has(url))
        fetched.set(
          url,
          fetchBytes(url).catch(() => null),
        );
      return fetched.get(url)!;
    };
    await Promise.all(
      [...urls].map(async ([rank, list]) => {
        art.set(rank, await Promise.all(list.map(get)));
      }),
    );
  }
  const { jpeg, placeholders } = await composeResultsPoster(input, art, part);
  return { jpeg, missing: placeholders };
}
