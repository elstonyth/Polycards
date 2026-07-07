'use client';

import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { FRAME_MOTION } from '@/lib/frame-motion';

/**
 * Animated avatar-frame overlay — a WebGL UV-displacement shader (ported from
 * the tuned Avatar_Frame preview) scrolls multi-octave noise through the frame
 * image so flames lick, water swirls and limbs sweep, anchored (zero motion)
 * at the photo hole. Renders the static <img> until the shader is live and
 * falls back to it permanently under prefers-reduced-motion, when WebGL is
 * unavailable, when the texture fails, or when the shared context budget is
 * spent — the static frame is always correct, animation is pure enhancement.
 */

// Geometry, avatar mode: FramedAvatar draws the frame at 128% of the avatar;
// the canvas adds 24% headroom beyond that (matching the preview's 310/250)
// so swinging limbs and displaced flames don't clip. The photo-hole anchor
// radius in canvas UV = (size/2) / (size*1.28*1.24) ≈ 0.315.
// Plain mode (frames workbook tiles — no photo): the frame box IS `size`, and
// the anchor is the art's own hole (60% of the art box, like the preview).
const FRAME_SCALE = 1.28;
const CANVAS_OVERSIZE = 1.24;
const HOLE_R_AVATAR = 0.5 / (FRAME_SCALE * CANVAS_OVERSIZE);
const HOLE_R_PLAIN = (0.6 * 0.5) / CANVAS_OVERSIZE;

// A WebGL context per animated frame; browsers cap ~16 per page. Header/
// profile avatar + up to 10 workbook tiles = 11, so 12 is the ceiling —
// beyond it, extras stay static. ponytail: module counter, no LRU reclaim.
const MAX_CONTEXTS = 12;
let activeContexts = 0;

