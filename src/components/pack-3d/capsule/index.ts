// The 3D capsule packs' sync lookup: which capsules have a 3D model and where
// its textures are. Data only (no three.js), so server components and the main
// bundle can import it. Building a capsule is the async half, behind a dynamic
// import:
//
//   const assets = capsule3dAssets(pack.id);       // null: keep the flat image
//   if (assets) {
//     const { openCapsule3d } = await import('@/components/pack-3d/capsule/build');
//     const capsule = openCapsule3d(pack.id, { resolution: 'half' });
//     const model = await capsule?.model();
//   }
//
// Separate from the sleeve catalogue (../catalog/): a capsule is a different
// model (cap, logo, glass, contents) with its own textures.

import { CAPSULE_3D_ASSETS } from './capsule-manifest';
import type { Capsule3dAssets } from './capsule-types';

export type { Capsule3dAssets, Capsule3dResolution } from './capsule-types';

/** Every capsule pack id (the /slots/<slug> slug) with a 3D model. */
export const CAPSULE_3D_IDS: readonly string[] = Object.keys(CAPSULE_3D_ASSETS);

/** The capsule's textures and fitted numbers, or null when it has none. */
export function capsule3dAssets(id: string): Capsule3dAssets | null {
  return Object.prototype.hasOwnProperty.call(CAPSULE_3D_ASSETS, id)
    ? (CAPSULE_3D_ASSETS[id] ?? null)
    : null;
}

/** Whether the pack has a 3D capsule model. */
export const hasCapsule3d = (id: string): boolean =>
  capsule3dAssets(id) !== null;
