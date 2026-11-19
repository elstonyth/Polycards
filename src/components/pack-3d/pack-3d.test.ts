import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { PACK_151_GEOMETRY } from './pack-151';
import {
  PACK_PROPORTIONS,
  finRaise,
  halfDepth,
  outlineAt,
  toPackLayout,
  type PackGeometry,
} from './pack-layout';
import {
  fitRidges,
  measureRowEdges,
  outlineMirrorError,
  simplifyEdges,
  type RgbaImage,
} from './pack-measure';
import { createPackModel } from './pack-model';
import {
  PACK_DETAIL,
  buildPackSurface,
  openEdges,
  signedVolume,
} from './pack-surface';

const layout = toPackLayout(PACK_151_GEOMETRY);
const surface = buildPackSurface(layout);
const frontCount = (surface.ring + 2) / 2;

const vertex = (j: number, k: number) => {
  const o = j * surface.ring + k;
  return {
    x: surface.positions[o * 3] as number,
    y: surface.positions[o * 3 + 1] as number,
    z: surface.positions[o * 3 + 2] as number,
    u: surface.uvs[o * 2] as number,
    v: surface.uvs[o * 2 + 1] as number,
    face: surface.faces[o] as number,
    nx: surface.normals[o * 3] as number,
  };
};

describe('pack layout', () => {
  it('turns the back-art numbers into the front frame once', () => {
    expect(layout.fin.x0).toBeCloseTo(1 - 0.5853, 6);
    expect(layout.fin.x1).toBeCloseTo(1 - 0.4939, 6);
    expect(layout.body.x0).toBeCloseTo(1 - 0.9766, 6);
    expect(layout.aspect).toBeCloseTo(897 / 1666, 6);
    // The fin's ridge run is mirrored with it.
    const fin = PACK_151_GEOMETRY.ridges?.fin;
    expect(layout.ridges.fin?.crest).toBeCloseTo(1 - (fin?.crest ?? 0), 6);
  });

  it('mirrors the measured outline and interpolates between knots', () => {
    const middle = outlineAt(layout, 0.5);
    expect(middle.x0).toBeGreaterThan(0.02);
    expect(middle.x0).toBeLessThan(0.03);
    expect(middle.x1).toBeGreaterThan(0.97);
    // The crimps run nearly the full width; the body is pulled in.
    const crimp = outlineAt(layout, 0.03);
    expect(crimp.x0).toBeLessThan(middle.x0);
    expect(crimp.x1).toBeGreaterThan(middle.x1);
  });

  it('falls back to a drawn outline without a measured one', () => {
    const { outline: _outline, ...bare } = PACK_151_GEOMETRY;
    const drawn = toPackLayout(bare as PackGeometry);
    expect(outlineAt(drawn, 0.5).x0).toBeCloseTo(1 - 0.9766, 6);
    expect(outlineAt(drawn, 0.02).x1).toBeCloseTo(1, 2);
  });

  it('closes to nothing on the sealed edges, stays thin on the crimps', () => {
    expect(halfDepth(layout, layout.top)).toBe(0);
    expect(halfDepth(layout, layout.bottom)).toBe(0);
    expect(halfDepth(layout, 0.03)).toBeCloseTo(PACK_PROPORTIONS.sealHalf, 6);
    const belly = halfDepth(layout, 0.5);
    expect(belly).toBeCloseTo(PACK_PROPORTIONS.bellyHalf, 6);
    // Rises monotonically off the top seal.
    let last = 0;
    for (let y = layout.crimpTop.y1; y < 0.3; y += 0.005) {
      const d = halfDepth(layout, y);
      expect(d).toBeGreaterThanOrEqual(last - 1e-9);
      last = d;
    }
  });

  it('raises the fin only inside its band', () => {
    const middle = (layout.fin.x0 + layout.fin.x1) / 2;
    expect(finRaise(layout, middle, 0.5)).toBeCloseTo(
      PACK_PROPORTIONS.finRaise,
      6,
    );
    expect(finRaise(layout, 0.2, 0.5)).toBe(0);
    expect(finRaise(layout, middle, layout.top)).toBe(0);
  });
});

