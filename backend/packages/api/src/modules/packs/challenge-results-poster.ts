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
// chase gold for money), the top 3 on a podium with every prize card they won,
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

// The side steps' centre line (the centre step sits on the poster's).
const SIDE_CX = PAD + 40 + SIDE.w / 2;
// A hand shows at most this many cards; more get a "+N MORE" tab.
export const MAX_FAN = 5;
// A hand splays from one base like cards held in a hand: each card leans
// this many degrees further out than the one inside it, its foot this share
// of a card's width further along, so the tops (the slab label and the art)
// of the cards behind stay in view.
const FAN_TILT = 11;
const FAN_SPREAD = 0.12;

/** Where the i-th card of a hand sits: the front card in the middle (0),
 *  then right, left, right, left (1, -1, 2, -2). */
export const fanPosition = (i: number): number =>
  i === 0 ? 0 : i % 2 ? (i + 1) / 2 : -i / 2;

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
          baseline(h / 2, 20),
          body(20, 4),
          SILVER,
          'middle',
        ) +
        '</svg>',
    ),
  )
    .png()
    .toBuffer();

/** One winner's cards as composite layers: a single slab, or a hand splayed
 *  from one base under `cx`, its front (most valuable) card upright with its
 *  top at `top`, drawn last, the others a shade darker behind it. `bottom`
 *  is the lowest pixel drawn. */
async function cardFan(
  count: number,
  art: (Buffer | null)[],
  cx: number,
  top: number,
  cardW: number,
): Promise<{ layers: OverlayOptions[]; missing: boolean; bottom: number }> {
  const n = Math.min(count, MAX_FAN);
  const cardH = Math.round(cardW / SLAB);
  // The hand turns about the front card's foot.
  const base = top + cardH;
  // An even hand has no middle card: centre it on its positions' mean.
  const positions = Array.from({ length: n }, (_, i) => fanPosition(i));
  const mean = positions.reduce((a, b) => a + b, 0) / n;
  // Outermost first, so the cards further in overlap them.
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => Math.abs(positions[b]) - Math.abs(positions[a]) || b - a,
  );
  const layers: OverlayOptions[] = [];
  let missing = false;
  let bottom = base;
  for (const i of order) {
    const p = positions[i] - mean;
    let card = await cardPng(art[i] ?? null, cardW, cardH);
    if (!card) {
      missing = true;
      card = await placeholderPng(cardW, cardH);
    }
    let img = sharp(card);
    if (i > 0) img = img.modulate({ brightness: 0.8 });
    const tilt = p * FAN_TILT;
    if (tilt !== 0) {
      img = img.rotate(tilt, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    }
    const { data, info } = await img
      .png()
      .toBuffer({ resolveWithObject: true });
    // sharp turns about the centre; place that centre where a turn about the
    // card's own foot (on the hand's base line) would put it.
    const rad = (tilt * Math.PI) / 180;
    const footX = cx + p * cardW * FAN_SPREAD;
    const midX = footX + (cardH / 2) * Math.sin(rad);
    const midY = base - (cardH / 2) * Math.cos(rad);
    layers.push({
      input: data,
      left: Math.round(midX - info.width / 2),
      top: Math.round(midY - info.height / 2),
    });
    bottom = Math.max(bottom, Math.round(midY + info.height / 2));
  }
  return { layers, missing, bottom };
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

  // ---- the podium ----------------------------------------------------------
  // Every card a winner received is on show: one card as a single slab,
  // several fanned like a hand with the most valuable in front.
  const panelY = Math.round(y + headSize / 2 + 48);
  const steps = [
    { rank: 2, cx: SIDE_CX, top: panelY + 170, single: SIDE, fanW: 160 },
    { rank: 1, cx: mid, top: panelY + 110, single: CENTER, fanW: 190 },
    { rank: 3, cx: W - SIDE_CX, top: panelY + 170, single: SIDE, fanW: 160 },
  ];
  const placeholders: number[] = [];
  const podium: string[] = [];
  let panelBottom = panelY + 110 + CENTER.h;
  for (const step of steps) {
    const winner = input.podium.find((p) => p.rank === step.rank);
    if (!winner) continue; // a hidden winner leaves the step empty
    const { cx, top } = step;
    podium.push(
      textEl(
        `#${step.rank}${RANK_SUFFIX[step.rank]}`,
        cx,
        baseline(top - 34, 40),
        display(40),
        RANK_TONE[step.rank],
        'middle',
      ),
    );
    let bottom: number;
    if (!winner.cards.length) {
      // Credits only: the amount on a plain tile.
      const { w, h } = step.single;
      const x = cx - w / 2;
      const amount = rmWhole(winner.credits);
      const size = await sizeToFit([amount], (s) => display(s), 44, 24, w - 28);
      podium.push(
        `<rect x="${x + 1}" y="${top + 1}" width="${w - 2}" height="${h - 2}" rx="24" ` +
          `fill="${GRAPHITE}" stroke="${HAIRLINE}" stroke-width="2"/>`,
        textEl(
          amount,
          cx,
          baseline(top + h / 2 - 18, size),
          display(size),
          CHASE,
          'middle',
        ),
        textEl(
          'CREDITS',
          cx,
          baseline(top + h / 2 + 34, 24),
          body(24, 4),
          SILVER,
          'middle',
        ),
      );
      bottom = top + h;
    } else {
      const fan = await cardFan(
        winner.cards.length,
        art.get(step.rank) ?? [],
        cx,
        top,
        winner.cards.length === 1 ? step.single.w : step.fanW,
      );
      layers.push(...fan.layers);
      if (fan.missing) placeholders.push(step.rank);
      bottom = fan.bottom;
      const extra = winner.cards.length - MAX_FAN;
      if (extra > 0) {
        // More cards than a hand shows: a gold tab over its foot.
        const tag = `+${extra} MORE`;
        const tagFont = body(20, 2);
        const tagW = Math.round((await measure(tag, tagFont)) + 36);
        const tagH = 40;
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
          top: Math.round(bottom - tagH / 2 - 6),
        });
      }
    }
    let ny = bottom + 46;
    const nameFont = body(30);
    podium.push(
      textEl(
        await fit(imageSafeName(winner.name), nameFont, step.single.w + 40),
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
          await fit(pulled, body(20, 2), step.single.w + 40),
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
      step.single.w + 40,
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
