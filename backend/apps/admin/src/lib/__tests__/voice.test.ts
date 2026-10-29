import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bytesToBase64,
  canTalkOver,
  createBargeInDetector,
  createVad,
  decodePcm16,
  downsample,
  encodeWav,
  MicError,
  PcmPlayer,
  startBargeIn,
  startRecording,
} from '../voice';

const ascii = (view: DataView, at: number, len: number) =>
  String.fromCharCode(
    ...Array.from({ length: len }, (_, i) => view.getUint8(at + i)),
  );

describe('encodeWav', () => {
  it('writes a 16-bit mono PCM header and clamped samples', () => {
    const buf = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]), 16000);
    const view = new DataView(buf);
    expect(buf.byteLength).toBe(44 + 12);
    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + 12);
    expect(ascii(view, 8, 4)).toBe('WAVE');
    expect(ascii(view, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(12);
    const pcm = Array.from({ length: 6 }, (_, i) =>
      view.getInt16(44 + i * 2, true),
    );
    expect(pcm).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
  });
});

describe('downsample', () => {
  it('turns 48k into 16k with a third of the samples', () => {
    const ramp = Float32Array.from({ length: 48000 }, (_, i) => i / 48000);
    const out = downsample(ramp, 48000, 16000);
    expect(out.length).toBe(16000);
    // each output averages three inputs: (3i + 1) / 48000
    expect(out[0]).toBeCloseTo(1 / 48000, 6);
    expect(out[8000]).toBeCloseTo(24001 / 48000, 6);
    expect(out[15999]).toBeCloseTo(47998 / 48000, 6);
  });

  it('returns the input when the rates match', () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(downsample(input, 16000, 16000)).toBe(input);
  });
});

describe('bytesToBase64', () => {
  it('round-trips a buffer larger than one chunk', () => {
    const bytes = Uint8Array.from(
      { length: 100_000 },
      (_, i) => (i * 7919) % 256,
    );
    const b64 = bytesToBase64(bytes.buffer);
    expect(
      new Uint8Array(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
    ).toEqual(bytes);
    expect(bytesToBase64(new TextEncoder().encode('hi').buffer)).toBe('aGk=');
  });
});

describe('decodePcm16', () => {
  it('reads little-endian samples into [-1, 1]', () => {
    const view = new DataView(new ArrayBuffer(10));
    [0, 16384, -16384, 32767, -32768].forEach((s, i) =>
      view.setInt16(i * 2, s, true),
    );
    const out = Array.from(decodePcm16(bytesToBase64(view.buffer)));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0.5);
    expect(out[2]).toBe(-0.5);
    expect(out[3]).toBeCloseTo(1, 4);
    expect(out[4]).toBe(-1);
  });
});

