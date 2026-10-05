import sharp, { type OverlayOptions } from 'sharp';
import { ensureBundledFonts } from '../../api/admin/media/label-font';
import { fetchBytes, MAX_DECODE_PIXELS } from '../../api/utils/image-fetch';
import { capH } from './brand-poster';
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

// Last week's Weekly Challenge result as a posting poster for the Growth desk
// (GET /reports/growth/challenge-results-poster and the Monday 9 a.m. drop):
// the challenge poster's language (ink stage, charcoal panels, Nekst claims,
// chase gold for money), the top 3 one row each with every prize card they
// won side by side, what they pulled and what they won, then ranks 4-10 as a
// ledger. Every
// figure comes from settlement's own rows; nothing is typed in.
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

const W = 1080;
const PAD = 64;
const TEXT_W = W - 2 * PAD;
const LOGO_H = 50;
const LOGO_W = Math.round((LOGO_H * 360) / 97); // polycards-logo.png is 360x97
const SLAB = 1600 / 2590;
const ROW_H = 78;

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

const decode = (bytes: Buffer) =>
  sharp(bytes, { limitInputPixels: MAX_DECODE_PIXELS });

// A winner's row shows at most this many cards; more are counted under
// what they won ("+2 MORE CARDS").
export const MAX_ROW_CARDS = 5;
// The left of a row: rank, name, what they pulled and won.
const INFO_W = 280;
const CARD_GAP = 16;
const ROW_PAD = 28;
// The tallest the left block gets, so a row never cuts it.
const INFO_H = 220;

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
        `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="20" fill="${GRAPHITE}" stroke="${HAIRLINE}" stroke-width="2"/>` +
        textEl(
          'PRIZE CARD',
          w / 2,
          baseline(h / 2, 18),
          body(18, 3),
          SILVER,
          'middle',
        ) +
        '</svg>',
    ),
  )
    .png()
    .toBuffer();

/** How wide each of a row's `n` cards is drawn: as big as the room allows,
 *  up to 170 px for the winner and 150 px for second and third. */
export function rowCardWidth(n: number, rank: number, room: number): number {
  if (n <= 0) return 0;
  return Math.min(
    rank === 1 ? 170 : 150,
    Math.floor((room - (n - 1) * CARD_GAP) / n),
  );
}

/**
 * Compose the poster. `art` maps a podium rank to its cards' bytes, in the
 * order of its `cards` (null or missing = a placeholder tile, never a failed
 * poster). `placeholders` lists the ranks with a card not shown as its art.
 */
