import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { AiOrb } from './AiOrb';
import type { VoiceState } from './use-voice';

// Hands-free talk: the orb listens (a ring follows the speaker's voice),
// thinks, then speaks; tapping it while it speaks interrupts and listens.
export function TalkPanel({
  state,
  level,
  onInterrupt,
  onEnd,
}: {
  state: VoiceState;
  level: number;
  onInterrupt: () => void;
  onEnd: () => void;
}) {
  const { t } = useTranslation();
  const still = useReducedMotion();
  const listening = state === 'listening';
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      className="bg-ui-bg-base border-ui-border-base flex items-center gap-x-4 rounded-2xl border px-4 py-3 shadow-lg"
    >
      <button
        type="button"
        onClick={state === 'speaking' ? onInterrupt : undefined}
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
        <AiOrb
          size={48}
          active={state === 'thinking' || state === 'speaking'}
        />
      </button>
      <div className="min-w-0 flex-1" aria-live="polite">
        <p className="text-ui-fg-base text-sm font-medium">
          {t(`assistant.voice.state.${state}`)}
        </p>
        <p className="text-ui-fg-muted text-[11px]">
          {state === 'speaking'
            ? t('assistant.voice.tapToInterrupt')
            : t('assistant.voice.talkHint')}
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
