import { memo, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowPathMini, CheckMini, SquareTwoStack } from '@medusajs/icons';
import { toast } from '@medusajs/ui';
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
  onRetry,
  canRetry,
  onConfirm,
}: {
  messages: UiMessage[];
  /** Read an answer aloud (by its saved id), or stop it. */
  onSpeak?: (messageId: string) => void;
  reading?: string | null;
  /** Ask a failed answer's question again (stable: Message is memoised). */
  onRetry?: (question: UiMessage) => void;
  canRetry?: boolean;
  /** Save a proposed note or task (stable: Message is memoised). */
  onConfirm?: (messageKey: string, token: string) => void;
}) {
  return (
    <div className="flex flex-col gap-y-6">
      {messages.map((m, i) => (
        <Message
          key={m.key}
          m={m}
          onSpeak={onSpeak}
          speaking={!!m.messageId && m.messageId === reading}
          asked={
            m.role === 'assistant' && messages[i - 1]?.role === 'user'
              ? messages[i - 1]
              : undefined
          }
          onRetry={canRetry ? onRetry : undefined}
          onConfirm={onConfirm}
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
  asked,
  onRetry,
  onConfirm,
}: {
  m: UiMessage;
  onSpeak?: (messageId: string) => void;
  speaking: boolean;
  /** The question this answer is for. */
  asked?: UiMessage;
  onRetry?: (question: UiMessage) => void;
  onConfirm?: (messageKey: string, token: string) => void;
}) {
  const { t } = useTranslation();
  const finished = !m.pending && !!m.content;
  const retry =
    onRetry && !m.pending && (m.error || m.stopped) && asked?.question
      ? asked
      : undefined;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.content);
      toast.success(t('assistant.copied', { defaultValue: 'Copied.' }));
    } catch {
      toast.error(
        t('assistant.copyFailed', { defaultValue: 'Could not copy.' }),
      );
    }
  };
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
      <div className="flex min-w-0 flex-1 flex-col gap-y-3 pt-0.5">
        {/* Only answers are live, and a region's first content is not read:
          opening a chat stays quiet, a new answer is read once it is whole. */}
        <div
          aria-live="polite"
          aria-busy={m.pending}
          className="flex flex-col gap-y-3"
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
            <Markdown text={m.content} streaming={m.pending} />
          ) : m.pending ? (
            !m.steps.some((s) => s.status === 'start') && (
              <Thinking since={m.since} />
            )
          ) : (
            !m.error &&
            m.images.length === 0 &&
            !m.proposals?.length && (
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
        </div>
        {/* The summary is plain text, never markdown: planted data writes it. */}
        {onConfirm &&
          m.proposals?.map((p) => (
            <div
              key={p.token}
              className="border-ui-border-base bg-ui-bg-base flex flex-col gap-y-2 rounded-xl border px-3 py-2.5"
            >
              <p className="text-ui-fg-base whitespace-pre-wrap break-words text-[13px]">
                {p.summary}
              </p>
              <div className="flex flex-wrap items-center gap-x-2">
                <button
                  type="button"
                  disabled={p.state !== 'waiting'}
                  aria-busy={p.state === 'saving'}
                  onClick={() => onConfirm(m.key, p.token)}
                  className={`flex w-fit items-center gap-x-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${p.state === 'saved' ? 'border-transparent text-ui-tag-green-text' : 'border-ui-border-base text-ui-fg-base hover:bg-ui-bg-base-hover disabled:opacity-50'}`}
                >
                  {p.state === 'saved' && <CheckMini />}
                  {p.state === 'saved'
                    ? p.kind === 'note'
                      ? t('assistant.confirm.saved')
                      : t('assistant.confirm.taskSaved')
                    : p.kind === 'note'
                      ? t('assistant.confirm.saveNote')
                      : t('assistant.confirm.saveTask')}
                </button>
                {p.state !== 'saved' && (
                  <span className="text-ui-fg-muted text-[11px]">
                    {t('assistant.confirm.hint')}
                  </span>
                )}
              </div>
            </div>
          ))}
        {/* Outside the live region: its buttons are not news to announce. */}
        {(finished || retry) && (
          <div className="flex flex-wrap items-center gap-x-1">
            {onSpeak && m.messageId && finished && (
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
            {finished && (
              <button
                type="button"
                onClick={() => void copy()}
                className="text-ui-fg-muted hover:text-ui-fg-base hover:bg-ui-bg-base-hover flex w-fit items-center gap-x-1.5 rounded-full px-2 py-0.5 text-[11px] transition-colors"
              >
                <SquareTwoStack />
                {t('assistant.copy', { defaultValue: 'Copy' })}
              </button>
            )}
            {retry && (
              <button
                type="button"
                onClick={() => onRetry?.(retry)}
                className="text-ui-fg-muted hover:text-ui-fg-base hover:bg-ui-bg-base-hover flex w-fit items-center gap-x-1.5 rounded-full px-2 py-0.5 text-[11px] transition-colors"
              >
                <ArrowPathMini />
                {t('assistant.tryAgain', { defaultValue: 'Try again' })}
              </button>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
});

// "Thinking… 4 s": counts from when the question went out, so the count
// carries on after each tool step. No animation; the number is not read out.
function Thinking({ since }: { since?: number }) {
  const { t } = useTranslation();
  // Now, not `since`: remounted after a tool step, it must not read 0 s.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = since ? Math.floor((now - since) / 1000) : 0;
  return (
    <span className="pc-ai-shimmer text-[13px] font-medium">
      {t('assistant.thinking')}
      {secs > 0 && (
        <span aria-hidden className="tabular-nums">
          {' '}
          {t('assistant.seconds', { n: secs })}
        </span>
      )}
    </span>
  );
}
