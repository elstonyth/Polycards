// The 3D pack catalogue: the 11 bundled sets, their files under public/pack-3d/,
// the front/back alpha pairing, the lookups, and the settings against the
// sources the approved renders used.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { PACK_151_GEOMETRY } from '../pack-151';
import { PACK_151_BACK_GEOMETRY } from '../pack-151-print';
import { PACK_RELIEF } from '../pack-layout';
import { PACK_FOIL } from '../pack-material';
import { PACK_PRINT_INK } from '../pack-print-inks';
import {
  GRADED_PACK_BACK_GEOMETRY,
  RAW_PACK_BACK_GEOMETRY,
} from '../pack-print-raw-geometry';
import { openPack3d } from './build';
import { PACK_3D_IDS, hasPack3d, pack3dAssets } from './index';
import { PACK_3D_SETTINGS } from './pack-3d-settings';

const IDS = [
  '151',
  'cr',
  'delta-reign',
  '30th-celebration',
  'ah',
  'bronze-pack',
  'silver-pack',
  'gold-pack',
  'platinum-pack',
  'diamond-pack',
  'poncho-pack',
];
const RAW = ['151', 'cr', 'delta-reign', '30th-celebration', 'ah'];
const repoFile = (rel: string) =>
  fileURLToPath(new URL(`../../../../${rel}`, import.meta.url));
const publicFile = (url: string) => repoFile(`public${url.split('?')[0]}`);

