import { describe, expect, it } from 'vitest';

import { poseAt, restState, stageOpacity } from '../stage-pose';
import { composePose } from '../stage-pose-compose';
import { lineupOpacity, lineupPose } from '../stage-spin';
import { LEAN } from '../stage-spin-math';
import type { ComposeCtx, StageLayout } from '../contract';

describe('poseAt with the lineup row injected', () => {
  const L: StageLayout = { cx: 195, cy: 330, step: 180, artH: 352, artW: 190 };
  const ctx: ComposeCtx = {
    spin: {
      count: 11,
      turn: 0,
      lean: LEAN,
      spinPose: lineupPose,
      panel: { w: 390, h: 710, anchorY: 330 / 710, viewH: 844 },
    },
    spinOpacity: lineupOpacity,
    compose: composePose,
  };

  it('is step 1 at spin 0 and without the composer', () => {
    for (let i = 0; i < 5; i++) {
      const st = restState(2);
      expect(poseAt(st, i, L, false, false, ctx)).toEqual(
        poseAt(st, i, L, false, false),
      );
      const half = { ...restState(2), spin: 0.5 };
      expect(
        poseAt(half, i, L, false, false, { ...ctx, compose: undefined }),
      ).toEqual(poseAt(half, i, L, false, false));
    }
  });

  it('forms the row: rolled, projected, and the row keeps its own fade', () => {
    const st = { ...restState(2), spin: 1 };
    const p = poseAt(st, 2, L, false, false, ctx);
    expect(p.rotZ).not.toBe(0);
    expect(p.fy).not.toBe(0);
    expect(stageOpacity(st, 2, false, 11, ctx)).toBeCloseTo(
      lineupOpacity(st, 2, false, 11),
      12,
    );
  });
});
