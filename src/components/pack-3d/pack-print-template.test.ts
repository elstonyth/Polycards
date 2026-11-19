import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ResolvedPack } from '@/lib/packs-data';
import { PACK_151_BACK_GEOMETRY, PACK_151_PRINT } from './pack-151-print';
import { packBackDetails } from './pack-back-details';
import { printLayoutIssues } from './pack-print-check';
import GEIST_WIDTHS from './pack-print-geist-widths.json';
import { ROLLOUT_PACK_DETAILS } from './pack-print-packs';
import {
  PACK_PRINT_TEMPLATE,
  packPrintSpecFromGeometry,
  printTypeScale,
  snappedZone,
  zoneRatios,
  type PackBackGeometry,
} from './pack-print-template';
import {
  layoutPackPrint,
  type MeasureText,
  type PackBackDetails,
  type PackPrintSpec,
  type PrintLayout,
} from './pack-print';

// The hand-fitted 151 spec as it stood before the template (frozen copy).
const LEGACY_151_PRINT: PackPrintSpec = {
  image: { width: 897, height: 1666 },
  orientation: 'bottom-to-top',
  zones: {
    headline: { x0: 0.65329, x1: 0.76031, y0: 0.5006, y1: 0.85834 },
    odds: { x0: 0.80825, x1: 0.92754, y0: 0.5006, y1: 0.85834 },
    buyback: { x0: 0.68004, x1: 0.89075, y0: 0.13505, y1: 0.46579 },
  },
  ink: { color: '#ffffff', softness: 0.35 },
  inset: 6,
  price: {
    font: { family: 'sans', weight: 610, size: 42.9, tracking: -0.9 },
    x: 245.6,
    baseline: 633.5,
  },
  productLine: {
    font: {
      family: 'sans',
      weight: 255,
      size: 29.05,
      tracking: -0.6,
      wordSpacing: 1.5,
    },
    x: 247.75,
    baseline: 666.5,
    separator: ' · ',
    minScale: 0.8,
  },
  odds: {
    font: { family: 'sans', weight: 255, size: 28.65, tracking: -0.65 },
    firstBaseline: 749.5,
    pitch: 33.5,
    lastBaseline: 825,
    columns: [
      { labelX: 246, valueRight: 502.3 },
      { labelX: 551.5, valueRight: 814.5 },
    ],
    valueTracking: 0.4,
    minScale: 0.6,
  },
  buyback: {
    font: { family: 'sans', weight: 278, size: 30.5, tracking: -0.36 },
    x: 899.8,
    firstBaseline: 641.9,
    pitch: 35.3,
    lastBaseline: 792,
    maxWidth: 538,
    minScale: 0.7,
  },
};

// Geist-like proportions: about 0.42 em a glyph, 0.25 em a space.
const roughMeasure: MeasureText = (text, font) =>
  Array.from(text).reduce(
    (w, ch) => w + (ch === ' ' ? 0.25 : 0.42) * font.size,
    0,
  );

// Real Geist advance widths at 100px for every string the layout measures for
// the 11 packs, recorded in Chromium by the capture stage
// (docs/research/home-3d/pack-3d/harness-text, WIDTHS_OUT=...).
const widths = GEIST_WIDTHS as Record<string, number>;
const geistMeasure: MeasureText = (text, font) => {
  const w = widths[`${Math.round(font.weight)}|${text}`];
  if (w === undefined) throw new Error(`no Geist width for "${text}"`);
  return (w * font.size) / 100;
};

const DETAILS_151 = ROLLOUT_PACK_DETAILS['151'] as PackBackDetails;
const tiers = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    label: `Tier ${i + 1}`,
    chance: `${i + 1}%`,
  }));
const DETAIL_SETS: [string, PackBackDetails][] = [
  ['151', DETAILS_151],
  ['five odds', { ...DETAILS_151, odds: tiers(5) }],
  ['eight odds', { ...DETAILS_151, odds: tiers(8) }],
  ['no odds', { ...DETAILS_151, odds: null }],
  ['free', { ...DETAILS_151, price: null, buyback: null }],
  [
    'long',
    {
      price: 'RM 12,345.67',
      productLine: [
        'Scarlet & Violet Prismatic Evolutions',
        'Pokémon',
        'Original',
        'Japanese',
        'Raw Cards',
      ],
      odds: [{ label: 'Legendary', chance: '12.345%' }],
      buyback: {
        headline: '100% instant buyback',
        rule: `${DETAILS_151.buyback?.rule} ${DETAILS_151.buyback?.rule}`,
      },
    },
  ],
  ...Object.entries(ROLLOUT_PACK_DETAILS),
];

