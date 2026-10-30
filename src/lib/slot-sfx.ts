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
  | 'tensionRise'
  | 'uiClick'
  | 'drawStart'
  | 'drawTick'
  | 'drawStop'
  | 'drawWin';

let ctx: AudioContext | null = null;
let effectsGain: GainNode | null = null;
let effectsMuted = false;

export function setSfxMuted(muted: boolean): void {
  effectsMuted = muted;
  if (effectsGain) effectsGain.gain.value = muted ? 0 : 0.22;
}
/**
 * The one AudioContext for the whole slot screen — the cue synth here and the
 * ambient bed in use-sound both run through it. Browsers cap live contexts, and
 * a second one would also need its own gesture unlock.
 */
export function sharedAudioContext(): AudioContext | null {
  return audio();
}

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** The shared effects bus every cue plays through (muted by setSfxMuted). */
function bus(ac: AudioContext): GainNode {
  if (!effectsGain) {
    effectsGain = ac.createGain();
    effectsGain.gain.value = 0.22;
    effectsGain.connect(ac.destination);
  }
  return effectsGain;
}

function blip(
  freq: number,
  durMs: number,
  opts: {
    type?: OscillatorType;
    gain?: number;
    slideTo?: number;
    /** Seconds from now, on the audio clock (tighter than setTimeout). */
    at?: number;
  } = {},
): void {
  if (effectsMuted) return;
  const ac = audio();
  if (!ac) return;
  const out = bus(ac);
  const t0 = ac.currentTime + (opts.at ?? 0);
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = opts.type ?? 'square';
  osc.frequency.setValueAtTime(freq, t0);
  if (opts.slideTo) {
    osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t0 + durMs / 1000);
  }
  g.gain.setValueAtTime(opts.gain ?? 0.08, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  osc.connect(g).connect(out);
  osc.onended = () => {
    osc.disconnect();
    g.disconnect();
  };
  osc.start(t0);
  osc.stop(t0 + durMs / 1000 + 0.02);
}

let noiseBuffer: AudioBuffer | null = null;

/** Band-passed white noise: airy swooshes and the grain in clicks/knocks.
 *  `attackMs` swells in (a whoosh); 0 is an instant hit that decays. */
function noise(
  durMs: number,
  opts: {
    from: number;
    to?: number;
    q?: number;
    gain?: number;
    attackMs?: number;
    at?: number;
  },
): void {
  if (effectsMuted) return;
  const ac = audio();
  if (!ac) return;
  if (!noiseBuffer) {
    noiseBuffer = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const t0 = ac.currentTime + (opts.at ?? 0);
  const end = t0 + durMs / 1000;
  const src = ac.createBufferSource();
  const filter = ac.createBiquadFilter();
  const g = ac.createGain();
  src.buffer = noiseBuffer;
  src.loop = true;
  filter.type = 'bandpass';
  filter.Q.value = opts.q ?? 1;
  filter.frequency.setValueAtTime(opts.from, t0);
  if (opts.to) filter.frequency.exponentialRampToValueAtTime(opts.to, end);
  const peak = opts.gain ?? 0.05;
  const attack = (opts.attackMs ?? 0) / 1000;
  if (attack > 0) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  } else {
    g.gain.setValueAtTime(peak, t0);
  }
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  src.connect(filter).connect(g).connect(bus(ac));
  src.onended = () => {
    src.disconnect();
    filter.disconnect();
    g.disconnect();
  };
  src.start(t0);
  src.stop(end + 0.02);
}

// The Lucky Draw wheel (operator ask 2026-10-25): premium and quiet, never a
// casino jingle. A glassy E-major shimmer for the win, matching the holo dust.
const WIN_NOTES = [1318.5, 1661.2, 1975.5, 2637]; // E6 G#6 B6 E7

const CUES: Record<SfxName, () => void> = {
  tick: () => blip(2400, 28, { type: 'square', gain: 0.03 }),
  // Clicky per-cell reel tick (operator ask 2026-08-04: "more clicky"): short
  // bright transient over a stubby tonal body — reads as a mechanical pawl
  // click per Pokémon crossing the winning line. Rate follows the reel (fires
  // per crossing), so ticks speed up through the fast middle and space out
  // into a countable landing.
  reelTick: () => {
    blip(2100, 16, { type: 'triangle', gain: 0.12, slideTo: 1700 });
    blip(5200, 10, { type: 'square', gain: 0.06 }); // sharp click transient
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
  // Site-wide button/link press (operator ask 2026-10-08): a soft, short "tok"
  // — triangle body sliding down so it reads as a press, not a beep. Pitch sits
  // in the 1–1.4 kHz band phone speakers reproduce; lower "thud" variants
  // vanish on mobile. `gain` is the loudness knob (0.07 was inaudible).
  uiClick: () => blip(1400, 40, { type: 'triangle', gain: 0.25, slideTo: 900 }),
  // Gains below are ~11x the first cut, which peaked near -26 dBFS and was
  // inaudible on phone speakers and under the music bed (operator 2026-10-25);
  // the wheel also ducks the music bed while it is on screen.
  // The wheel launching out of its pull-back: a soft rising air swoosh.
  drawStart: () => {
    noise(650, { from: 380, to: 2600, q: 0.7, gain: 0.8, attackMs: 220 });
    blip(110, 500, { type: 'sine', gain: 0.6, slideTo: 165 });
  },
  // The pointer flicking over a wedge edge: a crisp, light pawl click (fires
  // per edge, throttled by the wheel, so it slows into a countable landing).
  drawTick: () => {
    blip(3200, 14, { type: 'triangle', gain: 0.9, slideTo: 2500 });
    noise(12, { from: 6000, q: 1.4, gain: 0.5 });
  },
  // The wheel settling: a muted wooden knock.
  drawStop: () => {
    blip(150, 240, { type: 'sine', gain: 1.8, slideTo: 78 });
    blip(430, 90, { type: 'triangle', gain: 0.6, slideTo: 300 });
    noise(70, { from: 1800, to: 600, q: 0.8, gain: 0.7 });
  },
  // The prize rising and the winner named: a glassy arpeggio over a soft
  // pad, with high sparkles drifting off like the dust motes.
  drawWin: () => {
    WIN_NOTES.forEach((f, i) =>
      blip(f, 1200, { type: 'sine', gain: 0.6, at: i * 0.085 }),
    );
    blip(659.3, 1600, { type: 'sine', gain: 0.36, at: 0.05 });
    blip(988, 1500, { type: 'sine', gain: 0.25, at: 0.12 });
    for (let i = 0; i < 9; i++) {
      blip(3000 + Math.random() * 4000, 120, {
        type: 'sine',
        gain: 0.18,
        at: 0.25 + i * 0.12 + Math.random() * 0.06,
      });
    }
  },
};

export function playSfx(name: SfxName): void {
  try {
    CUES[name]();
  } catch {
    /* non-fatal */
  }
}
