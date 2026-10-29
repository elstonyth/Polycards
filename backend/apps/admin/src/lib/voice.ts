// Browser audio for the assistant's voice mode: record a question as a 16 kHz
// WAV, and play the streamed 24 kHz PCM16 answer. Web Audio + getUserMedia
// only: the speech model takes wav but not webm, so MediaRecorder is out.

export const RECORD_RATE = 16000;
export const PLAY_RATE = 24000;

/** 16-bit PCM mono WAV (44-byte RIFF header). */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++)
      view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** Linear-interpolated / averaged resample, e.g. 48000 -> 16000. Returns input when rates are equal. */
export function downsample(
  input: Float32Array,
  from: number,
  to: number,
): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const start = Math.floor(pos);
    const end = Math.min(input.length, Math.floor(pos + ratio));
    if (end - start > 1) {
      // average the span this sample covers: a cheap low-pass against aliasing
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      out[i] = sum / (end - start);
    } else {
      const next = input[Math.min(start + 1, input.length - 1)];
      out[i] = input[start] + (next - input[start]) * (pos - start);
    }
  }
  return out;
}

export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  // chunked: spreading a whole recording into fromCharCode overflows the stack
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function pcm16ToFloat(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength >> 1);
  for (let i = 0; i < out.length; i++)
    out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** base64 PCM16 LE -> Float32 in [-1, 1]. */
export function decodePcm16(base64: string): Float32Array {
  return pcm16ToFloat(base64ToBytes(base64));
}

const CALIBRATE_MS = 300; // the first frames are taken as the room's noise floor
const FLOOR_CAP = 0.02; // talking during calibration must not raise the bar above speech
const FLOOR_FACTOR = 3; // speech is at least 3x the room
const MIN_SPEECH_RMS = 0.01; // a near-silent room's hiss is never speech
const FLOOR_FALL = 0.3; // floor follows a quieter room fast
const FLOOR_RISE = 0.02; // and a louder one slowly, so pauses between words don't lift it

type VadState = 'waiting' | 'speaking' | 'ended' | 'timeout';

/** Energy-based end-of-speech detector, fed one frame at a time. */
export function createVad(
  opts: {
    silenceMs?: number; // default 1100: quiet this long after speech = ended
    minSpeechMs?: number; // default 250: shorter bursts are not speech
    noSpeechMs?: number; // default 8000: nothing said this long = 'timeout'
    maxMs?: number; // default 60000: hard stop = 'ended'
    sensitivity?: number; // default 1: below 1 needs louder speech (the bar is divided by it)
  } = {},
): { push(rms: number, frameMs: number): VadState } {
  const {
    silenceMs = 1100,
    minSpeechMs = 250,
    noSpeechMs = 8000,
    maxMs = 60000,
    sensitivity = 1,
  } = opts;
  let elapsed = 0;
  let calibrated = 0;
  let floor = 0;
  let run = 0; // ms of back-to-back loud frames
  let silent = 0; // ms since the last loud frame
  let spoke = false;
  let result: 'ended' | 'timeout' | undefined;
  return {
    push(rms, frameMs) {
      if (result) return result;
      elapsed += frameMs;
      if (elapsed <= CALIBRATE_MS) {
        calibrated++;
        floor = Math.min(FLOOR_CAP, floor + (rms - floor) / calibrated);
      } else if (
        rms >
        Math.max(floor * FLOOR_FACTOR, MIN_SPEECH_RMS) / sensitivity
      ) {
        run += frameMs;
        silent = 0;
        if (run >= minSpeechMs) spoke = true;
      } else {
        run = 0;
        silent += frameMs;
        floor = Math.min(
          FLOOR_CAP,
          floor + (rms - floor) * (rms < floor ? FLOOR_FALL : FLOOR_RISE),
        );
      }
      if ((spoke && silent >= silenceMs) || elapsed >= maxMs)
        return (result = 'ended');
      if (!spoke && elapsed >= noSpeechMs) return (result = 'timeout');
      return spoke ? 'speaking' : 'waiting';
    },
  };
}

export type Recording = {
  /** base64 WAV of what was said; null when nothing was said, the recording was cancelled, or the mic could not open. */
  done: Promise<string | null>;
  /** Stop now and keep what was said. */
  stop(): void;
  /** Stop and drop it (done resolves null). */
  cancel(): void;
};

export class MicError extends Error {
  constructor(readonly reason: 'denied' | 'unavailable') {
    super(
      reason === 'denied'
        ? 'Microphone access was denied'
        : 'No microphone available',
    );
    this.name = 'MicError';
  }
}

function audioContextCtor(): typeof AudioContext | undefined {
  // Safari before 14.1 only has the prefixed constructor
  const g = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  return g.AudioContext ?? g.webkitAudioContext;
}

const FRAME = 2048; // ~43 ms at 48 kHz: one VAD step and ~20 level updates a second