/** A geometry with the given snapped zone rects (texture px). */
function geometryFromPx(
  width: number,
  height: number,
  px: Record<string, { x0: number; x1: number; y0: number; y1: number }>,
): PackBackGeometry {
  return {
    image: { width, height },
    printZones: {
      zones: Object.entries(px).map(([id, r]) => ({
        id,
        rect: {
          x0: r.x0 / width,
          x1: r.x1 / width,
          y0: r.y0 / height,
          y1: r.y1 / height,
        },
      })),
    },
  };
}

/** 151's snapped zones in texture px. */
const ZONES_151_PX = Object.fromEntries(
  PACK_151_BACK_GEOMETRY.printZones.zones.map((z) => [
    z.id,
    {
      x0: Math.round(z.rect.x0 * 897),
      x1: Math.round(z.rect.x1 * 897),
      y0: Math.round(z.rect.y0 * 1666),
      y1: Math.round(z.rect.y1 * 1666),
    },
  ]),
);

const runsOf = (l: PrintLayout) => l.runs;

describe('zone-relative print spec', () => {
  it('builds exactly the hand-fitted 151 spec from the 151 geometry', () => {
    // the only deliberate changes: a price floor to report against, and the
    // product line's lower floor (the live names need it; see the template)
    const built = packPrintSpecFromGeometry(PACK_151_BACK_GEOMETRY);
    expect(built.price.minScale).toBe(0.75);
    expect(built.productLine.minScale).toBe(0.72);
    const { minScale: _price, ...price } = built.price;
    expect({
      ...built,
      price,
      productLine: { ...built.productLine, minScale: 0.8 },
    }).toEqual(LEGACY_151_PRINT);
    expect(PACK_151_PRINT).toEqual(built);
  });

  it('lays out runs IDENTICAL to the hand-fitted 151 spec (text, x, y, size, width)', () => {
    const sameFloor = packPrintSpecFromGeometry(
      PACK_151_BACK_GEOMETRY,
      undefined,
      {
        ...PACK_PRINT_TEMPLATE,
        productLine: { ...PACK_PRINT_TEMPLATE.productLine, minScale: 0.8 },
      },
    );
    for (const [name, details] of DETAIL_SETS)
      for (const k of [1, 2, 0.5]) {
        const a = layoutPackPrint(
          details,
          sameFloor,
          897 * k,
          1666 * k,
          roughMeasure,
        );
        const b = layoutPackPrint(
          details,
          LEGACY_151_PRINT,
          897 * k,
          1666 * k,
          roughMeasure,
        );
        expect(runsOf(a), `${name} at ${k}x`).toEqual(runsOf(b));
        expect(a.plate).toBe(b.plate);
        expect(a.ink).toEqual(b.ink);
      }
    // and with the shipped floor, wherever the floor does not decide
    for (const [name, details] of DETAIL_SETS.filter(([n]) => n !== 'long')) {
      const a = layoutPackPrint(
        details,
        PACK_151_PRINT,
        897,
        1666,
        roughMeasure,
      );
      const b = layoutPackPrint(
        details,
        LEGACY_151_PRINT,
        897,
        1666,
        roughMeasure,
      );
      expect(runsOf(a), name).toEqual(runsOf(b));
    }
  });

  // docs/research is untracked: check the copy only where the JSON exists
  const json151 = fileURLToPath(
    new URL(
      '../../../docs/research/home-3d/pack-back/151-back-geometry.json',
      import.meta.url,
    ),
  );
  it.skipIf(!existsSync(json151))(
    'keeps the 151 geometry in step with 151-back-geometry.json',
    () => {
      const json = JSON.parse(
        readFileSync(json151, 'utf8'),
      ) as PackBackGeometry;
      expect(json.image.width).toBe(897);
      expect(json.image.height).toBe(1666);
      for (const z of PACK_151_BACK_GEOMETRY.printZones.zones)
        expect(json.printZones.zones.find((j) => j.id === z.id)?.rect).toEqual(
          z.rect,
        );
      // the builder takes the JSON as it is
      expect(packPrintSpecFromGeometry(json)).toEqual(PACK_151_PRINT);
    },
  );

  it("measures packs against 151's snapped zones", () => {
    for (const id of ['headline', 'odds', 'buyback'] as const) {
      const r = PACK_151_PRINT.zones[id];
      const z = snappedZone(r, 897, 1666);
      expect(Number.isInteger(z.u0) && Number.isInteger(z.v1)).toBe(true);
      expect(PACK_PRINT_TEMPLATE.reference[id]).toEqual({
        along: z.u1 - z.u0,
        across: z.v1 - z.v0,
      });
    }
    expect(printTypeScale(PACK_151_BACK_GEOMETRY)).toBe(1);
  });

  it('throws when a geometry lacks a text zone', () => {
    expect(() =>
      packPrintSpecFromGeometry({
        image: { width: 897, height: 1666 },
        printZones: { zones: [] },
      }),
    ).toThrow(/headline/);
  });
});

