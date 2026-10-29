import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { PlusMini, Sparkles, Trash } from '@medusajs/icons';
import { Drawer, toast } from '@medusajs/ui';
import type { Permission, RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  assistantApi,
  streamChat,
  type AssistantMe,
} from '../../lib/assistant';
import { timeAgo } from '../../lib/format';
import { AiOrb } from '../../components/assistant/AiOrb';
import { Composer } from '../../components/assistant/Composer';
import { Thread } from '../../components/assistant/Thread';
import {
  fromStored,
  type UiMessage,
} from '../../components/assistant/thread-data';

// The AI assistant (spec 2026-10-29): one chat for everything the Discord
// desks did. What it can answer follows the asker's admin roles — the server
// decides; this page only shows what /admin/assistant/me says they can ask.
export const config: RouteConfig = {
  label: 'pcNav.assistant',
  translationNs: 'translation',
  icon: Sparkles,
  rank: 5,
  permissions: ['assistant:update' as Permission],
};

// Suggestions offered by the tools a person holds (first match wins a slot).
const SUGGESTIONS: { tool: string; key: string; send: boolean }[] = [
  { tool: 'economy', key: 'salesToday', send: true },
  { tool: 'top_pulls', key: 'topPull', send: true },
  { tool: 'challenge_stages_poster', key: 'challengePoster', send: true },
  { tool: 'generate_image', key: 'packArt', send: false },
  { tool: 'low_stock', key: 'lowStock', send: true },
  { tool: 'admin_read', key: 'toBuy', send: true },
  { tool: 'order', key: 'order', send: false },
  { tool: 'account', key: 'account', send: false },
];

function EmptyState({
  me,
  onPick,
}: {
  me: AssistantMe | undefined;
  onPick: (text: string, send: boolean) => void;
}) {
  const { t } = useTranslation();
  const tools = new Set(me?.tools.map((x) => x.name));
  const picks = SUGGESTIONS.filter((s) => tools.has(s.tool)).slice(0, 4);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-y-6 px-6 py-10 text-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      >
        <AiOrb size={84} />
      </motion.div>
      <div className="flex flex-col gap-y-2">
        <h1 className="font-sans text-2xl font-semibold tracking-tight text-ui-fg-base">
          {t('assistant.hello')}
        </h1>
        <p className="text-ui-fg-subtle mx-auto max-w-md text-sm">
          {me?.super_admin
            ? t('assistant.helloAdmin')
            : t('assistant.helloLimited')}
        </p>
      </div>
      {picks.length > 0 && (
        <div className="grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
          {picks.map((s, i) => (
            <motion.button
              key={s.key}
              type="button"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 + i * 0.06, duration: 0.3 }}
              onClick={() => onPick(t(`assistant.suggest.${s.key}`), s.send)}
              className="border-ui-border-base bg-ui-bg-base hover:bg-ui-bg-base-hover hover:border-ui-border-interactive text-ui-fg-base rounded-xl border px-4 py-3 text-left text-[13px] transition-colors"
            >
              {t(`assistant.suggest.${s.key}`)}
            </motion.button>
          ))}
        </div>
      )}
    </div>
  );
}