const TAP_WORKLET = `
class VoiceTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${FRAME}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === ${FRAME}) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(${FRAME}); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('voice-tap', VoiceTap);
`;

function rmsOf(frame: Float32Array): number {
  let sum = 0;
  for (const s of frame) sum += s * s;
  return Math.sqrt(sum / frame.length);
}

// dB scale (-60..-10 dB) so quiet speech still moves the meter
function toLevel(rms: number): number {
  return Math.max(0, Math.min(1, (20 * Math.log10(rms + 1e-9) + 60) / 50));
}

/** Opens the mic (echoCancellation, noiseSuppression, autoGainControl, mono)
 *  on a new context. Throws MicError('denied' | 'unavailable'). */
async function openMic(): Promise<{ ctx: AudioContext; stream: MediaStream }> {
  const Ctx = audioContextCtor();
  // getUserMedia is missing outside a secure context (plain http)
  if (!Ctx || !navigator.mediaDevices?.getUserMedia)
    throw new MicError('unavailable');
  // made before the permission await so iOS still counts the tap as the gesture
  const ctx = new Ctx();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    return { ctx, stream };
  } catch (err) {
    void ctx.close();
    const denied =
      err instanceof DOMException &&
      (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    throw new MicError(denied ? 'denied' : 'unavailable');
  }
}

/** Feeds the mic to onFrame, FRAME samples at a time. */
async function tapMic(
  ctx: AudioContext,
  stream: MediaStream,
  onFrame: (frame: Float32Array) => void,
): Promise<void> {
  const source = ctx.createMediaStreamSource(stream);
  let tap: AudioNode;
  if (ctx.audioWorklet) {
    const url = URL.createObjectURL(
      new Blob([TAP_WORKLET], { type: 'text/javascript' }),
    );
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, 'voice-tap');
    node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data);
    tap = node;
  } else {
    // Safari < 14.1 has no AudioWorklet; the deprecated ScriptProcessorNode still works there
    const node = ctx.createScriptProcessor(FRAME, 1, 1);
    node.onaudioprocess = (e) =>
      onFrame(e.inputBuffer.getChannelData(0).slice());
    tap = node;
  }
  source.connect(tap);
  // the tap outputs silence; it must reach destination or the browser won't run it
  tap.connect(ctx.destination);
  if (ctx.state === 'suspended') void ctx.resume();
}

/** Opens the mic (echoCancellation, noiseSuppression, autoGainControl, mono).
 *  With autoStop it ends by itself once the speaker goes quiet (createVad).
 *  onLevel gets 0..1 for a level meter about 20 times a second.
 *  Throws MicError('denied' | 'unavailable') when the mic can't open. */
export async function startRecording(opts: {
  autoStop: boolean;
  onLevel?: (level: number) => void;
  onSpeech?: () => void; // first time speech is detected
}): Promise<Recording> {
  const { ctx, stream } = await openMic();
  const rate = ctx.sampleRate;
  const frames: Float32Array[] = [];
  const vad = createVad();
  let heard = false;
  let finished = false;
  let resolveDone: (wav: string | null) => void = () => {};
  const done = new Promise<string | null>((resolve) => (resolveDone = resolve));

  const finish = (keep: boolean) => {
    if (finished) return;
    finished = true;
    window.removeEventListener('pagehide', onHide);
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    // under minSpeechMs of speech the VAD never says 'speaking': nothing worth sending
    if (!keep || !heard) return resolveDone(null);
    const all = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of frames) {
      all.set(f, at);
      at += f.length;
    }
    resolveDone(
      bytesToBase64(encodeWav(downsample(all, rate, RECORD_RATE), RECORD_RATE)),
    );
  };
  // leaving the page drops it, so a page back from the bfcache doesn't send it
  const onHide = () => finish(false);
  window.addEventListener('pagehide', onHide);

  const onFrame = (frame: Float32Array) => {
    if (finished) return;
    frames.push(frame);
    const rms = rmsOf(frame);
    opts.onLevel?.(toLevel(rms));
    const state = vad.push(rms, (frame.length / rate) * 1000);
    if (state === 'speaking' && !heard) {
      heard = true;
      opts.onSpeech?.();
    }
    if (opts.autoStop && (state === 'ended' || state === 'timeout'))
      finish(true);
  };

  try {
    await tapMic(ctx, stream, onFrame);
    // mic unplugged or permission revoked mid-recording: no more frames would ever come, keep what was said
    stream.getAudioTracks()[0]?.addEventListener('ended', () => finish(true));
  } catch {
    finish(false);
    throw new MicError('unavailable');
  }

  return { done, stop: () => finish(true), cancel: () => finish(false) };
}

// the bar is doubled: the answer leaking from the speakers past echo cancellation must not count
const BARGE_IN_SENSITIVITY = 0.5;

/** Listens while an answer plays and calls onSpeech once when the person talks
 *  over it, then stops by itself. Keeps no audio.
 *  Throws MicError('denied' | 'unavailable') when the mic can't open. */
