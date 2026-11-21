// The sleeve's one foil material. Front and back are the same material on the
// same mesh, so metalness, roughness, the lacquer coat and the environment
// reflections are identical on both faces and highlights travel across the
// hand-over unchanged. The shader picks the print per vertex (front art, back
// art, or a blend inside the side folds) and adds a faint normal relief that
// sits exactly on the painted crimp and fin ridges.

import * as THREE from 'three';
import {
  PACK_RELIEF,
  type PackLayout,
  type PackRelief,
  type PackRidgeRun,
} from './pack-layout';

/** Surface settings shared by both faces. */
export const PACK_FOIL = {
  /** Metal foil under a printed, lacquered skin. */
  metalness: 0.62,
  roughness: 0.3,
  /** A thin gloss coat over the print: the sharp white sweep as it turns. */
  clearcoat: 0.35,
  clearcoatRoughness: 0.14,
  /** Soft grazing-angle lift, so the edges stay lit when seen edge on. */
  sheen: 0.12,
  sheenRoughness: 0.45,
  envMapIntensity: 1.0,
  /** Share of the print that shows on its own, so the art never goes dark. */
  printGlow: 0.32,
  /** Alpha of the art's interior (the art is cut out at about 250 of 255). */
  alphaInterior: 0.98,
} as const;

export type PackFoilSettings = { [K in keyof typeof PACK_FOIL]: number };

export type PackFoilMaterial = THREE.MeshPhysicalMaterial & {
  /** Turns the ridge relief on (1) or off (0) without recompiling. */
  setRelief(strength: number): void;
  /**
   * The focused back's spotlight: one rect of the back image (fractions, x
   * across, y along from the top) stays lit, the rest of the back face falls
   * to `shadow` brightness. `on` 0 changes nothing. Never recompiles.
   */
  setSpot(spot: PackSpot): void;
};

/** The spotlight's values (see `setSpot`). */
export type PackSpot = {
  on: number;
  rect: { x0: number; y0: number; x1: number; y1: number };
  shadow?: number;
  lift?: number;
  /** Edge softness along y, as a fraction of the image height. */
  feather?: number;
  /** The back image's height over its width (the x feather follows it). */
  aspect?: number;
};

/**
 * The dark room around the lit window. The
 * shadow multiplies linear light: 0.05 shows as about 26% on screen (sRGB),
 * dark enough for the lit window, light enough that the foil and the
 * crimped ends still read as a pack.
 */
export const PACK_SPOT = { shadow: 0.05, lift: 1.06, feather: 0.02 } as const;

const NO_RUN = new THREE.Vector4(0, 0, 1, 0);

function runUniform(run: PackRidgeRun | null): THREE.Vector4 {
  return run
    ? new THREE.Vector4(run.from, run.to, run.pitch, run.crest)
    : NO_RUN.clone();
}

const VERTEX_HEAD = /* glsl */ `
attribute float packFace;
varying float vPackFace;
varying vec3 vPackAxisX;
varying vec3 vPackAxisY;
`;

const VERTEX_BODY = /* glsl */ `
vPackFace = packFace;
vPackAxisX = normalize( ( modelViewMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz );
vPackAxisY = normalize( ( modelViewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
`;

const FRAGMENT_HEAD = /* glsl */ `
uniform sampler2D packBack;
uniform vec4 packRidgeTop;
uniform vec4 packRidgeBottom;
uniform vec4 packRidgeFin;
uniform vec2 packFinSpan;
uniform vec2 packSlope;
uniform float packAlphaInterior;
uniform vec4 packSpotRect;
uniform vec4 packSpot;
uniform float packSpotAspect;
varying float vPackFace;
varying vec3 vPackAxisX;
varying vec3 vPackAxisY;

// One run of painted ridges along coordinate p: the slope term of a cosine
// relief cresting on the painted highlights, faded in and out at the run's
// ends, and faded away once a ridge is smaller than a few pixels (so it never
// shimmers when the pack is small or seen at a grazing angle).
float packRidge( float p, vec4 run ) {
	float pitch = max( run.z, 1e-4 );
	float edge = 0.5 * pitch;
	float mask = smoothstep( run.x - edge, run.x + edge, p ) *
		( 1.0 - smoothstep( run.y - edge, run.y + edge, p ) );
	float footprint = fwidth( p ) / pitch;
	float sharp = 1.0 - smoothstep( 0.12, 0.33, footprint );
	return mask * sharp * sin( 6.2831853 * ( p - run.w ) / pitch );
}
`;

const MAP_FRAGMENT = /* glsl */ `
// Round the side folds the print is squeezed into a few texels; a softer mip
// there turns the smeared rim into an even band of the rim's own colour.
float packFold = 1.0 - smoothstep( 0.55, 0.95, abs( 2.0 * vPackFace - 1.0 ) );
float packBias = 2.5 * packFold;
vec4 packFrontTexel = texture2D( map, vMapUv, packBias );
vec4 packBackTexel = texture2D( packBack, vec2( 1.0 - vMapUv.x, vMapUv.y ), packBias );
vec4 packTexel = mix( packBackTexel, packFrontTexel, clamp( vPackFace, 0.0, 1.0 ) );
// The art is straight alpha over black: mip levels pull black into the rim.
// Dividing by alpha restores the edge colour (the interior is ~0.98 alpha).
packTexel.rgb *= min( packAlphaInterior / max( packTexel.a, 0.02 ), 3.0 );
diffuseColor.rgb *= packTexel.rgb;
`;

