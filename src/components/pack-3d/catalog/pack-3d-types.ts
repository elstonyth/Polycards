// Types of the 3D pack catalogue (type-only imports: no three.js at runtime).

import type { PackGeometry, PackRelief } from '../pack-layout';
import type { PackFoilSettings } from '../pack-material';
import type { PackPrintSpec } from '../pack-print';
import type { PackBackGeometry } from '../pack-print-template';

/** One bundled pack's pictures (public/pack-3d/<id>/). URLs carry a content
 *  version (?v=), so a changed file always gets a new URL. */
export type Pack3dAssets = {
  front: string;
  frontHalf: string;
  back: string;
  backHalf: string;
  /** Full-size pixel size (front and back are the same size). */
  width: number;
  height: number;
  /** Half-size pixel size (front-half and back-half). */
  halfWidth: number;
  halfHeight: number;
};

export type Pack3dResolution = 'full' | 'half';

/**
 * The material the approved render used. 'model-defaults': it passed no foil,
 * relief or alphaInterior, so createPackModel's PACK_FOIL and PACK_RELIEF
 * apply. Otherwise the options it passed (both faces).
 */
export type Pack3dMaterial =
  | { source: 'model-defaults' }
  | {
      source: string;
      foil: Partial<PackFoilSettings>;
      relief: Partial<PackRelief>;
    };

export type Pack3dSettings = {
  /** For createPackModel. */
  geometry: PackGeometry;
  /** The back's print zones, for packPrintSpecFromGeometry. */
  backGeometry: PackBackGeometry;
  /** The live text's ink on this back. */
  ink: PackPrintSpec['ink'];
  material: Pack3dMaterial;
};
