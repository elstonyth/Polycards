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
  outputBus,
  playSfx,
  setSfxMuted,
  sharedAudioContext,
  type SfxName,
} from '@/lib/slot-sfx';
import { RARITY_ORDER, rarityWinVolume } from '@/lib/rarity';
import type { Rarity } from '@/lib/packs-data';

// Two switches. The older key is the Sounds one (clicks, reveals,
// vibration); until the Music one is first set it decides the music
// too, so a visitor who muted before there were two stays fully muted.
const MUTED_KEY = 'polycards.slot.muted';
const MUSIC_OFF_KEY = 'polycards.music.off';
// The loop is mastered at -14 LUFS, as loud as the fanfares (measured with
// ffmpeg ebur128), so at the effects' level it was no background (customers
// complained). This holds it about 9 dB under them.
const MUSIC_VOLUME = 0.08;
/** The music eases in (about 2 s to full) instead of starting at once. */
const MUSIC_FADE_S = 0.7;
const EFFECTS_VOLUME = 0.22;
// The fanfares were mastered apart (Common is the loudest file, Uncommon the
// quietest): these bring all six to -14 LUFS, so rarityWinVolume's ladder is
// what is heard.
const TRIM: Partial<Record<string, number>> = {
  Common: 0.74,
  Uncommon: 1.15,
  Rare: 0.95,
  Mythical: 0.86,
  Legendary: 0.88,
  Immortal: 0.76,
};
// 24 s of loop, wrapped in 0.1 s of itself on each side: MP3 start padding (under
// 0.1 s, and browsers trim it differently) stays outside the loop points, so the
// wrap is seamless on every decoder.
const MUSIC_LOOP_START_S = 0.1;
const MUSIC_LOOP_END_S = 24.1;
// A tick that waited on its sample's first download is out of time, and all the
// ticks that waited would start together as one loud crack.
const REEL_TICK_LATE_MS = 60;
const FILES = {
  tap: '/sounds/slot-tap.mp3',
  start: '/sounds/slot-start.mp3',
  stop: '/sounds/slot-stop.mp3',
  riser: '/sounds/slot-riser.mp3',
  count: '/sounds/slot-count.mp3',
  reelTick: '/sounds/reel-tick.wav',
  ambient: '/sounds/adventure-loop.mp3',
  Common: '/sounds/reveal-common.mp3',
  Uncommon: '/sounds/reveal-uncommon.mp3',
  Rare: '/sounds/reveal-rare.mp3',
  Mythical: '/sounds/reveal-mythical.mp3',
  Legendary: '/sounds/reveal-legendary.mp3',
  Immortal: '/sounds/reveal-immortal.mp3',
} as const;

// Labels are left out on purpose: a label click re-dispatches a click on its
// input, which would tick twice.
const CLICKABLE =
  'button, a[href], summary, input[type="radio"], input[type="checkbox"], [role="button"], [role="tab"], [role="switch"], [role="menuitem"], [role="option"]';

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

export function readMusicOff(): boolean {
  try {
    const raw = localStorage.getItem(MUSIC_OFF_KEY);
    return raw === null ? readMuted() : parseMuted(raw);
  } catch {
    return false;
  }
}

function writeMusicOff(off: boolean): void {
  try {
    localStorage.setItem(MUSIC_OFF_KEY, off ? '1' : '0');
  } catch {
    // As above.
  }
}

/** A batch flips together: celebrate its best rarity, once. */
export function revealSound(rarities: readonly string[]): Rarity {
  return RARITY_ORDER.find((rarity) => rarities.includes(rarity)) ?? 'Common';
}

