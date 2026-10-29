import sharp from 'sharp';
import { ensureBundledFonts } from '../media/label-font';
import { MAX_DECODE_PIXELS } from '../../utils/image-fetch';
import {
  CTA_H,
  ctaRow,
  posterTextError,
  POSTER_H,
  POSTER_W,
} from '../../../modules/packs/brand-poster';
import { BRAND_LOGO_B64 } from '../../../modules/packs/pull-card-assets';
import {
  baseline,
  body,
  display,
  esc,
  measure,
  textEl,
  type Font,
} from '../../../modules/packs/pull-card';

// A marketing post in the design Polycards uses on Instagram (owner,
// 2026-10-29): AI key art full-bleed, darkened top and bottom, then the real
// brand type drawn over it — the logo top-left and polycards.gg top-right, a
// spaced gold eyebrow between two gold hairlines, a big Nekst headline with
// optional gold words, a quiet line and the white "Open a pack" pill. Same
// values as the posted posters' HTML (reports/posters/*/poster.html). The
// image model never draws text: it garbles logos and letters.

const W = POSTER_W;
const H = POSTER_H;
const PAD = 64;
const BG = '#0a0a0a';
const GOLD = '#e2c48a';
const GOLD_DEEP = '#b8925a';
const INK = '#f6f3ec';
const MUTED = '#a39d92';
const LOGO_W = 200;
const HEAD_MAX = 104;
const HEAD_MIN = 60;
const TEXT_W = W - 2 * PAD;

// The posters set the gold eyebrow and corner in bold; only Geist Regular is
// bundled, so a hairline stroke in the same colour gives the weight.
const strong = (...args: Parameters<typeof textEl>): string =>
  textEl(...args).replace(
    '<text ',
    `<text stroke="${args[4]}" stroke-width="0.9" `,
  );

export type PosterCopy = {
  /** Small spaced line above the headline, e.g. "Every Saturday & Sunday". */
  eyebrow?: string;
  /** The big line. Short: 1 or 2 lines of a few words. */
  headline: string;
  /** Words of the headline drawn in gold, e.g. "100%". */
  gold?: string;
  /** One quiet line near the bottom. */
  subline?: string;
  /** Top-right text. Default polycards.gg. */
  corner?: string;
  /** The white "Open a pack" pill with polycards.gg. Default true. */
  button?: boolean;
};

/** What is wrong with the copy, or null: the brand fonts are Latin only. */
export function posterCopyError(c: PosterCopy): string | null {
  const checks: [string, string | undefined, number][] = [
    ['headline', c.headline, 40],
    ['eyebrow', c.eyebrow, 40],
    ['gold', c.gold, 30],
    ['subline', c.subline, 120],
    ['corner', c.corner, 32],
  ];
  if (!c.headline?.trim()) return 'headline is required.';
  for (const [name, text, max] of checks) {
    if (!text) continue;
    const bad = posterTextError(text, max);
    if (bad) {
      return `${name} ${bad} Chinese copy goes in the caption, not on the image.`;
    }
  }
  return null;
}

/** The headline as 1 or 2 lines at the largest size that fits. */
async function headlineLines(
  text: string,
): Promise<{ lines: string[]; size: number }> {
  const words = text.trim().split(/\s+/);
  for (let size = HEAD_MAX; size >= HEAD_MIN; size -= 4) {
    const font = display(size, -0.02 * size);
    if ((await measure(text, font)) <= TEXT_W) return { lines: [text], size };
    let best: string[] | null = null;
    let bestWidest = Infinity;
    for (let i = 1; i < words.length; i++) {
      const pair = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
      const widest = Math.max(
        ...(await Promise.all(pair.map((l) => measure(l, font)))),
      );
      if (widest <= TEXT_W && widest < bestWidest) {
        best = pair;
        bestWidest = widest;
      }
    }
    if (best) return { lines: best, size };
  }
  return { lines: [text], size: HEAD_MIN };
}

/** One centred headline line, gold where `gold` words appear. */
function headlineEl(
  line: string,
  mid: number,
  font: Font,
  gold: Set<string>,
): string {
  const spans = line
    .split(/(\s+)/)
    .map((part) =>
      gold.has(part.toLowerCase())
        ? `<tspan fill="url(#gold)">${esc(part)}</tspan>`
        : esc(part),
    )
    .join('');
  return (
    `<text x="${W / 2}" y="${baseline(mid, font.size).toFixed(1)}" font-family="${font.family}" ` +
    `font-size="${font.size}" letter-spacing="${font.spacing ?? 0}" fill="${INK}" ` +
    `text-anchor="middle">${spans}</text>`
  );
}

