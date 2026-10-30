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
const KEEP_MS = 120; // a short "yes" is worth keeping, though too short to end on

type VadState = 'waiting' | 'speaking' | 'ended' | 'timeout';

/** Energy-based end-of-speech detector, fed one frame at a time.
 *  heard: KEEP_MS of speech so far, a lower bar than 'speaking' (minSpeechMs).
 *  A null frame is one held back (the barge-in gate): quiet, but it says
 *  nothing about the room, so the floor and calibration skip it. */
export function createVad(
  opts: {
    silenceMs?: number; // default 1100: quiet this long after speech = ended
    minSpeechMs?: number; // default 250: shorter bursts are not speech
    noSpeechMs?: number; // default 8000: nothing said this long = 'timeout'
    maxMs?: number; // default 60000: hard stop = 'ended'
    sensitivity?: number; // default 1: below 1 needs louder speech (the bar is divided by it)
  } = {},
): {
  push(rms: number | null, frameMs: number): VadState;
  readonly heard: boolean;
} {
  const {
    silenceMs = 1100,
    minSpeechMs = 250,
    noSpeechMs = 8000,
    maxMs = 60000,
    sensitivity = 1,
  } = opts;
  let elapsed = 0;
  let measured = 0; // ms of real frames: the calibration window
  let calibrated = 0;
  let floor = 0;
  let run = 0; // ms of back-to-back loud frames
  let silent = 0; // ms since the last loud frame
  let spoke = false;
  let heard = false;
  let result: 'ended' | 'timeout' | undefined;
  const verdict = (): VadState => {
    // A short reply ("yes") ends on the same pause as a long one, rather
    // than waiting out the no-speech timeout.
    if (((spoke || heard) && silent >= silenceMs) || elapsed >= maxMs)
      return (result = 'ended');
    if (!spoke && !heard && elapsed >= noSpeechMs) return (result = 'timeout');
    return spoke ? 'speaking' : 'waiting';
  };
  return {
    get heard() {
      return heard || spoke;
    },
    push(rms, frameMs) {
      if (result) return result;
      elapsed += frameMs;
      if (rms === null) {
        run = 0;
        silent += frameMs;
        return verdict();
      }
      measured += frameMs;
      const calibrating = measured <= CALIBRATE_MS;
      if (calibrating) {
        calibrated++;
        floor = Math.min(FLOOR_CAP, floor + (rms - floor) / calibrated);
      }
      // the room is unknown while calibrating: judge against the highest floor it can settle at
      const bar =
        Math.max(
          (calibrating ? FLOOR_CAP : floor) * FLOOR_FACTOR,
          MIN_SPEECH_RMS,
        ) / sensitivity;
      if (rms > bar) {
        run += frameMs;
        silent = 0;
        if (run >= KEEP_MS) heard = true;
        if (run >= minSpeechMs) spoke = true;
      } else {
        run = 0;
        silent += frameMs;
        if (!calibrating)
          floor = Math.min(
            FLOOR_CAP,
            floor + (rms - floor) * (rms < floor ? FLOOR_FALL : FLOOR_RISE),
          );
      }
      return verdict();
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

/** iPhone and iPad: while a mic is open, Safari plays everything through
 *  the quiet earpiece (WebKit bugs 196539, 218012), so answers there play
 *  with the mic shut and only a tap interrupts them. */
export function canTalkOver(): boolean {
  if (typeof navigator === 'undefined') return true;
  const ua = navigator.userAgent ?? '';
  // iPadOS asks for the desktop site: a touch "Macintosh"
  return !(
    /iPhone|iPad|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}

let micsOpen = 0;

/** Safari 17+ (navigator.audioSession, elsewhere a no-op): 'playback' plays
 *  answers through the silent switch, which mutes Web Audio by default;
 *  'play-and-record' while a mic is open. */
function syncAudioSession(): void {
  const session = (navigator as { audioSession?: { type: string } })
    .audioSession;
  if (!session) return;
  try {
    session.type = micsOpen > 0 ? 'play-and-record' : 'playback';
  } catch {
    // a type this Safari doesn't know: keep its default
  }
}

/** Opens the mic (echoCancellation, noiseSuppression, autoGainControl, mono)
 *  on a new context; close() stops it all.
 *  Throws MicError('denied' | 'unavailable'). */
async function openMic(): Promise<{
  ctx: AudioContext;
  stream: MediaStream;
  close(): void;
}> {
  // getUserMedia is missing outside a secure context (plain http), AudioWorklet before Safari 14.1
  if (
    typeof AudioWorkletNode === 'undefined' ||
    !navigator.mediaDevices?.getUserMedia
  )
    throw new MicError('unavailable');
  // made before the permission await so iOS still counts the tap as the gesture
  const ctx = new AudioContext();
  micsOpen++;
  syncAudioSession();
  let closed = false;
  const shut = () => {
    if (closed) return;
    closed = true;
    void ctx.close().catch(() => {});
    micsOpen--;
    syncAudioSession();
  };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    return {
      ctx,
      stream,
      close: () => {
        stream.getTracks().forEach((t) => t.stop());
        shut();
      },
    };
  } catch (err) {
    shut();
    const denied =
      err instanceof DOMException &&
      (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    throw new MicError(denied ? 'denied' : 'unavailable');
  }
}

/** Feeds the mic to onFrame, FRAME samples at a time. Returns its release. */
async function tapMic(
  ctx: AudioContext,
  stream: MediaStream,
  onFrame: (frame: Float32Array) => void,
): Promise<() => void> {
  const source = ctx.createMediaStreamSource(stream);
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
  source.connect(node);
  // the tap outputs silence; it must reach destination or the browser won't run it
  node.connect(ctx.destination);
  if (ctx.state !== 'running') void ctx.resume().catch(() => {});
  return () => {
    node.port.onmessage = null;
    node.port.close();
    source.disconnect();
  };
}

/** Opens the mic (echoCancellation, noiseSuppression, autoGainControl, mono).
 *  With autoStop it ends by itself once the speaker goes quiet (createVad);
 *  without, it runs until stop() or cancel().
 *  onLevel gets 0..1 for a level meter about 20 times a second.
 *  signal aborts it while it is still starting: it then resolves a Recording
 *  whose done is null, as after cancel(), and never throws AbortError. Once
 *  started, use stop() or cancel().
 *  Throws MicError('denied' | 'unavailable') when the mic can't open. */
export async function startRecording(opts: {
  autoStop: boolean;
  onLevel?: (level: number) => void;
  onSpeech?: () => void; // first time speech is heard
  signal?: AbortSignal;
}): Promise<Recording> {
  const { ctx, stream, close } = await openMic();
  const rate = ctx.sampleRate;
  const frames: Float32Array[] = [];
  // the caller ends it, so the VAD must not stop listening by the clock
  const vad = createVad(
    opts.autoStop ? {} : { noSpeechMs: Infinity, maxMs: Infinity },
  );
  let heard = false;
  let finished = false;
  let release = () => {};
  let resolveDone: (wav: string | null) => void = () => {};
  const done = new Promise<string | null>((resolve) => (resolveDone = resolve));

  const finish = (keep: boolean) => {
    if (finished) return;
    finished = true;
    window.removeEventListener('pagehide', onHide);
    release();
    close();
    // under KEEP_MS of speech the VAD never says heard: nothing worth sending
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
    if (vad.heard && !heard) {
      heard = true;
      opts.onSpeech?.();
    }
    if (opts.autoStop && (state === 'ended' || state === 'timeout'))
      finish(true);
  };

  const recording = {
    done,
    stop: () => finish(true),
    cancel: () => finish(false),
  };
  if (opts.signal?.aborted) {
    finish(false);
    return recording;
  }
  try {
    release = await tapMic(ctx, stream, onFrame);
    // mic unplugged or permission revoked mid-recording: no more frames would ever come, keep what was said
    stream.getAudioTracks()[0]?.addEventListener('ended', () => finish(true));
    // Safari's 'interrupted' (a call, Siri) stops the frames too
    ctx.addEventListener('statechange', () => {
      if (ctx.state === 'interrupted') finish(true);
    });
  } catch {
    finish(false);
    throw new MicError('unavailable');
  }
  if (opts.signal?.aborted) finish(false);
  return recording;
}

// the bar is doubled: the answer leaking from the speakers past echo cancellation must not count
const BARGE_IN_SENSITIVITY = 0.5;
// Browser echo cancellation may not hear Web Audio playback, so on speakers
// the answer comes back through the mic. How loud it comes back (the mic's
// RMS per unit of the answer's) is learned from the answer's first moments,
// when people rarely talk, and talking over it must beat that.
const ECHO_WINDOW_MS = 500; // the answer reaches the mic up to this late (output buffers, Bluetooth)
const ECHO_LEARN_MS = 800;
const ECHO_MARGIN = 2; // talking over it is at least twice as loud as its echo
const ECHO_MAX_COUPLING = 1.5; // past this, learning heard something other than the answer
const ANSWER_SOUNDING = 0.005; // the answer's RMS above which it can echo at all
const ECHO_LEARN_FROM = 0.03; // learned only where the answer is loud: under it the room drowns its echo
const ROOM_CAP = 0.02; // someone talking before the answer starts must not pass for the room
const QUIET_ANSWER_MS = 2000; // an answer too quiet to learn from by now gets the worst-case echo

/** Talking over an answer, one mic frame at a time: push() takes the mic's
 *  RMS and the answer's RMS coming out at that moment, and is true once the
 *  person has talked over it for minSpeechMs. Not while the answer's echo
 *  is being learned, nor for anything the echo alone could explain. */
export function createBargeInDetector(minSpeechMs = 400): {
  push(mic: number, answer: number, frameMs: number): boolean;
} {
  const vad = createVad({
    sensitivity: BARGE_IN_SENSITIVITY,
    minSpeechMs,
    // it listens as long as the answer lasts: a cough and a pause never end it
    noSpeechMs: Infinity,
    silenceMs: Infinity,
    maxMs: Infinity,
  });
  const recent: number[] = [];
  let room = 0; // the room's own RMS, heard before the answer starts
  let roomFrames = 0;
  // the two highest echo ratios: the second is the coupling, so one click
  // while learning can't set it
  let top = 0;
  let coupling = 0;
  let learned = 0;
  let sounding = 0; // ms the answer has sounded while learning
  // null: held back, the echo could explain it
  const gate = (
    mic: number,
    answer: number,
    frameMs: number,
  ): number | null => {
    recent.push(answer);
    if (recent.length > Math.ceil(ECHO_WINDOW_MS / frameMs)) recent.shift();
    const loudest = Math.max(...recent);
    if (loudest < ANSWER_SOUNDING) {
      if (learned < ECHO_LEARN_MS)
        room = Math.min(ROOM_CAP, room + (mic - room) / ++roomFrames);
      return mic; // nothing to echo: an ordinary room
    }
    if (learned < ECHO_LEARN_MS) {
      sounding += frameMs;
      if (loudest >= ECHO_LEARN_FROM) {
        learned += frameMs;
        // the room adds power, not amplitude: take it out the same way
        const ratio = Math.sqrt(Math.max(0, mic * mic - room * room)) / loudest;
        if (ratio > top) [top, coupling] = [ratio, top];
        else coupling = Math.max(coupling, ratio);
        coupling = Math.min(ECHO_MAX_COUPLING, coupling);
      }
      if (learned < ECHO_LEARN_MS && sounding >= QUIET_ANSWER_MS) {
        learned = ECHO_LEARN_MS;
        coupling = ECHO_MAX_COUPLING;
      }
      return null;
    }
    return mic > coupling * loudest * ECHO_MARGIN ? mic : null;
  };
  return {
    push: (mic, answer, frameMs) =>
      vad.push(gate(mic, answer, frameMs), frameMs) === 'speaking',
  };
}

/** Listens while an answer plays and calls onSpeech once when the person talks
 *  over it, then stops by itself. Keeps no audio. answer() is the answer's
 *  loudness right now (PcmPlayer.loudness), so its own echo never counts.
 *  signal aborts it while it is still starting: it then resolves already
 *  stopped (onSpeech never fires) and never throws AbortError. Once started,
 *  use stop().
 *  Throws MicError('denied' | 'unavailable') when the mic can't open. */
export async function startBargeIn(opts: {
  onSpeech: () => void;
  answer?: () => number;
  signal?: AbortSignal;
}): Promise<{ stop(): void }> {
  const { ctx, stream, close } = await openMic();
  const detector = createBargeInDetector();
  let stopped = false;
  let release = () => {};
  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.removeEventListener('pagehide', stop);
    release();
    close();
  };
  window.addEventListener('pagehide', stop);
  if (opts.signal?.aborted) {
    stop();
    return { stop };
  }
  try {
    release = await tapMic(ctx, stream, (frame) => {
      if (stopped) return;
      const ms = (frame.length / ctx.sampleRate) * 1000;
      if (detector.push(rmsOf(frame), opts.answer?.() ?? 0, ms)) {
        stop();
        opts.onSpeech();
      }
    });
  } catch {
    stop();
    throw new MicError('unavailable');
  }
  if (opts.signal?.aborted) stop();
  return { stop };
}

// One playback context for every answer: iOS unlocks a context once, in a tap.
let playCtx: AudioContext | undefined;

function playbackContext(): AudioContext {
  playCtx ??= new AudioContext();
  return playCtx;
}

/** Call synchronously in a tap handler before answers play:
 *  iOS/Safari only let audio start inside a gesture. */
export function unlockAudio(): void {
  if (typeof AudioContext === 'undefined') return;
  syncAudioSession();
  const ctx = playbackContext();
  if (ctx.state !== 'running') void ctx.resume().catch(() => {});
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
  private readonly analyser: AnalyserNode;
  private readonly probe: Float32Array<ArrayBuffer>;
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
    private sampleRate: number = PLAY_RATE,
    opts: { onLevel?: (level: number) => void } = {},
  ) {
    this.ctx = playbackContext();
    this.out = this.ctx.createGain();
    this.out.connect(this.ctx.destination);
    this.analyser = this.ctx.createAnalyser();
    this.out.connect(this.analyser);
    this.probe = new Float32Array(this.analyser.fftSize);
    const { onLevel } = opts;
    this.onLevel = onLevel;
    if (onLevel)
      this.meter = setInterval(() => onLevel(toLevel(this.loudness)), 50);
    window.addEventListener('pagehide', this.onHide);
    this.ended = new Promise((resolve) => (this.resolveEnded = resolve));
  }

  /** The answer's RMS coming out right now (0 once it has ended). */
  get loudness(): number {
    if (this.over) return 0;
    this.analyser.getFloatTimeDomainData(this.probe);
    return rmsOf(this.probe);
  }

  /** The rate the speech comes at, from its stream's format event: only
   *  before the first chunk, so one answer never changes speed midway. */
  setRate(rate: number): void {
    // createBuffer throws outside this range, which would silence the answer
    if (this.nextStart === 0 && rate >= 3000 && rate <= 384000)
      this.sampleRate = rate;
  }

  /** true while sound is coming out */
  get playing(): boolean {
    return this.ctx.state === 'running' && this.sources.size > 0;
  }

  push(base64: string): void {
    if (this.over || this.finished) return;
    // 'suspended', or Safari's 'interrupted' after a phone call
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
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
