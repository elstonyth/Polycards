// Pure graded-slab label logic (spec 2026-07-16-graded-slab-dynamic-label §6/§8).
// No I/O here — the SVG renderer and layout join this module in a later task.

import { LABEL_FONT_FAMILY } from './label-font';
import { onePieceLabel } from './one-piece-label';

// PSA's canonical 11-point grade scale. Qualifier half-grades (2.5–9.5) are
// deliberately excluded (operator decision 2026-07-16): the catalog doesn't
// carry them and 9.5 is a PriceCharting price tier, never a PSA grade. 1.5
// stays — it is PSA's base FR grade, not a qualifier.
export const PSA_GRADES = [
  '10',
  '9',
  '8',
  '7',
  '6',
  '5',
  '4',
  '3',
  '2',
  '1.5',
  '1',
] as const;

// Verified against real slabs: PSA 7 → NM, 8 → NM-MT, 9 → MINT, 10 → GEM MT.
const PSA_DESCRIPTORS: Record<string, string> = {
  '10': 'GEM MT',
  '9': 'MINT',
  '8': 'NM-MT',
  '7': 'NM',
  '6': 'EX-MT',
  '5': 'EX',
  '4': 'VG-EX',
  '3': 'VG',
  '2': 'GOOD',
  '1.5': 'FR',
  '1': 'PR',
};

// Null for anything off-scale (legacy rows may hold e.g. 9.5): the grade
// number still prints, but the label must never assert a descriptor PSA
// wouldn't use.
export function psaDescriptor(grade: string): string | null {
  return PSA_DESCRIPTORS[grade.trim()] ?? null;
}

// PriceCharting embeds the card number in product-name ("Pikachu ex #238");
// no separate field exists.
export function parseCardName(product: string): {
  name: string;
  number: string;
} {
  const m = product.trim().match(/^(.*?)\s*#\s*([A-Za-z0-9/-]+)\s*$/);
  if (!m) return { name: product.trim(), number: '' };
  return { name: m[1].trim(), number: `#${m[2]}` };
}

// PSA prints PIKACHU ex, MEGA CHARIZARD X ex, BLASTOISE EX — uppercase every
// token EXCEPT a known suffix token, which is emitted verbatim from the
// source (source casing round-trips both TCG eras with no era table).
const SUFFIX_TOKENS = [
  'ex',
  'GX',
  'V',
  'VMAX',
  'VSTAR',
  'VUNION',
  'BREAK',
  'LV.X',
  'Prime',
  'LEGEND',
  'Star',
  'δ',
];

export function formatCardName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((tok) =>
      SUFFIX_TOKENS.some((s) => s.toLowerCase() === tok.toLowerCase())
        ? tok
        : tok.toUpperCase(),
    )
    .join(' ');
}

// PSA abbreviates sets; PriceCharting does not. Keyed on the normalised PC
// console-name INCLUDING its language marker ("Pokemon Japanese …") — an
// Italian printing must never inherit the English mapping. Values are PSA's
// verbatim printed line (verified against real slabs) and are emitted
// BYTE-IDENTICAL — mixed-case codes like M2a are load-bearing. NEVER derive
// these from ptcgoCode (§7a). A new set needs a new verified entry — the
// accepted maintenance cost of the map over an editable set field. Additional
// verified rows live in docs/research/psa-set-prefill.json (local-only);
// only rows verified against a real slab or PSA's own listing may be added.
const SET_ABBREV: Record<string, string> = {
  'pokemon surging sparks': 'POKEMON SSP EN', // Pikachu ex #238 slab
  'pokemon phantasmal flames': 'POKEMON PFL EN', // Mega Charizard X ex #125 slab
  'pokemon japanese mega dream ex': 'POKEMON M2a JP', // Mega Gengar ex #240 slab
};

