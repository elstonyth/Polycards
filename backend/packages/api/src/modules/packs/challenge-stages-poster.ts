import sharp, { type OverlayOptions } from 'sharp';
import { ensureBundledFonts } from '../../api/admin/media/label-font';
import { fetchBytes, MAX_DECODE_PIXELS } from '../../api/utils/image-fetch';
import { icon, POSTER_H } from './brand-poster';
import { rmWhole } from './challenge-results-poster';
import { sizeToFit } from './challenge-poster';
import { BRAND_LOGO_B64 } from './pull-card-assets';
import { baseline, body, display, fit, measure, textEl } from './pull-card';

// Every stage of one Weekly Challenge on one 1080x1350 poster (the 4:5 size
// Facebook and Instagram feeds show whole), for the Growth desk
// (GET /reports/growth/challenge-stages-poster and the Monday 9 a.m. drop):
// the challenge poster's language, then a grid of stage panels, each with its
// unlock threshold, its #1-#3 prizes as the official card art and a line for
// what ranks 4-10 win. Every word and figure comes from the live (or queued)
// challenge.
//
// Text is SVG rendered by sharp against the bundled fonts, so judge the look
// from a Linux render (the prod container), never a Windows one.

export type StagePrize = {
  rank: 1 | 2 | 3;
  name: string | null;
  credits: number;
};

export type StageBlock = {
  stage: number;
  thresholdMyr: number;
  unlocked: boolean;
  /** Ranks 1-3, in rank order; a rank the stage does not pay is left out. */
  podium: StagePrize[];
  /** What ranks 4 and below win; null = nothing. */
  rest: {
    from: number;
    to: number;
    minCredits: number;
    maxCredits: number;
    cards: number;
  } | null;
};

export type StagesPosterInput = {
  /** '5 OCT – 11 OCT' */
  weekLabel: string;
  /** e.g. '4 STAGES · EVERY REWARD STACKS' */
  headline: string;
  stages: StageBlock[];
  siteHost: string;
};

type Reward = { rank: number; cardId: string | null; credits: number };

/** One stage's panel, from its rank rewards and the prize cards' names. */
export function stageBlock(
  stage: { stageNumber: number; thresholdMyr: number; rankRewards: Reward[] },
  cards: Record<string, { name: string }>,
  unlocked: boolean,
): StageBlock {
  const prize = (r: Reward) =>
    r.cardId ? (cards[r.cardId]?.name ?? 'A prize card') : null;
  const podium = ([1, 2, 3] as const).flatMap((rank) => {
    const r = stage.rankRewards.find((x) => x.rank === rank);
    return r && (r.cardId || r.credits > 0)
      ? [{ rank, name: prize(r), credits: r.credits }]
      : [];
  });
  const below = stage.rankRewards.filter(
    (r) => r.rank > 3 && (r.cardId || r.credits > 0),
  );
  const credits = below.map((r) => r.credits).filter((c) => c > 0);
  return {
    stage: stage.stageNumber,
    thresholdMyr: stage.thresholdMyr,
    unlocked,
    podium,
    rest: below.length
      ? {
          from: Math.min(...below.map((r) => r.rank)),
          to: Math.max(...below.map((r) => r.rank)),
          minCredits: credits.length ? Math.min(...credits) : 0,
          maxCredits: credits.length ? Math.max(...credits) : 0,
          cards: below.filter((r) => r.cardId).length,
        }
      : null,
  };
}

/** '#4–#10 · RM 1,800 – RM 80 CREDITS', or what applies. */
export function restLine(rest: NonNullable<StageBlock['rest']>): string {
  const ranks =
    rest.from === rest.to ? `#${rest.from}` : `#${rest.from}–#${rest.to}`;
  const parts: string[] = [];
  if (rest.maxCredits > 0) {
    parts.push(
      rest.minCredits === rest.maxCredits
        ? `${rmWhole(rest.maxCredits)} CREDITS`
        : `${rmWhole(rest.maxCredits)} – ${rmWhole(rest.minCredits)} CREDITS`,
    );
  }
  if (rest.cards > 0)
    parts.push(`${rest.cards} CARD${rest.cards === 1 ? '' : 'S'}`);
  return `${ranks} · ${parts.join(' + ')}`;
}

/** The gold line under the title. */
export const stagesHeadline = (n: number): string =>
  n === 1 ? '1 STAGE OF PRIZES' : `${n} STAGES · EVERY REWARD STACKS`;

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

