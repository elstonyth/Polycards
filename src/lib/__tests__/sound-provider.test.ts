// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement, StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SoundProvider, revealSound, useSound } from '@/lib/use-sound';

const audio = vi.hoisted(() => {
  const sources: {
    loop: boolean;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  }[] = [];
  const gains: {
    gain: { value: number; setTargetAtTime: ReturnType<typeof vi.fn> };
  }[] = [];
  const context = {
    currentTime: 0,
    state: 'running',
    destination: {},
    decodeAudioData: vi.fn(async () => ({ duration: 12 })),
    createGain: () => {
      const gain = {
        gain: { value: 0, setTargetAtTime: vi.fn() },
        context,
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(gain);
      return gain;
    },
    createBufferSource: () => {
      const source = {
        loop: false,
        buffer: null,
        playbackRate: { value: 1 },
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn((gain) => gain),
        disconnect: vi.fn(),
        onended: null as (() => void) | null,
      };
      sources.push(source);
      return source;
    },
  };
  return { context, sources, gains, setMuted: vi.fn(), sfx: vi.fn() };
});

vi.mock('@/lib/slot-sfx', () => ({
  sharedAudioContext: () => audio.context,
  playSfx: audio.sfx,
  setSfxMuted: audio.setMuted,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let sound: ReturnType<typeof useSound>;
function Consumer() {
  const value = useSound();
  useEffect(() => {
    sound = value;
  }, [value]);
  return null;
}
async function render(show = true) {
  await act(async () =>
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(
          SoundProvider,
          null,
          show ? createElement(Consumer) : null,
        ),
      ),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  audio.sources.length = 0;
  audio.gains.length = 0;
  localStorage.clear();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    })),
  );
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('shares balanced public music, preserves complete reveal cues across navigation, and mutes immediately', async () => {
  await render();
  const music = audio.sources.filter((source) => source.loop);
  expect(music).toHaveLength(1); // StrictMode cannot create duplicate loops.
  expect(audio.gains[0]?.gain.value).toBe(0.25);
  expect(revealSound(['Common', 'Legendary', 'Rare'])).toBe('Legendary');
  expect(revealSound(['unknown'])).toBe('Common');
  await act(async () => sound.playReveal(['Legendary']));
  const fanfare = audio.sources.at(-1)!;
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(([url]) => url === '/sounds/reveal-legendary.mp3'),
  ).toBe(true);
  expect(audio.gains.at(-1)?.gain.value).toBeLessThanOrEqual(0.22);
  expect(audio.gains[0]?.gain.setTargetAtTime).toHaveBeenLastCalledWith(
    expect.closeTo(0.0875),
    0,
    0.15,
  );
  await render(false); // Route/reveal child leaves; the root player stays.
  expect(fanfare.stop).not.toHaveBeenCalled();
  await render();
  await act(async () => sound.playReveal(['Legendary']));
  expect(fanfare.stop).not.toHaveBeenCalled(); // Repeated rarity uses a new source.
  await act(async () => sound.toggleMuted());
  expect(fanfare.stop).toHaveBeenCalledOnce();
  expect(music[0]?.stop).toHaveBeenCalledOnce();
  expect(audio.setMuted).toHaveBeenLastCalledWith(true);
  expect(localStorage.getItem('polycards.slot.muted')).toBe('1');
});

it('honors saved mute before loading music and cancels a reveal that finishes loading after mute', async () => {
  localStorage.setItem('polycards.slot.muted', '1');
  await render();
  expect(audio.sources).toHaveLength(0);
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(([url]) => url === '/sounds/adventure-loop.wav'),
  ).toBe(false);
  await act(async () => sound.toggleMuted());
  expect(audio.sources.filter((source) => source.loop)).toHaveLength(1);
  let finish: (value: ArrayBuffer) => void = () => {};
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    arrayBuffer: () =>
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      }),
  } as Response);
  await act(async () => sound.playReveal(['Immortal']));
  const before = audio.sources.length;
  await act(async () => sound.toggleMuted());
  await act(async () => finish(new ArrayBuffer(0)));
  expect(audio.sources).toHaveLength(before);
});
