import sharp, { type OverlayOptions } from 'sharp';
import { ensureBundledFonts } from '../../api/admin/media/label-font';
import { fetchBytes, MAX_DECODE_PIXELS } from '../../api/utils/image-fetch';
import {
  capH,
  CTA_H,
  ctaRow,
  headFont,
  icon,
  POSTER_H,
  POSTER_W,
  posterRm,
} from './brand-poster';
import { sizeToFit, twoLines } from './challenge-poster';
import { BRAND_LOGO_B64 } from './pull-card-assets';
import { baseline, body, display, fit, measure, textEl } from './pull-card';

// A ladder of up to 10 tiles as a post graphic, in the brand poster's
// language: the logo, a centred eyebrow with an icon, a sentence-case Nekst
// headline, then one tile per entry (its picture, a big label like 'LV.10' or
// '#1' with an optional quiet note beside it, the name, and a value in chase
// gold), and the white "Open a pack" pill. 1080x1350, the 4:5 feed size.
// The achievements poster and the daily top-hits poster are both drawn here.
//
// Text is SVG rendered by sharp against the bundled fonts, so judge the look
// from a Linux render (the prod container), never a Windows one.

export type LadderTile = {
  /** Shown big over the name: 'LV.10', '#1'. */
  label: string;
  /** Quiet text beside the label, e.g. the player who pulled it; null = none. */
  note: string | null;
  /** Reported back when the picture is missing: the level, the rank. */
  key: number;
  /** A credit has no picture: a wallet tile, never a missing-art placeholder. */
  kind: 'credit' | 'pack' | 'card';
  title: string;
  /** null or 0 = no value to show (a credit's value is in its own name). */
  valueMyr: number | null;
};

export type LadderPoster = {
  eyebrow: string;
  /** Lucide path markup for the eyebrow's icon (24-unit viewBox). */
  eyebrowIcon: string;
  headline: string[];
  /** At most LADDER_MAX_TILES; the order given is the order drawn. */
  tiles: LadderTile[];
  /** A word before the value ('Worth'); null = the value alone. */
  valueLabel: string | null;
  /** Bare address beside the pill, e.g. 'polycards.gg/task'. */
  siteHost: string;
};

export const LADDER_MAX_TILES = 10;

const INK = '#0a0a0a';
const PANEL = '#171717';
const GRAPHITE = '#262626';
const HAIRLINE = 'rgba(255,255,255,0.1)';
const WHITE = '#fafafa';
const SILVER = '#a3a3a3';
const SOFT = '#d4d4d4'; // neutral-300, the /task reward chip's text
const CHASE = '#ffb020';

const W = POSTER_W;
const H = POSTER_H;
const PAD = 64;
const TEXT_W = W - 2 * PAD;
const LOGO_H = 50;
const LOGO_W = Math.round((LOGO_H * 360) / 97); // polycards-logo.png is 360x97
const GAP = 16;

// Lucide wallet and gift.
const ICON_WALLET =
  '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/>' +
  '<path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>';
const ICON_GIFT =
  '<rect x="3" y="7" width="18" height="4" rx="1"/><path d="M12 7v14"/>' +
  '<path d="M20 11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8"/>' +
  '<path d="M7.5 7a1 1 0 0 1 0-5A4.8 8 0 0 1 12 7a4.8 8 0 0 1 4.5-5 1 1 0 0 1 0 5"/>';

/** Where each tile sits: five or fewer in one full-width column; more in two
 *  columns that climb the left one first (an odd tile goes left). */
export function ladderSlots(
  n: number,
): { col: number; row: number; cols: 1 | 2 }[] {
  if (n <= 5) {
    return Array.from({ length: n }, (_, row) => ({ col: 0, row, cols: 1 }));
  }
  const rows = Math.ceil(n / 2);
  return Array.from({ length: n }, (_, i) =>
    i < rows
      ? { col: 0, row: i, cols: 2 as const }
      : { col: 1, row: i - rows, cols: 2 as const },
  );
}

const decode = (bytes: Buffer) =>
  sharp(bytes, { limitInputPixels: MAX_DECODE_PIXELS });

/** A picture contained in a w x h box, or null when it does not decode (the
 *  tile then shows a plain gift box, never a failed poster). */
