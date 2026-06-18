'use client';

// SFX + haptics for the slot. Gesture-unlocked (first sound follows the SPIN
// click, so no autoplay-policy violation). Mute persists in localStorage,
// default UNMUTED (PRD §3.9). Degrades silently if an asset is missing, so the
// slice ships before final audio is sourced.
import { useCallback, useEffect, useRef, useState } from 'react';

const MUTED_KEY = 'pokenic.slot.muted';

const FILES = {
  spin: '/sounds/slot-spin.mp3',
  stop: '/sounds/slot-stop.mp3',
  win: '/sounds/slot-win.mp3',
  bigwin: '/sounds/slot-bigwin.mp3',
  sell: '/sounds/slot-sell.mp3',
} as const;

export type SoundName = keyof typeof FILES;

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
  const [muted, setMuted] = useState(false);
  const pool = useRef<Partial<Record<SoundName, HTMLAudioElement>>>({});

  // Hydrate mute state + preload the pool on the client only.
  useEffect(() => {
    setMuted(readMuted());
    for (const [name, src] of Object.entries(FILES)) {
      const audio = new Audio(src);
      audio.preload = 'auto';
      pool.current[name as SoundName] = audio;
    }
  }, []);

  const play = useCallback((name: SoundName) => {
    if (readMuted()) return;
    const audio = pool.current[name];
    if (!audio) return;
    try {
      audio.currentTime = 0;
      void audio.play().catch(() => {});
    } catch {
      /* no-op */
    }
  }, []);

  const vibrate = useCallback((pattern: number | number[]) => {
    if (readMuted()) return;
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch {
        /* no-op */
      }
    }
  }, []);

  const toggleMuted = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      writeMuted(next);
      return next;
    });
  }, []);

  return { muted, toggleMuted, play, vibrate };
}
