import { describe, expect, it } from 'vitest';
import {
  bytesToBase64,
  createVad,
  decodePcm16,
  downsample,
  encodeWav,
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
});
