// The 3D capsule packs: the five tiers, their files under public/pack-3d/, the
// sync lookup, the shapes, the rest pose and the weight budget.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PACK_3D_IDS } from '../catalog/index';
import { capsuleLogoBytes, capsuleRest, openCapsule3d } from './build';
import {
  CAPSULE_DETAIL,
  CONTENTS_RADIUS,
  GLASS_RADIUS,
  capProfile,
  capsuleShapes,
  lathe,
  shapeBytes,
} from './capsule-geometry';
import { CAPSULE_LOGO_ATLAS } from './capsule-manifest';
import type { Capsule3dResolution, Capsule3dTexture } from './capsule-types';
import { CAPSULE_3D_IDS, capsule3dAssets, hasCapsule3d } from './index';

const IDS = [
  'lucky-pack',
  'silver-capsule',
  'gold-capsule',
  'platinum-capsule',
  'diamond-capsule',
];
const repoFile = (rel: string) =>
  fileURLToPath(new URL(`../../../../${rel}`, import.meta.url));
const publicFile = (url: string) => repoFile(`public${url.split('?')[0]}`);
const bytesOf = (t: Capsule3dTexture, mips: boolean) =>
  Math.round(t.width * t.height * 4 * (mips ? 4 / 3 : 1));

async function checkFile(t: Capsule3dTexture) {
  const file = publicFile(t.url);
  expect(existsSync(file), file).toBe(true);
  const meta = await sharp(file).metadata();
  expect([meta.format, meta.width, meta.height], t.url).toEqual([
    'webp',
    t.width,
    t.height,
  ]);
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  expect(t.url.endsWith(`?v=${sha.slice(0, 8)}`), t.url).toBe(true);
}

describe('3D capsule lookup', () => {
  it('lists exactly the five capsule packs', () => {
    expect([...CAPSULE_3D_IDS].sort()).toEqual([...IDS].sort());
    for (const id of IDS) expect(hasCapsule3d(id)).toBe(true);
  });

  it('returns nothing for other packs and prototype keys', () => {
    for (const id of [
      'gold-pack',
      '151',
      'free-151',
      '',
      'constructor',
      'toString',
    ]) {
      expect(capsule3dAssets(id), id).toBeNull();
      expect(openCapsule3d(id), id).toBeNull();
    }
  });

  it('stays out of the sleeve catalogue', () => {
    for (const id of IDS) expect(PACK_3D_IDS.includes(id), id).toBe(false);
  });

  it('keeps the sync lookup free of three.js', () => {
    for (const file of [
      'index.ts',
      'capsule-manifest.ts',
      'capsule-types.ts',
    ]) {
      const src = readFileSync(
        repoFile(`src/components/pack-3d/capsule/${file}`),
        'utf8',
      );
      for (const m of src.matchAll(
        /^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm,
      ))
        expect(
          m[1] !== undefined || m[2] === './capsule-manifest',
          `${file} imports ${m[2]}`,
        ).toBe(true);
    }
  });
});

describe('3D capsule files', () => {
  for (const id of IDS) {
    const a = capsule3dAssets(id)!;
    it(`${id}: every texture exists at its stated size, versioned by content`, async () => {
      for (const res of ['full', 'half'] as Capsule3dResolution[]) {
        const set = a.files[res];
        for (const t of Object.values(set)) if (t) await checkFile(t);
      }
      // half: matcaps half size, contents half size (rounded)
      expect(a.files.half.capMatcap.width).toBe(
        a.files.full.capMatcap.width / 2,
      );
      expect(a.files.half.contents.width).toBe(
        Math.round(a.files.full.contents.width / 2),
      );
      expect(a.files.half.contents.height).toBe(
        Math.round(a.files.full.contents.height / 2),
      );
    });

    it(`${id}: carries its own fit, logo placement and crops`, () => {
      expect(a.fit.F).toBe(24);
      expect(a.fit.HC).toBeGreaterThan(1.3);
      expect(a.fit.HC).toBeLessThan(1.7);
      expect(Math.abs(a.fit.SEAM)).toBeLessThan(0.2);
      for (const b of ['mark', 'word'] as const) {
        expect(a.logo[b].k).toBeGreaterThan(0.003);
        expect(a.logo[b].k).toBeLessThan(0.012);
        expect(Math.abs(a.logo[b].inflate)).toBeLessThan(3.01);
      }
      for (const r of [a.contentsRect, a.detailRect ?? [0, 0, 1, 1]]) {
        expect(
          r[0]! >= 0 &&
            r[1]! >= 0 &&
            r[0]! + r[2]! <= 1.0001 &&
            r[1]! + r[3]! <= 1.0001,
        ).toBe(true);
      }
      expect(a.logo.ink).toBe(
        id === 'lucky-pack' || id === 'platinum-capsule' ? 'white' : 'dark',
      );
      expect(a.cap === 'glitter').toBe(id === 'diamond-capsule');
      expect(!!a.files.full.detail).toBe(id === 'diamond-capsule');
      expect(!!a.detailRect).toBe(id === 'diamond-capsule');
    });
  }

  it('the shared logo mask exists and its block rects fit the atlas', async () => {
    for (const res of ['full', 'half'] as Capsule3dResolution[]) {
      const f = CAPSULE_LOGO_ATLAS.files[res];
      await checkFile(f);
      for (const r of [f.rects.mark, f.rects.word]) {
        expect(
          r[0]! >= 0 &&
            r[1]! >= 0 &&
            r[0]! + r[2]! <= 1.0001 &&
            r[1]! + r[3]! <= 1.0001,
        ).toBe(true);
      }
    }
  });
});

