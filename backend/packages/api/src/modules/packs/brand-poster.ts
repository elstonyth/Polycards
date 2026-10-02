import sharp, { type OverlayOptions } from 'sharp';
import { ensureBundledFonts } from '../../api/admin/media/label-font';
import { fetchBytes, MAX_DECODE_PIXELS } from '../../api/utils/image-fetch';
import { sizeToFit, twoLines } from './challenge-poster';
import { BRAND_LOGO_B64, SLAB_FRAME_B64 } from './pull-card-assets';
import {
  baseline,
  body,
  display,
  fit,
  measure,
  RARITY_RGB,
  textEl,
} from './pull-card';

// A post graphic for the Growth desk bot (GET /reports/growth/brand-poster):
// milestones, sign-ups, announcements, drawn as the storefront's own home hero
// in its mobile, portrait form (src/components/home/HeroBoard.tsx and
// HeroSlabs.tsx): the logo top-left, a centred eyebrow, a sentence-case Nekst
// headline with the hero's tight tracking, a quiet Geist line, the white
// "Open a pack" pill, the site's top chase cards fanned in their tier frames
// and halos, and the "Top 3 chase cards" panel over them. A live figure, when
// there is one, sits above the headline in chase gold. 1080x1350, the 4:5
// feed size.
//
// Text is SVG rendered by sharp against the bundled fonts, so judge the look
// from a Linux render (the prod container), never a Windows one.

export type HeroCard = { name: string; rarity: string };

export type BrandPosterInput = {
  /** The eyebrow, e.g. 'Community milestone'; '' = none. */
  kicker: string;
  /** Written like the site's hero: short sentence-case lines. */
  headline: string;
  /** The live figure as shown, e.g. '484' or '400+', or a goal not yet
   *  reached ('1,000', with `progress`); null = no figure. */
  stat: string | null;
  /** A goal's live progress, drawn under the headline. */
  progress?: { fraction: number; label: string } | null;
  /** One quiet line or two under the headline; '' = none. */
  subline: string;
  /** Up to 3 hero slabs, the most valuable first (centre, right, left). */
  cards: HeroCard[];
  /** The panel about cards[0]; null = no panel. */
  chase: { priceMyr: number; name: string; pack: string } | null;
  /** Bare address beside the pill, e.g. 'polycards.gg'. */
  siteHost: string;
};

// DESIGN.md tokens (neutral-900 is the site's panel, neutral-400 its quiet text).
const INK = '#0a0a0a';
const PANEL = '#171717';
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

// The storefront's framed slab (SlabImage): the tier band art (1600x2590)
// spans the tile, the slab sits inset 5% on every side.
const BAND_ASPECT = 2590 / 1600;
// HeroSlabs POSITIONS: the lead tilted -3deg; the next two 70% out, 14% down,
// tilted 14deg, at 0.88 scale.
const LEAD_TILT = -3;
const SIDE_TILT = 14;
const SIDE_SCALE = 0.88;

// Lucide layers-2, arrow-right and arrow-up-right (24-unit viewBox).
const ICON_LAYERS =
  '<path d="M13 13.74a2 2 0 0 1-2 0L2.5 8.87a1 1 0 0 1 0-1.74L11 2.26a2 2 0 0 1 2 0l8.5 4.87a1 1 0 0 1 0 1.74z"/>' +
  '<path d="m20 14.285 1.5.845a1 1 0 0 1 0 1.74L13 21.74a2 2 0 0 1-2 0l-8.5-4.87a1 1 0 0 1 0-1.74l1.5-.845"/>';
const ICON_ARROW = '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>';
const ICON_ARROW_UP = '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>';
const icon = (
  paths: string,
  x: number,
  midY: number,
  size: number,
  stroke: string,
): string =>
  `<g transform="translate(${x.toFixed(1)} ${(midY - size / 2).toFixed(1)}) scale(${size / 24})" ` +
  `fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`;

// Ink height of a line: the cap height of both faces is ~0.7em.
const capH = (size: number): number => size * 0.72;
// The hero headline's tracking (tracking-[-0.04em] on the site), eased to
// -0.03em: at poster size the tighter value makes Nekst's letters touch.
const headFont = (size: number) => display(size, -0.03 * size);

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

/** A goal for a live figure. Until the data reaches it, the poster shows
 *  the goal itself (framed as "Road to", with the live progress); once it
 *  does, the goal becomes the reached milestone ('1,000+'). Either way the
 *  poster states nothing the data does not show. */
