import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { FocusCtx } from '@/components/pack-stage/contract';
import POSES from '@/components/pack-stage/focus-poses.json';
import { spotAt } from '@/components/pack-stage/stage-focus';
import { focusKeys } from '@/components/pack-stage/stage-focus-keys';
import { PACK_3D_SETTINGS } from './catalog/pack-3d-settings';
import { spotRects } from './pack-print-template';

// The focused back (plan-focus-ciao sections 3 and 4): its lit rects and the
// pose that reads it level.
const DEG = Math.PI / 180;
const SLUGS = Object.keys(POSES.packs);
const ctxFor = (slug: string, desktop: boolean): FocusCtx => ({
  index: 0,
  anchorY: 0.45,
  keys: focusKeys(slug, desktop, 'sleeve'),
  panel: desktop ? { w: 1440, h: 831 } : { w: 390, h: 710 },
});

describe('the spotlight', () => {
  it('spotRects gives the table litRects for all 11 packs', () => {
    for (const slug of SLUGS) {
      const r = spotRects(PACK_3D_SETTINGS[slug]!.backGeometry);
      const want = (POSES.packs as Record<string, { litRects: unknown }>)[slug]!
        .litRects;
      expect(r).toEqual(want);
    }
  });

  it('is on at the back stops and slides from the box to the buyback', () => {
    const ctx = ctxFor('151', true);
    expect(spotAt(1, ctx).on).toBe(0);
    expect(spotAt(3, ctx)).toEqual({ on: 1, rect: ctx.keys[2]!.rect });
    expect(spotAt(4, ctx)).toEqual({ on: 1, rect: ctx.keys[3]!.rect });
    expect(spotAt(5, ctx).on).toBe(0);
    const mid = spotAt(3.5, ctx).rect;
    expect(mid.y0).toBeCloseTo(
      (ctx.keys[2]!.rect!.y0 + ctx.keys[3]!.rect!.y0) / 2,
      6,
    );
  });
});

describe('the back reads level (ZYX, roll outermost)', () => {
  for (const [kind, tilt] of [
    ['odds', -4],
    ['buyback', 2],
  ] as const) {
    it(`${kind}: along +x within the tilt, upper long edge receding`, () => {
      const key = focusKeys('151', true, 'sleeve').find(
        (k) => k.kind === kind,
      )!;
      // the scene's mapping: rotation.set(-rotX, rotY, -rotZ, 'ZYX')
      const e = new THREE.Euler(
        -key.rx * DEG,
        key.ry * DEG,
        -key.rz * DEG,
        'ZYX',
      );
      const along = new THREE.Vector3(0, 1, 0).applyEuler(e); // the print runs bottom to top
      // screen angle of the print's direction (y down on screen)
      const angle = Math.atan2(-along.y, along.x) / DEG;
      expect(along.x).toBeGreaterThan(0.99);
      expect(Math.abs(angle - tilt)).toBeLessThanOrEqual(1);
      // the pack's +x edge is the upper long edge; it recedes
      const edge = new THREE.Vector3(1, 0, 0).applyEuler(e);
      expect(edge.y).toBeGreaterThan(0.99);
      expect(edge.z).toBeLessThan(0);
      // the back faces the camera
      const normal = new THREE.Vector3(0, 0, -1).applyEuler(e);
      expect(normal.z).toBeGreaterThan(0.99);
    });
  }
});
