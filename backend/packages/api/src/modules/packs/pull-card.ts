import sharp, { type OverlayOptions } from 'sharp';
import {
  BODY_FONT_FAMILY,
  DISPLAY_FONT_FAMILY,
  ensureBundledFonts,
} from '../../api/admin/media/label-font';
import { fetchBytes, MAX_DECODE_PIXELS } from '../../api/utils/image-fetch';
import {
  BRAND_LOGO_B64,
  PSA_LOGO_B64,
  RAW_FRAME_B64,
  SLAB_FRAME_B64,
} from './pull-card-assets';

// The Telegram apex board's picture: the pulled slab in its storefront tier
// frame on the ink stage, lit by its own rarity, with the card, its grade, its
// value and who pulled it underneath — one JPEG, so the channel reads the pull
// at a glance. Speaks DESIGN.md's language ("The Midnight Rip"): monochrome
// chrome, colour only where it is a signal (rarity, money in), Nekst for names
// and money, Geist for the ledger around them.
//
// Pure rendering: every lookup (card, pack, price, puller) happens in
// telegram.ts's postApexPull, and the art arrives as bytes (renderPullCard is
// the thin fetching wrapper). Text is SVG rendered by sharp's librsvg/pango
// against the bundled fonts (ensureBundledFonts) — the Linux prod container
// has no system fonts, and on win32 dev sharp ignores the bundled ones, so
// judge the look from a Linux render, never a Windows one.
//
// Sizes are for how the post is actually seen: Telegram shows it ~330pt wide
// on a phone (about 0.3x), so nothing that must be read is under ~30px here.

export type PullCardInput = {
  rarity: string;
  cardName: string;
  /** Grading company ('PSA', 'CGC', …); empty for a raw card. */
  grader: string;
  grade: string;
  set: string;
  /** Display market value in MYR — the same number the site shows. */
  priceMyr: number;
  /** Flat buyback credit for that value, and the % it was taken at. */
  buybackMyr: number;
  buybackPercent: number;
  /** Public display name, already stripped of link-shaped text. */
  who: string;
  revealedAt: Date;
  /** Bare storefront host for the footer pill, e.g. "polycards.gg". */
  siteHost: string;
};

export type PullCardArt = {
  /** The baked slab composite — null for a raw card (or a failed bake). */
  slab: Buffer | null;
  /** The bare card photo, framed in the raw band when there is no slab. */
  card: Buffer | null;
  /** Pack wrapper art for the corner tile; null leaves the tile out. */
  pack: Buffer | null;
};

type Rgb = readonly [number, number, number];

/** Mirror of the storefront's RARITY_RGB (src/lib/rarity.ts) — the tier
 *  colour of the glow, the spotlight and the chip. Unknown tiers read as
 *  Common, like rarityRgb. */
const RARITY_RGB: Record<string, Rgb> = {
  Immortal: [251, 146, 60],
  Legendary: [236, 72, 153],
  Mythical: [168, 85, 247],
  Rare: [37, 99, 235],
  Uncommon: [56, 189, 248],
  Common: [163, 163, 163],
};

// DESIGN.md tokens.
const INK = '#0a0a0a';
const CHARCOAL = '#171717';
const GRAPHITE = '#262626';
const HAIRLINE = 'rgba(255,255,255,0.1)';
const WHITE = '#fafafa';
const SILVER = '#a3a3a3';
const MONEY_IN = '#2fbf6e'; // buyback-green-fg

const W = 1080;
const PAD = 64;
const TEXT_W = W - 2 * PAD;

// Framed slab — the storefront's framed tile (components/SlabImage.tsx): the
// tier band art spans the tile width and the slab sits on top of it, inset by
// FRAME_BAND (5%) on every side, which keeps SLAB_ASPECT exactly.
const FW = 500;
const FH = Math.round((FW * 2590) / 1600); // the band webp's own aspect
const BAND = Math.round(FW * 0.05);
const FX = (W - FW) / 2;
const FY = PAD;
const FRAME_R = Math.round((147 / 1600) * FW); // SlabImage OUTER_R

