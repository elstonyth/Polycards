import sharp, { type OverlayOptions } from 'sharp';
import { ensureBundledFonts } from '../../api/admin/media/label-font';
import { fetchBytes, MAX_DECODE_PIXELS } from '../../api/utils/image-fetch';
import { sizeToFit, twoLines } from './challenge-poster';
import { BRAND_LOGO_B64 } from './pull-card-assets';
import { baseline, body, display, fit, measure, textEl } from './pull-card';

// A post graphic for the Growth desk bot (GET /reports/growth/brand-poster):
// milestones, sign-ups, announcements. The challenge poster's language
// (DESIGN.md "The Midnight Rip"): ink stage, Nekst for the claim, Geist for
// the rest, chase gold only on the live figure, the official logo top-left,
// real top-hit slabs as the hero (never an AI redraw), the site in the
// footer. 1080x1350, the 4:5 feed size.
//
// Text is SVG rendered by sharp against the bundled fonts, so judge the look
// from a Linux render (the prod container), never a Windows one.

export type BrandPosterInput = {
  /** Small label top-right, e.g. 'MILESTONE'; '' = none. */
  kicker: string;
  headline: string;
  /** The live figure as shown, e.g. '480' or '400+'; null = no figure. */
  stat: string | null;
  /** One quiet line or two under the art; '' = none. */
  subline: string;
  /** Names of up to 3 hero slabs, the most valuable first. */
  cards: string[];
  /** Bare footer address, e.g. 'polycards.gg'. */
  siteHost: string;
};

const INK = '#0a0a0a';
const GRAPHITE = '#262626';
const HAIRLINE = 'rgba(255,255,255,0.1)';
const WHITE = '#fafafa';
const SILVER = '#a3a3a3';
const CHASE = '#ffb020';

export const POSTER_W = 1080;
export const POSTER_H = 1350;
const W = POSTER_W;
const H = POSTER_H;
const PAD = 64;
const TEXT_W = W - 2 * PAD;
const LOGO_H = 50;
const LOGO_W = Math.round((LOGO_H * 360) / 97); // polycards-logo.png is 360x97
const SLAB = 1600 / 2590; // the graded slab's own aspect
const MAX_SLAB_H = 560;
const SIDE_SCALE = 0.84;
const SIDE_TILT = 8; // degrees, a hand of cards

// Ink height of a caps line: the cap height of both faces is ~0.7em.
const capH = (size: number): number => size * 0.72;

/** The live figure as the poster shows it: exact (480, 12,345), or rounded
 *  DOWN to the hundred with a plus (400+). Never rounded up: a poster must
 *  not claim more than the data shows. Under 100 it stays exact. */
export function posterFigure(n: number, round: 'exact' | 'hundred'): string {
  const fmt = (v: number) => v.toLocaleString('en-MY');
  if (round === 'hundred' && n >= 100) {
    return `${fmt(Math.floor(n / 100) * 100)}+`;
  }
  return fmt(n);
}

