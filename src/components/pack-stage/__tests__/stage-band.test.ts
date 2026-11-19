import { describe, expect, it } from 'vitest';
import type { StageLayout, StageState } from '../contract';
import { stageBand } from '../runtime/stage-band';
import { poseAt, restState, stageOpacity } from '../stage-pose';

const TAN14 = Math.tan((14 * Math.PI) / 180);

/**
 * Screen y (host CSS px) of every corner of pack `i`, projected the way the
 * camera (and the matching CSS perspective) does: perspective distance
 * hostH / (2 tan 14 deg) from the host centre; the art box is artW x artH at
 * the slot, posed by translate3d(dx, dy, z) rotateY rotateX scale.
 */
function cornersY(
  s: StageState,
  i: number,
  l: StageLayout,
  hostH: number,
  desktop: boolean,
): number[] {
  const p = poseAt(s, i, l, desktop, false);
  const d = hostH / (2 * TAN14);
  const w = (l.artW ?? l.artH * 0.54) / 2;
  const h = l.artH / 2;
  const out: number[] = [];
  for (const [x0, y0] of [
    [-w, -h],
    [w, -h],
    [-w, h],
    [w, h],
  ] as const) {
    // scale, then rotateX (tips the top edge away for rotX > 0), then rotateY.
    const x1 = x0 * p.scale;
    const y1 = y0 * p.scale;
    const y2 = y1 * Math.cos(p.rotX);
    const z2 = y1 * Math.sin(p.rotX); // top (y1 < 0) goes back for rotX > 0
    const z3 = -x1 * Math.sin(p.rotY) + z2 * Math.cos(p.rotY);
    const y = l.cy + p.dy + y2;
    const z = p.z + z3;
    out.push(hostH / 2 + ((y - hostH / 2) * d) / (d - z));
  }
  return out;
}

const LAYOUTS: {
  name: string;
  hostH: number;
  l: StageLayout;
  desktop: boolean;
}[] = [
  // Measured on the production build (QA layout lines).
  {
    name: 'desktop 1440x900',
    hostH: 1020,
    l: { cx: 712, cy: 400, step: 253, artH: 430, artW: 230 },
    desktop: true,
  },
  {
    name: 'phone 390x844',
    hostH: 1180,
    l: { cx: 195, cy: 320, step: 180, artH: 352, artW: 190 },
    desktop: false,
  },
  {
    name: 'short desktop',
    hostH: 860,
    l: { cx: 700, cy: 330, step: 200, artH: 340, artW: 182 },
    desktop: true,
  },
];

describe('stageBand: the canvas covers every pack that can be seen', () => {
  it('is the whole host without a layout', () => {
    expect(stageBand(900, null)).toEqual({ y: 0, h: 900 });
  });

  it('is clamped to the host', () => {
    const b = stageBand(500, { cy: 100, artH: 430 });
    expect(b.y).toBe(0);
    expect(b.y + b.h).toBeLessThanOrEqual(500);
  });

  for (const { name, hostH, l, desktop } of LAYOUTS) {
    it(`${name}: float-in, sink, pointer lean, idle and drags stay inside it`, () => {
      const band = stageBand(hostH, l);
      // Much smaller than the host: that is the memory it saves.
      expect(band.h).toBeLessThan(hostH * 0.8);
      const states: StageState[] = [];
      for (let t = 0; t <= 1.0001; t += 0.05)
        states.push({ ...restState(2), intro: t });
      for (let s = 0; s <= 1.0001; s += 0.05)
        states.push({ ...restState(2), swap: s });
      for (const px of [-1, 1])
        for (const py of [-1, 1])
          states.push({ ...restState(2), pointerX: px, pointerY: py });
      for (let idle = 0; idle < 6; idle += 0.25)
        states.push({ ...restState(2), idle });
      for (let track = 1.5; track <= 2.5; track += 0.1)
        states.push(restState(track));
      let worstTop = Infinity;
      let worstBottom = -Infinity;
      for (const s of states) {
        for (let i = 0; i <= 4; i++) {
          // Only what can be seen: a pack faded out by reach or the sink
          // (opacity under 2%) may leave the band.
          if (stageOpacity(s, i, desktop) < 0.02) continue;
          for (const y of cornersY(s, i, l, hostH, desktop)) {
            worstTop = Math.min(worstTop, y);
            worstBottom = Math.max(worstBottom, y);
          }
        }
      }
      expect(worstTop).toBeGreaterThanOrEqual(band.y);
      expect(worstBottom).toBeLessThanOrEqual(band.y + band.h);
      // The test has teeth: visible packs really reach well below the art (the
      // float-in drop), so a band ending at the art's bottom would clip them.
      expect(worstBottom).toBeGreaterThan(l.cy + 0.9 * l.artH);
      expect(worstTop).toBeLessThan(l.cy - 0.49 * l.artH);
    });
  }
});