describe('pack surface', () => {
  it('is one closed, consistently wound surface facing outward', () => {
    expect(openEdges(surface.indices)).toEqual({ open: 0, flipped: 0 });
    expect(signedVolume(surface.positions, surface.indices)).toBeGreaterThan(0);
  });

  it('stays light enough for a phone scene of eleven packs', () => {
    const triangles = surface.indices.length / 3;
    expect(triangles).toBeLessThan(6500);
    expect(surface.rows).toBeGreaterThan(40);
    expect(PACK_DETAIL.foldSegments).toBeGreaterThanOrEqual(3);
  });

  it('meets front and back on the side folds with no gap', () => {
    for (let j = 1; j < surface.rows - 1; j++) {
      for (const k of [0, frontCount - 1]) {
        const seam = vertex(j, k);
        expect(seam.z).toBeCloseTo(0, 9);
        expect(seam.face).toBe(0.5);
        // Shared by both faces, so its normal points straight out sideways.
        if (surface.rowY[j]! > 0.15 && surface.rowY[j]! < 0.85)
          expect(Math.abs(seam.nx)).toBeGreaterThan(0.97);
      }
    }
  });

  it('mirrors the back of the front in depth, apart from the fin', () => {
    let worst = 0;
    for (let j = 0; j < surface.rows; j++) {
      for (let k = 1; k < frontCount - 1; k++) {
        const front = vertex(j, k);
        const back = vertex(j, surface.ring - k);
        expect(back.x).toBeCloseTo(front.x, 7);
        expect(back.y).toBeCloseTo(front.y, 7);
        expect(back.u).toBeCloseTo(front.u, 7);
        expect(front.z).toBeGreaterThanOrEqual(0);
        const off = Math.abs(back.z + front.z);
        if (front.u < layout.fin.x0 - 0.02 || front.u > layout.fin.x1 + 0.02)
          expect(off).toBeLessThan(1e-7);
        worst = Math.max(worst, off);
      }
    }
    expect(worst).toBeLessThanOrEqual(PACK_PROPORTIONS.finRaise + 1e-7);
  });

  it('keeps every texture coordinate on opaque art', () => {
    for (let j = 0; j < surface.rows; j++) {
      const y = surface.rowY[j]!;
      const span = outlineAt(layout, y);
      for (let k = 0; k < surface.ring; k++) {
        const { u, v } = vertex(j, k);
        expect(u).toBeGreaterThanOrEqual(span.x0 + layout.texel.x);
        expect(u).toBeLessThanOrEqual(span.x1 - layout.texel.x);
        expect(1 - v).toBeGreaterThanOrEqual(layout.top);
        expect(1 - v).toBeLessThanOrEqual(layout.bottom);
      }
    }
  });

  it('maps the print 1:1 across the faces (no stretch)', () => {
    // Along each face row, sleeve length over art length stays near 1;
    // only the side folds (outermost columns) compress the rim.
    const F = PACK_DETAIL.foldSegments;
    let worst = 0;
    for (let j = 1; j < surface.rows - 1; j++) {
      for (let k = F; k < frontCount - 1 - F; k++) {
        const a = vertex(j, k);
        const b = vertex(j, k + 1);
        const art = Math.abs(b.u - a.u) * layout.aspect;
        if (art < 1e-6) continue;
        const sleeve = Math.hypot(b.x - a.x, b.z - a.z);
        worst = Math.max(worst, Math.abs(sleeve / art - 1));
      }
    }
    expect(worst).toBeLessThan(0.03);
  });
});

function image(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return { width, height, data };
}

describe('pack measuring', () => {
  it('finds sub-pixel row edges and spots a mirror mismatch', () => {
    const left = (y: number) => 3 + y * 0.25;
    const art = image(40, 20, (x, y) => {
      const inside = x + 0.5 - left(y);
      return [
        200,
        200,
        200,
        Math.round(255 * Math.min(1, Math.max(0, inside))),
      ];
    });
    const rows = measureRowEdges(art, 128);
    expect(rows).toHaveLength(20);
    for (const row of rows)
      expect(row.left).toBeCloseTo(left(row.y - 0.5) + 0.5, 0);
    const mirrored = rows.map((r) => ({
      y: r.y,
      left: 40 - r.right,
      right: 40 - r.left,
    }));
    expect(outlineMirrorError(rows, mirrored, 40)).toBeCloseTo(0, 9);
    const shifted = mirrored.map((r) => ({ ...r, left: r.left + 1 }));
    expect(outlineMirrorError(rows, shifted, 40)).toBeCloseTo(1, 9);
  });

  it('keeps only the knots a straight outline needs', () => {
    const straight = Array.from({ length: 50 }, (_, i) => ({
      y: i,
      left: 2,
      right: 30,
    }));
    expect(simplifyEdges(straight, 0.3)).toHaveLength(2);
    const bent = straight.map((r) => ({
      ...r,
      left: r.y < 25 ? 2 : 2 + (r.y - 25) * 0.5,
    }));
    expect(simplifyEdges(bent, 0.3).length).toBeGreaterThan(2);
  });

  it('locks onto painted ridges: pitch, crest and where they run', () => {
    const pitch = 15.6;
    const crest = 7.3;
    const profile = Array.from({ length: 200 }, (_, i) => {
      const p = i + 0.5;
      const ridged = p > 40 && p < 140;
      return (
        100 +
        0.2 * i +
        (ridged ? 60 * Math.cos((2 * Math.PI * (p - crest)) / pitch) : 0)
      );
    });
    const fit = fitRidges(profile, 0, 200);
    expect(fit.pitch).toBeCloseTo(pitch, 1);
    // Same crest modulo the pitch.
    const phase = (((fit.crest - crest) % pitch) + pitch) % pitch;
    expect(Math.min(phase, pitch - phase)).toBeLessThan(0.3);
    expect(fit.from).toBeGreaterThan(25);
    expect(fit.from).toBeLessThan(55);
    expect(fit.to).toBeGreaterThan(125);
    expect(fit.to).toBeLessThan(155);
  });
});

describe('pack model', () => {
  it('builds one mesh with one material and frees everything', () => {
    const texture = () =>
      new THREE.DataTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4);
    const front = texture();
    const back = texture();
    const pack = createPackModel({ front, back, geometry: PACK_151_GEOMETRY });
    expect(pack.children).toHaveLength(1);
    expect(pack.mesh.geometry.getAttribute('packFace').count).toBe(
      pack.mesh.geometry.getAttribute('position').count,
    );
    expect(front.colorSpace).toBe(THREE.SRGBColorSpace);
    const spies = [
      vi.spyOn(pack.mesh.geometry, 'dispose'),
      vi.spyOn(pack.material, 'dispose'),
      vi.spyOn(front, 'dispose'),
      vi.spyOn(back, 'dispose'),
    ];
    pack.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledOnce();
  });
});
