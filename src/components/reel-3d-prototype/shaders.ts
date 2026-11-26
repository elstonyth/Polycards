// PROTOTYPE: the cell and halo materials for the 3D reel on /reel-preview.
// Each cell is today's CardTile drawn in one fragment shader: dark translucent
// rounded box, a thin rarity border and one crisp sprite. Only the landed winner
// glows (inner glow plus a second, additive instanced quad, the halo); decoys
// stay quiet to fit the black-and-white redesign. No post passes. Per instance: instanceMatrix, instanceColor (rarity, linear),
// aSprite (atlas u0, v0, figure scale) and aState (lit, landed, fade, speed).
import * as THREE from 'three';
import { CARD_ASPECT } from '@/lib/vault-reel';

/** Card in world units: 1 tall, CARD_ASPECT wide. */
export const CARD_W = CARD_ASPECT;
export const CARD_H = 1;
/** rounded-xl (12 px) on a ~152 px tall tile. */
export const CARD_RADIUS = 0.08;
/** Cell quad padding (card units) so the SDF edge is anti-aliased in-quad. */
export const CELL_PAD = 0.04;
/** Halo quad margin around the card. */
export const HALO_PAD = 0.5;
/** PokemonToken: token = 0.72 of the cell, figure = 0.82 of the token. */
const SPRITE_SIDE = 0.72 * 0.82;

const COMMON_VERT = /* glsl */ `
attribute vec4 aSprite;
attribute vec4 aState;
varying vec2 vP;
varying vec3 vColor;
varying vec4 vSprite;
varying vec4 vState;
void main() {
  vP = position.xy;
  vColor = instanceColor;
  vSprite = aSprite;
  vState = aState;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const SDF = /* glsl */ `
float sdRound(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
vec4 over(vec4 src, vec4 dst) { return src + dst * (1.0 - src.a); }
`;

const CELL_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec2 uTileUv;
uniform vec2 uCard;
uniform float uRadius;
uniform float uSpriteSide;
uniform float uBackDim;
uniform float uBgAlpha;
varying vec2 vP;
varying vec3 vColor;
varying vec4 vSprite;
varying vec4 vState;
${SDF}
void main() {
  float lit = vState.x;
  float landed = vState.y;
  float fade = vState.z;
  float speed = vState.w;
  vec2 p = vP;
  bool back = !gl_FrontFacing;
  // Seen from behind: un-mirror so sprites still read.
  if (back) p.x = -p.x;
  float d = sdRound(p, uCard * 0.5, uRadius);
  float aa = max(fwidth(d), 1e-4);
  float inside = 1.0 - smoothstep(-aa * 0.5, aa * 0.5, d);
  if (inside <= 0.001) discard;

  // bg: rgba(10,10,12,0.55) (linear)
  vec4 acc = vec4(vec3(0.0030, 0.0030, 0.0037) * uBgAlpha, uBgAlpha);
  float inD = max(-d, 0.0);
  if (landed > 0.001) {
    float g = lit * landed * 0.45 * exp(-inD / 0.1);
    acc = over(vec4(vColor * g, g), acc);
  }
  // unlit inset shadow: inset 0 0 8px rgba(0,0,0,0.5)
  float sh = (1.0 - lit) * 0.5 * exp(-inD / 0.03);
  acc = over(vec4(0.0, 0.0, 0.0, sh), acc);

  // sprite, smeared along local x by speed
  vec2 sp = p / (uSpriteSide * vSprite.z) + 0.5;
  // 8 taps with a per-pixel jitter of one tap step, so the smear reads as a
  // continuous streak rather than stacked copies. Zero speed = one crisp tap.
  float len = speed * 0.16;
  float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  vec4 s = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    float o = ((float(i) + jit * step(0.001, len)) / 7.0 - 0.5) * len;
    vec2 q = sp + vec2(o, 0.0);
    if (q.x > 0.0 && q.x < 1.0 && q.y > 0.0 && q.y < 1.0) {
      vec4 t = texture2D(uAtlas, vSprite.xy + vec2(q.x, 1.0 - q.y) * uTileUv);
      s += vec4(t.rgb * t.a, t.a);
    }
  }
  s *= 0.125;
  acc = over(s, acc);

  // border: 1 css px look, a constant ~1.3 screen px band inside the edge
  float bw = aa * 1.3;
  float band = smoothstep(-bw - aa, -bw, d);
  vec4 bc = lit > 0.001
    ? vec4(vColor, mix(0.45, 1.0, landed) * max(lit, 0.0))
    : vec4(1.0, 1.0, 1.0, 0.1);
  if (lit > 0.001 && lit < 0.999) bc = mix(vec4(1.0, 1.0, 1.0, 0.1), bc, lit);
  acc = over(vec4(bc.rgb * bc.a * band, bc.a * band), acc);

  float keep = (1.0 - fade) * (back ? uBackDim : 1.0);
  acc *= keep * inside;
  gl_FragColor = vec4(acc.rgb / max(acc.a, 1e-4), acc.a);
  #include <colorspace_fragment>
}
`;

const HALO_FRAG = /* glsl */ `
uniform vec2 uCard;
uniform float uRadius;
uniform float uGain;
varying vec2 vP;
varying vec3 vColor;
varying vec4 vSprite;
varying vec4 vState;
${SDF}
void main() {
  float lit = vState.x;
  float landed = vState.y;
  float fade = vState.z;
  float d = sdRound(vP, uCard * 0.5, uRadius);
  // Landed winner only: 0 0 30px 7px on a ~152 px tile.
  float x = max(d - 0.046, 0.0);
  float g = exp(-x * x / (2.0 * 0.11 * 0.11)) * smoothstep(-0.02, 0.01, d);
  float a = lit * landed * 0.8 * g * (1.0 - fade) * uGain;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor, a);
  #include <colorspace_fragment>
}
`;

export function cellMaterial(
  atlas: THREE.Texture,
  tileUv: [number, number],
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: atlas },
      uTileUv: { value: new THREE.Vector2(tileUv[0], tileUv[1]) },
      uCard: { value: new THREE.Vector2(CARD_W, CARD_H) },
      uRadius: { value: CARD_RADIUS },
      uSpriteSide: { value: SPRITE_SIDE },
      uBackDim: { value: 0.45 },
      uBgAlpha: { value: 0.55 },
    },
    vertexShader: COMMON_VERT,
    fragmentShader: CELL_FRAG,
    transparent: true,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
  });
}

export function haloMaterial(gain = 1): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCard: { value: new THREE.Vector2(CARD_W, CARD_H) },
      uRadius: { value: CARD_RADIUS },
      uGain: { value: gain },
    },
    vertexShader: COMMON_VERT,
    fragmentShader: HALO_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

export function cellGeometry(): THREE.PlaneGeometry {
  return new THREE.PlaneGeometry(CARD_W + CELL_PAD * 2, CARD_H + CELL_PAD * 2);
}

export function haloGeometry(): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(
    CARD_W + HALO_PAD * 2,
    CARD_H + HALO_PAD * 2,
  );
  g.translate(0, 0, -0.003);
  return g;
}