const W = 1080;
const PAD = 64;
const TEXT_W = W - 2 * PAD;
const LOGO_H = 50;
const LOGO_W = Math.round((LOGO_H * 360) / 97); // polycards-logo.png is 360x97
const GAP = 24;
const BLOCK_W = (TEXT_W - GAP) / 2;
const INNER = 28;
const SLAB = 1600 / 2590;
const CARD_GAP = 12;
// The widest a prize card is drawn; shorter grids (more rows) draw it smaller.
const CARD_W_MAX = Math.floor((BLOCK_W - 2 * INNER - 2 * CARD_GAP) / 3);
// A panel around its cards: the stage header, the rank tags, the line for
// ranks 4-10.
const BLOCK_CHROME = 84 + 40 + 64;
// 1080x1350, the 4:5 size Facebook and Instagram feeds show whole.
const H = POSTER_H;
const PILL_H = 84;
const PILL_Y = H - 56 - PILL_H;

// Lucide `check` and `lock`.
const ICON_CHECK = '<polyline points="20 6 9 17 4 12"/>';
const ICON_LOCK =
  '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>';

const decode = (bytes: Buffer) =>
  sharp(bytes, { limitInputPixels: MAX_DECODE_PIXELS });

export const artKey = (stage: number, rank: number) => `${stage}:${rank}`;

/**
 * Compose the poster. `art` maps artKey(stage, rank) to the prize card's
 * bytes (null or missing = a placeholder tile, never a failed poster).
 * `placeholders` lists the keys whose card is not shown as its art.
 */