/** Wraps `text` into at most 2 lines of `font` within `max`. */
async function wrap(text: string, font: Font, max: number): Promise<string[]> {
  if ((await measure(text, font)) <= max) return [text];
  const words = text.split(/\s+/);
  for (let i = words.length - 1; i > 0; i--) {
    const first = words.slice(0, i).join(' ');
    if ((await measure(first, font)) <= max) {
      return [first, words.slice(i).join(' ')];
    }
  }
  return [text];
}

export async function composePoster(
  art: Buffer,
  copy: PosterCopy,
): Promise<Buffer> {
  ensureBundledFonts();
  const bg = await sharp(art, { limitInputPixels: MAX_DECODE_PIXELS })
    .resize(W, H, { fit: 'cover', position: 'centre' })
    .toBuffer();
  const logo = await sharp(Buffer.from(BRAND_LOGO_B64, 'base64'))
    .resize({ width: LOGO_W })
    .png()
    .toBuffer();

  const parts: string[] = [];
  // Darken the top and bottom so the type reads on any art.
  parts.push(
    `<rect x="0" y="0" width="${W}" height="460" fill="url(#top)"/>`,
    `<rect x="0" y="${H - 480}" width="${W}" height="480" fill="url(#bottom)"/>`,
  );
  const corner = copy.corner?.trim() || 'polycards.gg';
  parts.push(
    strong(corner, W - PAD, baseline(84, 26), body(26, 1.5), GOLD, 'end'),
  );

  let y = 178;
  if (copy.eyebrow?.trim()) {
    const eye = copy.eyebrow.trim().toUpperCase();
    const font = body(28, 9);
    const w = await measure(eye, font);
    const half = w / 2;
    const line = 70;
    const gap = 28;
    parts.push(
      `<rect x="${(W / 2 - half - gap - line).toFixed(1)}" y="${y - 1}" width="${line}" height="2" fill="url(#hairL)"/>`,
      `<rect x="${(W / 2 + half + gap).toFixed(1)}" y="${y - 1}" width="${line}" height="2" fill="url(#hairR)"/>`,
      strong(eye, W / 2, baseline(y, 28), font, GOLD, 'middle'),
    );
    y += 84;
  } else {
    y += 40;
  }

  const { lines, size } = await headlineLines(copy.headline.trim());
  const headFont = display(size, -0.02 * size);
  const gold = new Set(
    (copy.gold ?? '').toLowerCase().split(/\s+/).filter(Boolean),
  );
  lines.forEach((line, i) => {
    parts.push(headlineEl(line, y + i * size * 1.02, headFont, gold));
  });

  // Bottom: the quiet line, then the pill.
  const button = copy.button !== false;
  let bottom = H - 96;
  if (button) {
    parts.push(await ctaRow(W / 2, bottom - CTA_H, 'polycards.gg'));
    bottom -= CTA_H + 40;
  }
  if (copy.subline?.trim()) {
    const font = body(30);
    const sub = await wrap(copy.subline.trim(), font, TEXT_W);
    sub.reverse().forEach((l, i) => {
      parts.push(
        textEl(
          l,
          W / 2,
          baseline(bottom - i * 42, 30),
          font,
          i === sub.length - 1 ? INK : MUTED,
          'middle',
        ),
      );
    });
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>` +
    `<linearGradient id="top" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BG}" stop-opacity="0.96"/><stop offset="0.55" stop-color="${BG}" stop-opacity="0.75"/><stop offset="1" stop-color="${BG}" stop-opacity="0"/></linearGradient>` +
    `<linearGradient id="bottom" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BG}" stop-opacity="0"/><stop offset="0.45" stop-color="${BG}" stop-opacity="0.8"/><stop offset="1" stop-color="${BG}" stop-opacity="0.97"/></linearGradient>` +
    `<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3dfb4"/><stop offset="0.5" stop-color="${GOLD}"/><stop offset="1" stop-color="${GOLD_DEEP}"/></linearGradient>` +
    `<linearGradient id="hairL" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${GOLD}" stop-opacity="0"/><stop offset="1" stop-color="${GOLD}"/></linearGradient>` +
    `<linearGradient id="hairR" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${GOLD}"/><stop offset="1" stop-color="${GOLD}" stop-opacity="0"/></linearGradient>` +
    `</defs>${parts.join('')}</svg>`;

  return sharp(bg)
    .composite([
      { input: Buffer.from(svg), top: 0, left: 0 },
      { input: logo, top: 58, left: PAD },
    ])
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();
}