describe('createVad', () => {
  const QUIET = 0.002;
  const LOUD = 0.2;
  // 20 ms frames
  const feed = (vad: ReturnType<typeof createVad>, rms: number, ms: number) =>
    Array.from({ length: ms / 20 }, () => vad.push(rms, 20));

  it('goes waiting -> speaking -> ended after the silence', () => {
    const vad = createVad();
    expect(feed(vad, QUIET, 300).every((s) => s === 'waiting')).toBe(true);
    const talk = feed(vad, LOUD, 400);
    expect(talk.slice(0, 12).every((s) => s === 'waiting')).toBe(true); // < 250 ms so far
    expect(talk.at(-1)).toBe('speaking');
    const after = feed(vad, QUIET, 1100);
    expect(after.slice(0, -1).every((s) => s === 'speaking')).toBe(true);
    expect(after.at(-1)).toBe('ended');
    expect(vad.push(LOUD, 20)).toBe('ended'); // sticky
  });

  it('does not count a short click as speech', () => {
    const vad = createVad();
    feed(vad, QUIET, 300);
    const states = [...feed(vad, LOUD, 60), ...feed(vad, QUIET, 2000)];
    expect(states.every((s) => s === 'waiting')).toBe(true);
    expect(vad.heard).toBe(false);
  });

  it('keeps a short reply and ends on the pause after it', () => {
    const vad = createVad();
    feed(vad, QUIET, 300);
    const states = [...feed(vad, LOUD, 200), ...feed(vad, QUIET, 2000)];
    // never 'speaking' (too short), but it ends after the usual pause
    // instead of waiting out the 8 s no-speech timeout
    expect(states).not.toContain('speaking');
    expect(states).toContain('ended');
    expect(states).not.toContain('timeout');
    expect(vad.heard).toBe(true);
  });

  it('hears a short reply said during calibration', () => {
    const vad = createVad();
    feed(vad, LOUD, 200);
    feed(vad, QUIET, 2000);
    expect(vad.heard).toBe(true);
  });

  it('times out when nothing is said', () => {
    const states = feed(createVad(), QUIET, 8000);
    expect(states.slice(0, -1).every((s) => s === 'waiting')).toBe(true);
    expect(states.at(-1)).toBe('timeout');
  });

  it('ends at maxMs even while still talking', () => {
    const vad = createVad({ maxMs: 2000 });
    feed(vad, QUIET, 300);
    const states = feed(vad, LOUD, 1700);
    expect(states.at(-2)).toBe('speaking');
    expect(states.at(-1)).toBe('ended');
  });

  it('still hears speech that started during calibration', () => {
    const vad = createVad();
    feed(vad, LOUD, 300); // floor is capped, so it cannot swallow later speech
    expect(feed(vad, LOUD, 300).at(-1)).toBe('speaking');
  });

  it('needs louder speech at a lower sensitivity', () => {
    // quiet room: the bar is MIN_SPEECH_RMS 0.01, divided by the sensitivity
    const MID = 0.015;
    const normal = createVad();
    feed(normal, QUIET, 300);
    expect(feed(normal, MID, 400).at(-1)).toBe('speaking');
    const strict = createVad({ sensitivity: 0.5 });
    feed(strict, QUIET, 300);
    expect(feed(strict, MID, 400).every((s) => s === 'waiting')).toBe(true);
    expect(feed(strict, LOUD, 400).at(-1)).toBe('speaking');
  });

  it('raises the bar over a noisy floor too', () => {
    const NOISE = 0.006; // floor 0.006: bar 0.018 at 1, 0.036 at 0.5
    const normal = createVad();
    feed(normal, NOISE, 300);
    expect(feed(normal, 0.025, 400).at(-1)).toBe('speaking');
    const strict = createVad({ sensitivity: 0.5 });
    feed(strict, NOISE, 300);
    expect(feed(strict, 0.025, 400).every((s) => s === 'waiting')).toBe(true);
  });
});