export function posterGoal(
  live: number,
  goal: number,
): { reached: boolean; figure: string; fraction: number } {
  const fmt = goal.toLocaleString('en-MY');
  return live >= goal
    ? { reached: true, figure: `${fmt}+`, fraction: 1 }
    : { reached: false, figure: fmt, fraction: Math.max(0, live / goal) };
}

/** A price as the storefront prints it (lib/format rm): RM with sen. */
export function posterRm(n: number): string {
  return `RM ${n.toLocaleString('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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
      ...(await Promise.all(lines.map((l) => measure(l, headFont(size))))),
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
  return { lines: await twoLines(text, headFont(floor), max), size: floor };
}

const decode = (bytes: Buffer) =>
  sharp(bytes, { limitInputPixels: MAX_DECODE_PIXELS });

/**
 * One hero slab as the storefront draws it: the tier band, the slab inset
 * in it, and the tier's halo outside the frame (SlabImage glowShadow, two
 * blurred rounded rects masked off the frame so the glass edge is not
 * tinted). The tile carries margin for the halo; `placeholder` when the art
 * is missing or does not decode.
 */
async function framedTile(
  bytes: Buffer | null,
  rarity: string,
  fw: number,
): Promise<{ png: Buffer; placeholder: boolean }> {
  const fh = Math.round(fw * BAND_ASPECT);
  const inset = Math.round(fw * 0.05);
  const r = Math.round((147 / 1600) * fw);
  const s = fw / 500; // the pull card tunes this halo on a 500 px frame
  const m = Math.round(120 * s);
  const tw = fw + 2 * m;
  const th = fh + 2 * m;
  const [cr, cg, cb] = RARITY_RGB[rarity] ?? RARITY_RGB.Common;
  const halo = (spread: number, alpha: number, id: string) =>
    `<rect x="${m + spread}" y="${m + spread}" width="${fw - 2 * spread}" height="${fh - 2 * spread}" ` +
    `rx="${Math.max(r - spread, 0)}" fill="rgba(${cr},${cg},${cb},${alpha})" filter="url(#${id})"/>`;
  const glow = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}"><defs>` +
      `<filter id="a" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(22 * s).toFixed(1)}"/></filter>` +
      `<filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(45 * s).toFixed(1)}"/></filter>` +
      `<mask id="out"><rect width="${tw}" height="${th}" fill="#fff"/>` +
      `<rect x="${m}" y="${m}" width="${fw}" height="${fh}" rx="${r}" fill="#000"/></mask></defs>` +
      `<g mask="url(#out)">${halo(2 * s, 0.8, 'a')}${halo(20 * s, 0.6, 'b')}</g></svg>`,
  );
  const tier = rarity.toLowerCase();
  const band = await sharp(
    Buffer.from(SLAB_FRAME_B64[tier] ?? SLAB_FRAME_B64.common, 'base64'),
  )
    .resize(fw, fh, { fit: 'fill' })
    .png()
    .toBuffer();
  let slab: Buffer | null = null;
  if (bytes) {
    try {
      slab = await decode(bytes)
        .resize(fw - 2 * inset, fh - 2 * inset, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
    } catch {
      // Undecodable art costs this tile its picture, never the poster.
    }
  }
  const fill = slab
    ? { input: slab, left: m + inset, top: m + inset }
    : {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${fw - 2 * inset}" height="${fh - 2 * inset}">` +
            `<rect width="100%" height="100%" rx="${Math.round(r * 0.6)}" fill="${GRAPHITE}"/>` +
            textEl(
              'TOP CHASE',
              (fw - 2 * inset) / 2,
              baseline((fh - 2 * inset) / 2, 22),
              body(22, 4),
              SILVER,
              'middle',
            ) +
            '</svg>',
        ),
        left: m + inset,
        top: m + inset,
      };
  const png = await sharp(glow)
    .composite([{ input: band, left: m, top: m }, fill])
    .png()
    .toBuffer();
  return { png, placeholder: !slab };
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
  const hasHero = cards.length > 0;

  layers.push({
    input: await sharp(Buffer.from(BRAND_LOGO_B64, 'base64'))
      .resize(LOGO_W, LOGO_H)
      .toBuffer(),
    left: PAD,
    top: PAD,
  });

  // ---- measure the text block, then place it --------------------------------
  const eyebrowFont = body(24, 5);
  const eyebrow = input.kicker
    ? await fit(input.kicker.toUpperCase(), eyebrowFont, TEXT_W - 60)
    : '';
  const progress = input.progress ?? null;
  const statSize = input.stat
    ? await sizeToFit(
        [input.stat],
        (s) => display(s, -0.03 * s),
        hasHero ? (progress ? 170 : 190) : 260,
        110,
        TEXT_W,
      )
    : 0;
  const progressFont = body(28);
  const progressLabel = progress
    ? await fit(progress.label, progressFont, TEXT_W)
    : '';
  const head = await headlineLines(
    input.headline,
    input.stat ? (hasHero ? 84 : 104) : hasHero ? 108 : 132,
    48,
    TEXT_W,
  );
  const subFont = body(32);
  const sub = input.subline
    ? input.stat && hasHero
      ? [await fit(input.subline, subFont, TEXT_W)]
      : await twoLines(input.subline, subFont, TEXT_W - 80)
    : [];
  const ctaFont = body(32);
  const ctaLabel = 'Open a pack';
  const pillH = 84;
  const pillW = Math.round((await measure(ctaLabel, ctaFont)) + 30 + 12 + 88);
  const host = await fit(input.siteHost, ctaFont, 360);
  const hostW = Math.round((await measure(host, ctaFont)) + 12 + 28);
  const rowW = pillW + 48 + hostW;

  const headAdvance = Math.round(head.size * 0.98);
  const parts = [
    eyebrow ? capH(24) + 36 : 0,
    input.stat ? capH(statSize) + 30 : 0,
    capH(head.size) + (head.lines.length - 1) * headAdvance,
    progress ? 46 + 16 + 22 + capH(28) : 0,
    sub.length ? 46 + capH(32) + (sub.length - 1) * 46 : 0,
    48 + pillH,
  ];
  const textH = parts.reduce((a, b) => a + b, 0);
  let y = hasHero
    ? PAD + LOGO_H + 64
    : Math.max(PAD + LOGO_H + 64, Math.round((H - textH) / 2));

  if (eyebrow) {
    const iconSize = 30;
    const w = iconSize + 14 + (await measure(eyebrow, eyebrowFont));
    const x = mid - w / 2;
    const cy = y + capH(24) / 2;
    svg.push(
      icon(ICON_LAYERS, x, cy, iconSize, SILVER),
      textEl(eyebrow, x + iconSize + 14, baseline(cy, 24), eyebrowFont, SILVER),
    );
    y += capH(24) + 36;
  }
  if (input.stat) {
    const cy = y + capH(statSize) / 2;
    svg.push(
      textEl(
        input.stat,
        mid,
        baseline(cy, statSize),
        display(statSize, -0.03 * statSize),
        CHASE,
        'middle',
      ),
    );
    y += capH(statSize) + 30;
  }
  for (const [i, line] of head.lines.entries()) {
    const cy = y + capH(head.size) / 2 + i * headAdvance;
    svg.push(
      textEl(
        line,
        mid,
        baseline(cy, head.size),
        headFont(head.size),
        WHITE,
        'middle',
      ),
    );
  }
  y += capH(head.size) + (head.lines.length - 1) * headAdvance;
  if (progress) {
    // The goal's live progress: a chase-gold bar on a graphite track.
    y += 46;
    const barH = 16;
    const barW = Math.round(TEXT_W * 0.62);
    const bx = mid - barW / 2;
    const done = Math.max(
      barH,
      Math.round(barW * Math.min(1, Math.max(0, progress.fraction))),
    );
    svg.push(
      `<rect x="${bx.toFixed(1)}" y="${y}" width="${barW}" height="${barH}" rx="${barH / 2}" fill="${GRAPHITE}"/>`,
      `<rect x="${bx.toFixed(1)}" y="${y}" width="${done}" height="${barH}" rx="${barH / 2}" fill="${CHASE}"/>`,
    );
    y += barH + 22;
    svg.push(
      textEl(
        progressLabel,
        mid,
        baseline(y + capH(28) / 2, 28),
        progressFont,
        SILVER,
        'middle',
      ),
    );
    y += capH(28);
  }
  if (sub.length) {
    y += 46; // clear of the headline's descenders
    for (const [i, line] of sub.entries()) {
      const cy = y + capH(32) / 2 + i * 46;
      svg.push(textEl(line, mid, baseline(cy, 32), subFont, SILVER, 'middle'));
    }
    y += capH(32) + (sub.length - 1) * 46;
  }
  // The hero's CTA row: the white pill, then the quiet link.
  y += 48;
  const rowX = mid - rowW / 2;
  const pillMid = y + pillH / 2;
  svg.push(
    `<rect x="${rowX.toFixed(1)}" y="${y}" width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="${WHITE}"/>`,
    textEl(ctaLabel, rowX + 44, baseline(pillMid, 32), ctaFont, INK),
    icon(ICON_ARROW, rowX + pillW - 44 - 30, pillMid, 30, INK),
    textEl(host, rowX + pillW + 48, baseline(pillMid, 32), ctaFont, WHITE),
    icon(ICON_ARROW_UP, rowX + pillW + 48 + hostW - 28, pillMid, 26, WHITE),
  );
  y += pillH;

  // ---- the hero: the chase slabs fanned, the panel over their feet -----------
  const placeholders: number[] = [];
  let wash = '';
  if (hasHero) {
    const panelH = input.chase ? 200 : 0;
    const panelY = H - PAD - panelH;
    const top = y + 64;
    // The panel covers the lower part of the fan, as on the site.
    const bottom = input.chase ? panelY + Math.round(panelH * 0.7) : H - PAD;
    const room = bottom - top;
    const fh = Math.min(640, room);
    const fw = Math.round(fh / BAND_ASPECT);
    const cy = top + room / 2;
    const slots = [
      { i: 2, dx: -0.7, tilt: -SIDE_TILT },
      { i: 1, dx: 0.7, tilt: SIDE_TILT },
      { i: 0, dx: 0, tilt: LEAD_TILT },
    ].filter((s) => s.i < cards.length);
    for (const slot of slots) {
      const lead = slot.i === 0;
      const w = Math.round(lead ? fw : fw * SIDE_SCALE);
      const tile = await framedTile(
        art[slot.i] ?? null,
        cards[slot.i].rarity,
        w,
      );
      if (tile.placeholder) placeholders.push(slot.i + 1);
      const turned = await sharp(tile.png)
        .rotate(slot.tilt, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer({ resolveWithObject: true });
      const cx = mid + slot.dx * fw;
      const sy = cy + (lead ? 0 : 0.14 * fh);
      layers.push({
        input: turned.data,
        left: Math.round(cx - turned.info.width / 2),
        top: Math.round(sy - turned.info.height / 2),
      });
    }
    wash =
      `<ellipse cx="${mid}" cy="${cy.toFixed(1)}" rx="${Math.round(W * 0.55)}" ` +
      `ry="${Math.round(fh * 0.75)}" fill="url(#wash)"/>`;

    if (input.chase) {
      const px = Math.round(W * 0.08);
      const pw = W - 2 * px;
      const inner = 44;
      const label = `TOP ${cards.length} CHASE ${cards.length === 1 ? 'CARD' : 'CARDS'}`;
      const price = posterRm(input.chase.priceMyr);
      const priceFont = display(52, -1);
      const priceW = await measure(price, priceFont);
      const nameFont = body(34);
      const noteFont = body(26);
      const panel =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
        `<rect x="${px + 1}" y="${panelY + 1}" width="${pw - 2}" height="${panelH - 2}" rx="28" ` +
        `fill="${PANEL}" stroke="${HAIRLINE}" stroke-width="2"/>` +
        textEl(
          await fit(label, body(22, 4), pw - 2 * inner - priceW - 32),
          px + inner,
          baseline(panelY + 56, 22),
          body(22, 4),
          SILVER,
        ) +
        textEl(
          price,
          px + pw - inner,
          baseline(panelY + 56, 52),
          priceFont,
          CHASE,
          'end',
        ) +
        textEl(
          await fit(input.chase.name, nameFont, pw - 2 * inner),
          px + inner,
          baseline(panelY + 116, 34),
          nameFont,
          WHITE,
        ) +
        textEl(
          await fit(
            `Discover it in ${input.chase.pack} · Pulls vary`,
            noteFont,
            pw - 2 * inner,
          ),
          px + inner,
          baseline(panelY + 160, 26),
          noteFont,
          SILVER,
        ) +
        '</svg>';
      // Over the slabs: the panel is the last layer.
      layers.push({ input: Buffer.from(panel), left: 0, top: 0 });
    }
  }

  const base = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<defs><radialGradient id="wash" cx="0.5" cy="0.5" r="0.5">` +
      `<stop offset="0" stop-color="#ffffff" stop-opacity="0.06"/>` +
      `<stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>` +
      `<rect width="${W}" height="${H}" fill="${INK}"/>${wash}${svg.join('')}</svg>`,
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
