/**
 * The stage's capsule packs (WP-G milestone 2): the 3D capsule module
 * (`pack-3d/capsule`) behind the same handle calls the runtime makes on a
 * sleeve (`textures`, `hideBack`, `canvasBytes`, `dispose`, `showBack`), and
 * the per-frame paint. A capsule has no back (it never turns), no spotlight
 * and no environment map: its light is in its textures.
 */
import * as THREE from 'three';

import { capsule3dAssets } from '@/components/pack-3d/capsule';
import {
  capsuleLogoBytes,
  openCapsule3d,
  type Capsule3dModel,
} from '@/components/pack-3d/capsule/build';
import type { Pose } from '../contract';
import { capsuleLean } from './stage-capsule-lean';

const DEG = Math.PI / 180;
type Res = 'half' | 'full';

export type StageCapsuleHandle = {
  model(): Promise<Capsule3dModel>;
  /** GPU bytes of this capsule: its own textures and geometry (not the shared logo mask). */
  textures(): { bytes: number }[];
  /** A capsule never shows a back. */
  showBack(details: unknown, options?: unknown): Promise<null>;
  hideBack(): void;
  canvasBytes(): number;
  dispose(): void;
};

/** Opens a capsule for the stage, or null when the pack has no 3D capsule. */
export function openStageCapsule(
  id: string,
  res: Res,
  anisotropy: number,
): StageCapsuleHandle | null {
  const capsule = openCapsule3d(id, { resolution: res, anisotropy });
  if (!capsule) return null;
  return {
    model: () => capsule.model(),
    textures() {
      const s = capsule.stats();
      return [{ bytes: s.textureBytes + s.geometryBytes }];
    },
    showBack: () => Promise.resolve(null),
    hideBack() {},
    canvasBytes: () => 0,
    dispose: () => capsule.dispose(),
  };
}

const mipBytes = (w: number, h: number, mips: boolean) =>
  Math.round(w * h * 4 * (mips ? 4 / 3 : 1));

/** Bytes a capsule will hold at `res` before it is built (its own textures). */
export function capsuleEstimateBytes(id: string, res: Res): number {
  const a = capsule3dAssets(id);
  if (!a) return 0;
  const f = a.files[res];
  let b = 0;
  for (const t of [f.capMatcap, f.glassMatcap, f.logoMatcap])
    b += mipBytes(t.width, t.height, false);
  for (const t of [f.contents, f.detail])
    if (t) b += mipBytes(t.width, t.height, true);
  return b;
}

/** The logo mask every open capsule of a resolution shares (charged once). */
export const capsuleSharedBytes = (res: Res): number => capsuleLogoBytes(res);

/** Every texture the capsule's materials bind (for upload ahead of drawing). */
export function capsuleMaps(model: Capsule3dModel): THREE.Texture[] {
  const out = new Set<THREE.Texture>();
  for (const m of Object.values(model.meshes))
    for (const u of Object.values(m.material.uniforms))
      if (u.value instanceof THREE.Texture) out.add(u.value);
  return [...out];
}

/**
 * After `placeModel`: the screen roll stays on the object, the yaw and pitch
 * go through the capsule's own lean (about its centre, within the limits),
 * then the light and the fade.
 */
export function paintCapsule(
  model: Capsule3dModel,
  pose: Readonly<Pose>,
  opacity: number,
): void {
  const { yaw, rotX } = capsuleLean(pose);
  model.rotation.set(0, 0, -pose.rotZ, 'ZYX');
  model.lean(yaw / DEG, -rotX / DEG);
  model.setDim(pose.dim);
  model.setOpacity(opacity);
}
