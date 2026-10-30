import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@medusajs/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { streamSpeech } from '../../lib/assistant';
import {
  canTalkOver,
  MicError,
  PcmPlayer,
  startBargeIn,
  startRecording,
  type Recording,
} from '../../lib/voice';

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking';

/** The chat's voice: one recording or one answer read aloud at a time.
 *  listen() throws MicError (after saying why) when the mic can't open. */
export function useVoice() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [state, setState] = useState<VoiceState>('idle');
  const [level, setLevel] = useState(0);
  const [reading, setReading] = useState<string | null>(null);
  const rec = useRef<Recording | null>(null);
  const player = useRef<PcmPlayer | null>(null);
  const speech = useRef<AbortController | null>(null);
  // Set while the mic opens (a permission prompt can hold it for a while).
  const starting = useRef(false);
  // Cancelled before the mic finished opening: drop it as soon as it opens.
  const cancelled = useRef(false);
  // Bumped by each speak(): only the latest one resets reading and state.
  const turn = useRef(0);

  const stopSpeaking = useCallback(() => {
    speech.current?.abort();
    speech.current = null;
    player.current?.stop();
    player.current = null;
  }, []);

  const listen = useCallback(
    async (autoStop: boolean): Promise<string | null> => {
      // One mic at a time: a double tap, or a mic tap and then Talk.
      if (starting.current || rec.current) return null;
      starting.current = true;
      cancelled.current = false;
      stopSpeaking();
      // Listening from the tap on, so the page refuses a second start while
      // the mic opens.
      setState('listening');
      let r: Recording;
      try {
        r = await startRecording({ autoStop, onLevel: setLevel });
      } catch (err) {
        setState('idle');
        const reason = err instanceof MicError ? err.reason : 'unavailable';
        toast.error(t(`assistant.voice.mic.${reason}`));
        throw err;
      } finally {
        starting.current = false;
      }
      rec.current = r;
      // Ended (End talk, leaving the page) while the mic was opening.
      if (cancelled.current) r.cancel();
      // A recorder whose audio never starts gets no frames, so its own
      // silence timers never run: stop it by the clock.
      const guard = setTimeout(() => r.stop(), 75_000);
      try {
        return await r.done;
      } finally {
        clearTimeout(guard);
        if (rec.current === r) rec.current = null;
        setLevel(0);
        setState((s) => (s === 'listening' ? 'idle' : s));
      }
    },
    [stopSpeaking, t],
  );

  /** Reads an answer aloud; resolves once it has been heard or stopped.
   *  With bargeIn (talk mode) the person talking over it stops it. */
  const speak = useCallback(
    async (messageId: string, opts?: { bargeIn?: boolean }) => {
      stopSpeaking();
      // no Web Audio (an old or stripped-down browser): nothing could play it
      if (typeof AudioContext === 'undefined') {
        toast.error(t('assistant.settings.noPlayback'));
        return { bargedIn: false };
      }
      const n = ++turn.current;
      const ac = new AbortController();
      // level carries the voice's loudness while speaking (the talk orb)
      const p = new PcmPlayer(undefined, { onLevel: setLevel });
      speech.current = ac;
      player.current = p;
      setReading(messageId);
      setState('speaking');
      let bargedIn = false;
      // shortcut: words said before speech is noticed are not recorded; keep the barge-in mic's audio if that matters
      const barge =
        opts?.bargeIn && canTalkOver()
          ? startBargeIn({
              onSpeech: () => {
                bargedIn = true;
                ac.abort();
                p.stop();
              },
              answer: () => p.loudness,
            }).catch(() => null) // no mic: the answer just plays on
          : null;
      try {
        await streamSpeech(
          messageId,
          (e) => {
            if (e.type === 'audio') p.push(e.data);
            else if (e.type === 'format') p.setRate(e.rate);
            else if (e.type === 'error') {
              toast.error(
                e.code
                  ? t(`assistant.err.${e.code}`, {
                      defaultValue: e.message,
                      reason: e.reason ?? '',
                    })
                  : e.message,
              );
            }
          },
          ac.signal,
        );
        p.finish();
      } catch {
        // Stopped, or the connection dropped: stop what is playing.
        p.stop();
      }
      // Likewise a player whose audio never starts never ends.
      await Promise.race([p.ended, new Promise((r) => setTimeout(r, 180_000))]);
      p.stop();
      // released before the next listen() opens the mic: iOS mishandles two captures
      (await barge)?.stop();
      if (player.current === p) {
        player.current = null;
        speech.current = null;
      }
      // A newer speak() owns reading and state now.
      if (turn.current === n) {
        setReading(null);
        setState((s) => (s === 'speaking' ? 'idle' : s));
      }
      // Reading aloud is paid for: the header's spend moves.
      void qc.invalidateQueries({ queryKey: ['assistant', 'me'] });
      return { bargedIn };
    },
    [qc, stopSpeaking, t],
  );

  // Leaving the page stops the mic and the voice.
  useEffect(
    () => () => {
      cancelled.current = true; // a mic still opening
      rec.current?.cancel();
      stopSpeaking();
    },
    [stopSpeaking],
  );

  return {
    state,
    setState,
    level,
    /** The answer being read aloud, if any. */
    reading,
    listen,
    /** Ends the recording now and keeps it. */
    stopListening: useCallback(() => rec.current?.stop(), []),
    /** Ends the recording and drops it. */
    cancelListening: useCallback(() => {
      if (rec.current) rec.current.cancel();
      else if (starting.current) cancelled.current = true;
    }, []),
    speak,
    stopSpeaking,
  };
}