// Unknown set → uppercased PC name (accurate, just not PSA's wording).
export function setAbbrev(pcSetName: string): string {
  const key = pcSetName.trim().toLowerCase().replace(/\s+/g, ' ');
  return SET_ABBREV[key] ?? pcSetName.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Layout + SVG renderer (spec §6, geometry re-measured 2026-07-16 on 4 real
// PSA cert label photos — docs/research/psa-labels/, incl. cert 152108321,
// the identical Pikachu ex #238). All fractions are of the label's WHITE
// STICKER (not the red outer border), and the cap height is bound to sticker
// WIDTH — the generated sticker is proportionally taller than a real one, so
// a height-bound cap oversizes the text and overruns the border.
// ---------------------------------------------------------------------------

export type SlabLabelFields = {
  set: string; // PriceCharting console-name, e.g. "Pokemon Surging Sparks"
  name: string; // raw card name, may embed "#238"
  grade: string;
  year?: string | null;
  note?: string | null;
};

// White-sticker box as fractions of the FRAME — printed by
// scripts/process-slabframe-v2.mjs for the shipped frame. Re-measured
// 2026-07-17 (Task 2R, operator case swap to slabframe-user-1600 — the
// textured/frosted case picked in the tier-frame session, PR #196). HOLO/logo
// top = 0.756 of sticker — baseline 3 at 0.723 stays above it (§13 holds).
export const LABEL_BOX = {
  top: 0.0593,
  left: 0.1,
  right: 0.095,
  height: 0.117,
} as const;

const BASELINES = [0.298, 0.509, 0.723] as const; // of sticker height (4-cert mean)
const CAP_OF_WIDTH = 0.033; // cap height / sticker WIDTH (4-cert mean, 0.030–0.037)
const LEFT_MARGIN = 0.032; // of sticker width
const RIGHT_EDGE = 0.968; // of sticker width — real labels end 0.963–0.974, never ~1
const ARIMO_CAP_PER_EM = 0.716; // Arimo/Arial capHeight ÷ unitsPerEm
const COL_GAP_FRAC = 0.02; // min gap between columns, of label-box width
const MIN_SHRINK = 0.7; // shrink-to-fit floor before ellipsizing (§10)
// ponytail: flat per-char advance estimate for uppercase Arimo — good enough
// to keep columns apart; swap for real pango measurement if it ever misfits.
const AVG_CHAR_PER_EM = 0.6;
const ELLIPSIS = '…';

export type LabelRun = {
  x: number;
  y: number;
  fontSize: number;
  anchor: 'start' | 'end';
  text: string;
};

const estWidth = (text: string, fontSize: number): number =>
  text.length * fontSize * AVG_CHAR_PER_EM;

// The three left and three right lines the label prints. A One Piece card
// takes PSA's wording from its PriceCharting name + set (one-piece-label.ts);
// the card's own label year / note, when set, still win.
export function labelLines(f: SlabLabelFields): {
  left: string[];
  right: string[];
} {
  const year = (f.year ?? '').trim();
  const note = (f.note ?? '').trim();
  const grade = f.grade.trim();
  const right = (number: string) => [number, psaDescriptor(grade) ?? '', grade];
  const op = onePieceLabel(f);
  if (op) {
    return {
      left: [
        [year || op.year, op.setLine].filter(Boolean).join(' '),
        op.name,
        note || op.variety,
      ],
      right: right(op.number),
    };
  }
  const { name, number } = parseCardName(f.name);
  return {
    left: [
      [year, setAbbrev(f.set)].filter(Boolean).join(' '),
      formatCardName(name),
      note,
    ],
    right: right(number),
  };
}

// Pure layout: three shared baselines, left column left-aligned, right column
// right-aligned, EVERY element the same size + weight (§6 — verified against
// the reference; an earlier draft that emphasised name/grade was measurably
// wrong). A left line that would collide with the right column shrinks to a
// floor, then ellipsizes — never overlaps (§10).
export function layoutLabel(
  f: SlabLabelFields,
  box: { x: number; y: number; w: number; h: number },
): LabelRun[] {
  const { left, right } = labelLines(f);

  const baseFs = (box.w * CAP_OF_WIDTH) / ARIMO_CAP_PER_EM;
  const leftX = Math.round(box.x + box.w * LEFT_MARGIN);
  const rightX = Math.round(box.x + box.w * RIGHT_EDGE);
  const runs: LabelRun[] = [];

  for (let i = 0; i < 3; i++) {
    const y = Math.round(box.y + box.h * BASELINES[i]);
    if (right[i] !== '') {
      runs.push({
        x: rightX,
        y,
        fontSize: baseFs,
        anchor: 'end',
        text: right[i],
      });
    }
    if (left[i] === '') continue;
    const rightW =
      right[i] === '' ? 0 : estWidth(right[i], baseFs) + box.w * COL_GAP_FRAC;
    const maxW = rightX - rightW - leftX;
    let fs = baseFs;
    let text = left[i];
    if (estWidth(text, fs) > maxW) {
      const fitted = (maxW / estWidth(text, baseFs)) * baseFs;
      fs = Math.max(baseFs * MIN_SHRINK, fitted);
      if (fs > fitted) {
        // clamped at the floor — ellipsize down to fit
        while (text.length > 1 && estWidth(text + ELLIPSIS, fs) > maxW) {
          text = text.slice(0, -1);
        }
        text += ELLIPSIS;
      }
    }
    runs.push({ x: leftX, y, fontSize: fs, anchor: 'start', text });
  }
  return runs;
}

const escXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Frame-sized SVG carrying only the label text — composited at (0,0) over
// the frame by composeSlab. Weight 500, letter-spacing 1% of the em, near-
// black ink, all matching the measured reference.
export function renderLabelSvg(
  f: SlabLabelFields,
  frameW: number,
  frameH: number,
): Buffer {
  const box = {
    x: Math.round(frameW * LABEL_BOX.left),
    y: Math.round(frameH * LABEL_BOX.top),
    w: Math.round(frameW * (1 - LABEL_BOX.left - LABEL_BOX.right)),
    h: Math.round(frameH * LABEL_BOX.height),
  };
  const runs = layoutLabel(f, box);
  const texts = runs
    .map(
      (r) =>
        `<text x="${r.x}" y="${r.y}" font-size="${r.fontSize.toFixed(1)}" ` +
        `letter-spacing="${(r.fontSize * 0.01).toFixed(2)}"` +
        `${r.anchor === 'end' ? ' text-anchor="end"' : ''}>${escXml(r.text)}</text>`,
    )
    .join('');
  return Buffer.from(
    `<svg width="${frameW}" height="${frameH}" xmlns="http://www.w3.org/2000/svg">` +
      `<g font-family="${LABEL_FONT_FAMILY}" font-weight="500" fill="#1a1a1a">${texts}</g></svg>`,
  );
}