describe('size rule on other plates (synthetic geometry)', () => {
  const base = layoutPackPrint(
    DETAILS_151,
    PACK_151_PRINT,
    897,
    1666,
    roughMeasure,
  );

  it('shifted, same size: every run moves by the shift, type unchanged', () => {
    // a 925-wide plate whose rows were moved 17 px right and 9 px up
    const dx = 17,
      dy = -9;
    const shifted = Object.fromEntries(
      Object.entries(ZONES_151_PX).map(([id, r]) => [
        id,
        { x0: r.x0 + dx, x1: r.x1 + dx, y0: r.y0 + dy, y1: r.y1 + dy },
      ]),
    );
    const geo = geometryFromPx(925, 1666, shifted);
    expect(printTypeScale(geo)).toBe(1);
    const spec = packPrintSpecFromGeometry(geo);
    const l = layoutPackPrint(DETAILS_151, spec, 925, 1666, roughMeasure);
    expect(l.runs).toHaveLength(base.runs.length);
    l.runs.forEach((run, i) => {
      const b = base.runs[i];
      if (!b) throw new Error('run count');
      expect(run.text).toBe(b.text);
      expect(run.font).toEqual(b.font);
      expect(run.width).toBeCloseTo(b.width, 9);
      expect(run.x).toBeCloseTo(b.x - dy, 9); // texture y up = along the line
      expect(run.y).toBeCloseTo(b.y + dx, 9); // texture x right = down the stack
    });
    expect(printLayoutIssues(l)).toEqual([]);
  });

  it('uniformly scaled (2x, exact): positions and type scale with it', () => {
    const geo: PackBackGeometry = {
      ...PACK_151_BACK_GEOMETRY,
      image: { width: 1794, height: 3332 },
    };
    expect(printTypeScale(geo)).toBe(2);
    const spec = packPrintSpecFromGeometry(geo);
    const l = layoutPackPrint(DETAILS_151, spec, 1794, 3332, roughMeasure);
    l.runs.forEach((run, i) => {
      const b = base.runs[i];
      expect(run.text).toBe(b?.text);
      expect(run.x).toBeCloseTo((b?.x ?? 0) * 2, 9);
      expect(run.y).toBeCloseTo((b?.y ?? 0) * 2, 9);
      expect(run.font.size).toBeCloseTo((b?.font.size ?? 0) * 2, 9);
    });
  });

  it('uniformly scaled (0.85, snapped to px, moved): same proportion to the heading', () => {
    const s = 0.85;
    const ox = 40,
      oy = 30;
    const scaled = Object.fromEntries(
      Object.entries(ZONES_151_PX).map(([id, r]) => [
        id,
        {
          x0: Math.round(r.x0 * s) + ox,
          x1: Math.round(r.x1 * s) + ox,
          y0: Math.round(r.y0 * s) + oy,
          y1: Math.round(r.y1 * s) + oy,
        },
      ]),
    );
    const geo = geometryFromPx(800, 1500, scaled);
    const t = printTypeScale(geo);
    expect(t).toBeGreaterThan(s - 0.012);
    expect(t).toBeLessThan(s + 0.012);
    const spec = packPrintSpecFromGeometry(geo);
    const l = layoutPackPrint(DETAILS_151, spec, 800, 1500, roughMeasure);
    expect(printLayoutIssues(l)).toEqual([]);
    // type against the fixed heading's depth stays 151's, within the px snap
    const heading = (px: { x0: number; x1: number }) => px.x1 - px.x0;
    const h151 = heading(
      ZONES_151_PX.oddsHeading as { x0: number; x1: number },
    );
    const hNew = heading(scaled.oddsHeading as { x0: number; x1: number });
    const label151 = base.runs.find((r) => r.role === 'oddsLabel');
    const labelNew = l.runs.find((r) => r.role === 'oddsLabel');
    expect((labelNew?.font.size ?? 0) / hNew).toBeCloseTo(
      (label151?.font.size ?? 0) / h151,
      1,
    );
    // rows keep their place in the zone
    const z = snappedZone(spec.zones.odds, 800, 1500);
    expect(spec.odds.firstBaseline).toBeCloseTo(
      z.v0 + PACK_PRINT_TEMPLATE.odds.firstDy * zoneRatios(geo).odds.across,
      9,
    );
  });

  it('unevenly scaled (737 x 1474, same fractions): type follows the smaller ratio, stays inside', () => {
    const geo: PackBackGeometry = {
      ...PACK_151_BACK_GEOMETRY,
      image: { width: 737, height: 1474 },
    };
    const r = zoneRatios(geo);
    expect(r.headline.across).toBeLessThan(r.headline.along);
    const t = printTypeScale(geo);
    expect(t).toBeCloseTo(
      Math.min(r.headline.across, r.odds.across, r.buyback.across),
      9,
    );
    expect(t).toBeGreaterThan(0.8);
    expect(t).toBeLessThan(0.83);
    const spec = packPrintSpecFromGeometry(geo);
    for (const [name, details] of Object.entries(ROLLOUT_PACK_DETAILS)) {
      const l = layoutPackPrint(details, spec, 737, 1474, roughMeasure);
      expect(printLayoutIssues(l), name).toEqual([]);
    }
  });

  it("'reference' keeps 151's px; a number forces the type scale", () => {
    const geo: PackBackGeometry = {
      ...PACK_151_BACK_GEOMETRY,
      image: { width: 1794, height: 3332 },
    };
    const ref = packPrintSpecFromGeometry(geo, {
      offsets: 'reference',
      type: 'reference',
    });
    expect(ref.price.font.size).toBe(42.9);
    expect(ref.price.x).toBe(236 * 2 + 9.6);
    const forced = packPrintSpecFromGeometry(geo, {
      offsets: 'zone',
      type: 1.5,
    });
    expect(forced.odds.font.size).toBeCloseTo(28.65 * 1.5, 9);
    expect(forced.odds.pitch).toBeCloseTo(33.5 * 2, 9);
  });
});

