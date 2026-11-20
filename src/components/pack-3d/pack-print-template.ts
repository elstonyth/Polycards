// One type template for the live print on every pack's back, and the builder
// that anchors it to one pack's own blanked zones (pack-print.ts does the
// layout and the draw). No React and no app imports, so the capture harness
// can load it as it is.
//
//   const spec = packPrintSpecFromGeometry(geometryJson);   // <pack>-back-geometry.json
//   const layout = layoutPackPrint(details, spec, plateW, plateH, measureWith(ctx));
//
// Why zone-relative: match-back.cjs moves the 151 back's printed rows onto
// another front by an integer shift, so on another pack's plate the fixed print
// (the gold box, the "Pull odds (by rarity)" heading) sits at SHIFTED positions,
// not at 151's positions scaled by the image size. Each zone in the pack's
// printZones marks where its live text goes, so every position here is an
// offset from a zone edge, and every pack shares the faces, weights, sizes,
// tracking, row pitch and column offsets below.
//
// Zone edges are read at the geometry's own precision (anchorZone: 0.1 px), not
// snapped to the whole px the plate blanked (snappedZone, zoneRects in
// scripts/pack-back/lib.cjs): a resampled plate moves the zones, and the fixed
// print with them, by a fraction of a px. For 151 and shifted plates both are
// the same whole numbers.
//
// SIZE RULE (when a pack's zones are not 151's pixel size). Each zone has two
// ratios against 151's zone of the same id: `along` (its length down the line,
// texture y) and `across` (its depth across the stack, texture x).
//   - offsets: 'zone' (default) scales every offset from a zone edge by that
//     zone's own ratio on that axis (along offsets, column offsets, the
//     paragraph's measure by `along`; baselines and row pitch by `across`), so
//     the rows keep their place relative to the fixed print inside the zone.
//     'reference' keeps 151's px offsets (a pure shift).
//   - type: 'zone' (default) sets the type at s = the smallest of the
//     along/across ratios over the headline, odds and buyback zones. Glyph
//     height runs across (texture x) and advance runs along (texture y), so the
//     smaller ratio keeps both inside the zone; for a uniform resize it equals
//     the resize, so the type keeps its proportion to the fixed heading that
//     was resized with it. 'reference' keeps 151's px size; a number forces s.
// Both defaults give exactly 151's spec for 151 and for any plate whose zones
// were moved without resampling (ratios 1).
// SETTLED on the four raw plates (2026-11-19, live-text/raw-packs/measure.json):
// delta-reign and ah are shifted (every ratio 1), cr and 30th Celebration are
// uniformly resampled (every ratio 0.931 / 0.787 within 0.001). With the
// defaults, the live odds label's cap height against the fixed heading's is
// 151's within 0.6%, the first label starts within 0.2 px of the heading's
// start, and no ink leaves its zone. An uneven resize (along != across) has
// not occurred; it would set the type by the smaller ratio and needs a look.

import type {
  PackPrintSpec,
  PrintFont,
  PrintRect,
  TextRect,
} from './pack-print';

/** The parts of a <pack>-back-geometry.json the print needs. */
export type PackBackGeometry = {
  image: { width: number; height: number };
  printZones: {
    zones: { id: string; rect: PrintRect; plate?: string }[];
  };
  /** The plate's own white and softness, when they differ from 151's (a
   *  resampled plate softens its fixed wording; some plates print the fixed
   *  white at #ecebf1). See pack-print-inks.ts. Absent = the template's. */
  printInk?: Partial<PackPrintSpec['ink']>;
};

/** The zones that hold live text (the oddsHeading zone only blanks). */
export type PrintZoneId = keyof PackPrintSpec['zones'];
const ZONE_IDS: readonly PrintZoneId[] = ['headline', 'odds', 'buyback'];

/** A zone's size in whole texture px: along the lines and across the stack. */
export type ZoneExtent = { along: number; across: number };

/**
 * The shared type template, in 151's px. Offsets: `dx` along the line from the
 * zone's start edge (u0, the zone's bottom on the texture), `dy` across the
 * stack from the zone's top edge (v0, its left side on the texture).
 */
export type PackPrintTemplate = {
  /** 151's snapped zone sizes: what the size rule measures a pack against. */
  reference: Record<PrintZoneId, ZoneExtent>;
  ink: PackPrintSpec['ink'];
  /** Space kept clear inside a zone's far end along the line, px. */
  inset: number;
  price: { font: PrintFont; dx: number; dy: number; minScale: number };
  productLine: {
    font: PrintFont;
    dx: number;
    dy: number;
    separator: string;
    minScale: number;
  };
  odds: {
    font: PrintFont;
    firstDy: number;
    pitch: number;
    lastDy: number;
    columns: { labelDx: number; valueRightDx: number }[];
    valueTracking?: number;
    minScale: number;
  };
  buyback: {
    font: PrintFont;
    dx: number;
    firstDy: number;
    pitch: number;
    lastDy: number;
    maxWidth: number;
    minScale: number;
  };
};