const AssistantPage = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selected = params.get('c');
  const me = useQuery({
    queryKey: ['assistant', 'me'],
    queryFn: assistantApi.me,
  });
  const conversations = useQuery({
    queryKey: ['assistant', 'conversations'],
    queryFn: assistantApi.conversations,
  });
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [seed, setSeed] = useState<{ text: string; n: number }>();
  const ctl = useRef<AbortController | null>(null);
  // The conversation the running answer created: already on screen, so
  // selecting it must not reload it mid-stream.
  const live = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Follow the answer as it grows (text, steps, a poster loading in) unless
  // the person scrolled up to read; sending or opening a chat follows again.
  const stick = useRef(true);
  const [history, setHistory] = useState(false);

  // The tool's name in the page's language (the server's label is English).
  const labelOf = useCallback(
    (name: string) =>
      t(`assistant.tools.${name}`, {
        defaultValue:
          me.data?.tools.find((x) => x.name === name)?.label ?? name,
      }),
    [me.data, t],
  );

  useEffect(() => {
    if (!selected) {
      if (!ctl.current) setMessages([]);
      return;
    }
    if (live.current === selected) return;
    let gone = false;
    assistantApi
      .conversation(selected)
      .then((d) => {
        // A question sent while this loaded owns the screen: never wipe it.
        if (gone || ctl.current) return;
        stick.current = true;
        setMessages(fromStored(d.messages, labelOf));
      })
      .catch(() => !gone && setParams({}));
    return () => {
      gone = true;
    };
    // labelOf changes once `me` loads; a thread already shown keeps its labels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const hasMessages = messages.length > 0;
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    const body = content.current;
    if (!el || !body) return;
    const follow = () => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    };
    const watch = new ResizeObserver(follow);
    watch.observe(body);
    follow();
    return () => watch.disconnect();
  }, [hasMessages]);

  const send = async (text: string, images: string[]) => {
    stick.current = true;
    const ac = new AbortController();
    ctl.current = ac;
    setBusy(true);
    const stamp = Date.now();
    const key = `a-${stamp}`;
    setMessages((prev) => [
      ...prev,
      {
        key: `u-${stamp}`,
        role: 'user',
        content: text,
        attachments: images,
        images: [],
        steps: [],
      },
      {
        key,
        role: 'assistant',
        content: '',
        attachments: [],
        images: [],
        steps: [],
        pending: true,
      },
    ]);
    const patch = (fn: (m: UiMessage) => UiMessage) =>
      setMessages((prev) => prev.map((m) => (m.key === key ? fn(m) : m)));
    // An answer is whole only once `done` arrived; a stream that just stops
    // (a deploy, a dropped connection) is shown as cut off, never as complete.
    let finished = false;
    let failed = false;
    try {
      await streamChat(
        { conversation_id: selected ?? undefined, message: text, images },
        (e) => {
          if (e.type === 'done') finished = true;
          if (e.type === 'conversation') {
            live.current = e.id;
            if (e.id !== selected) setParams({ c: e.id });
          } else if (e.type === 'text') {
            patch((m) => ({ ...m, content: m.content + e.delta }));
          } else if (e.type === 'tool') {
            patch((m) => {
              const step = {
                id: e.id,
                name: e.name,
                label: t(`assistant.tools.${e.name}`, {
                  defaultValue: e.label,
                }),
                status: e.status,
                ms: e.ms,
              };
              const at = m.steps.findIndex((s) => s.id === e.id);
              return {
                ...m,
                steps:
                  at < 0
                    ? [...m.steps, step]
                    : m.steps.map((s, i) => (i === at ? step : s)),
              };
            });
          } else if (e.type === 'image') {
            patch((m) => ({ ...m, images: [...m.images, e.url] }));
          } else if (e.type === 'error') {
            failed = true;
            patch((m) => ({
              ...m,
              error: e.code
                ? t(`assistant.err.${e.code}`, { defaultValue: e.message })
                : e.message,
            }));
          }
        },
        ac.signal,
      );
      if (!finished && !failed && !ac.signal.aborted) {
        patch((m) => ({ ...m, error: t('assistant.connectionLost') }));
      }
    } catch {
      if (!ac.signal.aborted) {
        patch((m) => ({ ...m, error: t('assistant.connectionLost') }));
      }
    } finally {
      patch((m) => ({
        ...m,
        pending: false,
        steps: m.steps.map((s) =>
          s.status === 'start' ? { ...s, status: 'error' } : s,
        ),
      }));
      setBusy(false);
      ctl.current = null;
      live.current = null;
      void qc.invalidateQueries({ queryKey: ['assistant', 'conversations'] });
    }
  };

  const newChat = () => {
    if (busy) return;
    setParams({});
    setMessages([]);
  };

  const remove = async (id: string) => {
    if (busy || !window.confirm(t('assistant.deleteConfirm'))) return;
    try {
      await assistantApi.remove(id);
      if (id === selected) newChat();
      void qc.invalidateQueries({ queryKey: ['assistant', 'conversations'] });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const toolLabels = [
    ...new Set(me.data?.tools.map((x) => labelOf(x.name)) ?? []),
  ];

  const list = (
    <>
      <div className="p-3">
        <button
          type="button"
          onClick={() => {
            newChat();
            setHistory(false);
          }}
          disabled={busy}
          className="border-ui-border-base text-ui-fg-base hover:bg-ui-bg-base-hover flex w-full items-center justify-center gap-x-1.5 rounded-xl border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
        >
          <PlusMini />
          {t('assistant.newChat')}
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        <AnimatePresence initial={false}>
          {conversations.data?.conversations.map((c) => (
            <motion.div
              key={c.id}
              layout
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, height: 0 }}
              className={`group flex items-center rounded-lg ${
                c.id === selected
                  ? 'bg-ui-bg-component'
                  : 'hover:bg-ui-bg-base-hover'
              }`}
            >
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setParams({ c: c.id });
                  setHistory(false);
                }}
                className="min-w-0 flex-1 px-3 py-2 text-left"
              >
                <span className="text-ui-fg-base block truncate text-[13px]">
                  {c.title}
                </span>
                <span className="text-ui-fg-muted text-[11px]">
                  {timeAgo(c.last_message_at)}
                </span>
              </button>
              <button
                type="button"
                aria-label={t('assistant.delete')}
                disabled={busy}
                onClick={() => void remove(c.id)}
                className="text-ui-fg-muted hover:text-ui-fg-error mr-1 rounded p-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Trash />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
        {conversations.data?.conversations.length === 0 && (
          <p className="text-ui-fg-muted px-3 py-2 text-xs">
            {t('assistant.noChats')}
          </p>
        )}
      </nav>
    </>
  );

  return (
    <MotionConfig reducedMotion="user">
      <div className="pc-admin pc-ai-aurora bg-ui-bg-subtle border-ui-border-base flex h-[calc(100vh-6.5rem)] min-h-[560px] overflow-hidden rounded-2xl border">
        {/* Conversations */}
        <aside className="border-ui-border-base bg-ui-bg-base/60 hidden w-64 shrink-0 flex-col border-r backdrop-blur lg:flex">
          {list}
        </aside>

        {/* Chat */}
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="border-ui-border-base flex items-center gap-x-3 border-b px-5 py-3">
            <AiOrb size={30} active={busy} />
            <div className="min-w-0">
              <p className="text-ui-fg-base text-sm font-semibold">
                {t('assistant.title')}
              </p>
              <p className="text-ui-fg-muted truncate text-[11px]">
                {me.data?.super_admin
                  ? t('assistant.fullAccess')
                  : toolLabels.length
                    ? t('assistant.limitedAccess', {
                        list: toolLabels.join(' · '),
                      })
                    : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setHistory(true)}
              className="border-ui-border-base text-ui-fg-subtle hover:text-ui-fg-base ml-auto rounded-full border px-3 py-1 text-xs lg:hidden"
            >
              {t('assistant.history')}
            </button>
            <Drawer open={history} onOpenChange={setHistory}>
              <Drawer.Content className="pc-admin max-w-xs">
                <Drawer.Header>
                  <Drawer.Title>{t('assistant.history')}</Drawer.Title>
                </Drawer.Header>
                <Drawer.Body className="flex flex-col overflow-y-auto p-0">
                  {list}
                </Drawer.Body>
              </Drawer.Content>
            </Drawer>
            {me.data?.chat_model && (
              <span className="border-ui-border-base text-ui-fg-subtle hidden rounded-full border px-2.5 py-0.5 font-mono text-[10.5px] md:inline lg:ml-auto">
                {me.data.chat_model}
              </span>
            )}
          </header>

          {me.data && !me.data.key_set && (
            <div className="border-ui-tag-orange-border bg-ui-tag-orange-bg text-ui-tag-orange-text mx-5 mt-4 rounded-xl border px-4 py-2.5 text-xs">
              {me.data.super_admin ? (
                <>
                  {t('assistant.noKeyAdmin')}{' '}
                  <Link to="/settings/ai" className="font-semibold underline">
                    {t('assistant.openSettings')}
                  </Link>
                </>
              ) : (
                t('assistant.noKeyStaff')
              )}
            </div>
          )}

          <div
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            className="flex flex-1 flex-col overflow-y-auto"
          >
            {messages.length === 0 ? (
              <EmptyState
                me={me.data}
                onPick={(text, now) =>
                  now
                    ? void send(text, [])
                    : setSeed((s) => ({ text, n: (s?.n ?? 0) + 1 }))
                }
              />
            ) : (
              <div
                ref={content}
                role="log"
                aria-live="polite"
                aria-busy={busy}
                className="mx-auto w-full max-w-3xl px-5 py-6"
              >
                <Thread messages={messages} />
              </div>
            )}
          </div>

          <div className="mx-auto w-full max-w-3xl px-5 pb-5 pt-2">
            <Composer
              busy={busy}
              seed={seed}
              autoFocus
              onSend={(text, images) => void send(text, images)}
              onStop={() => ctl.current?.abort()}
            />
            <p className="text-ui-fg-muted mt-2 text-center text-[11px]">
              {t('assistant.footnote')}
            </p>
          </div>
        </section>
      </div>
    </MotionConfig>
  );
};

export default AssistantPage;