describe('every live pack on the 151 plate (real Geist widths)', () => {
  // product-line scale each pack needs on the 151 plate (Chromium, Geist);
  // every other field sets at full size
  const LINE_SCALE: Record<string, number> = {
    '151': 1,
    cr: 0.838,
    'delta-reign': 0.862,
    '30th-celebration': 0.785,
    ah: 0.774,
    'bronze-pack': 1,
    'silver-pack': 1,
    'gold-pack': 1,
    'platinum-pack': 1,
    'diamond-pack': 1,
    'poncho-pack': 1,
  };

  for (const [slug, details] of Object.entries(ROLLOUT_PACK_DETAILS)) {
    it(`${slug}: whole wording, inside its zones, nothing colliding`, () => {
      const l = layoutPackPrint(
        details,
        PACK_151_PRINT,
        897,
        1666,
        geistMeasure,
      );
      expect(printLayoutIssues(l)).toEqual([]);
      const line = l.runs.find((r) => r.role === 'productLine');
      expect(line?.text).toBe(details.productLine.join(' · '));
      expect(l.runs.find((r) => r.role === 'price')?.text).toBe(details.price);
      expect(l.fit?.price).toEqual({ scale: 1, belowMin: false });
      expect(l.fit?.productLine?.dropped).toEqual([]);
      expect(l.fit?.productLine?.scale).toBeCloseTo(LINE_SCALE[slug] ?? 0, 3);
      expect(l.fit?.odds?.scale).toBe(1);
      expect(l.fit?.buyback).toEqual({ scale: 1, lines: 5, overflow: false });
      expect(l.runs.filter((r) => r.role === 'oddsLabel')).toHaveLength(6);
    });
  }

  it('a price wider than its room is shrunk whole, never cut, and flagged under its floor', () => {
    const huge = 'RM 22,000.00 '.repeat(4).trim();
    const full = layoutPackPrint(
      { ...DETAILS_151, price: 'RM 22,000.00' },
      PACK_151_PRINT,
      897,
      1666,
      roughMeasure,
    );
    expect(full.fit?.price).toEqual({ scale: 1, belowMin: false });
    const l = layoutPackPrint(
      { ...DETAILS_151, price: huge },
      PACK_151_PRINT,
      897,
      1666,
      roughMeasure,
    );
    const price = l.runs.find((r) => r.role === 'price');
    expect(price?.text).toBe(huge);
    expect(l.fit?.price?.scale).toBeLessThan(0.75);
    expect(l.fit?.price?.belowMin).toBe(true);
    expect(printLayoutIssues(l)).toContain(
      `price set at ${l.fit?.price?.scale.toFixed(3)}, below its floor`,
    );
    expect(
      printLayoutIssues(l).filter((i) => !i.startsWith('price set')),
    ).toEqual([]);
  });
});

