import sharp, { type OverlayOptions } from 'sharp';
import { ensureBundledFonts } from '../../api/admin/media/label-font';
import { fetchBytes, MAX_DECODE_PIXELS } from '../../api/utils/image-fetch';
import { BRAND_LOGO_B64 } from './pull-card-assets';
import {
  baseline,
  body,
  display,
  fit,
  imageSafeName,
  measure,
  textEl,
  type Font,
} from './pull-card';

// The Weekly Pulled Value Challenge poster the Growth desk bot posts as a
// draft (GET /reports/growth/challenge-poster). Same language as the Telegram
// pull card (DESIGN.md "The Midnight Rip", pull-card.ts): ink stage, one
// charcoal panel, Nekst for the claim, Geist for the ledger, and the
// challenge's own chase gold (--color-chase) as the only colour. The prize
// art is the official image the site shows, fetched as bytes: never an AI
// redraw, which is the whole point of the poster.
//
// Text is SVG rendered by sharp against the bundled fonts, so judge the look
// from a Linux render (the prod container), never a Windows one.

export type ChallengePosterInput = {
  /** e.g. 'ALL 3 STAGES UNLOCKED'. */
  headline: string;
  /** The challenge week in Malaysia time, e.g. '29 SEPT – 5 OCT'. */
  weekLabel: string;
  stages: { stage: number; unlocked: boolean }[];
  featureStage: number;
  /** Ranks 1-3 of the featured stage: a card name, or credits only. */
  podium: { rank: 1 | 2 | 3; name: string | null; credits: number }[];
  /** Empty = no leaders block. */
  leaders: { rank: number; name: string }[];
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
// The prize grid's medal numerals (storefront StageCarousel RANKS).
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

// Podium tiles keep the graded slab's own aspect (1600x2590).
const SLAB = 1600 / 2590;
const CENTER = { w: 312, h: Math.round(312 / SLAB) };
const SIDE = { w: 244, h: Math.round(244 / SLAB) };

// Lucide `check` and `lock` (24-unit viewBox).
const ICON_CHECK = '<polyline points="20 6 9 17 4 12"/>';
const ICON_LOCK =
  '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>';
const icon = (
  paths: string,
  x: number,
  midY: number,
  size: number,
  stroke: string,
): string =>
  `<g transform="translate(${x.toFixed(1)} ${(midY - size / 2).toFixed(1)}) scale(${size / 24})" ` +
  `fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`;

const credits = (n: number): string =>
  `RM ${n.toLocaleString('en-MY', { maximumFractionDigits: 2 })}`;

/** The largest size from `from` down to `floor` at which every line fits. */
async function sizeToFit(
  lines: string[],
  font: (size: number) => Font,
  from: number,
  floor: number,
  max: number,
): Promise<number> {
  for (let size = from; size > floor; size -= 4) {
    const widths = await Promise.all(lines.map((l) => measure(l, font(size))));
    if (Math.max(...widths) <= max) return size;
  }
  return floor;
}

/** A name as at most two balanced lines that fit `max`, the second one
 *  ellipsized if it must be. */
async function twoLines(
  text: string,
  font: Font,
  max: number,
): Promise<string[]> {
  if ((await measure(text, font)) <= max) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  let best: { lines: string[]; w: number } | null = null;
  for (let i = 1; i < words.length; i++) {
    const lines = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
    const w = Math.max(
      ...(await Promise.all(lines.map((l) => measure(l, font)))),
    );
    if (w <= max && (!best || w < best.w)) best = { lines, w };
  }
  if (best) return best.lines;
  const cut = Math.max(1, Math.ceil(words.length / 2));
  return [
    await fit(words.slice(0, cut).join(' '), font, max),
    await fit(words.slice(cut).join(' '), font, max),
  ].filter(Boolean);
}

const decode = (bytes: Buffer) =>
  sharp(bytes, { limitInputPixels: MAX_DECODE_PIXELS });

/**
 * Compose the poster. `art` maps a podium rank to its prize image bytes
 * (null or missing = a labelled placeholder tile, never a failed poster).
 */
export async function composeChallengePoster(
  input: ChallengePosterInput,
  art: Map<number, Buffer | null>,
): Promise<Buffer> {
  ensureBundledFonts(); // before the first text render in this process
  const mid = W / 2;
  const layers: OverlayOptions[] = [];
  const svg: string[] = [];

  // ---- brand mark and the week ------------------------------------------
  layers.push({
    input: await sharp(Buffer.from(BRAND_LOGO_B64, 'base64'))
      .resize(LOGO_W, LOGO_H)
      .toBuffer(),
    left: PAD,
    top: PAD,
  });
  svg.push(
    textEl(
      input.weekLabel,
      W - PAD,
      baseline(PAD + LOGO_H / 2, 28),
      body(28, 3),
      SILVER,
      'end',
    ),
  );

  // ---- title and the unlock headline --------------------------------------
  const title = ['WEEKLY PULLED VALUE', 'CHALLENGE'];
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
    68,
    40,
    TEXT_W,
  );
  y += 12;
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

  // ---- stage chips: gold when unlocked, graphite with a lock when not -----
  y += headSize / 2 + 70;
  const chipH = 64;
  const chipSize = 28;
  const chips = await Promise.all(
    input.stages.map(async (s) => {
      const text = `STAGE ${s.stage}`;
      const w = Math.round(
        (await measure(text, display(chipSize, 3))) + 26 + 12 + 2 * 28,
      );
      return { ...s, text, w };
    }),
  );
  const gap = 20;
  let x =
    mid - (chips.reduce((n, c) => n + c.w, 0) + gap * (chips.length - 1)) / 2;
  for (const c of chips) {
    const fill = c.unlocked ? CHASE : GRAPHITE;
    const ink = c.unlocked ? INK : SILVER;
    svg.push(
      `<rect x="${x.toFixed(1)}" y="${(y - chipH / 2).toFixed(1)}" width="${c.w}" height="${chipH}" ` +
        `rx="${chipH / 2}" fill="${fill}"${c.unlocked ? '' : ` stroke="${HAIRLINE}" stroke-width="2"`}/>`,
      icon(c.unlocked ? ICON_CHECK : ICON_LOCK, x + 28, y, 26, ink),
      textEl(
        c.text,
        x + 28 + 26 + 12,
        baseline(y, chipSize),
        display(chipSize, 3),
        ink,
      ),
    );
    x += c.w + gap;
  }

  // ---- the featured stage's podium, in one charcoal panel ----------------
  const panelY = y + chipH / 2 + 48;
  const nameFont = body(26);
  const slots = [
    { rank: 2, x: PAD + 44, top: panelY + 220, ...SIDE },
    { rank: 1, x: mid - CENTER.w / 2, top: panelY + 150, ...CENTER },
    { rank: 3, x: W - PAD - 44 - SIDE.w, top: panelY + 220, ...SIDE },
  ];
  let panelBottom = 0;
  const podium: string[] = [];
  for (const slot of slots) {
    const prize = input.podium.find((p) => p.rank === slot.rank);
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
    if (bytes && prize?.name) {
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
      if (prize && !prize.name && prize.credits > 0) {
        podium.push(
          textEl(
            credits(prize.credits),
            cx,
            baseline(slot.top + slot.h / 2 - 18, 44),
            display(44),
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
      } else {
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
      }
    }
    let ny = slot.top + slot.h + 40;
    const label =
      prize?.name ?? (prize && prize.credits > 0 ? '' : 'To be announced');
    for (const line of label
      ? await twoLines(label, nameFont, slot.w + 24)
      : []) {
      podium.push(
        textEl(line, cx, baseline(ny, 26), nameFont, WHITE, 'middle'),
      );
      ny += 34;
    }
    panelBottom = Math.max(panelBottom, ny + 4);
  }
  const panelH = panelBottom - panelY + 24;
  // Drawn under the spotlight (below), which sits under all the text.
  const panelRect =
    `<rect x="${PAD + 1}" y="${panelY + 1}" width="${TEXT_W - 2}" height="${panelH - 2}" rx="40" ` +
    `fill="${CHARCOAL}" stroke="${HAIRLINE}" stroke-width="2"/>`;
  svg.push(
    textEl(
      `STAGE ${input.featureStage} PRIZES`,
      mid,
      baseline(panelY + 64, 28),
      body(28, 4),
      SILVER,
      'middle',
    ),
    ...podium,
  );
  y = panelY + panelH;

  // ---- the current leaders, only when asked for ---------------------------
  if (input.leaders.length > 0) {
    y += 64;
    svg.push(
      textEl(
        'CURRENT LEADERS',
        mid,
        baseline(y, 26),
        body(26, 4),
        SILVER,
        'middle',
      ),
    );
    y += 64;
    const colW = TEXT_W / 3;
    for (const [i, leader] of input.leaders.slice(0, 3).entries()) {
      const cx = PAD + colW * i + colW / 2;
      const name = await fit(imageSafeName(leader.name), body(32), colW - 24);
      const rank = `#${leader.rank}`;
      const rankW = await measure(rank, display(36));
      const nameW = await measure(name, body(32));
      const sx = cx - (rankW + 14 + nameW) / 2;
      svg.push(
        textEl(
          rank,
          sx,
          baseline(y, 36),
          display(36),
          RANK_TONE[leader.rank] ?? WHITE,
        ),
        textEl(name, sx + rankW + 14, baseline(y, 32), body(32), WHITE),
      );
    }
    y += 24;
  }

  // ---- the rule and the address --------------------------------------------
  y += 70;
  const rule = await fit(
    "REWARDS STACK · THE WEEK'S TOP 10 CLAIM THEM ALL",
    body(26, 2),
    TEXT_W,
  );
  svg.push(textEl(rule, mid, baseline(y, 26), body(26, 2), SILVER, 'middle'));
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
  // The chase-gold spotlight behind the #1 prize: over the panel, under the
  // text and the art.
  const spotY = panelY + 150 + CENTER.h / 2;
  const base = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<defs><radialGradient id="spot" cx="0.5" cy="0.5" r="0.5">` +
      `<stop offset="0" stop-color="${CHASE}" stop-opacity="0.26"/>` +
      `<stop offset="0.5" stop-color="${CHASE}" stop-opacity="0.08"/>` +
      `<stop offset="1" stop-color="${CHASE}" stop-opacity="0"/></radialGradient></defs>` +
      `<rect width="${W}" height="${H}" fill="${INK}"/>${panelRect}` +
      `<ellipse cx="${mid}" cy="${spotY}" rx="420" ry="380" fill="url(#spot)"/>` +
      `${svg.join('')}</svg>`,
  );
  return sharp(base)
    .composite(layers)
    .flatten({ background: INK })
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/** Fetch each podium prize's official image, then compose. Art that cannot
 *  be fetched becomes a placeholder tile; `missing` names the ranks so the
 *  bot can say so. */
export async function renderChallengePoster(
  input: ChallengePosterInput,
  urls: Map<number, string | null>,
): Promise<{ jpeg: Buffer; missing: number[] }> {
  const missing: number[] = [];
  const art = new Map<number, Buffer | null>();
  await Promise.all(
    [...urls].map(async ([rank, url]) => {
      const bytes = url ? await fetchBytes(url).catch(() => null) : null;
      if (url && !bytes) missing.push(rank);
      art.set(rank, bytes);
    }),
  );
  return { jpeg: await composeChallengePoster(input, art), missing };
}