describe('createBargeInDetector', () => {
  const FRAME_MS = 2048 / 48; // one mic frame at 48 kHz, as the tap sends it
  // seeded, so every run sees the same trace
  const random = (seed: number) => () =>
    (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  // The answer's loudness: silent while it loads (1 s), then syllables with
  // a pause every 2 s; each sentence fades in over 300 ms, as speech does.
  const answerAt = (frame: number) => {
    const t = frame * FRAME_MS - 1000;
    const inSentence = t % 2000;
    if (t < 0 || inSentence > 1700) return 0;
    return (
      (0.15 + 0.1 * Math.sin((2 * Math.PI * t) / 250)) *
      Math.min(1, inSentence / 300)
    );
  };
  /** When it fires (ms), or -1. The mic hears the room at `room` RMS and
   *  the answer at `coupling` of its loudness, `delay` frames late, ±30%;
   *  plus a person talking at `talk` = [from ms, to ms, rms]. */
  const firesAt = (o: {
    coupling: number;
    delay: number;
    talk?: [number, number, number];
    room?: number; // default 0.003, a quiet room
    quiet?: boolean; // nothing is playing
  }): number => {
    const detector = createBargeInDetector();
    const next = random(7);
    for (let i = 0; i * FRAME_MS < 12_000; i++) {
      const t = i * FRAME_MS;
      const answer = o.quiet ? 0 : answerAt(i);
      const echo = o.quiet
        ? 0
        : o.coupling * answerAt(i - o.delay) * (0.7 + 0.6 * next());
      const [from, to, rms] = o.talk ?? [0, 0, 0];
      const voice = t >= from && t < to ? rms * (0.8 + 0.4 * next()) : 0;
      const mic = Math.hypot(echo, voice, o.room ?? 0.003);
      if (detector.push(mic, answer, FRAME_MS)) return t;
    }
    return -1;
  };

  it('never takes the answer’s own echo for someone talking', () => {
    // 0.05: echo cancellation working; 1.2: loud speakers, none at all
    for (const coupling of [0.05, 0.3, 0.8, 1.2])
      for (const delay of [0, 3, 7])
        // up to ~300 ms late
        expect(firesAt({ coupling, delay }), `${coupling}/${delay}`).toBe(-1);
  });

  it('hears someone talking over it', () => {
    const cancelled = firesAt({
      coupling: 0.05,
      delay: 3,
      talk: [4000, 5500, 0.15],
    });
    expect(cancelled).toBeGreaterThanOrEqual(4000);
    expect(cancelled).toBeLessThan(4700);
    // speakers without echo cancellation: talking up over it still works
    const loud = firesAt({ coupling: 0.3, delay: 7, talk: [4000, 5500, 0.3] });
    expect(loud).toBeGreaterThanOrEqual(4000);
    expect(loud).toBeLessThan(4700);
  });

  it('does not take a noisy room heard under the answer’s fade-in for its echo', () => {
    // headphones (no echo) and echo cancellation working, in an office
    for (const coupling of [0, 0.05]) {
      const t = firesAt({
        coupling,
        delay: 3,
        room: 0.01,
        talk: [4000, 5500, 0.15],
      });
      expect(t, `${coupling}`).toBeGreaterThanOrEqual(4000);
      expect(t, `${coupling}`).toBeLessThan(4700);
    }
    for (const coupling of [0.05, 0.3, 0.8, 1.2])
      expect(firesAt({ coupling, delay: 3, room: 0.01 }), `${coupling}`).toBe(
        -1,
      );
  });

  it('ignores a cough', () => {
    expect(
      firesAt({ coupling: 0.05, delay: 3, talk: [4000, 250 + 4000, 0.4] }),
    ).toBe(-1);
  });

  it('is the plain voice detector while nothing plays', () => {
    const t = firesAt({
      coupling: 0,
      delay: 0,
      quiet: true,
      talk: [2000, 3000, 0.15],
    });
    expect(t).toBeGreaterThanOrEqual(2000);
    expect(t).toBeLessThan(2700);
  });
});

describe('canTalkOver', () => {
  afterEach(() => vi.unstubAllGlobals());
  const on = (userAgent: string, maxTouchPoints = 0) =>
    vi.stubGlobal('navigator', { userAgent, maxTouchPoints });

  it('is a tap only on an iPhone or iPad', () => {
    on('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    expect(canTalkOver()).toBe(false);
    // iPadOS asks for the desktop site
    on('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5);
    expect(canTalkOver()).toBe(false);
    on('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    expect(canTalkOver()).toBe(true);
    on('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0');
    expect(canTalkOver()).toBe(true);
  });
});

describe('opening the mic', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects as unavailable without getUserMedia (non-secure context)', async () => {
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('navigator', {});
    await expect(startRecording({ autoStop: true })).rejects.toEqual(
      new MicError('unavailable'),
    );
    await expect(startBargeIn({ onSpeech: () => {} })).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  // a mic whose worklet runs whileLoading as it loads
  const fakeMic = (whileLoading = () => {}) => {
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    const port = { onmessage: null as unknown, close: vi.fn() };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const close = vi.fn(() => Promise.resolve());
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: () => Promise.resolve(stream) },
    });
    vi.stubGlobal(
      'AudioWorkletNode',
      class {
        port = port;
        connect = vi.fn();
      },
    );
    vi.stubGlobal(
      'AudioContext',
      class {
        sampleRate = 48000;
        state = 'running';
        destination = {};
        audioWorklet = { addModule: async () => whileLoading() };
        close = close;
        resume = () => Promise.resolve();
        createMediaStreamSource = () => source;
        addEventListener = vi.fn();
      },
    );
    return { track, port, source, close };
  };

  it('comes back cancelled when aborted while the mic opens', async () => {
    const mic = fakeMic();
    const signal = AbortSignal.abort();
    const rec = await startRecording({ autoStop: true, signal });
    await expect(rec.done).resolves.toBeNull();
    const onSpeech = vi.fn();
    await startBargeIn({ onSpeech, signal });
    expect(mic.track.stop).toHaveBeenCalledTimes(2);
    expect(mic.close).toHaveBeenCalledTimes(2);
  });

  it('sets Safari’s audio session for recording, then back for playback', async () => {
    fakeMic();
    const session = { type: 'auto' };
    (navigator as unknown as { audioSession: typeof session }).audioSession =
      session;
    const rec = await startRecording({ autoStop: false });
    expect(session.type).toBe('play-and-record');
    rec.cancel();
    expect(session.type).toBe('playback');
  });

  it('releases the worklet when aborted while it loads', async () => {
    const ac = new AbortController();
    const mic = fakeMic(() => ac.abort());
    const rec = await startRecording({ autoStop: false, signal: ac.signal });
    await expect(rec.done).resolves.toBeNull();
    expect(mic.port.onmessage).toBeNull();
    expect(mic.port.close).toHaveBeenCalled();
    expect(mic.source.disconnect).toHaveBeenCalled();
    expect(mic.track.stop).toHaveBeenCalled();
    expect(mic.close).toHaveBeenCalled();
  });
});

