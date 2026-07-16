'use client';

// SFX + haptics for the slot. Gesture-unlocked (first sound follows the SPIN
// click, so no autoplay-policy violation). Mute persists in localStorage,
// default UNMUTED (PRD §3.9). Degrades silently if an asset is missing, so the
// slice ships before final audio is sourced.
import { useCallback, useEffect, useRef, useState } from 'react';
import { playSfx, type SfxName } from '@/lib/slot-sfx';

const MUTED_KEY = 'polycards.slot.muted';

const FILES = {
  spin: '/sounds/slot-spin.mp3',
  stop: '/sounds/slot-stop.mp3',
  win: '/sounds/slot-win.mp3',
  bigwin: '/sounds/slot-bigwin.mp3',
  sell: '/sounds/slot-sell.mp3',
  riser: '/sounds/slot-riser.mp3',
  reveal: '/sounds/slot-reveal.mp3',
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
  // In-flight volume-fade timer for the looping reveal bed (HTMLAudio has no
  // native fade). A new fade cancels the previous one.
  const fadeTimer = useRef<number | null>(null);

  // Hydrate mute state + preload the audio pool on the client only.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- v7 false positive; deliberate post-mount SSR-safe sync
    setMuted(readMuted());
    for (const [name, src] of Object.entries(FILES)) {
      const audio = new Audio(src);
      audio.preload = 'auto';
      pool.current[name as SoundName] = audio;
    }
  }, []);

  const play = useCallback(
    (name: SoundName, volume = 1, rate = 1) => {
      // Gate on the in-memory state (authoritative) — readMuted() falls back to
      // false when storage is blocked, which would let muted sounds still play.
      if (muted) return;
      const audio = pool.current[name];
      if (!audio) return;
      try {
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

  // Halt a playing sound (the 6s spin bed outlives short spins). Not muted-
  // gated: halting must always work, even if mute was toggled mid-spin.
  const halt = useCallback((name: SoundName) => {
    const audio = pool.current[name];
    if (!audio) return;
    try {
      audio.pause();
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

  // Start the looping reveal ambience (fills the face-down wait); returns a
  // stop() the caller MUST call on reveal/unmount. Muted → no-op stop so callers
  // don't branch. Loops seamlessly (asset is crossfade-constructed).
  const anticipation = useCallback((): (() => void) => {
    if (muted) return () => {};
    const audio = pool.current.reveal;
    if (!audio) return () => {};
    // Manual volume ramp (HTMLAudio has no native fade): step every ~30ms so the
    // bed EMERGES under the reel-stop instead of popping in at full level, and
    // fades out on the tap instead of cutting. A new ramp cancels any prior one.
    const ramp = (to: number, ms: number, done?: () => void) => {
      if (fadeTimer.current !== null) window.clearInterval(fadeTimer.current);
      const from = audio.volume;
      const steps = Math.max(1, Math.round(ms / 30));
      let i = 0;
      fadeTimer.current = window.setInterval(() => {
        i += 1;
        audio.volume = Math.min(
          1,
          Math.max(0, from + (to - from) * (i / steps)),
        );
        if (i >= steps) {
          if (fadeTimer.current !== null)
            window.clearInterval(fadeTimer.current);
          fadeTimer.current = null;
          done?.();
        }
      }, 30);
    };
    try {
      audio.loop = true;
      audio.volume = 0;
      audio.currentTime = 0;
      void audio.play().catch(() => {});
      ramp(1, 600); // ease in across the reel-stop → reveal handoff
    } catch {
      /* no-op */
    }
    return () => {
      try {
        // Quick smooth duck on the tap so the bed clears cleanly under the
        // blooming win fanfare (which now eases in too) — a seamless handoff.
        ramp(0, 220, () => {
          audio.pause();
          audio.loop = false;
          audio.currentTime = 0;
        });
      } catch {
        /* no-op */
      }
    };
  }, [muted]);

  return { muted, toggleMuted, play, halt, vibrate, sfx, anticipation };
}
