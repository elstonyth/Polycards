/**
 * A capsule's lean on the stage (owner, 2026-11-20, "Small leans only"): the
 * pose's yaw and pitch, as the 3D capsule takes them (`Capsule3dModel.lean`,
 * about its own centre), held inside the owner's limits whatever the pose:
 * yaw within +-`CAPSULE_LEAN`, tipping away from the viewer at most
 * `capsuleTipAway`, toward it at most `capsuleTipToward`. Pure (no three.js).
 *
 * Pose convention: `rotY` turns about the screen's vertical, `rotX` positive
 * tips the top away. three.js (`placeModel`): rotation.y = rotY, rotation.x =
 * -rotX, order ZYX; the lean's 'YXZ' with no roll is the same Ry * Rx, so the
 * screen roll stays on the outer object and the result matches a sleeve's.
 */
import type { Pose } from '../contract';
import { CAPSULE_LEAN } from '../stage-spin-math';
import { CIAO_ROW } from '../stage-spin';

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/** The lean limits in pose terms (radians): yaw either way, rotX away / toward. */
export const CAPSULE_LIMITS = Object.freeze({
  yaw: CAPSULE_LEAN,
  tipAway: CIAO_ROW.capsuleTipAway,
  tipToward: CIAO_ROW.capsuleTipToward,
});

/**
 * The capsule's lean for a pose, radians: `yaw` (rotation about the screen's
 * vertical) and `rotX` (positive tips the top away), both clamped.
 */
export function capsuleLean(pose: Readonly<Pick<Pose, 'rotX' | 'rotY'>>): {
  yaw: number;
  rotX: number;
} {
  const yaw = Number.isFinite(pose.rotY) ? pose.rotY : 0;
  const rotX = Number.isFinite(pose.rotX) ? pose.rotX : 0;
  return {
    yaw: clamp(yaw, -CAPSULE_LIMITS.yaw, CAPSULE_LIMITS.yaw) + 0,
    rotX: clamp(rotX, -CAPSULE_LIMITS.tipToward, CAPSULE_LIMITS.tipAway) + 0,
  };
}
