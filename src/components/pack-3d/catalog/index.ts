// The 3D pack catalogue's sync lookup: which packs have a bundled 3D set and
// where its pictures are. Data only (no three.js), so server components and
// the main bundle can import it. Building a pack is the async half, behind a
// dynamic import:
//
//   const assets = pack3dAssets(pack.id);          // null: keep the flat image
//   if (assets) {
//     const { openPack3d } = await import('@/components/pack-3d/catalog/build');
//     const model = await openPack3d(pack.id, { resolution: 'half', envMap })?.model();
//   }
//
// The 3D pack always uses its bundled front, never `pack.image` (operator
// entered, may change): each back's outline was cut from that one front.

import { PACK_3D_ASSETS } from './pack-3d-manifest';
import type { Pack3dAssets } from './pack-3d-types';

export type { Pack3dAssets, Pack3dResolution } from './pack-3d-types';

/** Every pack id (the /slots/<slug> slug) with a bundled 3D set. */
export const PACK_3D_IDS: readonly string[] = Object.keys(PACK_3D_ASSETS);

/** The pack's bundled pictures and pixel sizes, or null when it has none. */
export function pack3dAssets(id: string): Pack3dAssets | null {
  return Object.prototype.hasOwnProperty.call(PACK_3D_ASSETS, id)
    ? (PACK_3D_ASSETS[id] ?? null)
    : null;
}

/** Whether the pack has a bundled 3D set. */
export const hasPack3d = (id: string): boolean => pack3dAssets(id) !== null;
