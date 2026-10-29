import { useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { canTalkOver } from '../../lib/voice';
import { AiOrb } from './AiOrb';
import type { VoiceState } from './use-voice';

// Hands-free talk: the orb listens (a ring follows the speaker's voice),
// thinks, then speaks (the orb follows its own voice); talking over it, or
// tapping it, while it speaks interrupts and listens (a tap only, on an
// iPhone or iPad). Esc ends the talk.
export function TalkPanel({
  state,
  level,
  caption,
  onInterrupt,
  onEnd,
}: {
  state: VoiceState;
  level: number;
  /** What was heard (thinking) or the answer being read (speaking). */
  caption?: string;
  onInterrupt: () => void;
  onEnd: () => void;
}) {
  const { t } = useTranslation();
  const still = useReducedMotion();
  const listening = state === 'listening';
  // Markdown marks read badly in one line; `_` stays (ids, snake_case).
  const line = caption
    ?.replace(/[*`#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Through a ref: the page hands a new onEnd each render, and the Esc
  // listener should not be re-attached each time.
  const end = useRef(onEnd);
  useEffect(() => {
    end.current = onEnd;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // an open drawer or dialog takes its own Esc (Radix prevents default)
      if (e.key === 'Escape' && !e.defaultPrevented) end.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      className="bg-ui-bg-base border-ui-border-base flex items-center gap-x-4 rounded-2xl border px-4 py-3 shadow-lg"
    >
      <button
        type="button"
        onClick={onInterrupt}
        // only an answer being spoken can be interrupted
        disabled={state !== 'speaking'}
        aria-label={
          state === 'speaking'
            ? t('assistant.voice.interrupt')
            : t(`assistant.voice.state.${state}`)
        }
        className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full"
      >
        {listening && (
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-full border-2 border-sky-400/70"
            animate={{ scale: still ? 1 : 1 + Math.min(level, 1) * 0.35 }}
            transition={{ duration: 0.08 }}
          />
        )}
        <motion.span
          className="flex"
          animate={{
            scale:
              state === 'speaking' && !still
                ? 1 + Math.min(level, 1) * 0.15
                : 1,
          }}
          transition={{ duration: 0.08 }}
        >
          <AiOrb
            size={48}
            active={state === 'thinking' || state === 'speaking'}
          />
        </motion.span>
      </button>
      <div className="min-w-0 flex-1" aria-live="polite">
        <p className="text-ui-fg-base text-sm font-medium">
          {t(`assistant.voice.state.${state}`)}
        </p>
        {line && (
          <p className="text-ui-fg-subtle line-clamp-2 text-xs">
            {line.length > 90 ? `${line.slice(0, 90)}…` : line}
          </p>
        )}
        <p className="text-ui-fg-muted text-[11px]">
          {state !== 'speaking'
            ? t('assistant.voice.talkHint')
            : canTalkOver()
              ? t('assistant.voice.tapToInterrupt')
              : t('assistant.voice.tapOnlyToInterrupt')}
        </p>
      </div>
      <button
        type="button"
        onClick={onEnd}
        className="border-ui-border-base text-ui-fg-subtle hover:text-ui-fg-base hover:bg-ui-bg-base-hover rounded-full border px-3 py-1.5 text-xs"
      >
        {t('assistant.voice.endTalk')}
      </button>
    </motion.div>
  );
}
