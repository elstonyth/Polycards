import { memo } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { AiOrb } from './AiOrb';
import { ImageCard, ImagePending } from './ImageCard';
import { Markdown } from './Markdown';
import { ToolSteps } from './ToolSteps';
import { DRAWS, type UiMessage } from './thread-data';
import { SpeakerIcon } from './VoiceIcons';

export function Thread({
  messages,
  onSpeak,
  reading,
}: {
  messages: UiMessage[];
  /** Read an answer aloud (by its saved id), or stop it. */
  onSpeak?: (messageId: string) => void;
  reading?: string | null;
}) {
  return (
    <div className="flex flex-col gap-y-6">
      {messages.map((m) => (
        <Message
          key={m.key}
          m={m}
          onSpeak={onSpeak}
          speaking={!!m.messageId && m.messageId === reading}
        />
      ))}
    </div>
  );
}

// Memoised: a streamed delta replaces only the answer it grows, so the rest
// of the thread does not re-parse its markdown.
const Message = memo(function Message({
  m,
  onSpeak,
  speaking,
}: {
  m: UiMessage;
  onSpeak?: (messageId: string) => void;
  speaking: boolean;
}) {
  const { t } = useTranslation();
  return m.role === 'user' ? (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="flex flex-col items-end gap-y-2"
    >
      {Array.isArray(m.attachments) && m.attachments.length > 0 && (
        <div className="flex gap-x-2">
          {m.attachments.map((src, i) => (
            <img
              key={i}
              src={src}
              alt=""
              className="border-ui-border-base h-20 w-20 rounded-xl border object-cover"
            />
          ))}
        </div>
      )}
      <div className="bg-ui-bg-component text-ui-fg-base max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-4 py-2.5 text-[13.5px] leading-relaxed">
        {m.content}
      </div>
      {typeof m.attachments === 'number' && m.attachments > 0 && (
        <span className="text-ui-fg-muted text-[11px]">
          {t('assistant.screenshotsSent', { count: m.attachments })}
        </span>
      )}
    </motion.div>
  ) : (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex gap-x-3"
    >
      <AiOrb size={28} active={m.pending} />
      {/* Only answers are live, and a region's first content is not read:
          opening a chat stays quiet, a new answer is read once it is whole. */}
      <div
        aria-live="polite"
        aria-busy={m.pending}
        className="flex min-w-0 flex-1 flex-col gap-y-3 pt-0.5"
      >
        <ToolSteps steps={m.steps} />
        {m.pending &&
          m.steps
            .filter((s) => s.status === 'start' && DRAWS.test(s.name))
            .map((s) => (
              <ImagePending
                key={s.id}
                label={t(`assistant.tools.${s.name}`, {
                  defaultValue: s.label ?? s.name,
                })}
              />
            ))}
        {m.images.length > 0 && (
          <div className="flex flex-wrap gap-3">
            {m.images.map((url) => (
              <ImageCard key={url} url={url} />
            ))}
          </div>
        )}
        {m.content ? (
          <Markdown text={m.content} />
        ) : m.pending ? (
          !m.steps.some((s) => s.status === 'start') && (
            <span className="pc-ai-shimmer text-[13px] font-medium">
              {t('assistant.thinking')}
            </span>
          )
        ) : (
          !m.error &&
          m.images.length === 0 && (
            <span className="text-ui-fg-muted text-[13px]">
              {t('assistant.stopped')}
            </span>
          )
        )}
        {m.error && (
          <div className="border-ui-tag-red-border bg-ui-tag-red-bg text-ui-tag-red-text rounded-xl border px-3 py-2 text-xs">
            {m.error}
          </div>
        )}
        {onSpeak && m.messageId && m.content && !m.pending && (
          <button
            type="button"
            onClick={() => m.messageId && onSpeak(m.messageId)}
            aria-pressed={speaking}
            className={`flex w-fit items-center gap-x-1.5 rounded-full px-2 py-0.5 text-[11px] transition-colors ${speaking ? 'bg-sky-500/15 text-sky-500' : 'text-ui-fg-muted hover:text-ui-fg-base hover:bg-ui-bg-base-hover'}`}
          >
            <SpeakerIcon />
            {speaking
              ? t('assistant.voice.stopReading')
              : t('assistant.voice.readAloud')}
          </button>
        )}
      </div>
    </motion.div>
  );
});