/**
 * Fitted to the approved 151 back's painted text (Geist, per-word fits on the
 * 897 x 1666 art). 151's snapped zones in text space: headline u 236-832,
 * v 586-682; odds u 236-832, v 725-832; buyback u 890-1441, v 610-799.
 */
export const PACK_PRINT_TEMPLATE: PackPrintTemplate = {
  reference: {
    headline: { along: 596, across: 96 },
    odds: { along: 596, across: 107 },
    buyback: { along: 551, across: 189 },
  },
  ink: { color: '#ffffff', softness: 0.35 },
  inset: 6,
  price: {
    font: { family: 'sans', weight: 610, size: 42.9, tracking: -0.9 },
    dx: 9.6,
    dy: 47.5,
    // A price is never cut or wrapped: past this it still shrinks to fit, and
    // the layout's fit report flags it (belowMin).
    minScale: 0.75,
  },
  productLine: {
    font: {
      family: 'sans',
      weight: 255,
      size: 29.05,
      tracking: -0.6,
      wordSpacing: 1.5,
    },
    dx: 11.75,
    dy: 80.5,
    separator: ' · ',
    // Was 0.8 (151 only). The live names need more: "30th Celebration ·
    // Pokémon · Original · English · Raw Cards" sets at about 0.79 in Geist, and
    // under the floor the layout drops trailing facts, which rewords the page's
    // line. So the floor sits under every live pack's need, with some room.
    minScale: 0.72,
  },
  odds: {
    font: { family: 'sans', weight: 255, size: 28.65, tracking: -0.65 },
    firstDy: 24.5,
    pitch: 33.5,
    lastDy: 100,
    columns: [
      { labelDx: 10, valueRightDx: 266.3 },
      { labelDx: 315.5, valueRightDx: 578.5 },
    ],
    valueTracking: 0.4,
    minScale: 0.6,
  },
  buyback: {
    font: { family: 'sans', weight: 278, size: 30.5, tracking: -0.36 },
    dx: 9.8,
    firstDy: 31.9,
    pitch: 35.3,
    lastDy: 182,
    maxWidth: 538,
    minScale: 0.7,
  },
};

/** How the template meets zones that are not 151's pixel size (see top). */
export type PrintSizeRule = {
  offsets: 'zone' | 'reference';
  type: 'zone' | 'reference' | number;
};

export const DEFAULT_PRINT_SIZE_RULE: PrintSizeRule = {
  offsets: 'zone',
  type: 'zone',
};

/**
 * Where a zone's edges really are, in text space: fraction x size kept to
 * 0.1 px (the geometry's 5-decimal fractions hold an edge to about 0.01 px).
 * On a resampled plate the zones are 151's moved by a non-integer amount, and
 * the fixed print moved with them, so the live text anchors here, not to the
 * whole-px rectangle the plate blanked (snappedZone). For 151 and every
 * shifted plate the two are the same whole numbers.
 */
export function anchorZone(
  rect: PrintRect,
  width: number,
  height: number,
): TextRect {
  const tenth = (v: number) => Math.round(v * 10) / 10;
  return {
    u0: height - tenth(rect.y1 * height),
    u1: height - tenth(rect.y0 * height),
    v0: tenth(rect.x0 * width),
    v1: tenth(rect.x1 * width),
  };
}

/** A zone rectangle snapped to whole texture px (what the plate blanked). */
export function snappedZone(
  rect: PrintRect,
  width: number,
  height: number,
): TextRect {
  return {
    u0: height - Math.round(rect.y1 * height),
    u1: height - Math.round(rect.y0 * height),
    v0: Math.round(rect.x0 * width),
    v1: Math.round(rect.x1 * width),
  };
}

function zoneRect(geometry: PackBackGeometry, id: PrintZoneId): PrintRect {
  const zone = geometry.printZones.zones.find((z) => z.id === id);
  if (!zone) throw new Error(`pack back geometry has no "${id}" print zone`);
  const { x0, x1, y0, y1 } = zone.rect;
  return { x0, x1, y0, y1 };
}

/** Each text zone's along/across ratio against the template's reference. */
export function zoneRatios(
  geometry: PackBackGeometry,
  template: PackPrintTemplate = PACK_PRINT_TEMPLATE,
): Record<PrintZoneId, ZoneExtent> {
  const { width, height } = geometry.image;
  const out = {} as Record<PrintZoneId, ZoneExtent>;
  for (const id of ZONE_IDS) {
    const z = anchorZone(zoneRect(geometry, id), width, height);
    out[id] = {
      along: (z.u1 - z.u0) / template.reference[id].along,
      across: (z.v1 - z.v0) / template.reference[id].across,
    };
  }
  return out;
}

/** The type scale the rule gives for this geometry (1 for 151). */
export function printTypeScale(
  geometry: PackBackGeometry,
  rule: PrintSizeRule = DEFAULT_PRINT_SIZE_RULE,
  template: PackPrintTemplate = PACK_PRINT_TEMPLATE,
): number {
  if (typeof rule.type === 'number') return rule.type;
  if (rule.type === 'reference') return 1;
  const r = zoneRatios(geometry, template);
  return Math.min(...ZONE_IDS.flatMap((id) => [r[id].along, r[id].across]));
}

