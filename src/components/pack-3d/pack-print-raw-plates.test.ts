// The size rule on the raw and graded packs' real plates (geometry inlined from
// docs/research/home-3d/pack-back/<pack>/). The pixel-level proofs (cap height
// against the fixed heading, label start, zero changed pixels outside the
// zones, edge softness, contrast) are in live-text/raw-packs/measure.json and
// live-text/graded-packs/measure.json, made by
// docs/research/home-3d/pack-3d/harness-text/measure-raw.cjs.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PACK_151_PRINT } from './pack-151-print';
import { printLayoutIssues } from './pack-print-check';
import GEIST_WIDTHS from './pack-print-geist-widths.json';
import { PACK_PRINT_INK } from './pack-print-inks';
import { ROLLOUT_PACK_DETAILS } from './pack-print-packs';
import {
  GRADED_PACK_BACK_GEOMETRY,
  RAW_PACK_BACK_GEOMETRY,
} from './pack-print-raw-geometry';
import {
  PACK_PRINT_TEMPLATE,
  anchorZone,
  packPrintSpecFromGeometry,
  printTypeScale,
  snappedZone,
  zoneRatios,
  type PackBackGeometry,
} from './pack-print-template';
import { layoutPackPrint, type MeasureText } from './pack-print';

const widths = GEIST_WIDTHS as Record<string, number>;
const geistMeasure: MeasureText = (text, font) => {
  const w = widths[`${Math.round(font.weight)}|${text}`];
  if (w === undefined) throw new Error(`no Geist width for "${text}"`);
  return (w * font.size) / 100;
};

const geometry = (pack: string): PackBackGeometry => {
  const g = RAW_PACK_BACK_GEOMETRY[pack] ?? GRADED_PACK_BACK_GEOMETRY[pack];
  if (!g) throw new Error(`no geometry for ${pack}`);
  return g;
};
const jsonFile = (pack: string) =>
  fileURLToPath(
    new URL(
      `../../../docs/research/home-3d/pack-back/${pack}/${pack}-back-geometry.json`,
      import.meta.url,
    ),
  );

// how the plate agent brought 151's art to each front (back-ref.json placement.s)
const RAW: [string, number][] = [
  ['cr', 0.931],
  ['delta-reign', 1],
  ['30th-celebration', 0.787],
  ['ah', 1],
  // graded family: 151's art at scale 1, whole-px shifts
  ['bronze-pack', 1],
  ['silver-pack', 1],
  ['gold-pack', 1],
  ['platinum-pack', 1],
  ['diamond-pack', 1],
  ['poncho-pack', 1],
];

describe('raw and graded packs on their own plates', () => {
  for (const [pack, s] of RAW) {
    // docs/research is untracked: check the copy only where the JSON exists
    it.skipIf(!existsSync(jsonFile(pack)))(
      `${pack}: the inlined geometry matches ${pack}-back-geometry.json`,
      () => {
        const json = JSON.parse(
          readFileSync(jsonFile(pack), 'utf8'),
        ) as PackBackGeometry;
        expect(json.image.width).toBe(geometry(pack).image.width);
        expect(json.image.height).toBe(geometry(pack).image.height);
        for (const z of geometry(pack).printZones.zones)
          expect(
            json.printZones.zones.find((j) => j.id === z.id)?.rect,
            z.id,
          ).toEqual(z.rect);
      },
    );

    it(`${pack}: every zone ratio is ${s}, so the type is set at ${s}`, () => {
      const geo = geometry(pack);
      const r = zoneRatios(geo);
      // within 0.1 px over the zone's size (the edges' precision)
      for (const id of ['headline', 'odds', 'buyback'] as const) {
        expect(Math.abs(r[id].along - s), `${id} along`).toBeLessThan(0.0015);
        expect(Math.abs(r[id].across - s), `${id} across`).toBeLessThan(0.0015);
      }
      expect(Math.abs(printTypeScale(geo) - s)).toBeLessThan(0.0015);
    });

    it(`${pack}: positions follow the plate's own move and scale of 151's`, () => {
      const geo = geometry(pack);
      const spec = packPrintSpecFromGeometry(geo);
      const z = anchorZone(spec.zones.odds, geo.image.width, geo.image.height);
      const t = printTypeScale(geo);
      // 151: first label 10 px into the zone, first baseline 24.5 px down
      expect(spec.odds.columns[0]?.labelX).toBeCloseTo(z.u0 + 10 * t, 1);
      expect(spec.odds.firstBaseline).toBeCloseTo(z.v0 + 24.5 * t, 1);
      expect(spec.odds.font.size).toBeCloseTo(
        PACK_PRINT_TEMPLATE.odds.font.size * t,
        1,
      );
    });

    it(`${pack}: its strings fit its own plate as on 151, nothing out of zone`, () => {
      const geo = geometry(pack);
      const details = ROLLOUT_PACK_DETAILS[pack];
      if (!details) throw new Error(pack);
      const spec = packPrintSpecFromGeometry({
        ...geo,
        printInk: PACK_PRINT_INK[pack],
      });
      const { width, height } = geo.image;
      const l = layoutPackPrint(details, spec, width, height, geistMeasure);
      expect(printLayoutIssues(l)).toEqual([]);
      // and inside the whole-px rectangles the plate blanked
      for (const run of l.runs) {
        const zone =
          run.role === 'buyback'
            ? 'buyback'
            : run.role.startsWith('odds')
              ? 'odds'
              : 'headline';
        const b = snappedZone(spec.zones[zone], width, height);
        const u0 = run.align === 'right' ? run.x - run.width : run.x;
        expect(u0, run.text).toBeGreaterThanOrEqual(b.u0);
        expect(u0 + run.width, run.text).toBeLessThanOrEqual(b.u1);
      }
      const on151 = layoutPackPrint(
        details,
        PACK_151_PRINT,
        897,
        1666,
        geistMeasure,
      );
      expect(l.fit?.productLine?.scale).toBeCloseTo(
        on151.fit?.productLine?.scale ?? 0,
        2,
      );
      expect(l.fit?.buyback).toEqual(on151.fit?.buyback);
      expect(l.ink).toEqual({
        color: PACK_PRINT_INK[pack]?.color,
        softness: PACK_PRINT_INK[pack]?.softness,
      });
    });
  }

  it("reads zone edges at 0.1 px: cr's resampled zones keep their fraction", () => {
    const geo = geometry('cr');
    const rect = geo.printZones.zones.find((z) => z.id === 'headline')?.rect;
    if (!rect) throw new Error('no headline');
    expect(anchorZone(rect, 853, 1666).v0).toBe(557.5);
    expect(snappedZone(rect, 853, 1666).v0).toBe(557); // 557.495 rounds down
  });

  it('carries 151 unchanged through the ink table', () => {
    expect(PACK_PRINT_INK['151']).toEqual(PACK_151_PRINT.ink);
  });
});
