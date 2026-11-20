// The capsule's three shaders (three.js ShaderMaterial, GLSL ES 1 style; three
// compiles them as GLSL ES 3). Every material is unlit and opts out of tone
// mapping: its light comes from textures sampled from the approved picture.
//
// Matcap lookups use the view-corrected frame of three.js MeshMatcapMaterial
// (the normal measured against the direction to the camera), the same frame
// the bake script binned the picture's pixels in, so the rim stays on the
// outline wherever the capsule sits on screen.

const MATCAP_UV = /* glsl */ `
vec2 matcapUV(vec3 n, vec3 viewDir) {
  vec3 x = normalize(vec3(viewDir.z, 0.0, -viewDir.x));
  vec3 y = cross(viewDir, x);
  return vec2(dot(x, n), dot(y, n)) * 0.495 + 0.5;
}
`;

/** Pill normal from the local position (cylinder + hemispheres). */
const PILL_NORMAL = /* glsl */ `
vec3 pillNormal(vec3 p, float hc) {
  return normalize(p - vec3(0.0, clamp(p.y, -hc, hc), 0.0));
}
`;

// ---------------------------------------------------------------- cap + logo
export const CAP_VERTEX = /* glsl */ `
uniform float uHC;
varying vec3 vViewPos;
varying vec3 vN;
varying vec3 vTp;
varying vec3 vTm;
varying vec2 vPhiM;
#ifdef USE_DETAIL
uniform mat4 uRestMVP;
uniform float uPhiC;
uniform float uBand;
uniform vec3 uCamLocal;
varying vec3 vClipD;
varying vec3 vClipT;
varying float vGraze;
#endif
${PILL_NORMAL}
void main() {
  vec3 p = position;
  vec3 nl = pillNormal(p, uHC);
  float phi = atan(p.x, p.z);
  vec3 tp = vec3(cos(phi), 0.0, -sin(phi));
  vec3 tm = normalize(cross(nl, tp));
  vN = normalize(normalMatrix * nl);
  vTp = normalize(normalMatrix * tp);
  vTm = normalize(normalMatrix * tm);
  float m = p.y <= uHC ? p.y : uHC + atan(p.y - uHC, length(p.xz));
  vPhiM = vec2(phi, m);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vViewPos = -mv.xyz;
  gl_Position = projectionMatrix * mv;
#ifdef USE_DETAIL
  // (1) where this point sat in the picture (the far half folded back at
  // 90 degrees): exact at rest; (2) the same height in the well-resolved front
  // band, the azimuth ping-ponged inside +-uBand of the picture's view: used,
  // only while leaning, where the picture saw the surface at a grazing angle
  // (its stones would stretch into streaks there)
  float r = phi - uPhiC;
  r = atan(sin(r), cos(r));
  float ar = abs(r);
  if (ar > 1.5707963) ar = 3.1415927 - ar;
  float rad = length(p.xz);
  float phiA = uPhiC + sign(r) * ar;
  vec4 cd = uRestMVP * vec4(rad * sin(phiA), p.y, rad * cos(phiA), 1.0);
  vClipD = vec3(cd.xy, cd.w);
  float tb = mod(abs(r), 2.0 * uBand);
  float phiB = uPhiC + sign(r) * (tb < uBand ? tb : 2.0 * uBand - tb);
  // dome points (the picture sees the tip at a grazing angle) borrow stones
  // from the cylinder, mirrored down by their arc length over the dome
  float yB = p.y <= uHC ? p.y : uHC - (m - uHC);
  vec4 cb = uRestMVP * vec4(sin(phiB), yB, cos(phiB), 1.0);
  vClipT = vec3(cb.xy, cb.w);
  // how squarely the picture saw this point
  float facing = dot(nl, normalize(uCamLocal - p));
  vGraze = 1.0 - smoothstep(0.5, 0.8, facing);
#endif
}
`;