const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FS = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_time;
uniform float u_inset;
uniform float u_holeR;
uniform float u_amp;
uniform float u_angScale;
uniform float u_radScale;
uniform float u_radialFlow;
uniform float u_swirl;
uniform float u_speed;
uniform float u_flicker;
uniform float u_twinkle;
uniform float u_waveFreq;
uniform float u_waveAmp;
uniform float u_waveSpeed;
uniform float u_bend;
uniform float u_bendNoise;
uniform float u_chroma;
uniform float u_jolt;
uniform float u_ghost;
uniform float u_surge;
uniform float u_surgeSpeed;
uniform float u_upFlow;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 d = v_uv - 0.5;
  float r = length(d);
  vec2 dir = r > 0.0005 ? d / r : vec2(0.0);
  vec2 tang = vec2(-dir.y, dir.x);
  float ang = atan(d.y, d.x);
  float t = u_time * u_speed;

  float m = smoothstep(u_holeR, u_holeR + 0.20, r);

  float bendMask = smoothstep(u_holeR + 0.01, 0.55, r);
  float sn = sin(ang * u_waveFreq - u_time * u_waveSpeed);
  float bn = (fbm(vec2(ang * 1.5 + 3.7, u_time * 0.45)) - 0.44) * 2.5;
  float bend = u_bend * mix(sn, bn, u_bendNoise) * bendMask;
  float surge = u_waveAmp * sn * bendMask;

  float cb = cos(bend), sb = sin(bend);
  vec2 rd = vec2(d.x * cb - d.y * sb, d.x * sb + d.y * cb) * (1.0 - surge);
  vec2 uv = rd * u_inset + 0.5;

  vec2 fp = vec2(ang * u_angScale + t * u_swirl,
                 r * u_radScale - t * u_radialFlow);
  float n1 = fbm(fp);
  float n2 = fbm(fp + vec2(5.2, 1.3));
  vec2 disp = (dir * (n1 - 0.44) + tang * (n2 - 0.44)) * u_amp * m;

  if (u_jolt > 0.0001) {
    float g = step(0.72, hash(vec2(floor(t * 9.0), 3.7)));
    disp += (dir * (n2 - 0.5) + tang * (n1 - 0.5)) * u_jolt * g * m;
  }

  if (u_upFlow > 0.0001) {
    float n3 = fbm(vec2(v_uv.x * 6.0, v_uv.y * 8.0 - t * u_upFlow));
    disp.y += (n3 - 0.44) * u_amp * 1.4 * m;
  }

  vec2 suv = uv - disp;

  vec4 col;
  if (u_chroma > 0.0001) {
    vec2 off = dir * u_chroma * m;
    vec4 base = texture2D(u_tex, suv);
    col = vec4(texture2D(u_tex, suv + off).r,
               base.g,
               texture2D(u_tex, suv - off).b,
               base.a);
  } else {
    col = texture2D(u_tex, suv);
  }
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) {
    col = vec4(0.0);
  }

  if (u_ghost > 0.001) {
    float sn2 = sin(ang * u_waveFreq - (u_time - 0.22) * u_waveSpeed);
    float bend2 = u_bend * mix(sn2, bn, u_bendNoise) * bendMask;
    float surge2 = u_waveAmp * sn2 * bendMask;
    float cb2 = cos(bend2), sb2 = sin(bend2);
    vec2 rd2 = vec2(d.x * cb2 - d.y * sb2, d.x * sb2 + d.y * cb2)
               * (1.0 - surge2);
    vec2 uv2 = rd2 * u_inset + 0.5;
    vec4 g = texture2D(u_tex, uv2 - disp);
    if (uv2.x < 0.0 || uv2.x > 1.0 || uv2.y < 0.0 || uv2.y > 1.0) {
      g = vec4(0.0);
    }
    col += g * u_ghost * (1.0 - col.a);
  }

  float lum = dot(col.rgb, vec3(0.299, 0.587, 0.114));

  if (u_flicker > 0.0001) {
    float fl = fbm(vec2(ang * 3.0 + t * 0.7, r * 8.0 - t * 1.6));
    col.rgb *= 1.0 + u_flicker * (fl - 0.45) * 2.0 * m
                   * smoothstep(0.25, 0.75, lum);
  }

  if (u_twinkle > 0.0001) {
    float tw = vnoise(v_uv * 60.0 + vec2(t * 1.5, -t * 1.1));
    tw = pow(tw, 6.0);
    col.rgb += col.rgb * tw * u_twinkle * 4.0 * smoothstep(0.35, 0.85, lum);
  }

  if (u_surge > 0.001) {
    float sa = u_time * u_surgeSpeed;
    float dA = abs(mod(ang - sa + 3.14159, 6.2831) - 3.14159);
    float sweep = exp(-dA * dA * 10.0);
    col.rgb += col.rgb * sweep * u_surge * m;
  }

  // Some frame art (e.g. LV 40's lateral flame streams) runs to the PNG
  // border and gets hard-cut by it. Dissolve the last ~5% of texture space
  // so edge-touching art fades out instead of slicing off. (Ascending edges
  // only — smoothstep with edge0 > edge1 is undefined per the GLSL spec.)
  float edge = smoothstep(0.0, 0.05, suv.x)
             * (1.0 - smoothstep(0.95, 1.0, suv.x))
             * smoothstep(0.0, 0.05, suv.y)
             * (1.0 - smoothstep(0.95, 1.0, suv.y));
  col *= edge;

  gl_FragColor = col;
}`;

const UNIFORM_MAP = {
  amp: 'u_amp',
  angScale: 'u_angScale',
  radScale: 'u_radScale',
  radialFlow: 'u_radialFlow',
  swirl: 'u_swirl',
  speed: 'u_speed',
  flicker: 'u_flicker',
  twinkle: 'u_twinkle',
  waveFreq: 'u_waveFreq',
  waveAmp: 'u_waveAmp',
  waveSpeed: 'u_waveSpeed',
  bend: 'u_bend',
  bendNoise: 'u_bendNoise',
  chroma: 'u_chroma',
  jolt: 'u_jolt',
  ghost: 'u_ghost',
  surge: 'u_surge',
  surgeSpeed: 'u_surgeSpeed',
  upFlow: 'u_upFlow',
} as const;

// One shared rAF drives every live frame — N frames never spawn N loops.
type Instance = {
  gl: WebGLRenderingContext;
  uTime: WebGLUniformLocation | null;
};
const instances = new Set<Instance>();
let rafId = 0;
let t0 = 0;
function tick(now: number) {
  if (!t0) t0 = now;
  const time = (now - t0) / 1000;
  for (const ins of instances) {
    ins.gl.uniform1f(ins.uTime, time);
    ins.gl.drawArrays(ins.gl.TRIANGLES, 0, 3);
  }
  rafId = instances.size > 0 ? requestAnimationFrame(tick) : 0;
}
function addInstance(ins: Instance) {
  instances.add(ins);
  if (!rafId) rafId = requestAnimationFrame(tick);
}
function removeInstance(ins: Instance) {
  instances.delete(ins);
}

export function AnimatedFrame({
  frameSrc,
  level,
  size,
  plain = false,
}: {
  frameSrc: string;
  /** Milestone level — selects the tuned motion recipe. */
  level: number;
  /** Avatar size in px (the frame renders at 128% of it, like FramedAvatar). */
  size: number;
  /** No photo behind (workbook tile): the frame box IS `size`. */
  plain?: boolean;
}) {
  const reduced = usePrefersReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState(false);
  const params = FRAME_MOTION[level];
  // CSS box only — the DPR-scaled draw buffer is sized in the init effect
  // (render-time devicePixelRatio would cause a hydration mismatch).
  const canvasCss = Math.round(
    size * (plain ? 1 : FRAME_SCALE) * CANVAS_OVERSIZE,
  );

  useEffect(() => {
    if (reduced || !params) return;
    const canvas = canvasRef.current;
    if (!canvas || activeContexts >= MAX_CONTEXTS) return;
    // Reserve the slot NOW: the guard and the increment must not straddle the
    // async image load, or N simultaneous mounts all pass the check at 0 and
    // the cap never caps. Released exactly once (cleanup, or early on a path
    // where no context will ever exist).
    activeContexts++;
    let released = false;
    const releaseSlot = () => {
      if (!released) {
        released = true;
        activeContexts--;
      }
    };

    let cancelled = false;
    let ins: Instance | null = null;
    let gl: WebGLRenderingContext | null = null;

    const img = new Image();
    // Same-origin via the Next image optimizer — raw backend/CDN frame URLs
    // would need CORS for texImage2D; the proxy sidesteps that everywhere.
    img.src = `/_next/image?url=${encodeURIComponent(frameSrc)}&w=640&q=75`;
    img.onerror = () => {
      if (!cancelled) releaseSlot(); // texture failed — no context will exist
    };
    img.onload = () => {
      if (cancelled || !canvasRef.current) return;
      const cv = canvasRef.current;
      // Draw-buffer size is set here, NOT as JSX width/height: reading
      // devicePixelRatio during render makes server (1) and HiDPI client
      // HTML disagree — a hydration mismatch. The buffer only has to be
      // right before the first draw.
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      cv.width = Math.round(canvasCss * dpr);
      cv.height = Math.round(canvasCss * dpr);
      gl = cv.getContext('webgl', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
      });
      if (!gl) {
        releaseSlot(); // context creation failed — free the slot for others
        return;
      }

      const compile = (type: number, src: string) => {
        const s = gl!.createShader(type)!;
        gl!.shaderSource(s, src);
        gl!.compileShader(s);
        return gl!.getShaderParameter(s, gl!.COMPILE_STATUS) ? s : null;
      };
      const vs = compile(gl.VERTEX_SHADER, VS);
      const fs = compile(gl.FRAGMENT_SHADER, FS);
      if (!vs || !fs) return;
      const prog = gl.createProgram()!;
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
      gl.useProgram(prog);

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]),
        gl.STATIC_DRAW,
      );
      const loc = gl.getAttribLocation(prog, 'a_pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      // Optimizer output is non-POT — LINEAR + CLAMP, no mipmaps (WebGL1 rule).
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      gl.uniform1f(gl.getUniformLocation(prog, 'u_inset'), CANVAS_OVERSIZE);
      gl.uniform1f(
        gl.getUniformLocation(prog, 'u_holeR'),
        plain ? HOLE_R_PLAIN : HOLE_R_AVATAR,
      );
      for (const [k, u] of Object.entries(UNIFORM_MAP)) {
        gl.uniform1f(
          gl.getUniformLocation(prog, u),
          params[k as keyof typeof UNIFORM_MAP],
        );
      }
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

      ins = { gl, uTime: gl.getUniformLocation(prog, 'u_time') };
      addInstance(ins);
      setLive(true);
    };

    return () => {
      cancelled = true;
      if (ins) removeInstance(ins);
      releaseSlot();
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      setLive(false);
    };
  }, [frameSrc, params, reduced, plain, canvasCss]);

  return (
    <>
      {/* Static frame stays mounted below the canvas until the shader is live
          (and forever when it never goes live) — never a blank ring. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={frameSrc}
        alt=""
        aria-hidden
        width={size}
        height={size}
        className={
          plain
            ? 'pointer-events-none absolute left-1/2 top-1/2 h-full w-full max-w-none -translate-x-1/2 -translate-y-1/2 object-contain'
            : 'pointer-events-none absolute left-1/2 top-1/2 h-[128%] w-[128%] max-w-none -translate-x-1/2 -translate-y-1/2 object-contain'
        }
        style={live ? { visibility: 'hidden' } : undefined}
      />
      {!reduced && params && (
        <canvas
          // A canvas whose WebGL context was lost can never host a fresh one —
          // key by src so a frame swap mounts a NEW canvas instead of reusing
          // the dead node (the "static after equip" bug).
          key={frameSrc}
          ref={canvasRef}
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 max-w-none -translate-x-1/2 -translate-y-1/2"
          style={{
            width: canvasCss,
            height: canvasCss,
            visibility: live ? 'visible' : 'hidden',
          }}
        />
      )}
    </>
  );
}
