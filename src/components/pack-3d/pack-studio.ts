// Studio reflections for the foil: soft boxes around the pack, baked once into
// a prefiltered environment map. No file to fetch, so nothing to wait for or
// fail. Any scene showing packs can share one.

import * as THREE from 'three';

/** [x, y, z, width, height, brightness, warmth (-1 cool .. 1 warm)] */
type Softbox = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/**
 * A key box high and front left, a broad soft fill near the camera, a long
 * strip at each side (they light the folds when the pack is edge on), a low
 * bounce in front, and a broad panel plus two boxes behind, so a face seen at
 * a grazing angle (or the back, once it turns round) still has light to show.
 */
const SOFTBOXES: readonly Softbox[] = [
  [-3.2, 4.2, 4.5, 4.5, 3.2, 4.2, 0.15],
  [0.8, 0.3, 6.0, 3.5, 4.5, 1.0, 0.0],
  [5.2, 1.0, 2.0, 1.2, 7.0, 3.0, -0.25],
  [-5.4, -0.5, 1.0, 1.0, 6.5, 2.2, 0.3],
  [0.0, -4.2, 4.0, 7.0, 1.4, 1.0, 0.0],
  [0.5, 1.0, -6.0, 7.0, 5.0, 0.4, 0.0],
  [3.0, 3.6, -4.6, 4.0, 2.6, 1.4, -0.1],
  [-4.0, 0.8, -4.0, 1.6, 6.0, 0.9, 0.2],
];

export function buildStudioEnvironment(
  renderer: THREE.WebGLRenderer,
  { ambient = 0.12 }: { ambient?: number } = {},
): THREE.WebGLRenderTarget {
  const studio = new THREE.Scene();
  // A dim room rather than black, so metal never reflects pure nothing.
  studio.background = new THREE.Color().setScalar(ambient);
  const geometry = new THREE.PlaneGeometry(1, 1);
  const materials: THREE.Material[] = [];
  for (const [x, y, z, width, height, level, warmth] of SOFTBOXES) {
    const tint = new THREE.Color(
      1 + 0.12 * warmth,
      1 + 0.02 * warmth,
      1 - 0.12 * warmth,
    );
    const material = new THREE.MeshBasicMaterial({
      color: tint.multiplyScalar(level),
      side: THREE.DoubleSide,
    });
    materials.push(material);
    const softbox = new THREE.Mesh(geometry, material);
    softbox.position.set(x, y, z);
    softbox.scale.set(width, height, 1);
    softbox.lookAt(0, 0, 0);
    studio.add(softbox);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(studio, 0.02);
  geometry.dispose();
  for (const material of materials) material.dispose();
  pmrem.dispose();
  return environment;
}
