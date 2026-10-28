import { useEffect, useRef, useState } from 'react';
import { attentionIncreased, attentionTitle } from '../../lib/dashboard';

const SOUND_KEY = 'pc-dashboard-sound';

const savedSound = () => {
  try {
    return window.localStorage.getItem(SOUND_KEY) === 'on';
  } catch {
    return false;
  }
};

/** Two soft rising notes, made with Web Audio so there is no file to ship. */
const chime = (ctx: AudioContext) => {
  const t0 = ctx.currentTime;
  [880, 1320].forEach((freq, i) => {
    const start = t0 + i * 0.14;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.42);
  });
};

/** The page's one AudioContext, resumed; call it from a click. */
const unlock = (audio: { current: AudioContext | null }) => {
  audio.current ??= new AudioContext();
  void audio.current.resume();
  return audio.current;
};

/**
 * Tells the operator when an attention queue grows: the tab title carries the
 * number of waiting items, and a chime plays when sound is on. Browsers allow
 * audio only after a click on the page; switching sound on is one, and a saved
 * "on" waits for the first click anywhere.
 */
export const useAttentionAlert = (counts: Record<string, number>) => {
  const [soundOn, setSoundOn] = useState(savedSound);
  const audio = useRef<AudioContext | null>(null);
  const seen = useRef<Record<string, number>>({});
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  useEffect(() => {
    if (soundOn && audio.current && attentionIncreased(seen.current, counts)) {
      chime(audio.current);
    }
    seen.current = { ...seen.current, ...counts };
  });

  useEffect(() => {
    if (!soundOn || audio.current) return;
    const onFirstClick = () => void unlock(audio);
    window.addEventListener('pointerdown', onFirstClick, { once: true });
    return () => window.removeEventListener('pointerdown', onFirstClick);
  }, [soundOn]);

  useEffect(() => {
    document.title = attentionTitle(document.title, total);
  }, [total]);
  useEffect(
    () => () => {
      document.title = attentionTitle(document.title, 0);
    },
    [],
  );

  const setSound = (on: boolean) => {
    setSoundOn(on);
    try {
      window.localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
    } catch {
      // Private mode or blocked storage: the switch still works for this visit.
    }
    if (on) chime(unlock(audio));
  };

  return { soundOn, setSound };
};
