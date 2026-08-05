'use client';

// SFX + haptics for the slot. Gesture-unlocked (first sound follows the SPIN
// click, so no autoplay-policy violation). Mute persists in localStorage,
// default UNMUTED (PRD §3.9). Degrades silently if an asset is missing, so the
// slice ships before final audio is sourced.
import { useCallback, useEffect, useRef, useState } from 'react';
import { playSfx, sharedAudioContext, type SfxName } from '@/lib/slot-sfx';

const MUTED_KEY = 'polycards.slot.muted';

const FILES = {
  tap: '/sounds/slot-tap.mp3',
  start: '/sounds/slot-start.mp3',
  stop: '/sounds/slot-stop.mp3',
  win: '/sounds/slot-win.mp3',
  bigwin: '/sounds/slot-bigwin.mp3',
  riser: '/sounds/slot-riser.mp3',
  count: '/sounds/slot-count.mp3',
  ambient: '/sounds/slot-ambient.mp3',
} as const;

export type SoundName = keyof typeof FILES;
export type { SfxName } from '@/lib/slot-sfx';

/** Pure: maps a raw localStorage value to muted state. Default unmuted. */
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
    /* private mode / storage disabled — non-fatal */
  }
}

export function useSound() {
  // SSR-safe: server + client first render both start unmuted, so there's no
  // hydration mismatch on the mute icon; the stored value is applied in an
  // effect after mount (mirrors usePrefersReducedMotion). A lazy useState
  // initialiser would read localStorage during render and diverge from the
  // server snapshot.
  const [muted, setMuted] = useState(false);
  const pool = useRef<Partial<Record<SoundName, HTMLAudioElement>>>({});
  // Looping beds run through WebAudio, not the <audio> element: an MP3 carries
  // encoder padding at both ends, and HTMLAudioElement.loop plays that padding
  // as a short silence every lap — clearly audible as a "reset" on a sustained
  // bass bed. A decoded AudioBuffer loops sample-accurately instead.
  const beds = useRef<
    Partial<
      Record<
        SoundName,
        { buffer: AudioBuffer | null; source: AudioBufferSourceNode | null }
      >
    >
  >({});

  // Hydrate mute state + preload the audio pool on the client only.
  useEffect(() => {
    setMuted(readMuted());
    for (const [name, src] of Object.entries(FILES)) {
      const audio = new Audio(src);
      audio.preload = 'auto';
      pool.current[name as SoundName] = audio;
    }
    const pool_ = pool.current;
    const beds_ = beds.current;
    return () => {
      // One-shots (bigwin fanfare etc.) must not bleed past the machine's
      // unmount — nor must the looping bed, which has no end of its own.
      for (const audio of Object.values(pool_)) audio?.pause();
      for (const bed of Object.values(beds_)) {
        try {
          bed?.source?.stop();
        } catch {
          /* already stopped */
        }
      }
    };
  }, []);

  const play = useCallback(
    (name: SoundName, volume = 1, rate = 1) => {
      // Gate on the in-memory state (authoritative) — readMuted() falls back to
      // false when storage is blocked, which would let muted sounds still play.
      if (muted) return;
      const audio = pool.current[name];
      if (!audio) return;
      try {
        audio.loop = false; // an element last used by loop() must not re-loop
        audio.volume = Math.min(1, Math.max(0, volume));
        // rate ≠ 1 shifts pitch (classic rising reel-stop): pitch correction off.
        audio.preservesPitch = rate === 1;
        audio.playbackRate = rate;
        audio.currentTime = 0;
        void audio.play().catch(() => {});
      } catch {
        /* no-op */
      }
    },
    [muted],
  );

  // Looping playback (ambient bed). Stop via halt(). Resolves to whether
  // playback actually started, so callers latching "already playing" state
  // (ambientOn) can reset on failure and retry on a later gesture instead of
  // going permanently silent.
  const loop = useCallback(
    async (name: SoundName, volume = 1): Promise<boolean> => {
      if (muted) return false;

      // Preferred path: decode once, then loop the buffer. Gapless.
      const ac = sharedAudioContext();
      if (ac) {
        try {
          const bed = (beds.current[name] ??= { buffer: null, source: null });
          bed.buffer ??= await fetch(FILES[name])
            .then((r) => r.arrayBuffer())
            .then((b) => ac.decodeAudioData(b));
          bed.source?.stop();
          const source = ac.createBufferSource();
          source.buffer = bed.buffer;
          source.loop = true;
          const gain = ac.createGain();
          gain.gain.value = Math.min(1, Math.max(0, volume));
          source.connect(gain).connect(ac.destination);
          source.start();
          bed.source = source;
          return true;
        } catch {
          // Decode or autoplay refused — fall through to the element.
        }
      }

      const audio = pool.current[name];
      if (!audio) return false;
      try {
        audio.loop = true;
        audio.volume = Math.min(1, Math.max(0, volume));
        audio.playbackRate = 1;
        audio.currentTime = 0;
        return await audio.play().then(
          () => true,
          () => false,
        );
      } catch {
        return false;
      }
    },
    [muted],
  );

  // Halt a playing sound (the 6s spin bed outlives short spins). Not muted-
  // gated: halting must always work, even if mute was toggled mid-spin.
  const halt = useCallback((name: SoundName) => {
    const bed = beds.current[name];
    if (bed?.source) {
      try {
        bed.source.stop();
      } catch {
        /* already stopped */
      }
      bed.source = null;
    }
    const audio = pool.current[name];
    if (!audio) return;
    try {
      audio.pause();
      audio.loop = false;
      audio.currentTime = 0;
    } catch {
      /* no-op */
    }
  }, []);

  const vibrate = useCallback(
    (pattern: number | number[]) => {
      if (muted) return;
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try {
          navigator.vibrate(pattern);
        } catch {
          /* no-op */
        }
      }
    },
    [muted],
  );

  const toggleMuted = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      writeMuted(next);
      return next;
    });
  }, []);

  const sfx = useCallback(
    (name: SfxName) => {
      if (muted) return;
      playSfx(name);
    },
    [muted],
  );

  return { muted, toggleMuted, play, loop, halt, vibrate, sfx };
}
