/**
 * A capsule's lean on the stage (owner, 2026-11-20, "Small leans only"): the
 * pose's yaw and pitch, as the 3D capsule takes them (`Capsule3dModel.lean`,
 * about its own centre), held inside the owner's limits whatever the pose:
 * yaw within +-`CAPSULE_LIMITS.yaw`, tipping away from the viewer at most
 * `capsuleTipAway`, toward it at most `capsuleTipToward`. Pure (no three.js).
 *
 * The limits live here, with no imports, beside the pose module, because the
 * CSS tiles' rest pose (`tileVars`, first load) clamps with them too; the spin row's capsule
 * lean and tip limits take their values from `CAPSULE_LIMITS`.
 *
 * Pose convention: `rotY` turns about the screen's vertical, `rotX` positive
 * tips the top away. three.js (`placeModel`): rotation.y = rotY, rotation.x =
 * -rotX, order ZYX; the lean's 'YXZ' with no roll is the same Ry * Rx, so the
 * screen roll stays on the outer object and the result matches a sleeve's.
 */
import type { Pose } from './contract';

const DEG = Math.PI / 180;

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/** A tile with no row entry poses as a sleeve that is not sold out. */
export const SLEEVE_TILE = Object.freeze({ soldOut: false, ticket: false });

/**
 * The lean limits in pose terms (radians): yaw 25 degrees either way, rotX
 * 15 away / 25 toward (owner, 2026-11-20).
 */
export const CAPSULE_LIMITS = Object.freeze({
  yaw: 25 * DEG,
  tipAway: 15 * DEG,
  tipToward: 25 * DEG,
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

/**
 * A pose as a flat tile draws it: a capsule's yaw and pitch through
 * `capsuleLean` (as the 3D capsule takes them), a sleeve's pose as it is.
 */
export function capsulePose<T extends Pick<Pose, 'rotX' | 'rotY'>>(
  pose: T,
  capsule: boolean,
): T {
  if (!capsule) return pose;
  const { yaw, rotX } = capsuleLean(pose);
  return { ...pose, rotY: yaw, rotX };
}
