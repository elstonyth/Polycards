// Tiny WebAudio synth for the Vault Room's mechanical cues (spec decision #14:
// diegetic-only). No assets to source; degrades silently without AudioContext.
// All cues are short envelopes on oscillators/noise — cheap and latency-free.

export type SfxName =
  | 'tick'
  | 'clack'
  | 'ratchet'
  | 'chime'
  | 'thunk'
  | 'credit'
  | 'meterUp'
  | 'meterDown'
  | 'clockTick'
  | 'swell';

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function blip(
  freq: number,
  durMs: number,
  opts: { type?: OscillatorType; gain?: number; slideTo?: number } = {},
): void {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = opts.type ?? 'square';
  osc.frequency.setValueAtTime(freq, t0);
  if (opts.slideTo) {
    osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t0 + durMs / 1000);
  }
  g.gain.setValueAtTime(opts.gain ?? 0.08, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + durMs / 1000 + 0.02);
}

const CUES: Record<SfxName, () => void> = {
  tick: () => blip(2400, 28, { type: 'square', gain: 0.03 }),
  clack: () => {
    blip(180, 90, { type: 'triangle', gain: 0.16, slideTo: 70 });
    blip(3200, 40, { type: 'square', gain: 0.025 }); // glass ring overtone
  },
  ratchet: () => {
    blip(900, 30, { gain: 0.04 });
    setTimeout(() => blip(1100, 30, { gain: 0.04 }), 45);
    setTimeout(() => blip(1300, 30, { gain: 0.045 }), 95);
  },
  chime: () => blip(1568, 450, { type: 'sine', gain: 0.07 }),
  thunk: () => blip(90, 260, { type: 'sine', gain: 0.22, slideTo: 45 }),
  credit: () => {
    blip(1046, 120, { type: 'sine', gain: 0.06 });
    setTimeout(() => blip(1568, 200, { type: 'sine', gain: 0.06 }), 90);
  },
  meterUp: () => blip(1800, 24, { gain: 0.03 }),
  meterDown: () => blip(1200, 24, { gain: 0.022 }),
  clockTick: () => blip(1000, 35, { type: 'sine', gain: 0.035 }),
  swell: () => blip(220, 1100, { type: 'sine', gain: 0.05, slideTo: 330 }),
};

export function playSfx(name: SfxName): void {
  try {
    CUES[name]();
  } catch {
    /* non-fatal */
  }
}