// Raw card — the storefront's raw glass band (card 1112x1557 padded 64px,
// outer r 117) scaled to sit in the same slot as a slab.
const RAW_H = Math.round(FH * 0.92);
const RAW_W = Math.round((RAW_H * 1240) / 1685);
const RAW_PAD = (RAW_H * 64) / 1685;
const RAW_R = Math.round((117 / 1240) * RAW_W);

// Corners flanking the slab: the brand mark top-left, the pack top-right.
const LOGO_H = 50;
const LOGO_W = Math.round((LOGO_H * 360) / 97); // polycards-logo.png is 360x97
const TILE_W = 150;
const TILE_H = 200;
const TILE_X = W - PAD - TILE_W;
const TILE_INSET = 16;

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

type Font = { family: string; size: number; spacing?: number };
const display = (size: number, spacing = 0): Font => ({
  family: DISPLAY_FONT_FAMILY,
  size,
  spacing,
});
const body = (size: number, spacing = 0): Font => ({
  family: BODY_FONT_FAMILY,
  size,
  spacing,
});

const textEl = (
  text: string,
  x: number,
  y: number,
  font: Font,
  fill: string,
  anchor: 'start' | 'middle' | 'end' = 'start',
): string =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${font.family}" ` +
  `font-size="${font.size}"${font.spacing ? ` letter-spacing="${font.spacing}"` : ''} ` +
  `fill="${fill}"${anchor === 'start' ? '' : ` text-anchor="${anchor}"`}>${esc(text)}</text>`;

/** Baseline that optically centres a line of `size` on `mid` (cap height of
 *  both faces is ~0.7em). */
const baseline = (mid: number, size: number): number => mid + size * 0.35;

/**
 * Ink width of one line, measured by rendering it — the only width that is
 * right for whatever face fontconfig actually resolved (an estimate would be
 * wrong on exactly the fallback it would need to survive). Blank text is 0.
 */
async function measure(text: string, font: Font): Promise<number> {
  if (!text.trim()) return 0;
  const h = Math.ceil(font.size * 2);
  const w = Math.ceil(
    (font.size + (font.spacing ?? 0)) * (text.length + 2) * 1.1,
  );
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    textEl(text, font.size / 2, font.size * 1.4, font, '#fff') +
    '</svg>';
  try {
    const { info } = await sharp(Buffer.from(svg))
      .trim()
      .toBuffer({ resolveWithObject: true });
    return info.width;
  } catch {
    // trim throws on an image with no ink at all (a line of unrenderable
    // glyphs) — treat as a best-effort estimate rather than failing the card.
    return text.length * font.size * 0.55;
  }
}

/** Longest prefix of `text` (plus an ellipsis) that fits `max`, or the text
 *  itself when it already fits. */