async function artBox(
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

/**
 * Compose the poster. `art[i]` is the picture of `poster.tiles[i]` (null for
 * a credit, or when it could not be fetched). `placeholders` lists the keys
 * of tiles whose picture was missing or did not decode.
 */
export async function composeLadderPoster(
  poster: LadderPoster,
  art: (Buffer | null)[],
): Promise<{ jpeg: Buffer; placeholders: number[] }> {
  ensureBundledFonts(); // before the first text render in this process
  const mid = W / 2;
  const tiles = poster.tiles.slice(0, LADDER_MAX_TILES);
  const layers: OverlayOptions[] = [
    {
      input: await sharp(Buffer.from(BRAND_LOGO_B64, 'base64'))
        .resize(LOGO_W, LOGO_H)
        .toBuffer(),
      left: PAD,
      top: PAD,
    },
  ];
  const svg: string[] = [];

  // ---- the header: eyebrow, then the headline -------------------------------
  let y = PAD + LOGO_H + 44;
  const eyebrowFont = body(24, 5);
  const eyebrow = await fit(poster.eyebrow, eyebrowFont, TEXT_W - 60);
  const eyebrowW = 30 + 14 + (await measure(eyebrow, eyebrowFont));
  const ex = mid - eyebrowW / 2;
  const ecy = y + capH(24) / 2;
  svg.push(
    icon(poster.eyebrowIcon, ex, ecy, 30, CHASE),
    textEl(eyebrow, ex + 44, baseline(ecy, 24), eyebrowFont, SILVER),
  );
  y += capH(24) + 30;
  const headSize = await sizeToFit(poster.headline, headFont, 80, 56, TEXT_W);
  const headAdvance = Math.round(headSize * 0.98);
  for (const [i, line] of poster.headline.entries()) {
    const cy = y + capH(headSize) / 2 + i * headAdvance;
    svg.push(
      textEl(
        line,
        mid,
        baseline(cy, headSize),
        headFont(headSize),
        WHITE,
        'middle',
      ),
    );
  }
  y += capH(headSize) + (poster.headline.length - 1) * headAdvance + 40;

  // ---- the ladder -------------------------------------------------------------
  const ctaTop = H - PAD - CTA_H;
  const gridTop = Math.round(y); // sharp places layers on whole pixels
  const gridBottom = ctaTop - 40;
  const slots = ladderSlots(tiles.length);
  const cols = slots[0]?.cols ?? 1;
  const rows = Math.max(1, Math.ceil(tiles.length / cols));
  const tw = cols === 2 ? (TEXT_W - GAP) / 2 : TEXT_W;
  const th = Math.min(
    200,
    Math.floor((gridBottom - gridTop - (rows - 1) * GAP) / rows),
  );
  // A short ladder sits in the middle of the room it has.
  const top =
    gridTop +
    Math.round((gridBottom - gridTop - (rows * th + (rows - 1) * GAP)) / 2);

  // One full-width column has room for bigger type and the value on the
  // right, like a price list; in two columns the value sits under the name.
  const wide = cols === 1;
  const lvSize = wide ? 38 : 30;
  const nameSize = wide ? 30 : 24;
  const noteSize = wide ? 26 : 22;
  const nameAdvance = Math.round(nameSize * 1.3);
  const levelFont = display(lvSize, 1);
  const nameFont = body(nameSize);
  const noteFont = body(noteSize);
  const worthFont = body(22);
  const valueFont = display(28, 0);
  const tagFont = body(20, 4);
  const bigValueFont = display(44, -1);
  const worthW = poster.valueLabel
    ? (await measure(poster.valueLabel, worthFont)) + 10
    : 0;
  const placeholders: number[] = [];

  for (const [i, tile] of tiles.entries()) {
    const { col, row } = slots[i];
    const tx = PAD + col * (tw + GAP);
    const ty = top + row * (th + GAP);
    svg.push(
      `<rect x="${(tx + 1).toFixed(1)}" y="${ty + 1}" width="${(tw - 2).toFixed(1)}" height="${th - 2}" rx="24" ` +
        `fill="${PANEL}" stroke="${HAIRLINE}" stroke-width="2"/>`,
    );
    // The picture, on the left.
    const ah = th - 24;
    const aw = Math.round(ah * 0.62);
    const ax = Math.round(tx + 14);
    const ay = ty + 12;
    const pic =
      tile.kind === 'credit' ? null : await artBox(art[i] ?? null, aw, ah);
    if (pic) {
      layers.push({ input: pic, left: ax, top: ay });
    } else {
      if (tile.kind !== 'credit') placeholders.push(tile.key);
      // A credit is money in the wallet: its tile says so in chase gold. A
      // picture that is missing gets a plain gift box instead.
      const credit = tile.kind === 'credit';
      svg.push(
        `<rect x="${ax}" y="${ay}" width="${aw}" height="${ah}" rx="16" ` +
          `fill="${credit ? 'rgba(255,176,32,0.12)' : GRAPHITE}"/>`,
        icon(
          credit ? ICON_WALLET : ICON_GIFT,
          ax + aw / 2 - aw * 0.25,
          ay + ah / 2,
          aw * 0.5,
          credit ? CHASE : SILVER,
        ),
      );
    }

    // The words, beside the picture, centred on the tile. The RM value never
    // clips: the name gives way to it.
    const textX = ax + aw + (wide ? 32 : 22);
    const right = tx + tw - (wide ? 36 : 20);
    const worth =
      tile.kind !== 'credit' && tile.valueMyr !== null && tile.valueMyr > 0;
    const value = worth ? posterRm(tile.valueMyr!) : '';
    const valueW = wide && worth ? await measure(value, bigValueFont) : 0;
    const textRight = right - (valueW ? valueW + 40 : 0);
    const name = await twoLines(tile.title, nameFont, textRight - textX);
    const under = worth && !wide;
    const blockH =
      capH(lvSize) +
      14 +
      capH(nameSize) +
      (name.length - 1) * nameAdvance +
      (under ? 16 + capH(28) : 0);
    let ly = ty + Math.round((th - blockH) / 2);
    const labelMid = ly + capH(lvSize) / 2;
    svg.push(
      textEl(tile.label, textX, baseline(labelMid, lvSize), levelFont, WHITE),
    );
    if (tile.note) {
      // Beside the label, sharing its centre line, cut short before the edge.
      const nx = textX + (await measure(tile.label, levelFont)) + 14;
      const room = textRight - nx;
      if (room > 40) {
        svg.push(
          textEl(
            await fit(tile.note, noteFont, room),
            nx,
            baseline(labelMid, noteSize),
            noteFont,
            SILVER,
          ),
        );
      }
    }
    ly += capH(lvSize) + 14;
    for (const [j, line] of name.entries()) {
      svg.push(
        textEl(
          line,
          textX,
          baseline(ly + capH(nameSize) / 2 + j * nameAdvance, nameSize),
          nameFont,
          SOFT,
        ),
      );
    }
    ly += capH(nameSize) + (name.length - 1) * nameAdvance;
    if (wide && worth) {
      if (poster.valueLabel) {
        // The label over the value at the right edge, the pair centred.
        const pairTop = ty + (th - (capH(20) + 16 + capH(44))) / 2;
        svg.push(
          textEl(
            poster.valueLabel.toUpperCase(),
            right,
            baseline(pairTop + capH(20) / 2, 20),
            tagFont,
            SILVER,
            'end',
          ),
          textEl(
            value,
            right,
            baseline(pairTop + capH(20) + 16 + capH(44) / 2, 44),
            bigValueFont,
            CHASE,
            'end',
          ),
        );
      } else {
        svg.push(
          textEl(
            value,
            right,
            baseline(ty + th / 2, 44),
            bigValueFont,
            CHASE,
            'end',
          ),
        );
      }
    }
    if (under) {
      ly += 16;
      const cy = ly + capH(28) / 2;
      if (poster.valueLabel) {
        svg.push(
          textEl(poster.valueLabel, textX, baseline(cy, 22), worthFont, SILVER),
        );
      }
      svg.push(
        textEl(value, textX + worthW, baseline(cy, 28), valueFont, CHASE),
      );
    }
  }

  svg.push(await ctaRow(mid, ctaTop, poster.siteHost));

  const base = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<defs><radialGradient id="wash" cx="0.5" cy="0.5" r="0.5">` +
      `<stop offset="0" stop-color="#ffffff" stop-opacity="0.05"/>` +
      `<stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>` +
      `<rect width="${W}" height="${H}" fill="${INK}"/>` +
      `<ellipse cx="${mid}" cy="${Math.round((gridTop + gridBottom) / 2)}" rx="${Math.round(W * 0.6)}" ` +
      `ry="${Math.round((gridBottom - gridTop) * 0.6)}" fill="url(#wash)"/>` +
      `${svg.join('')}</svg>`,
  );
  const jpeg = await sharp(base)
    .composite(layers)
    .flatten({ background: INK })
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return { jpeg, placeholders };
}

/** Fetch each tile's picture, then compose. `missing` names the keys whose
 *  picture could not be fetched or decoded, so the bot can say so. */
export async function renderLadderPoster(
  poster: LadderPoster,
  urls: (string | null)[],
): Promise<{ jpeg: Buffer; missing: number[] }> {
  const art = await Promise.all(
    urls.map((url) => (url ? fetchBytes(url).catch(() => null) : null)),
  );
  const { jpeg, placeholders } = await composeLadderPoster(poster, art);
  return { jpeg, missing: placeholders };
}
