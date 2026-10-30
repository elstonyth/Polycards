import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckMini, XMarkMini } from '@medusajs/icons';
import { useTranslation } from 'react-i18next';

export type Step = {
  id: string;
  /** The tool's name, like challenge_poster. */
  name: string;
  /** The server's English label, on a step that streamed in live. */
  label?: string;
  status: 'start' | 'done' | 'error';
  ms?: number;
};

// What the assistant is doing, as it does it (21st.dev "tool call timeline"
// pattern): each step slides in, shimmers while it runs, then settles with a
// tick or a cross and how long it took.
export function ToolSteps({ steps }: { steps: Step[] }) {
  const { t } = useTranslation();
  if (!steps.length) return null;
  return (
    <div className="relative">
      <span
        aria-hidden
        className="bg-ui-border-base absolute bottom-2 left-[15px] top-2 w-px"
      />
      <ol className="relative flex flex-col gap-y-1.5 pl-1">
        <AnimatePresence initial={false}>
          {steps.map((s) => (
            <motion.li
              key={s.id}
              layout
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              className="relative flex items-center gap-x-2.5 text-xs"
            >
              <span
                className={`relative z-[1] flex h-[22px] w-[22px] items-center justify-center rounded-full border ${
                  s.status === 'error'
                    ? 'border-ui-tag-red-border bg-ui-tag-red-bg text-ui-tag-red-icon'
                    : s.status === 'done'
                      ? 'border-ui-tag-green-border bg-ui-tag-green-bg text-ui-tag-green-icon'
                      : 'border-ui-border-interactive bg-ui-bg-base'
                }`}
              >
                {s.status === 'start' ? (
                  <span className="pc-ai-spin h-2.5 w-2.5 rounded-full border-2 border-violet-400 border-t-transparent" />
                ) : s.status === 'done' ? (
                  <CheckMini />
                ) : (
                  <XMarkMini />
                )}
              </span>
              <span
                className={
                  s.status === 'start'
                    ? 'pc-ai-shimmer font-medium'
                    : 'text-ui-fg-subtle'
                }
              >
                {t(`assistant.tools.${s.name}`, {
                  defaultValue: s.label ?? s.name,
                })}
              </span>
              {s.status === 'start' && <Running />}
              {s.ms !== undefined && (
                <span className="text-ui-fg-muted tabular-nums">
                  {/* Floor 0.1 s: a 20 ms lookup must not read "0.0 s". */}
                  {t('assistant.seconds', {
                    n: (Math.max(s.ms, 100) / 1000).toFixed(1),
                  })}
                </span>
              )}
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </div>
  );
}

// A running step counts up: with reduced motion its spinner stands still,
// and a long run must not look frozen. Not read out (inside a live region).
function Running() {
  const { t } = useTranslation();
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSecs((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return secs > 0 ? (
    <span aria-hidden className="text-ui-fg-muted tabular-nums">
      {t('assistant.seconds', { n: secs })}
    </span>
  ) : null;
}