describe('3D capsule shapes', () => {
  const d = { HC: 1.47, SEAM: 0.04 };

  it('sweeps a profile with valid 16-bit indices and no pole slivers', () => {
    const l = lathe(capProfile(d), 8);
    expect(l.vertices).toBe(9 * capProfile(d).length);
    expect(Math.max(...l.index)).toBeLessThan(l.vertices);
    expect(l.index.length % 3).toBe(0);
    // the tip row has radius 0: one triangle per segment there, not two
    const rows = capProfile(d).length;
    expect(l.triangles).toBe(8 * (2 * (rows - 1) - 1));
  });

  it('puts the glass and contents on their radii and the cap on radius 1', () => {
    const s = capsuleShapes(d);
    const radius = (p: Float32Array, i: number) =>
      Math.hypot(p[i * 3]!, p[i * 3 + 2]!);
    const onCyl = (l: typeof s.glass, r: number) => {
      let n = 0;
      for (let i = 0; i < l.vertices; i++) {
        const y = l.positions[i * 3 + 1]!;
        if (y > -d.HC + 1e-6 && y < d.SEAM) {
          expect(radius(l.positions, i)).toBeCloseTo(r, 5);
          n++;
        }
      }
      return n;
    };
    expect(onCyl(s.glass, GLASS_RADIUS)).toBeGreaterThan(0);
    expect(onCyl(s.contents, CONTENTS_RADIUS)).toBeGreaterThan(0);
    const top = Math.max(
      ...Array.from(
        { length: s.cap.vertices },
        (_, i) => s.cap.positions[i * 3 + 1]!,
      ),
    );
    expect(top).toBeCloseTo(d.HC + 1, 5);
  });

  it('stays inside the weight budget', () => {
    for (const id of IDS) {
      const a = capsule3dAssets(id)!;
      const s = capsuleShapes(
        { HC: a.fit.HC, SEAM: a.fit.SEAM },
        CAPSULE_DETAIL,
      );
      const geo = shapeBytes(s);
      expect(geo).toBeLessThan(1024 * 1024);
      const tex = (res: Capsule3dResolution) => {
        const f = a.files[res];
        return (
          bytesOf(f.capMatcap, false) +
          bytesOf(f.glassMatcap, false) +
          bytesOf(f.logoMatcap, false) +
          bytesOf(f.contents, true) +
          (f.detail ? bytesOf(f.detail, true) : 0) +
          capsuleLogoBytes(res)
        );
      };
      expect(geo + tex('half'), `${id} phone`).toBeLessThan(4 * 1024 * 1024);
      expect(geo + tex('full'), `${id} desktop`).toBeLessThan(10 * 1024 * 1024);
    }
  });
});

describe('3D capsule rest pose', () => {
  it("projects the capsule's centre where the fit put it in the picture", () => {
    for (const id of IDS) {
      const a = capsule3dAssets(id)!;
      const rest = capsuleRest(a);
      const c = new THREE.Vector4(0, 0, 0, 1).applyMatrix4(rest.mvp);
      const t = Math.tan((a.fit.F * Math.PI) / 360);
      expect(c.x / c.w).toBeCloseTo(a.fit.tx / a.fit.D / (t * rest.aspect), 6);
      expect(c.y / c.w).toBeCloseTo(a.fit.ty / a.fit.D / t, 6);
      // the picture's height at the capsule's depth is one model unit
      expect(2 * a.fit.D * t * rest.scale).toBeCloseTo(1, 9);
    }
  });
});
