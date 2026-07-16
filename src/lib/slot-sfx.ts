// Tiny WebAudio synth for the Vault Room's mechanical cues (spec decision #14:
// diegetic-only). No assets to source; degrades silently without AudioContext.
// All cues are short envelopes on oscillators/noise — cheap and latency-free.

export type SfxName =
  | 'tick'
  | 'reelTick'
  | 'clack'
  | 'ratchet'
  | 'chime'
  | 'thunk'
  | 'credit'
  | 'meterUp'
  | 'meterDown'
  | 'clockTick'
  | 'swell'
  | 'heartbeat'
  | 'tensionRise';

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
  // Woody per-cell reel tick — softer than `tick` (triangle, lower, quick decay)
  // so a rapid run of them reads as a crisp tick track, not a harsh buzz. One
  // fires per Pokémon crossing the winning line; the rate decelerates with the
  // reel, so the ticks naturally slow and space out into a countable landing.
  reelTick: () => {
    blip(1500, 24, { type: 'triangle', gain: 0.14, slideTo: 1300 });
    blip(3600, 12, { type: 'square', gain: 0.028 }); // click transient
  },
  clack: () => {
    blip(180, 90, { type: 'triangle', gain: 0.16, slideTo: 70 });
    blip(3200, 40, { type: 'square', gain: 0.025 }); // glass ring overtone
  },
  ratchet: () => {
    blip(900, 30, { gain: 0.04 });
    setTimeout(() => blip(1100, 30, { gain: 0.04 }), 45);
    setTimeout(() => blip(1300, 30, { gain: 0.045 }), 95);
  },
  chime: () => blip(1568, 450, { type: 'sine', gain: 0.045 }),
  thunk: () => blip(90, 260, { type: 'sine', gain: 0.22, slideTo: 45 }),
  credit: () => {
    blip(1046, 120, { type: 'sine', gain: 0.06 });
    setTimeout(() => blip(1568, 200, { type: 'sine', gain: 0.06 }), 90);
  },
  meterUp: () => blip(1800, 24, { gain: 0.03 }),
  meterDown: () => blip(1200, 24, { gain: 0.022 }),
  clockTick: () => blip(1000, 35, { type: 'sine', gain: 0.035 }),
  swell: () => blip(220, 1100, { type: 'sine', gain: 0.05, slideTo: 330 }),
  heartbeat: () => {
    blip(60, 90, { type: 'sine', gain: 0.14, slideTo: 40 });
    setTimeout(
      () => blip(60, 120, { type: 'sine', gain: 0.18, slideTo: 38 }),
      150,
    );
  },
  tensionRise: () =>
    blip(180, 900, { type: 'sawtooth', gain: 0.05, slideTo: 520 }),
};

export function playSfx(name: SfxName): void {
  try {
    CUES[name]();
  } catch {
    /* non-fatal */
  }
}