export async function startBargeIn(opts: {
  onSpeech: () => void;
  minSpeechMs?: number; // default 350
}): Promise<{ stop(): void }> {
  const { ctx, stream } = await openMic();
  const vad = createVad({
    sensitivity: BARGE_IN_SENSITIVITY,
    minSpeechMs: opts.minSpeechMs ?? 350,
    // it listens as long as the answer lasts
    noSpeechMs: Infinity,
    maxMs: Infinity,
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.removeEventListener('pagehide', stop);
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
  window.addEventListener('pagehide', stop);
  try {
    await tapMic(ctx, stream, (frame) => {
      if (stopped) return;
      const ms = (frame.length / ctx.sampleRate) * 1000;
      if (vad.push(rmsOf(frame), ms) === 'speaking') {
        stop();
        opts.onSpeech();
      }
    });
  } catch {
    stop();
    throw new MicError('unavailable');
  }
  return { stop };
}

// One playback context for every answer: iOS unlocks a context once, in a tap.
let playCtx: AudioContext | undefined;

function playbackContext(): AudioContext {
  if (!playCtx) {
    const Ctx = audioContextCtor();
    if (!Ctx) throw new Error('Web Audio is not available');
    playCtx = new Ctx();
  }
  return playCtx;
}

/** Call synchronously in a tap handler before answers play:
 *  iOS/Safari only let audio start inside a gesture. */
export function unlockAudio(): void {
  if (!audioContextCtor()) return;
  const ctx = playbackContext();
  if (ctx.state !== 'running') void ctx.resume();
  // a sound started in the gesture is what unlocks iOS; one silent sample is enough
  const src = ctx.createBufferSource();
  src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  src.connect(ctx.destination);
  src.start();
}

/** Plays streamed PCM16 chunks gaplessly as they arrive, on the shared context.
 *  onLevel gets 0..1 about 20 times a second until it ends, then 0. */
export class PcmPlayer {
  readonly ended: Promise<void>;
  private readonly ctx: AudioContext;
  private readonly out: GainNode; // this answer's own bus, so stop() silences only it
  private readonly onLevel?: (level: number) => void;
  private readonly meter?: ReturnType<typeof setInterval>;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextStart = 0;
  private carry: number | undefined; // odd trailing byte, completed by the next chunk
  private finished = false;
  private over = false;
  private resolveEnded: () => void = () => {};
  private readonly onHide = () => this.stop();

  constructor(
    private readonly sampleRate: number = PLAY_RATE,
    opts: { onLevel?: (level: number) => void } = {},
  ) {
    this.ctx = playbackContext();
    this.out = this.ctx.createGain();
    this.out.connect(this.ctx.destination);
    const { onLevel } = opts;
    this.onLevel = onLevel;
    if (onLevel) {
      const analyser = this.ctx.createAnalyser();
      this.out.connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      this.meter = setInterval(() => {
        analyser.getFloatTimeDomainData(data);
        onLevel(toLevel(rmsOf(data)));
      }, 50);
    }
    window.addEventListener('pagehide', this.onHide);
    this.ended = new Promise((resolve) => (this.resolveEnded = resolve));
  }

  /** true while sound is coming out */
  get playing(): boolean {
    return this.ctx.state === 'running' && this.sources.size > 0;
  }

  push(base64: string): void {
    if (this.over || this.finished) return;
    // 'suspended', or Safari's 'interrupted' after a phone call
    if (this.ctx.state !== 'running') void this.ctx.resume();
    let bytes = base64ToBytes(base64);
    if (this.carry !== undefined) {
      const joined = new Uint8Array(bytes.length + 1);
      joined[0] = this.carry;
      joined.set(bytes, 1);
      bytes = joined;
      this.carry = undefined;
    }
    if (bytes.length % 2) {
      this.carry = bytes[bytes.length - 1];
      bytes = bytes.subarray(0, -1);
    }
    const samples = pcm16ToFloat(bytes);
    if (!samples.length) return;
    const buffer = this.ctx.createBuffer(1, samples.length, this.sampleRate);
    buffer.getChannelData(0).set(samples);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.out);
    const at = Math.max(this.ctx.currentTime, this.nextStart);
    src.start(at);
    this.nextStart = at + buffer.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (this.finished && this.sources.size === 0) this.end();
    };
  }

  finish(): void {
    this.finished = true;
    if (this.sources.size === 0) this.end();
  }

  stop(): void {
    for (const src of this.sources) {
      src.onended = null;
      src.stop();
    }
    this.sources.clear();
    this.end();
  }

  private end(): void {
    if (this.over) return;
    this.over = true;
    clearInterval(this.meter);
    this.onLevel?.(0);
    // the context is shared: unplug this answer, never close it
    this.out.disconnect();
    window.removeEventListener('pagehide', this.onHide);
    this.resolveEnded();
  }
}