async function fit(text: string, font: Font, max: number): Promise<string> {
  if ((await measure(text, font)) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const probe = `${text.slice(0, mid).trimEnd()}…`;
    if ((await measure(probe, font)) <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/**
 * The card name as one or two balanced lines. Tries one line, then the most
 * even two-line word split, stepping the size down to a floor; past the floor
 * the second line ellipsizes. Long names wrap rather than shrink to nothing.
 */
async function nameLines(
  name: string,
  max: number,
): Promise<{ lines: string[]; size: number }> {
  const words = name.split(/\s+/).filter(Boolean);
  for (let size = 64; size >= 48; size -= 4) {
    const font = display(size);
    const oneLine = await measure(name, font);
    if (oneLine <= max) return { lines: [name], size };
    // Two lines share the one-line ink less one word gap (under 1em), so the
    // wider line is at least half of that: past 2x max no split can fit.
    // Skipping them spares a pathological name ~2 renders per word per size.
    if (oneLine - font.size > 2 * max) continue;
    let best: { lines: string[]; w: number } | null = null;
    for (let i = 1; i < words.length; i++) {
      const lines = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
      const w = Math.max(
        ...(await Promise.all(lines.map((l) => measure(l, font)))),
      );
      if (w <= max && (!best || w < best.w)) best = { lines, w };
    }
    if (best) return { lines: best.lines, size };
  }
  const font = display(48);
  const cut = Math.max(1, Math.ceil(words.length / 2));
  return {
    lines: [
      await fit(words.slice(0, cut).join(' '), font, max),
      await fit(words.slice(cut).join(' ') || '', font, max),
    ].filter(Boolean),
    size: 48,
  };
}

/** The puller's name as the image shows it. Usernames are ASCII by rule, but
 *  a legacy row could carry glyphs no bundled face covers (CJK, emoji) —
 *  those would render as tofu boxes on a public channel, so they fall back to
 *  'Anonymous' in the IMAGE only; the caption still carries the real name. */
export function imageSafeName(name: string): string {
  const trimmed = name.trim();
  return /^[ -~ -ԯḀ-ỿ‐-‧]+$/.test(trimmed) ? trimmed : 'Anonymous';
}

/** "28 Sept 2026, 3:26 pm" in Malaysia time — the audience's clock, not the
 *  container's UTC. */
export function formatPulledAt(at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kuala_Lumpur',
  }).format(at);
}

const amount = (n: number): string =>
  n.toLocaleString('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// Lucide `user` and `clock` (24-unit viewBox).
const ICON_USER =
  '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>';
const ICON_CLOCK =
  '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>';
const icon = (paths: string, x: number, midY: number, size: number): string =>
  `<g transform="translate(${x.toFixed(1)} ${(midY - size / 2).toFixed(1)}) scale(${size / 24})" ` +
  `fill="none" stroke="${SILVER}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`;

type Box = { x: number; y: number; w: number; h: number; r: number };

/** The hero's light, all inherited from its rarity (DESIGN.md "The Glow Is
 *  Earned"): a wide spotlight wash on the stage, then the storefront's
 *  glowShadow (SlabImage) as two blurred rounded rects masked to OUTSIDE the
 *  frame — a CSS box-shadow never paints under its element, and the slab's
 *  glass edge is part-transparent, so an unmasked glow would tint the case. */
function heroLight(box: Box, [r, g, b]: Rgb, canvasH: number): string {
  const rect = (inset: number, alpha: number, filter: string): string =>
    `<rect x="${box.x + inset}" y="${box.y + inset}" width="${box.w - 2 * inset}" height="${box.h - 2 * inset}" ` +
    `rx="${Math.max(box.r - inset, 0)}" fill="rgba(${r},${g},${b},${alpha})" filter="url(#${filter})"/>`;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h * 0.45;
  return (
    '<defs>' +
    '<filter id="glowA" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="22"/></filter>' +
    '<filter id="glowB" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="45"/></filter>' +
    `<mask id="outside"><rect width="${W}" height="${canvasH}" fill="#fff"/>` +
    `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${box.r}" fill="#000"/></mask>` +
    `<radialGradient id="spot" cx="0.5" cy="0.5" r="0.5">` +
    `<stop offset="0" stop-color="rgb(${r},${g},${b})" stop-opacity="0.34"/>` +
    `<stop offset="0.45" stop-color="rgb(${r},${g},${b})" stop-opacity="0.12"/>` +
    `<stop offset="1" stop-color="rgb(${r},${g},${b})" stop-opacity="0"/></radialGradient>` +
    '</defs>' +
    `<ellipse cx="${cx}" cy="${cy}" rx="${W * 0.62}" ry="${box.h * 0.78}" fill="url(#spot)"/>` +
    '<g mask="url(#outside)">' +
    rect(2, 0.8, 'glowA') +
    rect(20, 0.6, 'glowB') +
    '</g>'
  );
}

/** TierBadge ink: near-black on light tiers, white on the one dark one. */
const chipInk = ([r, g, b]: Rgb): string =>
  0.299 * r + 0.587 * g + 0.114 * b > 120 ? INK : WHITE;

const decode = (bytes: Buffer) =>
  sharp(bytes, { limitInputPixels: MAX_DECODE_PIXELS });

/** Card photo with the storefront's raw-card corner rounding (4.8% / 3.4%). */
async function roundedCard(
  bytes: Buffer,
  w: number,
  h: number,
): Promise<Buffer> {
  const mask = Buffer.from(
    `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" ` +
      `rx="${(w * 0.048).toFixed(1)}" ry="${(h * 0.034).toFixed(1)}" fill="#fff"/></svg>`,
  );
  return decode(bytes)
    .resize(w, h, { fit: 'cover' })
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

/**
 * Compose the pull card. Throws on undecodable art — renderPullCard is the
 * never-throws boundary the Telegram path calls.
 */
export async function composePullCard(
  input: PullCardInput,
  art: PullCardArt,
): Promise<Buffer> {
  ensureBundledFonts(); // before the first text render in this process
  const rgb = RARITY_RGB[input.rarity] ?? RARITY_RGB.Common;
  const tier = input.rarity.toLowerCase();
  const mid = W / 2;
  const layers: OverlayOptions[] = [];
  const svg: string[] = []; // drawn above the stage light, below the art

  // ---- hero: framed slab, or the raw card in its glass band --------------
  let hero: Box;
  if (art.slab) {
    hero = { x: FX, y: FY, w: FW, h: FH, r: FRAME_R };
    const band = await sharp(
      Buffer.from(SLAB_FRAME_B64[tier] ?? SLAB_FRAME_B64.common, 'base64'),
    )
      .resize(FW, FH, { fit: 'fill' })
      .toBuffer();
    const slab = await decode(art.slab)
      .resize(FW - 2 * BAND, FH - 2 * BAND, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    layers.push(
      { input: band, left: FX, top: FY },
      { input: slab, left: FX + BAND, top: FY + BAND },
    );
  } else if (art.card) {
    const x = Math.round((W - RAW_W) / 2);
    const y = Math.round(FY + (FH - RAW_H) / 2);
    hero = { x, y, w: RAW_W, h: RAW_H, r: RAW_R };
    const band = await sharp(
      Buffer.from(RAW_FRAME_B64[tier] ?? RAW_FRAME_B64.common, 'base64'),
    )
      .resize(RAW_W, RAW_H, { fit: 'fill' })
      .toBuffer();
    const cw = Math.round(RAW_W - 2 * RAW_PAD);
    const ch = Math.round(RAW_H - 2 * RAW_PAD);
    layers.push(
      { input: band, left: x, top: y },
      {
        input: await roundedCard(art.card, cw, ch),
        left: Math.round(x + RAW_PAD),
        top: Math.round(y + RAW_PAD),
      },
    );
  } else {
    throw new Error('no card art to render');
  }

  // Brand mark, top-left — the app header's logo.
  layers.push({
    input: await sharp(Buffer.from(BRAND_LOGO_B64, 'base64'))
      .resize(LOGO_W, LOGO_H)
      .toBuffer(),
    left: PAD,
    top: FY,
  });

  // Pack tile, top-right — what it was pulled from.
  if (art.pack) {
    try {
      const packImg = await decode(art.pack)
        .resize(TILE_W - 2 * TILE_INSET, TILE_H - 2 * TILE_INSET, {
          fit: 'inside',
        })
        .png()
        .toBuffer({ resolveWithObject: true });
      svg.push(
        `<rect x="${TILE_X + 1}" y="${FY + 1}" width="${TILE_W - 2}" height="${TILE_H - 2}" rx="28" ` +
          `fill="${CHARCOAL}" stroke="${HAIRLINE}" stroke-width="2"/>`,
      );
      layers.push({
        input: packImg.data,
        left: Math.round(TILE_X + (TILE_W - packImg.info.width) / 2),
        top: Math.round(FY + (TILE_H - packImg.info.height) / 2),
      });
    } catch {
      // Undecodable pack art costs the corner tile, never the post.
    }
  }

  // Tier chip, seated on the frame's bottom edge (TierBadge colours), with an
  // ink ring so it reads as sitting ON the band rather than blending into it.
  const chipFont = display(30, 4);
  const chipText = input.rarity.toUpperCase();
  const chipH = 64;
  const chipW = Math.round((await measure(chipText, chipFont)) + 64);
  const chipY = hero.y + hero.h - chipH / 2;
  const chip =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${chipW + 12}" height="${chipH + 12}">` +
    `<rect x="3" y="3" width="${chipW + 6}" height="${chipH + 6}" rx="${(chipH + 6) / 2}" fill="${INK}"/>` +
    `<rect x="6" y="6" width="${chipW}" height="${chipH}" rx="${chipH / 2}" fill="rgb(${rgb.join(',')})"/>` +
    textEl(
      chipText,
      6 + chipW / 2 + 2,
      baseline(6 + chipH / 2, 30),
      chipFont,
      chipInk(rgb),
      'middle',
    ) +
    '</svg>';
  layers.push({
    input: Buffer.from(chip),
    left: Math.round(mid - chipW / 2 - 6),
    top: Math.round(chipY - 6),
  });

  // ---- card identity ------------------------------------------------------
  // Uppercase Nekst like the card page's title; one or two balanced lines.
  let y = hero.y + hero.h + chipH / 2 + 70;
  const title = await nameLines(input.cardName.trim().toUpperCase(), TEXT_W);
  const lineH = Math.round(title.size * 1.12);
  for (const line of title.lines) {
    svg.push(
      textEl(
        line,
        mid,
        baseline(y, title.size),
        display(title.size),
        WHITE,
        'middle',
      ),
    );
    y += lineH;
  }

  // Meta line: SET · [PSA] 10 — the grade in display type, it is the claim.
  y += 6;
  const grader = input.grader.trim();
  const grade = input.grade.trim();
  const isPsa = grader.toUpperCase() === 'PSA' && grade !== '';
  const gradeText = isPsa ? grade : [grader, grade].filter(Boolean).join(' ');
  const metaFont = body(30, 3);
  const gradeFont = display(36);
  const logoH = 30;
  const logoW = Math.round((logoH * 256) / 99); // psa.png is 256x99
  const gradeW = gradeText ? await measure(gradeText, gradeFont) : 0;
  const tailW = gradeText ? 44 + (isPsa ? logoW + 12 : 0) + gradeW : 0;
  const setText = input.set.trim()
    ? await fit(input.set.trim().toUpperCase(), metaFont, TEXT_W - tailW)
    : '';
  const setW = await measure(setText, metaFont);
  let x = mid - (setW + (setText ? tailW : tailW - 44)) / 2;
  if (setText) {
    svg.push(textEl(setText, x, baseline(y, 30), metaFont, SILVER));
    x += setW;
  }
  if (gradeText) {
    if (setText) {
      svg.push(
        `<circle cx="${(x + 22).toFixed(1)}" cy="${y}" r="4" fill="${SILVER}"/>`,
      );
      x += 44;
    }
    if (isPsa) {
      layers.push({
        input: await sharp(Buffer.from(PSA_LOGO_B64, 'base64'))
          .resize(logoW, logoH)
          .toBuffer(),
        left: Math.round(x),
        top: Math.round(y - logoH / 2),
      });
      x += logoW + 12;
    }
    svg.push(textEl(gradeText, x, baseline(y, 36), gradeFont, WHITE));
  }

  // ---- money: one charcoal panel, two columns ----------------------------
  // Values in Nekst (DESIGN.md "The Money Is Display Rule"); buyback is money
  // in, so it alone wears the money-in green.
  y += 60;
  const panel = { x: PAD, y, w: TEXT_W, h: 204 };
  svg.push(
    `<rect x="${panel.x + 1}" y="${panel.y + 1}" width="${panel.w - 2}" height="${panel.h - 2}" rx="40" ` +
      `fill="${CHARCOAL}" stroke="${HAIRLINE}" stroke-width="2"/>`,
    `<rect x="${mid - 1}" y="${panel.y + 40}" width="2" height="${panel.h - 80}" fill="${HAIRLINE}"/>`,
  );
  const colW = panel.w / 2 - 56;
  const cols = [
    { label: 'MARKET VALUE', value: amount(input.priceMyr), fill: WHITE },
    {
      label: `BUYBACK · ${input.buybackPercent}%`,
      value: amount(input.buybackMyr),
      fill: MONEY_IN,
    },
  ];
  // "RM" as a smaller prefix, both columns at one size so they read as a pair.
  let valueSize = 68;
  const rmW = async (s: number) => measure('RM', display(Math.round(s * 0.56)));
  const widest = async (s: number) =>
    (await rmW(s)) +
    10 +
    Math.max(
      ...(await Promise.all(cols.map((c) => measure(c.value, display(s))))),
    );
  while ((await widest(valueSize)) > colW && valueSize > 44) valueSize -= 4;
  const rmSize = Math.round(valueSize * 0.56);
  const rmWidth = await rmW(valueSize);
  for (const [i, c] of cols.entries()) {
    const cx = panel.x + panel.w / 4 + (i * panel.w) / 2;
    svg.push(
      textEl(
        c.label,
        cx,
        baseline(panel.y + 60, 28),
        body(28, 3),
        SILVER,
        'middle',
      ),
    );
    const vw = rmWidth + 10 + (await measure(c.value, display(valueSize)));
    const vx = cx - vw / 2;
    const vMid = panel.y + 134;
    // Share the value's baseline so the prefix sits on the numerals' line.
    const base = baseline(vMid, valueSize);
    svg.push(textEl('RM', vx, base, display(rmSize), c.fill));
    svg.push(
      textEl(c.value, vx + rmWidth + 10, base, display(valueSize), c.fill),
    );
  }

  // ---- who and when -------------------------------------------------------
  y = panel.y + panel.h + 64;
  const footFont = body(34);
  const iconSize = 36;
  const when = formatPulledAt(input.revealedAt);
  const whenW = await measure(when, footFont);
  const fixedW = iconSize + 14 + 56 + iconSize + 14 + whenW;
  const who = await fit(imageSafeName(input.who), footFont, TEXT_W - fixedW);
  const whoW = await measure(who, footFont);
  x = mid - (fixedW + whoW) / 2;
  svg.push(icon(ICON_USER, x, y, iconSize));
  x += iconSize + 14;
  svg.push(textEl(who, x, baseline(y, 34), footFont, WHITE));
  x += whoW + 56;
  svg.push(icon(ICON_CLOCK, x, y, iconSize));
  x += iconSize + 14;
  svg.push(textEl(when, x, baseline(y, 34), footFont, SILVER));

  // ---- site pill (DESIGN.md secondary pill: graphite, white text) ---------
  const pillH = 88;
  const pillY = y + 58;
  const pillFont = body(36);
  const pillW = Math.round((await measure(input.siteHost, pillFont)) + 112);
  svg.push(
    `<rect x="${(mid - pillW / 2).toFixed(1)}" y="${pillY}" width="${pillW}" height="${pillH}" ` +
      `rx="${pillH / 2}" fill="${GRAPHITE}"/>`,
    textEl(
      input.siteHost,
      mid,
      baseline(pillY + pillH / 2, 36),
      pillFont,
      WHITE,
      'middle',
    ),
  );

  const H = Math.round(pillY + pillH + PAD);
  const base = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<rect width="${W}" height="${H}" fill="${INK}"/>${heroLight(hero, rgb, H)}${svg.join('')}</svg>`,
  );
  return sharp(base)
    .composite(layers)
    .flatten({ background: INK })
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/** A render attempt, in the same shape as telegram.ts's PhotoComposite: the
 *  JPEG, or null plus why (`error`). Never throws — the caller's fallback is
 *  the plain slab photo, so a broken card must cost the design, never the post.
 *  `warning` rides WITH a photo: art that failed without sinking the card (the
 *  pack tile, or a slab that fell back to the bare photo), so the degradation
 *  is logged instead of silently shipping for months. */
export async function renderPullCard(
  input: PullCardInput,
  urls: { slab: string | null; card: string | null; pack: string | null },
): Promise<{ photo: Buffer | null; error?: string; warning?: string }> {
  const why: string[] = [];
  const get = async (
    label: string,
    url: string | null,
  ): Promise<Buffer | null> =>
    url
      ? fetchBytes(url, (r) => why.push(`${label}: ${r}`)).catch((err) => {
          why.push(
            `${label} threw: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        })
      : null;
  const packFetch = get('pack art', urls.pack);
  const slab = await get('slab art', urls.slab);
  // The bare photo only when there is no slab to show — a graded card whose
  // slab is unreachable renders on the raw path, as the storefront does.
  const card = slab ? null : await get('card art', urls.card);
  const pack = await packFetch;
  if (!slab && !card) {
    return {
      photo: null,
      error: `pull card: ${why.join('; ') || 'no card art'}`,
    };
  }
  try {
    const photo = await composePullCard(input, { slab, card, pack });
    return why.length ? { photo, warning: why.join('; ') } : { photo };
  } catch (err) {
    return {
      photo: null,
      error: `pull card render failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
