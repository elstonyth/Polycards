'use client';

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  playSfx,
  setSfxMuted,
  sharedAudioContext,
  type SfxName,
} from '@/lib/slot-sfx';
import { RARITY_ORDER, rarityWinVolume } from '@/lib/rarity';
import type { Rarity } from '@/lib/packs-data';

const MUTED_KEY = 'polycards.slot.muted';
const MUSIC_VOLUME = 0.25;
const EFFECTS_VOLUME = 0.22;
const FILES = {
  tap: '/sounds/slot-tap.mp3',
  start: '/sounds/slot-start.mp3',
  stop: '/sounds/slot-stop.mp3',
  riser: '/sounds/slot-riser.mp3',
  count: '/sounds/slot-count.mp3',
  reelTick: '/sounds/reel-tick.wav',
  ambient: '/sounds/adventure-loop.wav',
  Common: '/sounds/reveal-common.mp3',
  Uncommon: '/sounds/reveal-uncommon.mp3',
  Rare: '/sounds/reveal-rare.mp3',
  Mythical: '/sounds/reveal-mythical.mp3',
  Legendary: '/sounds/reveal-legendary.mp3',
  Immortal: '/sounds/reveal-immortal.mp3',
} as const;

export type SoundName = keyof typeof FILES;
export type { SfxName } from '@/lib/slot-sfx';

export function parseMuted(raw: string | null): boolean {
  return raw === '1';
}

export function readMuted(): boolean {
  try {
    return parseMuted(localStorage.getItem(MUTED_KEY));
  } catch {
    return false;
  }
}

export function writeMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
  } catch {
    // The in-memory preference remains authoritative when storage is blocked.
  }
}

/** A batch flips together: celebrate its best rarity, once. */
export function revealSound(rarities: readonly string[]): Rarity {
  return RARITY_ORDER.find((rarity) => rarities.includes(rarity)) ?? 'Common';
}

