import sharp, { type OverlayOptions } from 'sharp';
import { ensureBundledFonts } from '../../api/admin/media/label-font';
import { fetchBytes, MAX_DECODE_PIXELS } from '../../api/utils/image-fetch';
import { sizeToFit } from './challenge-poster';
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
// chase gold for money), the top 3 on a podium with their best prize card,
// what they pulled and what they won, then ranks 4-10 as a ledger. Every
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
  /** The most valuable card won; null = credits only. */
  card: string | null;
  /** Cards won besides the one shown (counting each pull minted). */
  moreCards: number;
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
const CENTER = { w: 280, h: Math.round(280 / SLAB) };
const SIDE = { w: 220, h: Math.round(220 / SLAB) };
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

/**
 * Compose the poster. `art` maps a podium rank to its prize card's bytes
 * (null or missing = a placeholder tile, never a failed poster).
 * `placeholders` lists the ranks whose card is not shown as its art.
 */
export async function composeResultsPoster(
  input: ResultsPosterInput,
  art: Map<number, Buffer | null>,
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

  // ---- the podium ----------------------------------------------------------
  const panelY = Math.round(y + headSize / 2 + 48);
  const slots = [
    { rank: 2, x: PAD + 40, top: panelY + 170, ...SIDE },
    { rank: 1, x: mid - CENTER.w / 2, top: panelY + 110, ...CENTER },
    { rank: 3, x: W - PAD - 40 - SIDE.w, top: panelY + 170, ...SIDE },
  ];
  const placeholders: number[] = [];
  const podium: string[] = [];
  let panelBottom = panelY + 110 + CENTER.h;
  for (const slot of slots) {
    const winner = input.podium.find((p) => p.rank === slot.rank);
    if (!winner) continue; // a hidden winner leaves the step empty
    const cx = slot.x + slot.w / 2;
    podium.push(
      textEl(
        `#${slot.rank}${RANK_SUFFIX[slot.rank]}`,
        cx,
        baseline(slot.top - 34, 40),
        display(40),
        RANK_TONE[slot.rank],
        'middle',
      ),
    );
    const bytes = art.get(slot.rank) ?? null;
    let drawn = false;
    if (bytes && winner.card) {
      try {
        layers.push({
          input: await decode(bytes)
            .resize(slot.w, slot.h, {
              fit: 'contain',
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .png()
            .toBuffer(),
          left: Math.round(slot.x),
          top: Math.round(slot.top),
        });
        drawn = true;
      } catch {
        // Undecodable art costs this tile its picture, never the poster.
      }
    }
    if (!drawn) {
      podium.push(
        `<rect x="${slot.x + 1}" y="${slot.top + 1}" width="${slot.w - 2}" height="${slot.h - 2}" rx="24" ` +
          `fill="${GRAPHITE}" stroke="${HAIRLINE}" stroke-width="2"/>`,
      );
      if (winner.card) {
        placeholders.push(slot.rank);
        podium.push(
          textEl(
            'PRIZE CARD',
            cx,
            baseline(slot.top + slot.h / 2, 24),
            body(24, 4),
            SILVER,
            'middle',
          ),
        );
      } else {
        const amount = rmWhole(winner.credits);
        const size = await sizeToFit(
          [amount],
          (s) => display(s),
          44,
          24,
          slot.w - 28,
        );
        podium.push(
          textEl(
            amount,
            cx,
            baseline(slot.top + slot.h / 2 - 18, size),
            display(size),
            CHASE,
            'middle',
          ),
          textEl(
            'CREDITS',
            cx,
            baseline(slot.top + slot.h / 2 + 34, 24),
            body(24, 4),
            SILVER,
            'middle',
          ),
        );
      }
    }
    if (winner.moreCards > 0) {
      // "+1 MORE CARD" as a gold tab over the slab's foot.
      const tag = `+${winner.moreCards} MORE CARD${winner.moreCards === 1 ? '' : 'S'}`;
      const tagFont = body(20, 2);
      const tagW = Math.round((await measure(tag, tagFont)) + 36);
      const tagH = 40;
      // Its own layer, composited after the art: drawn in the base SVG, the
      // slab would cover it.
      layers.push({
        input: await sharp(
          Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${tagW}" height="${tagH}">` +
              `<rect width="${tagW}" height="${tagH}" rx="${tagH / 2}" fill="${CHASE}"/>` +
              textEl(
                tag,
                tagW / 2,
                baseline(tagH / 2, 20),
                tagFont,
                INK,
                'middle',
              ) +
              '</svg>',
          ),
        )
          .png()
          .toBuffer(),
        left: Math.round(cx - tagW / 2),
        top: Math.round(slot.top + slot.h - tagH / 2 - 6),
      });
    }
    let ny = slot.top + slot.h + 46;
    const nameFont = body(30);
    podium.push(
      textEl(
        await fit(imageSafeName(winner.name), nameFont, slot.w + 40),
        cx,
        baseline(ny, 30),
        nameFont,
        WHITE,
        'middle',
      ),
    );
    if (winner.pulledMyr !== null) {
      ny += 40;
      const pulled = `PULLED ${rmWhole(winner.pulledMyr)}`;
      podium.push(
        textEl(
          await fit(pulled, body(20, 2), slot.w + 40),
          cx,
          baseline(ny, 20),
          body(20, 2),
          SILVER,
          'middle',
        ),
      );
    }
    ny += 44;
    const won = `WON ${rmWhole(winner.prizeMyr)}`;
    const wonSize = await sizeToFit(
      [won],
      (s) => display(s),
      32,
      22,
      slot.w + 40,
    );
    podium.push(
      textEl(won, cx, baseline(ny, wonSize), display(wonSize), CHASE, 'middle'),
    );
    panelBottom = Math.max(panelBottom, ny + 36);
  }
  const panelH = panelBottom - panelY;
  const panels = [
    `<rect x="${PAD + 1}" y="${panelY + 1}" width="${TEXT_W - 2}" height="${panelH - 2}" rx="40" ` +
      `fill="${CHARCOAL}" stroke="${HAIRLINE}" stroke-width="2"/>`,
  ];
  svg.push(...podium);
  y = panelY + panelH;

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
  const spotY = panelY + 110 + CENTER.h / 2;
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
  urls: Map<number, string | null>,
): Promise<{ jpeg: Buffer; missing: number[] }> {
  const art = new Map<number, Buffer | null>();
  await Promise.all(
    [...urls].map(async ([rank, url]) => {
      art.set(rank, url ? await fetchBytes(url).catch(() => null) : null);
    }),
  );
  const { jpeg, placeholders } = await composeResultsPoster(input, art);
  return { jpeg, missing: placeholders };
}