describe('the fixture is what the pack pages print (packBackDetails)', () => {
  const rawTiers = {
    Immortal: 0.1,
    Legendary: 1.4,
    Mythical: 3.5,
    Rare: 22,
    Uncommon: 30,
    Common: 43,
  };
  const gradedTiers = {
    Immortal: 0.2,
    Legendary: 2.4,
    Mythical: 3.4,
    Rare: 22,
    Uncommon: 30,
    Common: 42,
  };
  const pack = (
    id: string,
    name: string,
    priceMyr: number,
    kind: 'raw' | 'classic' | 'special',
  ): ResolvedPack => ({
    id,
    name,
    priceMyr,
    image: '/x.webp',
    categoryId: 'pokemon',
    categoryName: 'Pokémon',
    icon: '/i.webp',
    ...(kind === 'raw'
      ? { packType: 'original', language: 'en', group: 'RAW', psa10: false }
      : { packType: kind, group: 'GRADED', psa10: true }),
  });
  const PAGES: [ResolvedPack, typeof rawTiers][] = [
    [pack('151', '151', 40, 'raw'), rawTiers],
    [pack('cr', 'Chaos Rising', 15, 'raw'), rawTiers],
    [pack('delta-reign', 'Delta Reign', 18, 'raw'), rawTiers],
    [pack('30th-celebration', '30th Celebration', 45, 'raw'), rawTiers],
    [pack('ah', 'Ascended Heroes', 50, 'raw'), rawTiers],
    [pack('bronze-pack', 'Bronze Pack', 300, 'classic'), gradedTiers],
    [pack('silver-pack', 'Silver Pack', 600, 'classic'), gradedTiers],
    [pack('gold-pack', 'Gold Pack', 1200, 'classic'), gradedTiers],
    [pack('platinum-pack', 'Platinum Pack', 2500, 'classic'), gradedTiers],
    [pack('diamond-pack', 'Diamond Pack', 5000, 'classic'), gradedTiers],
    [pack('poncho-pack', 'Poncho Pack', 22000, 'special'), gradedTiers],
  ];

  it('covers the same 11 packs', () => {
    expect(PAGES.map(([p]) => p.id)).toEqual(Object.keys(ROLLOUT_PACK_DETAILS));
  });

  for (const [p, t] of PAGES)
    it(`${p.id}`, () => {
      expect(packBackDetails(p, { tiers: t })).toEqual(
        ROLLOUT_PACK_DETAILS[p.id],
      );
    });

  it('graded lines read as the audit found them on the live pages', () => {
    expect(ROLLOUT_PACK_DETAILS['bronze-pack']?.productLine.join(' · ')).toBe(
      'Bronze Pack · Pokémon · Classic · Graded',
    );
    expect(ROLLOUT_PACK_DETAILS['poncho-pack']?.productLine.join(' · ')).toBe(
      'Poncho Pack · Pokémon · Special · Graded',
    );
  });
});