function useSoundPlayer() {
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(true);
  const mounted = useRef(false);
  const generation = useRef(0);
  const buffers = useRef(new Map<SoundName, Promise<AudioBuffer>>());
  const sources = useRef(new Set<AudioBufferSourceNode>());
  const music = useRef<{
    source: AudioBufferSourceNode;
    gain: GainNode;
  } | null>(null);
  const celebrations = useRef(0);

  const load = useCallback((name: SoundName, ac: AudioContext) => {
    let pending = buffers.current.get(name);
    if (!pending) {
      pending = fetch(FILES[name])
        .then((response) => {
          if (!response.ok) throw new Error('Sound unavailable');
          return response.arrayBuffer();
        })
        .then((data) => ac.decodeAudioData(data))
        .catch((error: unknown) => {
          buffers.current.delete(name);
          throw error;
        });
      buffers.current.set(name, pending);
    }
    return pending;
  }, []);

  const duckMusic = useCallback(() => {
    const bed = music.current;
    if (!bed) return;
    bed.gain.gain.setTargetAtTime(
      MUSIC_VOLUME * (celebrations.current > 0 ? 0.35 : 1),
      bed.gain.context.currentTime,
      0.15,
    );
  }, []);

  const silence = useCallback(() => {
    // Invalidate sounds still fetching/decoding, as well as those already playing.
    generation.current++;
    for (const source of sources.current) source.stop();
    sources.current.clear();
    celebrations.current = 0;
    if (music.current) {
      music.current.source.stop();
      music.current.source.disconnect();
      music.current.gain.disconnect();
      music.current = null;
    }
  }, []);

  const startMusic = useCallback(() => {
    if (!mounted.current || mutedRef.current || document.hidden) return;
    const ac = sharedAudioContext(); // Resume synchronously inside the gesture.
    if (!ac || music.current) return;
    const ticket = generation.current;
    void load('ambient', ac)
      .then((buffer) => {
        if (
          !mounted.current ||
          mutedRef.current ||
          document.hidden ||
          ticket !== generation.current ||
          music.current
        )
          return;
        const source = ac.createBufferSource();
        const gain = ac.createGain();
        gain.gain.value = MUSIC_VOLUME * (celebrations.current > 0 ? 0.35 : 1);
        source.buffer = buffer;
        source.loop = true;
        source.connect(gain).connect(ac.destination);
        music.current = { source, gain };
        source.start();
      })
      .catch(() => {}); // Retry on the next gesture if autoplay or loading failed.
  }, [load]);

  const play = useCallback(
    (name: SoundName, volume = 1, rate = 1) => {
      if (!mounted.current || mutedRef.current || document.hidden) return;
      const ac = sharedAudioContext();
      if (!ac) return;
      const ticket = generation.current;
      void load(name, ac)
        .then((buffer) => {
          if (
            !mounted.current ||
            mutedRef.current ||
            document.hidden ||
            ticket !== generation.current
          )
            return;
          const source = ac.createBufferSource();
          const gain = ac.createGain();
          const celebration = (RARITY_ORDER as readonly string[]).includes(
            name,
          );
          gain.gain.value = EFFECTS_VOLUME * Math.min(1, Math.max(0, volume));
          source.buffer = buffer;
          source.playbackRate.value = rate;
          source.connect(gain).connect(ac.destination);
          sources.current.add(source);
          if (celebration) {
            celebrations.current++;
            duckMusic();
          }
          source.onended = () => {
            const wasActive = sources.current.delete(source);
            source.disconnect();
            gain.disconnect();
            if (celebration && wasActive) {
              celebrations.current--;
              duckMusic();
            }
          };
          // A new source per trigger: a later reveal never restarts an unfinished cue.
          source.start();
        })
        .catch(() => {});
    },
    [load, duckMusic],
  );

  const playReveal = useCallback(
    (rarities: readonly string[]) => {
      const rarity = revealSound(rarities);
      play(rarity, rarityWinVolume(rarity));
    },
    [play],
  );

  const applyMuted = useCallback(
    (next: boolean) => {
      mutedRef.current = next;
      setMuted(next);
      setSfxMuted(next || document.hidden);
      if (next) silence();
      else startMusic();
    },
    [silence, startMusic],
  );

  const toggleMuted = useCallback(() => {
    const next = !mutedRef.current;
    writeMuted(next);
    applyMuted(next);
  }, [applyMuted]);

  useEffect(() => {
    mounted.current = true;
    // Browser-only preference must hydrate after SSR, before any sound starts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    applyMuted(readMuted());
    const visibility = () => {
      setSfxMuted(mutedRef.current || document.hidden);
      if (document.hidden) silence();
      else startMusic();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === MUTED_KEY || event.key === null)
        applyMuted(readMuted());
    };
    document.addEventListener('pointerup', startMusic);
    document.addEventListener('keydown', startMusic);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('storage', storage);
    const ac = sharedAudioContext();
    if (ac) void load('reelTick', ac).catch(() => {});
    return () => {
      mounted.current = false;
      silence();
      setSfxMuted(true);
      document.removeEventListener('pointerup', startMusic);
      document.removeEventListener('keydown', startMusic);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('storage', storage);
    };
  }, [applyMuted, load, silence, startMusic]);

  const vibrate = useCallback((pattern: number | number[]) => {
    if (mutedRef.current || !('vibrate' in navigator)) return;
    try {
      navigator.vibrate(pattern);
    } catch {
      /* Optional on mobile browsers. */
    }
  }, []);

  const sfx = useCallback(
    (name: SfxName) => {
      if (mutedRef.current || document.hidden) return;
      if (name === 'reelTick') play('reelTick', 0.6);
      else playSfx(name);
    },
    [play],
  );

  return { muted, toggleMuted, play, playReveal, vibrate, sfx };
}

const SoundContext = createContext<ReturnType<typeof useSoundPlayer> | null>(
  null,
);

export function SoundProvider({ children }: { children: ReactNode }) {
  const sound = useSoundPlayer();
  return createElement(SoundContext.Provider, { value: sound }, children);
}

export function useSound() {
  const sound = useContext(SoundContext);
  if (!sound) throw new Error('useSound requires SoundProvider');
  return sound;
}