export async function composeResultsPoster(
  input: ResultsPosterInput,
  art: Map<number, (Buffer | null)[]>,
): Promise<{ jpeg: Buffer; placeholders: number[] }> {
  ensureBundledFonts(); // before the first text render in this process
  const mid = W / 2;
  const layers: OverlayOptions[] = [
    {
      input: await sharp(Buffer.from(BRAND_LOGO_B64, 'base64'))
        .resize(LOGO_W, LOGO_H)
        .toBuffer(),
      left: PAD,
      top: PAD,
    },
  ];
  const svg: string[] = [
    textEl(
      input.weekLabel,
      W - PAD,
      baseline(PAD + LOGO_H / 2, 28),
      body(28, 3),
      SILVER,
      'end',
    ),
  ];

  // ---- title and the gold line ---------------------------------------------
  const title = ['WEEKLY CHALLENGE', 'RESULTS'];
  const titleSize = await sizeToFit(title, (s) => display(s), 96, 56, TEXT_W);
  let y = PAD + LOGO_H + 52 + titleSize / 2;
  for (const line of title) {
    svg.push(
      textEl(
        line,
        mid,
        baseline(y, titleSize),
        display(titleSize),
        WHITE,
        'middle',
      ),
    );
    y += Math.round(titleSize * 1.04);
  }
  const headline = input.headline.toUpperCase();
  const headSize = await sizeToFit(
    [headline],
    (s) => display(s),
    56,
    30,
    TEXT_W,
  );
  y += 8;
  svg.push(
    textEl(
      headline,
      mid,
      baseline(y, headSize),
      display(headSize),
      CHASE,
      'middle',
    ),
  );

  // ---- the top 3: one row each, every card they won side by side -----------
  // Who on the left (rank, name, what they pulled and what they won); on the
  // right each card they received, once per pull minted, upright and whole
  // with its name under it, the most valuable first.
  y = Math.round(y + headSize / 2 + 48);
  const placeholders: number[] = [];
  const panels: string[] = [];
  let spotY = y + INFO_H / 2;
  const cardsX = PAD + 32 + INFO_W + 24;
  const cardsW = W - PAD - 32 - cardsX;
  for (const winner of [...input.podium].sort((a, b) => a.rank - b.rank)) {
    const first = winner.rank === 1;
    const n = Math.min(winner.cards.length, MAX_ROW_CARDS);
    const cardW = rowCardWidth(n, winner.rank, cardsW);
    const cardH = Math.round(cardW / SLAB);
    // The cards and up to two lines of names; or the credits tile.
    const contentH = n ? cardH + 14 + 50 : 180;
    const rowH = Math.max(contentH, INFO_H) + 2 * ROW_PAD;
    const rowY = y;
    panels.push(
      `<rect x="${PAD + 1}" y="${rowY + 1}" width="${TEXT_W - 2}" height="${rowH - 2}" rx="32" ` +
        `fill="${CHARCOAL}" stroke="${first ? CHASE : HAIRLINE}" stroke-width="2"/>`,
    );
    if (first) spotY = rowY + rowH / 2;

    // Who: the rank, the name, what they pulled, what they won.
    const infoX = PAD + 40;
    const nameFont = body(32);
    const won = `WON ${rmWhole(winner.prizeMyr)}`;
    const wonSize = await sizeToFit([won], (s) => display(s), 36, 22, INFO_W);
    const extra = winner.cards.length - n;
    const lines: {
      h: number;
      gap: number;
      el: (mid: number) => Promise<string>;
    }[] = [
      {
        h: capH(48),
        gap: 24,
        el: async (m) =>
          textEl(
            `#${winner.rank}${RANK_SUFFIX[winner.rank] ?? ''}`,
            infoX,
            baseline(m, 48),
            display(48),
            RANK_TONE[winner.rank] ?? WHITE,
          ),
      },
      {
        h: capH(32),
        gap: 20,
        el: async (m) =>
          textEl(
            await fit(imageSafeName(winner.name), nameFont, INFO_W),
            infoX,
            baseline(m, 32),
            nameFont,
            WHITE,
          ),
      },
      ...(winner.pulledMyr !== null
        ? [
            {
              h: capH(20),
              gap: 20,
              el: async (m: number) =>
                textEl(
                  await fit(
                    `PULLED ${rmWhole(winner.pulledMyr as number)}`,
                    body(20, 2),
                    INFO_W,
                  ),
                  infoX,
                  baseline(m, 20),
                  body(20, 2),
                  SILVER,
                ),
            },
          ]
        : []),
      {
        h: capH(wonSize),
        gap: extra > 0 ? 18 : 0,
        el: async (m) =>
          textEl(won, infoX, baseline(m, wonSize), display(wonSize), CHASE),
      },
      ...(extra > 0
        ? [
            {
              h: capH(20),
              gap: 0,
              el: async (m: number) =>
                textEl(
                  `+${extra} MORE CARD${extra === 1 ? '' : 'S'}`,
                  infoX,
                  baseline(m, 20),
                  body(20, 2),
                  CHASE,
                ),
            },
          ]
        : []),
    ];
    const blockH = lines.reduce((sum, l) => sum + l.h + l.gap, 0);
    let ly = rowY + (rowH - blockH) / 2;
    for (const line of lines) {
      svg.push(await line.el(ly + line.h / 2));
      ly += line.h + line.gap;
    }

    // What: every card, side by side, its name under it.
    const top = rowY + ROW_PAD;
    if (n) {
      const total = n * cardW + (n - 1) * CARD_GAP;
      const x0 = cardsX + (cardsW - total) / 2;
      const pics = art.get(winner.rank) ?? [];
      for (let i = 0; i < n; i++) {
        const x = Math.round(x0 + i * (cardW + CARD_GAP));
        let card = await cardPng(pics[i] ?? null, cardW, cardH);
        if (!card) {
          if (!placeholders.includes(winner.rank))
            placeholders.push(winner.rank);
          card = await placeholderPng(cardW, cardH);
        }
        layers.push({ input: card, left: x, top });
        let ny = top + cardH + 14 + capH(18) / 2;
        for (const line of await twoLines(
          winner.cards[i],
          body(18),
          cardW + CARD_GAP - 4,
        )) {
          svg.push(
            textEl(
              line,
              x + cardW / 2,
              baseline(ny, 18),
              body(18),
              SOFT,
              'middle',
            ),
          );
          ny += 24;
        }
      }
    } else {
      // Credits only: the amount on a plain tile.
      const tileW = 300;
      const tileX = cardsX + (cardsW - tileW) / 2;
      const tileY = rowY + (rowH - 180) / 2;
      const amount = rmWhole(winner.credits);
      const size = await sizeToFit(
        [amount],
        (s) => display(s),
        48,
        24,
        tileW - 40,
      );
      svg.push(
        `<rect x="${tileX.toFixed(1)}" y="${tileY}" width="${tileW}" height="180" rx="24" ` +
          `fill="${GRAPHITE}" stroke="${HAIRLINE}" stroke-width="2"/>`,
        textEl(
          amount,
          tileX + tileW / 2,
          baseline(tileY + 72, size),
          display(size),
          CHASE,
          'middle',
        ),
        textEl(
          'CREDITS',
          tileX + tileW / 2,
          baseline(tileY + 126, 22),
          body(22, 4),
          SILVER,
          'middle',
        ),
      );
    }
    y = rowY + rowH + 20;
  }
  y -= 20;

  // ---- ranks 4-10 as a ledger ------------------------------------------------
  if (input.list.length) {
    const listY = y + 32;
    const headY = listY + 44;
    const nameX = PAD + 132;
    const pulledX = PAD + 700;
    const wonX = W - PAD - 40;
    svg.push(
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
    let ry = headY + 30;
    for (const [i, row] of input.list.entries()) {
      const cy = ry + ROW_H / 2;
      if (i > 0) {
        svg.push(
          `<line x1="${PAD + 32}" y1="${ry}" x2="${W - PAD - 32}" y2="${ry}" stroke="${HAIRLINE}" stroke-width="2"/>`,
        );
      }
      svg.push(
        textEl(`#${row.rank}`, PAD + 40, baseline(cy, 32), display(32), WHITE),
        textEl(
          await fit(imageSafeName(row.name), body(30), pulledX - 200 - nameX),
          nameX,
          baseline(cy, 30),
          body(30),
          WHITE,
        ),
        textEl(
          row.pulledMyr === null ? '–' : rmWhole(row.pulledMyr),
          pulledX,
          baseline(cy, 26),
          body(26),
          SILVER,
          'end',
        ),
        textEl(
          rmWhole(row.prizeMyr),
          wonX,
          baseline(cy, 30),
          display(30),
          CHASE,
          'end',
        ),
      );
      ry += ROW_H;
    }
    const listH = ry + 16 - listY;
    panels.push(
      `<rect x="${PAD + 1}" y="${listY + 1}" width="${TEXT_W - 2}" height="${listH - 2}" rx="32" ` +
        `fill="${CHARCOAL}" stroke="${HAIRLINE}" stroke-width="2"/>`,
    );
    y = listY + listH;
  }

  // ---- the thanks and the address --------------------------------------------
  y += 70;
  svg.push(
    textEl(
      'CONGRATULATIONS TO THE TOP 10',
      mid,
      baseline(y, 26),
      body(26, 2),
      SILVER,
      'middle',
    ),
  );
  const pillH = 84;
  const pillY = y + 50;
  const pillFont = body(34);
  const pillW = Math.round((await measure(input.siteHost, pillFont)) + 104);
  svg.push(
    `<rect x="${(mid - pillW / 2).toFixed(1)}" y="${pillY}" width="${pillW}" height="${pillH}" ` +
      `rx="${pillH / 2}" fill="${GRAPHITE}"/>`,
    textEl(
      input.siteHost,
      mid,
      baseline(pillY + pillH / 2, 34),
      pillFont,
      WHITE,
      'middle',
    ),
  );

  const H = Math.round(pillY + pillH + PAD);
  const base = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<defs><radialGradient id="spot" cx="0.5" cy="0.5" r="0.5">` +
      `<stop offset="0" stop-color="${CHASE}" stop-opacity="0.26"/>` +
      `<stop offset="0.5" stop-color="${CHASE}" stop-opacity="0.08"/>` +
      `<stop offset="1" stop-color="${CHASE}" stop-opacity="0"/></radialGradient></defs>` +
      `<rect width="${W}" height="${H}" fill="${INK}"/>${panels.join('')}` +
      `<ellipse cx="${mid}" cy="${spotY}" rx="400" ry="360" fill="url(#spot)"/>` +
      `${svg.join('')}</svg>`,
  );
  const jpeg = await sharp(base)
    .composite(layers)
    .flatten({ background: INK })
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return { jpeg, placeholders: placeholders.sort((a, b) => a - b) };
}

/** Fetch each podium card's art, then compose. `missing` names the ranks
 *  whose card could not be fetched or decoded. */
export async function renderResultsPoster(
  input: ResultsPosterInput,
  urls: Map<number, (string | null)[]>,
): Promise<{ jpeg: Buffer; missing: number[] }> {
  // One fetch per picture: a card won twice is the same picture twice.
  const fetched = new Map<string, Promise<Buffer | null>>();
  const get = (url: string | null) => {
    if (!url) return Promise.resolve(null);
    if (!fetched.has(url)) {
      fetched.set(
        url,
        fetchBytes(url).catch(() => null),
      );
    }
    return fetched.get(url)!;
  };
  const art = new Map<number, (Buffer | null)[]>();
  await Promise.all(
    [...urls].map(async ([rank, list]) => {
      art.set(rank, await Promise.all(list.map(get)));
    }),
  );
  const { jpeg, placeholders } = await composeResultsPoster(input, art);
  return { jpeg, missing: placeholders };
}