export async function composeStagesPoster(
  input: StagesPosterInput,
  art: Map<string, Buffer | null>,
): Promise<{ jpeg: Buffer; placeholders: string[] }> {
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
  const title = 'WEEKLY PULLED VALUE CHALLENGE';
  const titleSize = await sizeToFit([title], (s) => display(s), 64, 36, TEXT_W);
  let y = PAD + LOGO_H + 44 + titleSize / 2;
  svg.push(
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

  // ---- the stage grid --------------------------------------------------------
  const gridTop = Math.round(y + headSize / 2 + 36);
  const gridBottom = PILL_Y - 95;
  const placeholders: string[] = [];
  const panels: string[] = [];
  const rows = Math.ceil(input.stages.length / 2);
  const BLOCK_H = Math.floor(
    (gridBottom - gridTop - (rows - 1) * GAP) / Math.max(1, rows),
  );
  const CARD_W = Math.max(
    40,
    Math.min(CARD_W_MAX, Math.floor((BLOCK_H - BLOCK_CHROME) * SLAB)),
  );
  const CARD_H = Math.round(CARD_W / SLAB);
  // Cards narrower than the panel stay centred in it.
  const cardsInset = (BLOCK_W - (3 * CARD_W + 2 * CARD_GAP)) / 2;
  for (const [i, block] of input.stages.entries()) {
    const row = Math.floor(i / 2);
    const alone = i === input.stages.length - 1 && i % 2 === 0;
    const bx = alone ? mid - BLOCK_W / 2 : PAD + (i % 2) * (BLOCK_W + GAP);
    const by = gridTop + row * (BLOCK_H + GAP);
    panels.push(
      `<rect x="${(bx + 1).toFixed(1)}" y="${by + 1}" width="${(BLOCK_W - 2).toFixed(1)}" height="${BLOCK_H - 2}" rx="32" ` +
        `fill="${CHARCOAL}" stroke="${block.unlocked ? CHASE : HAIRLINE}" stroke-width="2"/>`,
    );
    // Header: the stage on the left, its threshold as a chip on the right.
    const hy = by + 48;
    svg.push(
      textEl(
        `STAGE ${block.stage}`,
        bx + INNER,
        baseline(hy, 36),
        display(36),
        WHITE,
      ),
    );
    const amount = rmWhole(block.thresholdMyr);
    const chipFont = display(22, 1);
    const chipH = 44;
    const chipW = Math.round((await measure(amount, chipFont)) + 26 + 10 + 32);
    const chipX = bx + BLOCK_W - INNER - chipW;
    svg.push(
      `<rect x="${chipX.toFixed(1)}" y="${hy - chipH / 2}" width="${chipW}" height="${chipH}" rx="${chipH / 2}" ` +
        `fill="${block.unlocked ? CHASE : GRAPHITE}"/>`,
      icon(
        block.unlocked ? ICON_CHECK : ICON_LOCK,
        chipX + 16,
        hy,
        22,
        block.unlocked ? INK : SILVER,
      ),
      textEl(
        amount,
        chipX + 16 + 26 + 6,
        baseline(hy, 22),
        chipFont,
        block.unlocked ? INK : WHITE,
      ),
    );
    // The #1-#3 prizes.
    const cardsTop = by + 84 + 40;
    for (const rank of [1, 2, 3] as const) {
      const cx0 = bx + cardsInset + (rank - 1) * (CARD_W + CARD_GAP);
      const cx = cx0 + CARD_W / 2;
      svg.push(
        textEl(
          `#${rank}`,
          cx,
          baseline(cardsTop - 22, 26),
          display(26),
          RANK_TONE[rank],
          'middle',
        ),
      );
      const prize = block.podium.find((p) => p.rank === rank);
      const bytes = art.get(artKey(block.stage, rank)) ?? null;
      let drawn = false;
      if (prize?.name && bytes) {
        try {
          layers.push({
            input: await decode(bytes)
              .resize(CARD_W, CARD_H, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 },
              })
              .png()
              .toBuffer(),
            left: Math.round(cx0),
            top: Math.round(cardsTop),
          });
          drawn = true;
        } catch {
          // Undecodable art costs this tile its picture, never the poster.
        }
      }
      if (drawn) continue;
      svg.push(
        `<rect x="${(cx0 + 1).toFixed(1)}" y="${cardsTop + 1}" width="${CARD_W - 2}" height="${CARD_H - 2}" rx="16" ` +
          `fill="${GRAPHITE}" stroke="${HAIRLINE}" stroke-width="2"/>`,
      );
      const midY = cardsTop + CARD_H / 2;
      if (prize?.name) {
        placeholders.push(artKey(block.stage, rank));
        svg.push(
          textEl(
            'PRIZE',
            cx,
            baseline(midY, 18),
            body(18, 3),
            SILVER,
            'middle',
          ),
        );
      } else if (prize && prize.credits > 0) {
        const text = rmWhole(prize.credits);
        const size = await sizeToFit(
          [text],
          (s) => display(s),
          30,
          14,
          CARD_W - 16,
        );
        svg.push(
          textEl(
            text,
            cx,
            baseline(midY - 12, size),
            display(size),
            CHASE,
            'middle',
          ),
          textEl(
            'CREDITS',
            cx,
            baseline(midY + 22, 16),
            body(16, 3),
            SILVER,
            'middle',
          ),
        );
      } else {
        svg.push(
          textEl('–', cx, baseline(midY, 30), body(30), SILVER, 'middle'),
        );
      }
    }
    // Ranks 4 and below.
    if (block.rest) {
      const ly = cardsTop + CARD_H + 36;
      const line = await fit(
        restLine(block.rest),
        body(20, 1),
        BLOCK_W - 2 * INNER,
      );
      svg.push(
        textEl(
          line,
          bx + BLOCK_W / 2,
          baseline(ly, 20),
          body(20, 1),
          SILVER,
          'middle',
        ),
      );
    }
  }
  // ---- the rule and the address ----------------------------------------------
  const rule = await fit(
    "REWARDS STACK · THE WEEK'S TOP 10 CLAIM THEM ALL",
    body(26, 2),
    TEXT_W,
  );
  svg.push(
    textEl(rule, mid, baseline(PILL_Y - 46, 26), body(26, 2), SILVER, 'middle'),
  );
  const pillFont = body(34);
  const pillW = Math.round((await measure(input.siteHost, pillFont)) + 104);
  svg.push(
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
      `<defs><radialGradient id="wash" cx="0.5" cy="0.5" r="0.5">` +
      `<stop offset="0" stop-color="${CHASE}" stop-opacity="0.12"/>` +
      `<stop offset="1" stop-color="${CHASE}" stop-opacity="0"/></radialGradient></defs>` +
      `<rect width="${W}" height="${H}" fill="${INK}"/>` +
      `<ellipse cx="${mid}" cy="${gridTop + (rows * BLOCK_H) / 2}" rx="${W * 0.6}" ry="${rows * BLOCK_H * 0.6}" fill="url(#wash)"/>` +
      `${panels.join('')}${svg.join('')}</svg>`,
  );
  const jpeg = await sharp(base)
    .composite(layers)
    .flatten({ background: INK })
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return { jpeg, placeholders };
}

/** Fetch each prize card's art, then compose. `missing` names the
 *  'stage:rank' keys whose card could not be fetched or decoded. */
export async function renderStagesPoster(
  input: StagesPosterInput,
  urls: Map<string, string | null>,
): Promise<{ jpeg: Buffer; missing: string[] }> {
  const art = new Map<string, Buffer | null>();
  await Promise.all(
    [...urls].map(async ([key, url]) => {
      art.set(key, url ? await fetchBytes(url).catch(() => null) : null);
    }),
  );
  const { jpeg, placeholders } = await composeStagesPoster(input, art);
  return { jpeg, missing: placeholders };
}