// The focused back's spotlight, after the lighting sum: a soft rect of the
// back image stays lit (`lift`), the rest of the back face goes to `shadow`;
// speculars, clearcoat and the print glow dim with it. The front never shows
// it (gated by the face), so the flip to the back never flashes a rect.
const SPOT_FRAGMENT = /* glsl */ `
{
	float packSpotFy = max( packSpot.z, 1e-4 );
	float packSpotFx = packSpotFy * packSpotAspect;
	float packBx = 1.0 - vMapUv.x;
	float packBy = 1.0 - vMapUv.y;
	float packLit = smoothstep( packSpotRect.x - packSpotFx, packSpotRect.x + packSpotFx, packBx ) *
		( 1.0 - smoothstep( packSpotRect.z - packSpotFx, packSpotRect.z + packSpotFx, packBx ) ) *
		smoothstep( packSpotRect.y - packSpotFy, packSpotRect.y + packSpotFy, packBy ) *
		( 1.0 - smoothstep( packSpotRect.w - packSpotFy, packSpotRect.w + packSpotFy, packBy ) );
	outgoingLight *= mix( 1.0, mix( packSpot.y, packSpot.w, packLit ),
		packSpot.x * ( 1.0 - clamp( vPackFace, 0.0, 1.0 ) ) );
}
#include <opaque_fragment>
`;

const RELIEF_FRAGMENT = /* glsl */ `
{
	float artY = 1.0 - vMapUv.y;
	// Height h = A cos(2 pi (p - crest) / pitch); these are dh/dx and dh/dy in
	// the sleeve's own units (x right, y up), scaled to the steepest slope.
	float crimp = packRidge( artY, packRidgeTop ) + packRidge( artY, packRidgeBottom );
	float backSide = 1.0 - smoothstep( 0.2, 0.45, vPackFace );
	// The fin's ridges stop where it runs flat into the crimps.
	float finSpan = smoothstep( packFinSpan.x, packFinSpan.x + 0.006, artY ) *
		( 1.0 - smoothstep( packFinSpan.y - 0.006, packFinSpan.y, artY ) );
	float fin = packRidge( vMapUv.x, packRidgeFin ) * backSide * finSpan;
	vec2 slope = vec2( - packSlope.y * fin, packSlope.x * crimp );
	vec3 axisX = normalize( vPackAxisX - normal * dot( normal, vPackAxisX ) );
	vec3 axisY = normalize( vPackAxisY - normal * dot( normal, vPackAxisY ) );
	vec3 packRelief = - slope.x * axisX - slope.y * axisY;
	normal = normalize( normal + packRelief );
#ifdef USE_CLEARCOAT
	clearcoatNormal = normalize( clearcoatNormal + packRelief );
#endif
}
`;

/**
 * The foil material for one pack. `front` and `back` are the two art
 * textures (same size; the back is the front's outline mirrored).
 */
export function createPackFoilMaterial({
  front,
  back,
  layout,
  relief = PACK_RELIEF,
  foil = PACK_FOIL,
  envMap = null,
}: {
  front: THREE.Texture;
  back: THREE.Texture;
  layout: PackLayout;
  relief?: PackRelief;
  foil?: PackFoilSettings;
  envMap?: THREE.Texture | null;
}): PackFoilMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    map: front,
    color: 0xffffff,
    metalness: foil.metalness,
    roughness: foil.roughness,
    clearcoat: foil.clearcoat,
    clearcoatRoughness: foil.clearcoatRoughness,
    sheen: foil.sheen,
    sheenRoughness: foil.sheenRoughness,
    sheenColor: new THREE.Color(0xffffff),
    envMap,
    envMapIntensity: foil.envMapIntensity,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: foil.printGlow,
    side: THREE.FrontSide,
  }) as PackFoilMaterial;

  // Slopes are the steepest rise over run, so they need no unit conversion.
  const uniforms = {
    packBack: { value: back },
    packRidgeTop: { value: runUniform(layout.ridges.top) },
    packRidgeBottom: { value: runUniform(layout.ridges.bottom) },
    packRidgeFin: { value: runUniform(layout.ridges.fin) },
    packFinSpan: {
      value: new THREE.Vector2(layout.crimpTop.y1, layout.crimpBottom.y0),
    },
    packSlope: {
      value: new THREE.Vector2(relief.crimpSlope, relief.finSlope),
    },
    packAlphaInterior: { value: foil.alphaInterior },
    packSpotRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    packSpot: {
      value: new THREE.Vector4(
        0,
        PACK_SPOT.shadow,
        PACK_SPOT.feather,
        PACK_SPOT.lift,
      ),
    },
    packSpotAspect: { value: 1 },
  };
  const slopes = uniforms.packSlope.value.clone();
  material.setRelief = (strength: number) => {
    uniforms.packSlope.value.copy(slopes).multiplyScalar(strength);
  };

  material.setSpot = (spot: PackSpot) => {
    const r = spot.rect;
    uniforms.packSpotRect.value.set(r.x0, r.y0, r.x1, r.y1);
    uniforms.packSpot.value.set(
      Math.max(0, Math.min(1, spot.on)),
      spot.shadow ?? PACK_SPOT.shadow,
      spot.feather ?? PACK_SPOT.feather,
      spot.lift ?? PACK_SPOT.lift,
    );
    uniforms.packSpotAspect.value = spot.aspect ?? 1;
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_HEAD}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${VERTEX_BODY}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_HEAD}`)
      .replace('#include <map_fragment>', MAP_FRAGMENT)
      .replace(
        '#include <clearcoat_normal_fragment_maps>',
        `#include <clearcoat_normal_fragment_maps>\n${RELIEF_FRAGMENT}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        'totalEmissiveRadiance *= packTexel.rgb;',
      )
      .replace('#include <opaque_fragment>', SPOT_FRAGMENT);
  };
  material.customProgramCacheKey = () => 'polycards-pack-foil-2';
  return material;
}
