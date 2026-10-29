import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { AiOrb } from './AiOrb';
import { ImageCard, ImagePending } from './ImageCard';
import { Markdown } from './Markdown';
import { ToolSteps } from './ToolSteps';
import { DRAWS, type UiMessage } from './thread-data';

export function Thread({ messages }: { messages: UiMessage[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-y-6">
      {messages.map((m) =>
        m.role === 'user' ? (
          <motion.div
            key={m.key}
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
            key={m.key}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="flex gap-x-3"
          >
            <AiOrb size={28} active={m.pending} />
            <div className="flex min-w-0 flex-1 flex-col gap-y-3 pt-0.5">
              <ToolSteps steps={m.steps} />
              {m.pending &&
                m.steps
                  .filter(
                    (s) =>
                      s.status === 'start' && DRAWS.test(s.name),
                  )
                  .map((s) => <ImagePending key={s.id} label={s.label} />)}
              {m.images.length > 0 && (
                <div className="flex flex-wrap gap-3">
                  {m.images.map((url) => (
                    <ImageCard key={url} url={url} />
                  ))}
                </div>
              )}
              {m.content ? (
                <Markdown text={m.content} />
              ) : (
                m.pending &&
                !m.steps.some((s) => s.status === 'start') && (
                  <span className="pc-ai-shimmer text-[13px] font-medium">
                    {t('assistant.thinking')}
                  </span>
                )
              )}
              {m.error && (
                <div className="border-ui-tag-red-border bg-ui-tag-red-bg text-ui-tag-red-text rounded-xl border px-3 py-2 text-xs">
                  {m.error}
                </div>
              )}
            </div>
          </motion.div>
        ),
      )}
    </div>
  );
}