const scaled = (font: PrintFont, s: number): PrintFont =>
  s === 1
    ? { ...font }
    : {
        ...font,
        size: font.size * s,
        tracking: font.tracking * s,
        ...(font.wordSpacing !== undefined
          ? { wordSpacing: font.wordSpacing * s }
          : {}),
      };

/**
 * One pack's PackPrintSpec: the template anchored to the pack's own snapped
 * zones, at the pack's own image size. For 151's geometry it is exactly the
 * hand-fitted 151 spec.
 */
export function packPrintSpecFromGeometry(
  geometry: PackBackGeometry,
  rule: PrintSizeRule = DEFAULT_PRINT_SIZE_RULE,
  template: PackPrintTemplate = PACK_PRINT_TEMPLATE,
): PackPrintSpec {
  const { width, height } = geometry.image;
  const rect = {
    headline: zoneRect(geometry, 'headline'),
    odds: zoneRect(geometry, 'odds'),
    buyback: zoneRect(geometry, 'buyback'),
  };
  const z = {
    headline: anchorZone(rect.headline, width, height),
    odds: anchorZone(rect.odds, width, height),
    buyback: anchorZone(rect.buyback, width, height),
  };
  const ratios = zoneRatios(geometry, template);
  const r = (id: PrintZoneId): ZoneExtent =>
    rule.offsets === 'zone' ? ratios[id] : { along: 1, across: 1 };
  const s = printTypeScale(geometry, rule, template);
  const t = template;
  const hl = r('headline');
  const od = r('odds');
  const bb = r('buyback');
  return {
    image: { width, height },
    orientation: 'bottom-to-top',
    zones: rect,
    ink: { ...t.ink, ...geometry.printInk },
    inset: t.inset * Math.min(hl.along, bb.along),
    price: {
      font: scaled(t.price.font, s),
      x: z.headline.u0 + t.price.dx * hl.along,
      baseline: z.headline.v0 + t.price.dy * hl.across,
      minScale: t.price.minScale,
    },
    productLine: {
      font: scaled(t.productLine.font, s),
      x: z.headline.u0 + t.productLine.dx * hl.along,
      baseline: z.headline.v0 + t.productLine.dy * hl.across,
      separator: t.productLine.separator,
      minScale: t.productLine.minScale,
    },
    odds: {
      font: scaled(t.odds.font, s),
      firstBaseline: z.odds.v0 + t.odds.firstDy * od.across,
      pitch: t.odds.pitch * od.across,
      lastBaseline: z.odds.v0 + t.odds.lastDy * od.across,
      columns: t.odds.columns.map((c) => ({
        labelX: z.odds.u0 + c.labelDx * od.along,
        valueRight: z.odds.u0 + c.valueRightDx * od.along,
      })),
      ...(t.odds.valueTracking !== undefined
        ? { valueTracking: t.odds.valueTracking * s }
        : {}),
      minScale: t.odds.minScale,
    },
    buyback: {
      font: scaled(t.buyback.font, s),
      x: z.buyback.u0 + t.buyback.dx * bb.along,
      firstBaseline: z.buyback.v0 + t.buyback.firstDy * bb.across,
      pitch: t.buyback.pitch * bb.across,
      lastBaseline: z.buyback.v0 + t.buyback.lastDy * bb.across,
      maxWidth: t.buyback.maxWidth * bb.along,
      minScale: t.buyback.minScale,
    },
  };
}

/** A lit rect of the back image (fractions: x across, y along from the top). */
export type SpotRect = { x0: number; y0: number; x1: number; y1: number };

/** Padding that takes in the printed gold border around a lit zone. */
export const SPOT_PAD = 0.012;

/**
 * The focused back's two lit rects (plan-focus-ciao section 4): `odds`, the
 * whole gold box (the union of the headline, odds heading and odds zones),
 * and `buyback`, the buyback paragraph; each padded by `SPOT_PAD`. Null when
 * the geometry lacks one of the zones.
 */
export function spotRects(
  geometry: Pick<PackBackGeometry, 'printZones'>,
): { odds: SpotRect; buyback: SpotRect } | null {
  const zone = (id: string) =>
    geometry.printZones.zones.find((z) => z.id === id)?.rect;
  const box = ['headline', 'oddsHeading', 'odds']
    .map(zone)
    .filter((r): r is PrintRect => !!r);
  const buy = zone('buyback');
  if (box.length < 3 || !buy) return null;
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const pad = (r: SpotRect): SpotRect => ({
    x0: r4(r.x0 - SPOT_PAD),
    x1: r4(r.x1 + SPOT_PAD),
    y0: r4(r.y0 - SPOT_PAD),
    y1: r4(r.y1 + SPOT_PAD),
  });
  return {
    odds: pad({
      x0: Math.min(...box.map((r) => r.x0)),
      x1: Math.max(...box.map((r) => r.x1)),
      y0: Math.min(...box.map((r) => r.y0)),
      y1: Math.max(...box.map((r) => r.y1)),
    }),
    buyback: pad(buy),
  };
}
