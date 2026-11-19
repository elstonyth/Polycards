// A booster pack as a plain three.js object: one closed, softly pillowed foil
// sleeve with the front art on one face and the back art on the other, in one
// mesh, one material and one draw call. No React, so any scene can hold it.
//
//   const pack = createPackModel({ front, back, geometry: PACK_151_GEOMETRY });
//   scene.add(pack);
//   ...
//   pack.dispose();
//
// The sleeve is 1 unit tall and centred on the origin, front facing +z; turn
// it about y to show the back.

import * as THREE from 'three';
import {
  PACK_PROPORTIONS,
  PACK_RELIEF,
  toPackLayout,
  type PackGeometry,
  type PackLayout,
  type PackProportions,
  type PackRelief,
} from './pack-layout';
import {
  PACK_FOIL,
  createPackFoilMaterial,
  type PackFoilMaterial,
  type PackFoilSettings,
} from './pack-material';
import { PACK_DETAIL, buildPackSurface, type PackDetail } from './pack-surface';

export type PackModelOptions = {
  /** Front and back art: same size, sRGB, with the outline in alpha. */
  front: THREE.Texture;
  back: THREE.Texture;
  /** The pack's layout numbers (see `PackGeometry`). */
  geometry: PackGeometry;
  proportions?: Partial<PackProportions>;
  detail?: Partial<PackDetail>;
  relief?: Partial<PackRelief>;
  foil?: Partial<PackFoilSettings>;
  /** Reflections; leave out to use the scene's environment. */
  envMap?: THREE.Texture | null;
  /** Texture filtering quality (the renderer's max is a good choice). */
  anisotropy?: number;
  /** Whether `dispose()` also frees the two textures (default true). */
  disposeTextures?: boolean;
};

export type PackModel = THREE.Group & {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, PackFoilMaterial>;
  readonly material: PackFoilMaterial;
  readonly layout: PackLayout;
  /** Frees the geometry, the material and (by default) the textures. */
  dispose(): void;
};

/** The sleeve's mesh data as a three.js geometry. */
export function createPackGeometry(
  layout: PackLayout,
  proportions: PackProportions = PACK_PROPORTIONS,
  detail: PackDetail = PACK_DETAIL,
): THREE.BufferGeometry {
  const surface = buildPackSurface(layout, proportions, detail);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(surface.positions, 3),
  );
  geometry.setAttribute(
    'normal',
    new THREE.BufferAttribute(surface.normals, 3),
  );
  geometry.setAttribute('uv', new THREE.BufferAttribute(surface.uvs, 2));
  geometry.setAttribute(
    'packFace',
    new THREE.BufferAttribute(surface.faces, 1),
  );
  geometry.setIndex(new THREE.BufferAttribute(surface.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function prepareArt(texture: THREE.Texture, anisotropy: number): void {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
}

export function createPackModel(options: PackModelOptions): PackModel {
  const layout = toPackLayout(options.geometry);
  const proportions = { ...PACK_PROPORTIONS, ...options.proportions };
  const detail = { ...PACK_DETAIL, ...options.detail };
  prepareArt(options.front, options.anisotropy ?? 8);
  prepareArt(options.back, options.anisotropy ?? 8);

  const geometry = createPackGeometry(layout, proportions, detail);
  const material = createPackFoilMaterial({
    front: options.front,
    back: options.back,
    layout,
    relief: { ...PACK_RELIEF, ...options.relief },
    foil: { ...PACK_FOIL, ...options.foil },
    envMap: options.envMap ?? null,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'pack-sleeve';

  const group = new THREE.Group() as PackModel;
  group.name = `pack-${options.geometry.pack ?? 'model'}`;
  group.add(mesh);
  const disposeTextures = options.disposeTextures ?? true;
  Object.assign(group, {
    mesh,
    material,
    layout,
    dispose() {
      geometry.dispose();
      material.dispose();
      if (disposeTextures) {
        options.front.dispose();
        options.back.dispose();
      }
    },
  });
  return group;
}