async function alphaOf(url: string) {
  const { data, info } = await sharp(publicFile(url))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
/** Pixels where `back`'s alpha is not `front`'s mirrored left-right. */
function mirrorMismatch(
  front: { data: Buffer; width: number; height: number },
  back: { data: Buffer; width: number; height: number },
): number {
  let n = 0;
  for (let y = 0; y < front.height; y++)
    for (let x = 0; x < front.width; x++)
      if (
        front.data[(y * front.width + x) * 4 + 3] !==
        back.data[(y * front.width + (front.width - 1 - x)) * 4 + 3]
      )
        n++;
  return n;
}

describe('3D pack catalogue', () => {
  it('lists exactly the 11 sleeve packs', () => {
    expect([...PACK_3D_IDS].sort()).toEqual([...IDS].sort());
    expect(Object.keys(PACK_3D_SETTINGS).sort()).toEqual([...IDS].sort());
  });

  it('returns nothing for a pack without a bundled set', () => {
    for (const id of [
      'free-151',
      'lucky-pack',
      '',
      'constructor',
      'toString',
    ]) {
      expect(pack3dAssets(id), id).toBeNull();
      expect(hasPack3d(id), id).toBe(false);
      expect(openPack3d(id), id).toBeNull();
    }
  });

  it('keeps the sync lookup free of three.js and heavy imports', () => {
    for (const file of [
      'index.ts',
      'pack-3d-manifest.ts',
      'pack-3d-types.ts',
    ]) {
      const src = readFileSync(
        repoFile(`src/components/pack-3d/catalog/${file}`),
        'utf8',
      );
      const imports = [
        ...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm),
      ];
      for (const m of imports)
        expect(
          m[1] !== undefined || ['./pack-3d-manifest'].includes(m[2] ?? ''),
          `${file} imports ${m[2]}`,
        ).toBe(true);
    }
  });

  for (const id of IDS) {
    describe(id, () => {
      const a = pack3dAssets(id);
      if (!a) throw new Error(`no assets for ${id}`);
      const files: [string, string, number, number][] = [
        ['front', a.front, a.width, a.height],
        ['back', a.back, a.width, a.height],
        ['frontHalf', a.frontHalf, a.halfWidth, a.halfHeight],
        ['backHalf', a.backHalf, a.halfWidth, a.halfHeight],
      ];

      it('every file exists at its stated pixel size, versioned by its content', async () => {
        for (const [name, url, w, h] of files) {
          const file = publicFile(url);
          expect(existsSync(file), `${name} ${file}`).toBe(true);
          const meta = await sharp(file).metadata();
          expect([meta.format, meta.width, meta.height], name).toEqual([
            'webp',
            w,
            h,
          ]);
          const sha = createHash('sha256')
            .update(readFileSync(file))
            .digest('hex');
          expect(url, name).toBe(
            `/pack-3d/${id}/${file.split(/[\\/]/).pop()}?v=${sha.slice(0, 8)}`,
          );
        }
        expect(a.halfWidth).toBe(Math.round(a.width / 2));
        expect(a.halfHeight).toBe(Math.round(a.height / 2));
        expect(PACK_3D_SETTINGS[id]?.backGeometry.image).toEqual({
          width: a.width,
          height: a.height,
        });
      });

      it("each back's alpha is its front's mirrored left-right", async () => {
        const [f, b, fh, bh] = await Promise.all(
          files.map(([, url]) => alphaOf(url)),
        );
        expect(mirrorMismatch(f!, b!)).toBe(0);
        expect(mirrorMismatch(fh!, bh!)).toBe(0);
      });

      it('carries the settings the approved render used', () => {
        const s = PACK_3D_SETTINGS[id];
        if (!s) throw new Error(id);
        expect(s.ink).toEqual(PACK_PRINT_INK[id]);
        expect(s.backGeometry).toEqual(
          id === '151'
            ? PACK_151_BACK_GEOMETRY
            : (RAW_PACK_BACK_GEOMETRY[id] ?? GRADED_PACK_BACK_GEOMETRY[id]),
        );
        if (id === '151') expect(s.geometry).toBe(PACK_151_GEOMETRY);
        else expect(s.geometry.pack).toBe(id);
        expect(s.material.source === 'model-defaults').toBe(RAW.includes(id));
      });

      // the graded packs compare with tracked fixtures and fail when one is missing; the raw packs'
      // JSON stays in the untracked docs/research and is compared only where present
      const own = !RAW.includes(id);
      const dir = own
        ? `src/components/pack-3d/fixtures/pack-back/${id}`
        : id === '151'
          ? 'docs/research/home-3d/pack-back'
          : `docs/research/home-3d/pack-back/${id}`;
      const packJson = repoFile(`${dir}/${id}-pack-geometry.json`);
      it.skipIf(id === '151' || (!own && !existsSync(packJson)))(
        'geometry is the research JSON',
        () => {
          const json = JSON.parse(readFileSync(packJson, 'utf8'));
          const g = PACK_3D_SETTINGS[id]!.geometry;
          expect(g.outline).toEqual(json.outline);
          expect(g.ridges).toEqual(json.ridges);
          expect(g.bounds).toEqual(json.bounds);
          expect(g.image).toEqual({
            width: json.image.width,
            height: json.image.height,
          });
        },
      );
      const matJson = repoFile(`${dir}/${id}-material.json`);
      it.skipIf(!own && !existsSync(matJson))(
        'material is the research JSON',
        () => {
          const json = JSON.parse(readFileSync(matJson, 'utf8'));
          const m = PACK_3D_SETTINGS[id]!.material;
          if (!('foil' in m)) throw new Error('model defaults');
          expect(m.foil).toEqual(json.foil);
          expect(m.relief).toEqual(json.relief);
        },
      );
    });
  }

  it("pins the model defaults the raw packs' approved renders used", () => {
    expect(PACK_FOIL).toEqual({
      metalness: 0.62,
      roughness: 0.3,
      clearcoat: 0.35,
      clearcoatRoughness: 0.14,
      sheen: 0.12,
      sheenRoughness: 0.45,
      envMapIntensity: 1.0,
      printGlow: 0.32,
      alphaInterior: 0.98,
    });
    expect(PACK_RELIEF).toEqual({ crimpSlope: 0.45, finSlope: 0.3 });
  });
});