function useSoundPlayer() {
  const [soundsOff, setSoundsOff] = useState(false);
  const [musicOff, setMusicOff] = useState(false);
  // "muted" below is the Sounds switch; the music has its own.
  const mutedRef = useRef(true);
  const musicOffRef = useRef(true);
  const mounted = useRef(false);
  const generation = useRef(0);
  // Audio is blocked until a gesture anyway, so nothing downloads before one:
  // this provider wraps every page, and a page view must not pay for the music.
  const gestured = useRef(false);
  const buffers = useRef(new Map<SoundName, Promise<AudioBuffer>>());
  const sources = useRef(new Set<AudioBufferSourceNode>());
  const music = useRef<{
    source: AudioBufferSourceNode;
    gain: GainNode;
  } | null>(null);
  const celebrations = useRef(0);
  // duck() holds, counted apart: silence() (tab hidden, mute) clears the
  // reveals but must not drop a hold whose arena is still on screen.
  const ducks = useRef(0);

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
      MUSIC_VOLUME * (celebrations.current > 0 || ducks.current > 0 ? 0.35 : 1),
      bed.gain.context.currentTime,
      0.15,
    );
  }, []);

  const stopSounds = useCallback(() => {
    // Invalidate sounds still fetching/decoding, as well as those already playing.
    generation.current++;
    for (const source of sources.current) source.stop();
    sources.current.clear();
    celebrations.current = 0;
    duckMusic(); // the music may play on: a fanfare cut short hands it back
  }, [duckMusic]);

  const stopMusic = useCallback(() => {
    if (!music.current) return;
    music.current.source.stop();
    music.current.source.disconnect();
    music.current.gain.disconnect();
    music.current = null;
  }, []);

  const silence = useCallback(() => {
    stopSounds();
    stopMusic();
  }, [stopSounds, stopMusic]);

  const startMusic = useCallback(() => {
    if (
      !gestured.current ||
      !mounted.current ||
      musicOffRef.current ||
      document.hidden
    )
      return;
    const ac = sharedAudioContext(); // Resume synchronously inside the gesture.
    if (!ac || music.current) return;
    void load('ambient', ac)
      .then((buffer) => {
        if (
          !mounted.current ||
          musicOffRef.current ||
          document.hidden ||
          music.current
        )
          return;
        const source = ac.createBufferSource();
        const gain = ac.createGain();
        gain.gain.value = 0;
        gain.gain.setTargetAtTime(
          MUSIC_VOLUME *
            (celebrations.current > 0 || ducks.current > 0 ? 0.35 : 1),
          ac.currentTime,
          MUSIC_FADE_S,
        );
        source.buffer = buffer;
        source.loop = true;
        source.loopStart = MUSIC_LOOP_START_S;
        source.loopEnd = MUSIC_LOOP_END_S;
        source.connect(gain).connect(outputBus(ac));
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
      const asked = performance.now();
      void load(name, ac)
        .then((buffer) => {
          if (
            !mounted.current ||
            mutedRef.current ||
            document.hidden ||
            ticket !== generation.current ||
            (name === 'reelTick' &&
              performance.now() - asked > REEL_TICK_LATE_MS)
          )
            return;
          const source = ac.createBufferSource();
          const gain = ac.createGain();
          const celebration = (RARITY_ORDER as readonly string[]).includes(
            name,
          );
          gain.gain.value =
            EFFECTS_VOLUME *
            Math.min(1, Math.max(0, volume)) *
            (TRIM[name] ?? 1);
          source.buffer = buffer;
          source.playbackRate.value = rate;
          source.connect(gain).connect(outputBus(ac));
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

  // Hold the music bed down (as a rarity reveal does) while a cue sequence
  // needs the room — the Lucky Draw arena. Every duck(true) gets a duck(false).
  const duck = useCallback(
    (on: boolean) => {
      ducks.current = Math.max(0, ducks.current + (on ? 1 : -1));
      duckMusic();
    },
    [duckMusic],
  );
  const playReveal = useCallback(
    (rarities: readonly string[]) => {
      const rarity = revealSound(rarities);
      play(rarity, rarityWinVolume(rarity));
    },
    [play],
  );

  const applySoundsOff = useCallback(
    (next: boolean) => {
      mutedRef.current = next;
      setSoundsOff(next);
      setSfxMuted(next || document.hidden);
      if (next) stopSounds();
    },
    [stopSounds],
  );
  const applyMusicOff = useCallback(
    (next: boolean) => {
      musicOffRef.current = next;
      setMusicOff(next);
      if (next) stopMusic();
      else startMusic();
    },
    [stopMusic, startMusic],
  );

  const onGesture = useCallback(() => {
    gestured.current = true;
    startMusic();
    if (mutedRef.current) return;
    const ac = sharedAudioContext();
    if (ac) void load('reelTick', ac).catch(() => {});
  }, [load, startMusic]);

  const toggleSounds = useCallback(() => {
    const next = !mutedRef.current;
    // The music's own choice is written with it: left unset it would follow
    // this key on the next load, and Sounds off would take the music along.
    writeMusicOff(musicOffRef.current);
    writeMuted(next);
    applySoundsOff(next);
  }, [applySoundsOff]);
  const toggleMusic = useCallback(() => {
    const next = !musicOffRef.current;
    writeMusicOff(next);
    applyMusicOff(next);
  }, [applyMusicOff]);
  // One button for everything (the slot machine's): all off, then back to
  // what was on before it (both, when it found everything off already).
  const beforeMute = useRef({ sounds: false, music: false });
  const toggleMuted = useCallback(() => {
    const mute = !(mutedRef.current && musicOffRef.current);
    if (mute)
      beforeMute.current = {
        sounds: mutedRef.current,
        music: musicOffRef.current,
      };
    const sounds = mute || beforeMute.current.sounds;
    const music = mute || beforeMute.current.music;
    if (!mute) beforeMute.current = { sounds: false, music: false };
    writeMuted(sounds);
    writeMusicOff(music);
    applySoundsOff(sounds);
    applyMusicOff(music);
  }, [applySoundsOff, applyMusicOff]);

  useEffect(() => {
    mounted.current = true;
    // Browser-only preference must hydrate after SSR, before any sound starts.
    /* eslint-disable react-hooks/set-state-in-effect */
    applySoundsOff(readMuted());
    applyMusicOff(readMusicOff());
    /* eslint-enable react-hooks/set-state-in-effect */
    const visibility = () => {
      setSfxMuted(mutedRef.current || document.hidden);
      if (document.hidden) silence();
      else startMusic();
    };
    const storage = (event: StorageEvent) => {
      if (
        event.key === MUTED_KEY ||
        event.key === MUSIC_OFF_KEY ||
        event.key === null
      ) {
        applySoundsOff(readMuted());
        applyMusicOff(readMusicOff());
      }
    };
    document.addEventListener('pointerup', onGesture);
    document.addEventListener('keydown', onGesture);
    // Screen readers can activate a control with a click and no pointer events.
    document.addEventListener('click', onGesture);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('storage', storage);
    return () => {
      mounted.current = false;
      silence();
      setSfxMuted(true);
      document.removeEventListener('pointerup', onGesture);
      document.removeEventListener('keydown', onGesture);
      document.removeEventListener('click', onGesture);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('storage', storage);
    };
  }, [applySoundsOff, applyMusicOff, onGesture, silence, startMusic]);

  const vibrate = useCallback((pattern: number | number[]) => {
    if (mutedRef.current || !('vibrate' in navigator)) return;
    try {
      navigator.vibrate(pattern);
    } catch {
      /* Optional on mobile browsers. */
    }
  }, []);

  const sfx = useCallback(
    // `amount` (0-1) scales the cues that take one, e.g. a later, softer bounce.
    (name: SfxName, amount?: number) => {
      if (mutedRef.current || document.hidden) return;
      if (name === 'reelTick') play('reelTick', 0.6);
      else playSfx(name, amount);
    },
    [play],
  );

  useEffect(() => {
    // One delegated listener gives every control a press sound. `click`, not
    // pointerdown: a touch that starts a scroll stays silent and keyboard
    // presses still tick. On document, not window: sheets stopPropagation on
    // their panel, and React's own document listener (attached at hydration)
    // still runs first, so the header mute toggle has flipped by now — muting
    // is silent, unmuting ticks. Controls with their own cue opt out with
    // data-sound="off".
    const uiClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const control = event.target.closest(CLICKABLE);
      if (!control || control.closest('[data-sound="off"]')) return;
      if (control.matches(':disabled, [aria-disabled="true"]')) return;
      sfx('uiClick');
    };
    document.addEventListener('click', uiClick);
    return () => document.removeEventListener('click', uiClick);
  }, [sfx]);

  return {
    /** Everything is off. */
    muted: soundsOff && musicOff,
    soundsOff,
    musicOff,
    toggleMuted,
    toggleSounds,
    toggleMusic,
    play,
    playReveal,
    vibrate,
    sfx,
    duck,
  };
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
