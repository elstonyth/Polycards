/**
 * Per-tier motion recipes for the animated avatar frames — ported verbatim
 * from the tuned WebGL preview (Desktop/Avatar_Frame/_preview/preview.html).
 * amp/waveAmp are UV units (0.01 ≈ 3px at preview scale). radialFlow > 0
 * flows outward (fire), < 0 inward (void). bend = structural limb swing in
 * radians at the tips; bendNoise 0 = smooth sine swing, 1 = erratic wobble.
 */
export interface FrameMotionParams {
  amp: number;
  angScale: number;
  radScale: number;
  radialFlow: number;
  swirl: number;
  speed: number;
  flicker: number;
  twinkle: number;
  bend: number;
  bendNoise: number;
  waveFreq: number;
  waveSpeed: number;
  waveAmp: number;
  chroma: number;
  jolt: number;
  ghost: number;
  surge: number;
  surgeSpeed: number;
  upFlow: number;
}

export const FRAME_MOTION: Record<number, FrameMotionParams> = {
  // Aqua Portal
  10: {
    amp: 0.014,
    angScale: 3.0,
    radScale: 9.0,
    radialFlow: 0.7,
    swirl: 0.9,
    speed: 0.9,
    flicker: 0.25,
    twinkle: 0.25,
    bend: 0.1,
    bendNoise: 0.35,
    waveFreq: 2,
    waveSpeed: 2.0,
    waveAmp: 0.02,
    chroma: 0,
    jolt: 0,
    ghost: 0.3,
    surge: 0.5,
    surgeSpeed: 1.4,
    upFlow: 0,
  },
  // Verdant Bloom
  20: {
    amp: 0.013,
    angScale: 4.0,
    radScale: 7.0,
    radialFlow: 0.35,
    swirl: 0.5,
    speed: 0.7,
    flicker: 0.2,
    twinkle: 0.2,
    bend: 0.08,
    bendNoise: 0.45,
    waveFreq: 3,
    waveSpeed: 1.4,
    waveAmp: 0.014,
    chroma: 0,
    jolt: 0,
    ghost: 0.2,
    surge: 0.4,
    surgeSpeed: 1.0,
    upFlow: 0.2,
  },
  // Frost Sigil
  30: {
    amp: 0.006,
    angScale: 5.0,
    radScale: 8.0,
    radialFlow: 0.2,
    swirl: 0.15,
    speed: 0.6,
    flicker: 0.15,
    twinkle: 1.1,
    bend: 0.035,
    bendNoise: 0.15,
    waveFreq: 2,
    waveSpeed: 0.8,
    waveAmp: 0.008,
    chroma: 0.0015,
    jolt: 0,
    ghost: 0.15,
    surge: 0.55,
    surgeSpeed: 0.8,
    upFlow: 0,
  },
  // Inferno Phoenix
  40: {
    amp: 0.03,
    angScale: 3.5,
    radScale: 10.0,
    radialFlow: 2.2,
    swirl: 0.25,
    speed: 1.15,
    flicker: 0.7,
    twinkle: 0,
    bend: 0.14,
    bendNoise: 0.55,
    waveFreq: 2,
    waveSpeed: 2.6,
    waveAmp: 0.03,
    chroma: 0,
    jolt: 0,
    ghost: 0.45,
    surge: 0.6,
    surgeSpeed: 1.8,
    upFlow: 1.5,
  },
  // Storm Caller
  50: {
    amp: 0.018,
    angScale: 6.0,
    radScale: 12.0,
    radialFlow: 0.9,
    swirl: 0.4,
    speed: 1.6,
    flicker: 0.6,
    twinkle: 0.3,
    bend: 0.11,
    bendNoise: 1.0,
    waveFreq: 4,
    waveSpeed: 4.0,
    waveAmp: 0.016,
    chroma: 0,
    jolt: 0.035,
    ghost: 0.3,
    surge: 0.7,
    surgeSpeed: 2.6,
    upFlow: 0.4,
  },
  // Golden Dragon
  60: {
    amp: 0.01,
    angScale: 3.0,
    radScale: 7.0,
    radialFlow: 0.5,
    swirl: 0.3,
    speed: 1.0,
    flicker: 0.4,
    twinkle: 0.25,
    bend: 0.2,
    bendNoise: 0.15,
    waveFreq: 2,
    waveSpeed: 2.0,
    waveAmp: 0.024,
    chroma: 0,
    jolt: 0,
    ghost: 0.55,
    surge: 0.6,
    surgeSpeed: 1.5,
    upFlow: 0.3,
  },
  // Void Warden
  70: {
    amp: 0.02,
    angScale: 3.0,
    radScale: 9.0,
    radialFlow: -1.5,
    swirl: 1.1,
    speed: 0.8,
    flicker: 0.25,
    twinkle: 0.35,
    bend: 0.16,
    bendNoise: 0.45,
    waveFreq: 1,
    waveSpeed: 0.9,
    waveAmp: 0.018,
    chroma: 0.002,
    jolt: 0,
    ghost: 0.45,
    surge: 0.5,
    surgeSpeed: -1.2,
    upFlow: 0,
  },
  // Solar Regalia
  80: {
    amp: 0.014,
    angScale: 4.0,
    radScale: 8.0,
    radialFlow: 0.8,
    swirl: 0.2,
    speed: 0.9,
    flicker: 0.5,
    twinkle: 0.5,
    bend: 0.08,
    bendNoise: 0.12,
    waveFreq: 2,
    waveSpeed: 0.9,
    waveAmp: 0.013,
    chroma: 0,
    jolt: 0,
    ghost: 0.25,
    surge: 0.8,
    surgeSpeed: 1.1,
    upFlow: 0.6,
  },
  // Galaxy Sovereign
  90: {
    amp: 0.013,
    angScale: 2.5,
    radScale: 6.0,
    radialFlow: 0.15,
    swirl: 0.8,
    speed: 0.5,
    flicker: 0.2,
    twinkle: 1.2,
    bend: 0.1,
    bendNoise: 0.25,
    waveFreq: 1,
    waveSpeed: 0.55,
    waveAmp: 0.012,
    chroma: 0.0025,
    jolt: 0,
    ghost: 0.35,
    surge: 0.55,
    surgeSpeed: 0.7,
    upFlow: 0,
  },
  // Ascendant Prism
  100: {
    amp: 0.012,
    angScale: 3.0,
    radScale: 7.0,
    radialFlow: 0.3,
    swirl: 0.35,
    speed: 0.8,
    flicker: 0.3,
    twinkle: 0.9,
    bend: 0.09,
    bendNoise: 0.15,
    waveFreq: 3,
    waveSpeed: 1.2,
    waveAmp: 0.012,
    chroma: 0.007,
    jolt: 0,
    ghost: 0.35,
    surge: 0.9,
    surgeSpeed: 2.0,
    upFlow: 0.2,
  },
};