describe('PcmPlayer', () => {
  type FakeBuffer = { duration: number; getChannelData(): Float32Array };
  type FakeSource = {
    buffer: FakeBuffer | null;
    onended: (() => void) | null;
    connect: () => void;
    start: () => void;
    stop: ReturnType<typeof vi.fn>;
  };
  // the player keeps one shared context for the whole module: every test sees these
  const sources: FakeSource[] = [];
  class FakePlayCtx {
    state = 'running';
    currentTime = 0;
    sampleRate = 24000;
    destination = {};
    resume = () => Promise.resolve();
    createGain = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    createAnalyser = () => ({ fftSize: 32, getFloatTimeDomainData: vi.fn() });
    createBuffer = (_ch: number, length: number, rate: number): FakeBuffer => {
      const data = new Float32Array(length);
      return { duration: length / rate, getChannelData: () => data };
    };
    createBufferSource = () => {
      const src: FakeSource = {
        buffer: null,
        onended: null,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      sources.push(src);
      return src;
    };
  }

  beforeEach(() => {
    sources.length = 0;
    vi.stubGlobal('AudioContext', FakePlayCtx);
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('carries an odd trailing byte into the next chunk', () => {
    const p = new PcmPlayer();
    p.push('AQID'); // bytes 1 2 3
    p.push('BA=='); // byte 4
    expect(sources.map((s) => Array.from(s.buffer!.getChannelData()))).toEqual([
      [0x0201 / 32768],
      [0x0403 / 32768],
    ]);
  });

  it('ends on stop() before anything was pushed', async () => {
    const p = new PcmPlayer();
    p.stop();
    await expect(p.ended).resolves.toBeUndefined();
  });

  it('ends on finish() with nothing queued', async () => {
    const onLevel = vi.fn();
    const p = new PcmPlayer(undefined, { onLevel });
    p.finish();
    await expect(p.ended).resolves.toBeUndefined();
    expect(onLevel).toHaveBeenLastCalledWith(0);
  });

  it('stop() silences only its own answer', () => {
    const a = new PcmPlayer();
    const b = new PcmPlayer();
    a.push('AAA=');
    b.push('AAA=');
    a.stop();
    expect(sources[0].stop).toHaveBeenCalled();
    expect(sources[1].stop).not.toHaveBeenCalled();
    expect(a.playing).toBe(false);
    expect(b.playing).toBe(true);
    b.stop();
  });
});