export const CAP_FRAGMENT = /* glsl */ `
uniform sampler2D uMatcap;
uniform sampler2D uLogoMatcap;
uniform sampler2D uLogoSdf;
uniform vec4 uMark;        // k, phi0, m0, inflate (viewBox units)
uniform vec4 uWord;
uniform vec4 uMarkBox;     // viewBox x0, y0, x1, y1
uniform vec4 uWordBox;
uniform vec2 uMarkAnchor;  // cx, cy
uniform vec2 uWordAnchor;
uniform vec4 uMarkRect;    // atlas u0, v0 (from the top), du, dv
uniform vec4 uWordRect;
uniform vec2 uSdfTexel;    // 1 / atlas size
uniform float uSdfPpu;     // atlas texels per viewBox unit
uniform float uSdfRange;
uniform float uBevel;      // raised edge width (capsule radii)
uniform float uRelief;     // raised edge height / width
uniform float uEdgeShade;  // light / shade on the raised edge
uniform float uSpec;       // specular glint on the raised edge
uniform float uAO;         // soft contact shade round the logo
uniform float uAOWidth;
uniform float uOpacity;
uniform float uDim;       // light multiplier (sold out, the row light)
varying vec3 vViewPos;
varying vec3 vN;
varying vec3 vTp;
varying vec3 vTm;
varying vec2 vPhiM;
#ifdef USE_DETAIL
uniform sampler2D uDetail;
uniform vec4 uDetailRect;  // picture x0, y0 (from the top), w, h
uniform vec2 uDetailSize;
uniform vec2 uLean;        // yaw, pitch (radians) away from the picture's pose
varying vec3 vClipD;
varying vec3 vClipT;
varying float vGraze;
vec2 detailUV(vec3 clip) {
  vec2 ndc = clip.xy / clip.z;
  vec2 pic = vec2(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  vec2 c = (pic - uDetailRect.xy) / uDetailRect.zw;
  return vec2(c.x, 1.0 - c.y);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
#endif
${MATCAP_UV}
// one logo block: signed distance in capsule radii (+ inside) and its
// gradient along (phi arc, meridian)
float blockSd(vec4 place, vec2 anchor, vec4 box, vec4 rect, out vec2 grad) {
  vec2 X = vec2(anchor.x + (vPhiM.x - place.y) / place.x, anchor.y - (vPhiM.y - place.z) / place.x);
  vec2 t = (X - box.xy) / (box.zw - box.xy);
  grad = vec2(0.0);
  if (t.x < 0.0 || t.y < 0.0 || t.x > 1.0 || t.y > 1.0) return (place.w - uSdfRange) * place.x;
  vec2 uv = vec2(rect.x + t.x * rect.z, 1.0 - (rect.y + t.y * rect.w));
  float s = texture2D(uLogoSdf, uv).r;
  // the encoded range's outer floor: far outside, whatever the inflation
  // (kept continuous with the clipped texels, so fwidth() sees no jump)
  if (s < 0.004) return (place.w - uSdfRange) * place.x;
  float sx = texture2D(uLogoSdf, uv + vec2(uSdfTexel.x, 0.0)).r - texture2D(uLogoSdf, uv - vec2(uSdfTexel.x, 0.0)).r;
  float sy = texture2D(uLogoSdf, uv - vec2(0.0, uSdfTexel.y)).r - texture2D(uLogoSdf, uv + vec2(0.0, uSdfTexel.y)).r;
  // per viewBox unit (X right, Y down) -> along phi arc, along m (up)
  grad = vec2(sx, -sy) * uSdfRange * uSdfPpu;
  return ((s - 0.5) * 2.0 * uSdfRange + place.w) * place.x;
}
void main() {
  vec3 view = normalize(vViewPos);
  vec3 n = normalize(vN);
  vec3 cap = texture2D(uMatcap, matcapUV(n, view)).rgb;
#ifdef USE_DETAIL
  vec2 uvd = detailUV(vClipD);
  vec3 alb = texture2D(uDetail, uvd).rgb * 4.0;
  // leaning: the grazing bands cross to front-band stones (reads as twinkle)
  float wl = vGraze * clamp(length(uLean) / 0.21, 0.0, 1.0);
  // variance-preserving: a plain mix of two stone patterns halves their
  // contrast (the glitter would dull as it leans); the ratio's mean is ~1
  if (wl > 0.0) {
    vec3 mixed = mix(alb, texture2D(uDetail, detailUV(vClipT)).rgb * 4.0, wl);
    alb = max(vec3(0.0), 1.0 + (mixed - 1.0) / sqrt(wl * wl + (1.0 - wl) * (1.0 - wl)));
  }
  // stones twinkle as the capsule leans (exactly the picture at rest)
  float h = hash12(floor(uvd * uDetailSize / 3.0));
  float spark = clamp(dot(alb, vec3(0.2126, 0.7152, 0.0722)) - 1.2, 0.0, 1.0);
  float tw = cos(6.2832 * h + 9.0 * (uLean.x * (h - 0.5) + uLean.y * (fract(h * 7.13) - 0.5))) - cos(6.2832 * h);
  alb *= max(0.45, 1.0 + 0.3 * spark * tw);
  cap *= alb;
#endif
  vec2 gM, gW;
  float dM = blockSd(uMark, uMarkAnchor, uMarkBox, uMarkRect, gM);
  float dW = blockSd(uWord, uWordAnchor, uWordBox, uWordRect, gW);
  float d = max(dM, dW);
  vec2 grad = dM > dW ? gM : gW;
  float aa = min(fwidth(d) * 0.75, 0.02) + 1e-5;
  float cover = smoothstep(-aa, aa, d);
  // the raised edge: height rises over uBevel inside the outline
  float bt = clamp(d / uBevel, 0.0, 1.0);
  // fade the edge out when its band is under ~2 px on screen (stage size):
  // there it would only grey the whole stroke
  float hp = 6.0 * bt * (1.0 - bt) * smoothstep(0.75, 2.0, uBevel / max(fwidth(d), 1e-6));
  vec3 nb = normalize(n - uRelief * hp * (grad.x * normalize(vTp) + grad.y * normalize(vTm)));
  // the ink matcap: colour in the left half, specular strength in the right
  vec2 euv = matcapUV(nb, view);
  vec3 e = texture2D(uLogoMatcap, vec2(euv.x * 0.5, euv.y)).rgb;
  float es = texture2D(uLogoMatcap, vec2(0.5 + euv.x * 0.5, euv.y)).r;
  float lit = dot(nb - n, normalize(vec3(-0.55, 0.83, 0.0)));
  // the glint only on the edges that face the studio's key (upper left)
  vec3 ink = e * clamp(1.0 + uEdgeShade * lit, 0.0, 2.0) + uSpec * es * hp * clamp(4.0 * lit, 0.0, 1.0) * vec3(1.0, 0.97, 0.92);
  float ao = 1.0 - uAO * (1.0 - smoothstep(0.0, uAOWidth, -d)) * step(d, 0.0);
  vec3 col = mix(cap * ao, ink, cover);
  gl_FragColor = vec4(col * uDim, uOpacity);
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------- contents
// The picture's glass interior carried by the inner surface (radius 0.93), so
// the pile turns with the capsule. The far half is NOT mirrored: it takes the
// picture turned half round the axis, squeezed into the middle of the front and
// shifted along the axis (ping-pong inside the glass); the join lies on the
// inner limb, under the live rim (the prototype's glass-c.js).
export const CONTENTS_VERTEX = /* glsl */ `
uniform mat4 uRestMVP;
uniform vec3 uCamLocal;
uniform float uRi, uHC, uYmin, uYmax, uShift;
varying vec3 vClipF;
varying vec3 vClipB;
varying float vFacing;
${PILL_NORMAL}
vec3 innerPoint(float phi, float y) {
  float dy = y + uHC;
  float r = y < -uHC ? sqrt(max(uRi * uRi - dy * dy, 0.0)) : uRi;
  return vec3(r * sin(phi), y, r * cos(phi));
}
float pingpong(float y) {
  float L = uYmax - uYmin;
  float t = mod(y - uYmin, 2.0 * L);
  return uYmin + (t < L ? t : 2.0 * L - t);
}
void main() {
  vec3 nl = pillNormal(position, uHC);
  vFacing = dot(nl, normalize(uCamLocal - position));
  vec4 c = uRestMVP * vec4(position, 1.0);
  vClipF = vec3(c.xy, c.w);
  float pb = atan(position.x, position.z) + 3.14159265;
  pb = mod(pb + 3.14159265, 6.2831853) - 3.14159265;
  vec3 q = innerPoint(0.5 * pb, pingpong(position.y + uShift));
  vec4 b = uRestMVP * vec4(q, 1.0);
  vClipB = vec3(b.xy, b.w);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const CONTENTS_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec4 uRect;   // picture x0, y0 (from the top), w, h
uniform float uBackDim;
uniform float uOpacity;
uniform float uDim;       // light multiplier (sold out, the row light)
varying vec3 vClipF;
varying vec3 vClipB;
varying float vFacing;
vec2 cropUV(vec3 clip) {
  vec2 ndc = clip.xy / clip.z;
  vec2 pic = vec2(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  vec2 c = (pic - uRect.xy) / uRect.zw;
  return vec2(c.x, 1.0 - c.y);
}
void main() {
  vec3 f = texture2D(uMap, cropUV(vClipF)).rgb;
  vec3 b = texture2D(uMap, cropUV(vClipB)).rgb * uBackDim;
  float w = smoothstep(-0.06, 0.06, vFacing);
  gl_FragColor = vec4(mix(b, f, w) * uDim, uOpacity);
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------- live glass
// Composited ONE / ONE_MINUS_SRC_ALPHA: the rim and reflections add at full
// strength while the opacity dims the contents behind.
export const GLASS_VERTEX = /* glsl */ `
uniform float uHC;
varying vec3 vN;
varying vec3 vViewPos;
${PILL_NORMAL}
void main() {
  vN = normalize(normalMatrix * pillNormal(position, uHC));
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

export const GLASS_FRAGMENT = /* glsl */ `
uniform sampler2D uMatcap;
uniform float uOpacity;
uniform float uDim;       // light multiplier (sold out, the row light)
varying vec3 vN;
varying vec3 vViewPos;
${MATCAP_UV}
void main() {
  vec4 m = texture2D(uMatcap, matcapUV(normalize(vN), normalize(vViewPos)));
  gl_FragColor = vec4(m.rgb * uDim, m.a);
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
  gl_FragColor *= uOpacity;
}
`;