// English letters, spaces and the punctuation the brand faces draw.
const POSTER_TEXT = /^[A-Za-z .,'’!?&:;()"“”\-–—/]+$/;

/** Why `text` cannot go on a poster, or null when it can. Digits are refused
 *  outright: a figure only reaches the poster through the live metric. */
export function posterTextError(text: string, max: number): string | null {
  const t = text.trim();
  if (!t) return 'must not be empty.';
  if (t.length > max) return `must be ${max} characters or fewer.`;
  if (/\d/.test(t)) {
    return 'numbers cannot be typed in: use metric, so the figure comes from live data.';
  }
  if (!POSTER_TEXT.test(t)) {
    return 'must be English letters and punctuation only (the brand fonts have no other glyphs).';
  }
  return null;
}

/** One line, or the most even two-line split, at the largest size from
 *  `from` down to `floor` that fits `max`; past the floor, two lines that
 *  ellipsize. */
async function headlineLines(
  text: string,
  from: number,
  floor: number,
  max: number,
): Promise<{ lines: string[]; size: number }> {
  const words = text.split(/\s+/).filter(Boolean);
  const width = async (lines: string[], size: number) =>
    Math.max(
      ...(await Promise.all(lines.map((l) => measure(l, display(size))))),
    );
  for (let size = from; size >= floor; size -= 4) {
    if ((await width([text], size)) <= max) return { lines: [text], size };
    // The most even two-line split (the narrowest wider line) that fits.
    let best: { lines: string[]; w: number } | null = null;
    for (let i = 1; i < words.length; i++) {
      const lines = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
      const w = await width(lines, size);
      if (w <= max && (!best || w < best.w)) best = { lines, w };
    }
    if (best) return { lines: best.lines, size };
  }
  return { lines: await twoLines(text, display(floor), max), size: floor };
}

const decode = (bytes: Buffer) =>
  sharp(bytes, { limitInputPixels: MAX_DECODE_PIXELS });

/** One hero tile as a PNG: the slab art, or a labelled graphite placeholder
 *  when there is none or it does not decode. */
async function slabTile(
  bytes: Buffer | null,
  w: number,
  h: number,
): Promise<{ png: Buffer; placeholder: boolean }> {
  if (bytes) {
    try {
      return {
        png: await decode(bytes)
          .resize(w, h, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .png()
          .toBuffer(),
        placeholder: false,
      };
    } catch {
      // Undecodable art costs this tile its picture, never the poster.
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="24" fill="${GRAPHITE}" ` +
    `stroke="${HAIRLINE}" stroke-width="2"/>` +
    textEl(
      'TOP HIT',
      w / 2,
      baseline(h / 2, 24),
      body(24, 4),
      SILVER,
      'middle',
    ) +
    '</svg>';
  return {
    png: await sharp(Buffer.from(svg)).png().toBuffer(),
    placeholder: true,
  };
}

/**
 * Compose the poster. `art[i]` is the image bytes of `input.cards[i]` (null =
 * a placeholder tile, never a failed poster). `placeholders` lists the
 * 1-based card positions drawn as placeholders.
 */
export async function composeBrandPoster(
  input: BrandPosterInput,
  art: (Buffer | null)[],
): Promise<{ jpeg: Buffer; placeholders: number[] }> {
  ensureBundledFonts(); // before the first text render in this process
  const mid = W / 2;
  const layers: OverlayOptions[] = [];
  const svg: string[] = [];
  const cards = input.cards.slice(0, 3);

  // ---- brand mark and the kicker -------------------------------------------
  layers.push({
    input: await sharp(Buffer.from(BRAND_LOGO_B64, 'base64'))
      .resize(LOGO_W, LOGO_H)
      .toBuffer(),
    left: PAD,
    top: PAD,
  });
  if (input.kicker) {
    const kickerFont = body(26, 4);
    svg.push(
      textEl(
        await fit(input.kicker.toUpperCase(), kickerFont, TEXT_W - LOGO_W - 48),
        W - PAD,
        baseline(PAD + LOGO_H / 2, 26),
        kickerFont,
        SILVER,
        'end',
      ),
    );
  }

  // ---- the figure and the headline, from the top -----------------------------
  let y = PAD + LOGO_H + 80;
  if (input.stat) {
    const statSize = await sizeToFit(
      [input.stat],
      (s) => display(s),
      cards.length ? 236 : 300,
      120,
      TEXT_W,
    );
    y += capH(statSize) / 2;
    svg.push(
      textEl(
        input.stat,
        mid,
        baseline(y, statSize),
        display(statSize),
        CHASE,
        'middle',
      ),
    );
    y += capH(statSize) / 2 + 44;
  }
  const head = await headlineLines(
    input.headline.toUpperCase(),
    input.stat ? 72 : 112,
    input.stat ? 40 : 56,
    TEXT_W,
  );
  y += capH(head.size) / 2;
  for (const [i, line] of head.lines.entries()) {
    if (i > 0) y += Math.round(head.size * 1.06);
    svg.push(
      textEl(
        line,
        mid,
        baseline(y, head.size),
        display(head.size),
        WHITE,
        'middle',
      ),
    );
  }
  const headBottom = y + capH(head.size) / 2;

  // ---- the address and the subline, from the bottom --------------------------
  const pillH = 84;
  const pillY = H - PAD - pillH;
  const pillFont = body(34);
  const host = await fit(input.siteHost, pillFont, TEXT_W - 104);
  const pw = Math.round((await measure(host, pillFont)) + 104);
  svg.push(
    `<rect x="${(mid - pw / 2).toFixed(1)}" y="${pillY}" width="${pw}" height="${pillH}" ` +
      `rx="${pillH / 2}" fill="${GRAPHITE}"/>`,
    textEl(
      host,
      mid,
      baseline(pillY + pillH / 2, 34),
      pillFont,
      WHITE,
      'middle',
    ),
  );
  let bottom = pillY - 56;
  if (input.subline) {
    const subFont = body(32);
    const lines = await twoLines(input.subline, subFont, TEXT_W);
    const advance = 46;
    let ly = bottom - capH(32) / 2 - (lines.length - 1) * advance;
    bottom = ly - capH(32) / 2 - 56;
    for (const line of lines) {
      svg.push(textEl(line, mid, baseline(ly, 32), subFont, SILVER, 'middle'));
      ly += advance;
    }
  }

  // ---- the hero slabs: whatever height is left, centred in it ----------------
  const placeholders: number[] = [];
  const top = headBottom + 64;
  const room = bottom - top;
  let spot = '';
  if (cards.length && room >= 240) {
    const ch = Math.min(MAX_SLAB_H, room);
    const cw = Math.round(ch * SLAB);
    const cy = top + room / 2;
    const sh = Math.round(ch * SIDE_SCALE);
    const sw = Math.round(sh * SLAB);
    // Slots in draw order: the sides first, so the best card sits on top.
    const slots =
      cards.length === 1
        ? [{ i: 0, cx: mid, cy, w: cw, h: Math.round(ch), tilt: 0 }]
        : cards.length === 2
          ? [
              {
                i: 1,
                cx: mid + cw * 0.56,
                cy: cy + ch * 0.04,
                w: sw,
                h: sh,
                tilt: SIDE_TILT,
              },
              {
                i: 0,
                cx: mid - cw * 0.56,
                cy,
                w: cw,
                h: Math.round(ch),
                tilt: -SIDE_TILT / 2,
              },
            ]
          : [
              {
                i: 1,
                cx: mid - cw * 0.76,
                cy: cy + ch * 0.06,
                w: sw,
                h: sh,
                tilt: -SIDE_TILT,
              },
              {
                i: 2,
                cx: mid + cw * 0.76,
                cy: cy + ch * 0.06,
                w: sw,
                h: sh,
                tilt: SIDE_TILT,
              },
              { i: 0, cx: mid, cy, w: cw, h: Math.round(ch), tilt: 0 },
            ];
    for (const slot of slots) {
      const tile = await slabTile(art[slot.i] ?? null, slot.w, slot.h);
      if (tile.placeholder) placeholders.push(slot.i + 1);
      const png = slot.tilt
        ? await sharp(tile.png)
            .rotate(slot.tilt, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer()
        : tile.png;
      const meta = await sharp(png).metadata();
      layers.push({
        input: png,
        left: Math.round(slot.cx - meta.width! / 2),
        top: Math.round(slot.cy - meta.height! / 2),
      });
    }
    // The chase-gold spotlight behind the best card: under the art.
    spot =
      `<ellipse cx="${mid}" cy="${cy.toFixed(1)}" rx="${Math.round(cw * 1.7)}" ` +
      `ry="${Math.round(ch * 0.78)}" fill="url(#spot)"/>`;
  }

  const base = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<defs><radialGradient id="spot" cx="0.5" cy="0.5" r="0.5">` +
      `<stop offset="0" stop-color="${CHASE}" stop-opacity="0.24"/>` +
      `<stop offset="0.5" stop-color="${CHASE}" stop-opacity="0.07"/>` +
      `<stop offset="1" stop-color="${CHASE}" stop-opacity="0"/></radialGradient></defs>` +
      `<rect width="${W}" height="${H}" fill="${INK}"/>${spot}${svg.join('')}</svg>`,
  );
  const jpeg = await sharp(base)
    .composite(layers)
    .flatten({ background: INK })
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return { jpeg, placeholders: placeholders.sort((a, b) => a - b) };
}

/** Fetch each hero card's official image, then compose. A card whose art
 *  cannot be fetched or decoded becomes a placeholder tile; `missing` names
 *  those positions (1-based) so the bot can say so. */
export async function renderBrandPoster(
  input: BrandPosterInput,
  urls: (string | null)[],
): Promise<{ jpeg: Buffer; missing: number[] }> {
  const art = await Promise.all(
    urls.map((url) => (url ? fetchBytes(url).catch(() => null) : null)),
  );
  const { jpeg, placeholders } = await composeBrandPoster(input, art);
  return { jpeg, missing: placeholders };
}
