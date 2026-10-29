import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@medusajs/ui';
import { useTranslation } from 'react-i18next';
import { streamSpeech } from '../../lib/assistant';
import {
  MicError,
  PcmPlayer,
  startRecording,
  type Recording,
} from '../../lib/voice';

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking';

/** The chat's voice: one recording or one answer read aloud at a time.
 *  listen() throws MicError (after saying why) when the mic can't open. */
export function useVoice() {
  const { t } = useTranslation();
  const [state, setState] = useState<VoiceState>('idle');
  const [level, setLevel] = useState(0);
  const [reading, setReading] = useState<string | null>(null);
  const rec = useRef<Recording | null>(null);
  const player = useRef<PcmPlayer | null>(null);
  const speech = useRef<AbortController | null>(null);

  const stopSpeaking = useCallback(() => {
    speech.current?.abort();
    speech.current = null;
    player.current?.stop();
    player.current = null;
  }, []);

  const listen = useCallback(
    async (autoStop: boolean): Promise<string | null> => {
      stopSpeaking();
      let r: Recording;
      try {
        r = await startRecording({ autoStop, onLevel: setLevel });
      } catch (err) {
        const reason = err instanceof MicError ? err.reason : 'unavailable';
        toast.error(t(`assistant.voice.mic.${reason}`));
        throw err;
      }
      rec.current = r;
      setState('listening');
      // A recorder whose audio never starts gets no frames, so its own
      // silence timers never run: stop it by the clock.
      const guard = setTimeout(() => r.stop(), 75_000);
      try {
        return await r.done;
      } finally {
        clearTimeout(guard);
        rec.current = null;
        setLevel(0);
        setState((s) => (s === 'listening' ? 'idle' : s));
      }
    },
    [stopSpeaking, t],
  );

  /** Reads an answer aloud; resolves once it has been heard or stopped. */
  const speak = useCallback(
    async (messageId: string) => {
      stopSpeaking();
      const ac = new AbortController();
      const p = new PcmPlayer();
      speech.current = ac;
      player.current = p;
      setReading(messageId);
      setState('speaking');
      try {
        await streamSpeech(
          messageId,
          (e) => {
            if (e.type === 'audio') p.push(e.data);
            else if (e.type === 'error') {
              toast.error(
                e.code
                  ? t(`assistant.err.${e.code}`, { defaultValue: e.message })
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
      await Promise.race([
        p.ended,
        new Promise((r) => setTimeout(r, 180_000)),
      ]);
      p.stop();
      if (player.current === p) {
        player.current = null;
        speech.current = null;
      }
      setReading((r) => (r === messageId ? null : r));
      setState((s) => (s === 'speaking' ? 'idle' : s));
    },
    [stopSpeaking, t],
  );

  // Leaving the page stops the mic and the voice.
  useEffect(
    () => () => {
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
    cancelListening: useCallback(() => rec.current?.cancel(), []),
    speak,
    stopSpeaking,
  };
}
