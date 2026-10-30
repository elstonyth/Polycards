import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { ArrowDownMini, PlusMini, Sparkles, Trash } from '@medusajs/icons';
import { Drawer, toast } from '@medusajs/ui';
import type { Permission, RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  assistantApi,
  confirmProposal,
  streamChat,
  type AssistantMe,
} from '../../lib/assistant';
import { timeAgo } from '../../lib/format';
import { AiOrb } from '../../components/assistant/AiOrb';
import { Composer } from '../../components/assistant/Composer';
import { SpendMeter } from '../../components/assistant/SpendMeter';
import { TalkPanel } from '../../components/assistant/TalkPanel';
import { Thread } from '../../components/assistant/Thread';
import { WaveIcon } from '../../components/assistant/VoiceIcons';
import { useVoice } from '../../components/assistant/use-voice';
import { MicError, unlockAudio } from '../../lib/voice';
import {
  fromStored,
  type Proposal,
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
  disabled,
}: {
  me: AssistantMe | undefined;
  onPick: (text: string, send: boolean) => void;
  disabled: boolean;
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
              disabled={disabled}
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
  // The chat whose messages are on screen (null: a new one). Until it is the
  // selected chat, that chat is loading and nothing can be sent.
  const [shown, setShown] = useState<string | null>(null);
  const loading = !!selected && selected !== shown;
  const scroller = useRef<HTMLDivElement>(null);
  // Holds the composer: Try again hands focus back to its textarea.
  const dock = useRef<HTMLDivElement>(null);
  // Follow the answer as it grows (text, steps, a poster loading in) unless
  // the person scrolled up to read; sending or opening a chat follows again.
  const stick = useRef(true);
  // `stick` as state, for the "Jump to latest" pill.
  const [away, setAway] = useState(false);
  const [history, setHistory] = useState(false);
  const voice = useVoice();
  // Hands-free talk: listen, ask, read the answer aloud, listen again.
  const [talk, setTalk] = useState(false);
  const talking = useRef(false);
  // The chat a question goes to, read by the talk loop, which outlives the
  // render it started in.
  const at = useRef({ selected, shown });
  useEffect(() => {
    at.current = { selected, shown };
  }, [selected, shown]);

  // The tool's name in the page's language (the server's label is English).
  const labelOf = useCallback(
    (name: string) =>
      t(`assistant.tools.${name}`, {
        defaultValue:
          me.data?.tools.find((x) => x.name === name)?.label ?? name,
      }),
    [me.data, t],
  );

  // Back to no chat (browser back, or a chat that failed to load): clear it,
  // while rendering rather than in an effect.
  if (!selected && shown && !busy) {
    setShown(null);
    setMessages([]);
  }

  // Never under a streaming answer: a chat picked meanwhile, or one whose
  // load lost the race to a question, loads once the answer ends.
  useEffect(() => {
    if (busy || !selected || selected === shown) return;
    let gone = false;
    assistantApi
      .conversation(selected)
      .then((d) => {
        // A question sent while this loaded owns the screen: never wipe it.
        if (gone || ctl.current) return;
        stick.current = true;
        setShown(selected);
        setMessages(fromStored(d.messages));
      })
      .catch(() => !gone && setParams({}));
    return () => {
      gone = true;
    };
  }, [selected, busy, shown, setParams]);

  // Leaving the page stops the answer: it would keep billing and hold the
  // server's one-answer-at-a-time lock. `alive` keeps a voice question that
  // ended because the page closed from toasting on the next page.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ctl.current?.abort();
    };
  }, []);

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

  /** Asks one question, typed or spoken (audio: a WAV recording). Gives the
   *  saved answer's id when it was answered in full, for reading aloud. */
  const send = async ({
    text,
    images,
    audio,
  }: {
    text: string;
    images: string[];
    audio?: string;
  }): Promise<string | null> => {
    // One answer at a time: a second stream would take Stop from the first.
    if (ctl.current) return null;
    const { selected: chatId, shown: onScreen } = at.current;
    stick.current = true;
    setAway(false);
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
        content: audio ? t('assistant.voice.hearing') : text,
        question: audio ? undefined : text,
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
        since: stamp,
      },
    ]);
    const patch = (fn: (m: UiMessage) => UiMessage, k = key) =>
      setMessages((prev) => prev.map((m) => (m.key === k ? fn(m) : m)));
    let answered: string | null = null;
    // An answer is whole only once `done` arrived; a stream that just stops
    // (a deploy, a dropped connection) is shown as cut off, never as complete.
    let finished = false;
    let failed = false;
    try {
      await streamChat(
        {
          conversation_id: chatId ?? undefined,
          ...(audio ? { audio } : { message: text }),
          images,
        },
        (e) => {
          if (e.type === 'done') {
            finished = true;
            answered = e.message_id;
            patch((m) => ({ ...m, messageId: e.message_id }));
          }
          if (e.type === 'transcript') {
            patch(
              (m) => ({
                ...m,
                content: e.text || t('assistant.voice.nothingHeard'),
                question: e.text || undefined,
              }),
              `u-${stamp}`,
            );
          } else if (e.type === 'conversation') {
            // The screen is this chat now, unless it was showing another.
            if (onScreen === chatId) setShown(e.id);
            if (e.id !== chatId) setParams({ c: e.id });
          } else if (e.type === 'text') {
            patch((m) => ({ ...m, content: m.content + e.delta }));
          } else if (e.type === 'tool') {
            patch((m) => {
              const step = {
                id: e.id,
                name: e.name,
                label: e.label,
                status: e.status,
                ms: e.ms,
              };
              const idx = m.steps.findIndex((s) => s.id === e.id);
              return {
                ...m,
                steps:
                  idx < 0
                    ? [...m.steps, step]
                    : m.steps.map((s, i) => (i === idx ? step : s)),
              };
            });
          } else if (e.type === 'image') {
            patch((m) => ({ ...m, images: [...m.images, e.url] }));
          } else if (e.type === 'confirm') {
            patch((m) => ({
              ...m,
              proposals: [
                ...(m.proposals ?? []),
                {
                  token: e.token,
                  kind: e.kind,
                  summary: e.summary,
                  state: 'waiting',
                },
              ],
            }));
          } else if (e.type === 'error') {
            failed = true;
            patch((m) => ({
              ...m,
              error: e.code
                ? t(`assistant.err.${e.code}`, {
                    defaultValue: e.message,
                    reason:
                      'reason' in e && typeof e.reason === 'string'
                        ? e.reason
                        : '',
                  })
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
        stopped: ac.signal.aborted && !finished,
        steps: m.steps.map((s) =>
          s.status === 'start' ? { ...s, status: 'error' } : s,
        ),
      }));
      setBusy(false);
      ctl.current = null;
      void qc.invalidateQueries({ queryKey: ['assistant', 'conversations'] });
      // Today's spend in the header moves with each answer.
      void qc.invalidateQueries({ queryKey: ['assistant', 'me'] });
    }
    return finished && !failed ? answered : null;
  };

  // Try again: the same question, asked anew at the end of the same chat.
  // Through a ref, so Thread's memoised messages get one stable handler.
  const latestSend = useRef(send);
  useEffect(() => {
    latestSend.current = send;
  });
  const retry = useCallback(
    (q: UiMessage) => {
      if (!q.question || ctl.current) return;
      // Text only: after a reload a question's screenshots are just a count.
      const shots = Array.isArray(q.attachments)
        ? q.attachments.length
        : q.attachments;
      if (shots > 0) {
        toast(
          t('assistant.retryTextOnly', {
            defaultValue:
              'Asked again with the text only: screenshots are not sent again.',
          }),
        );
      }
      void latestSend.current({ text: q.question, images: [] });
      // The button unmounts once the answer starts; keep focus on the page.
      dock.current?.querySelector('textarea')?.focus();
    },
    [t],
  );

  // Save tapped on a proposed note or task: only now does the server keep it.
  const saveProposal = useCallback(
    async (key: string, token: string) => {
      const mark = (state: Proposal['state']) =>
        setMessages((prev) =>
          prev.map((m) =>
            m.key === key
              ? {
                  ...m,
                  proposals: m.proposals?.map((p) =>
                    p.token === token ? { ...p, state } : p,
                  ),
                }
              : m,
          ),
        );
      mark('saving');
      try {
        await confirmProposal(token);
        mark('saved');
      } catch (err) {
        const { message, code } = err as Error & { code?: string };
        toast.error(
          code
            ? t(`assistant.err.${code}`, {
                defaultValue: message,
                reason: message,
              })
            : message,
        );
        mark('waiting');
      }
    },
    [t],
  );

  /** The mic: ask one question by voice and hear the answer. A second tap
   *  ends the recording early. */
  const askByVoice = async () => {
    unlockAudio(); // iOS/Safari: audio unlocks only inside the tap, before any await
    if (voice.state === 'listening') {
      voice.stopListening();
      return;
    }
    if (busy || loading || talking.current) return;
    let wav: string | null;
    try {
      wav = await voice.listen(true);
    } catch {
      return; // the mic could not open (already said why)
    }
    if (!wav) {
      if (alive.current) toast(t('assistant.voice.nothingHeard'));
      return;
    }
    voice.setState('thinking');
    const id = await send({ text: '', images: [], audio: wav });
    voice.setState('idle');
    if (id) await voice.speak(id);
  };

  const startTalk = async () => {
    unlockAudio(); // in the tap, before any await (iOS/Safari)
    // listening: the mic's own recording is running or opening
    if (talking.current || busy || loading || voice.state === 'listening')
      return;
    talking.current = true;
    setTalk(true);
    // Three silent turns in a row (about 24 s) end the talk by themselves.
    let silent = 0;
    try {
      while (talking.current && silent < 3) {
        let wav: string | null;
        try {
          wav = await voice.listen(true);
        } catch (err) {
          if (err instanceof MicError) break;
          throw err;
        }
        if (!talking.current) break;
        if (!wav) {
          silent += 1;
          continue;
        }
        silent = 0;
        voice.setState('thinking');
        const id = await send({ text: '', images: [], audio: wav });
        voice.setState('idle');
        // Talking over the answer stops it; the loop then listens at once.
        if (talking.current && id) await voice.speak(id, { bargeIn: true });
      }
      if (silent >= 3) {
        toast(
          t('assistant.voice.talkEndedSilent', {
            defaultValue: 'Talk ended: I didn’t hear anything.',
          }),
        );
      }
    } finally {
      talking.current = false;
      setTalk(false);
      voice.setState('idle');
    }
  };

  const endTalk = () => {
    talking.current = false;
    voice.cancelListening();
    voice.stopSpeaking();
    ctl.current?.abort();
  };

  // Leaving the page ends the talk: its loop would reopen the mic on another
  // page and ask (billed) questions there.
  useEffect(
    () => () => {
      talking.current = false;
    },
    [],
  );

  // Read aloud (or stop) one answer from the thread.
  const { speak: speakAnswer, stopSpeaking, reading } = voice;
  const readAloud = useCallback(
    (id: string) => {
      unlockAudio(); // in the tap, before any await (iOS/Safari)
      if (reading === id) stopSpeaking();
      else void speakAnswer(id);
    },
    [reading, speakAnswer, stopSpeaking],
  );

  const newChat = () => {
    if (busy || talk) return;
    setParams({});
    setMessages([]);
  };

  const remove = async (id: string) => {
    if (busy || !window.confirm(t('assistant.deleteConfirm'))) return;
    try {
      await assistantApi.remove(id);
      if (id === selected) {
        // Talk would ask on in the deleted chat (and newChat refuses during it).
        if (talking.current) endTalk();
        setParams({});
        setMessages([]);
      }
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
                className="text-ui-fg-muted hover:text-ui-fg-error mr-1 rounded p-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
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
      <div className="pc-admin pc-ai-aurora bg-ui-bg-subtle border-ui-border-base flex h-[calc(100dvh-6.5rem)] min-h-[420px] overflow-hidden sm:min-h-[560px] rounded-2xl border">
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
            <button
              type="button"
              onClick={() => (talk ? endTalk() : void startTalk())}
              aria-pressed={talk}
              aria-disabled={!talk && (busy || loading)}
              className={`flex items-center gap-x-1.5 rounded-full border px-3 py-1 text-xs transition-colors aria-disabled:opacity-40 lg:ml-auto ${talk ? 'border-sky-500 bg-sky-500 text-white' : 'border-ui-border-base text-ui-fg-subtle hover:text-ui-fg-base'}`}
            >
              <WaveIcon />
              {talk ? t('assistant.voice.endTalk') : t('assistant.voice.talk')}
            </button>
            {/* An older pod (rolling deploy) may not send the cap yet. */}
            {me.data &&
              typeof me.data.daily_cap_usd === 'number' &&
              me.data.daily_cap_usd > 0 && (
                <SpendMeter
                  spent={me.data.spent_today_usd ?? 0}
                  cap={me.data.daily_cap_usd}
                />
              )}
            {me.data?.chat_model && (
              <span className="border-ui-border-base text-ui-fg-subtle hidden rounded-full border px-2.5 py-0.5 font-mono text-[10.5px] md:inline">
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
              setAway(!stick.current);
            }}
            className="flex flex-1 flex-col overflow-y-auto"
          >
            {messages.length === 0 ? (
              <EmptyState
                me={me.data}
                disabled={loading || voice.state === 'listening'}
                onPick={(text, now) =>
                  now
                    ? void send({ text, images: [] })
                    : setSeed((s) => ({ text, n: (s?.n ?? 0) + 1 }))
                }
              />
            ) : (
              <div ref={content} className="mx-auto w-full max-w-3xl px-5 py-6">
                <Thread
                  messages={messages}
                  onSpeak={talk ? undefined : readAloud}
                  reading={reading}
                  onRetry={retry}
                  onConfirm={saveProposal}
                  canRetry={
                    !busy && !loading && !talk && voice.state === 'idle'
                  }
                />
              </div>
            )}
          </div>

          <div
            ref={dock}
            className="relative mx-auto flex w-full max-w-3xl flex-col gap-y-2 px-5 pb-5 pt-2"
          >
            {/* Scrolled up while an answer streams: one tap back to it. */}
            {busy && away && (
              <button
                type="button"
                onClick={() => {
                  const el = scroller.current;
                  if (!el) return;
                  // Instant: a smooth scroll's in-between events unstick it.
                  stick.current = true;
                  setAway(false);
                  el.scrollTop = el.scrollHeight;
                }}
                className="bg-ui-bg-base border-ui-border-base text-ui-fg-base hover:bg-ui-bg-base-hover absolute -top-10 left-1/2 z-10 flex -translate-x-1/2 items-center gap-x-1 rounded-full border px-3 py-1 text-xs shadow-md"
              >
                <ArrowDownMini />
                {t('assistant.jumpToLatest', {
                  defaultValue: 'Jump to latest',
                })}
              </button>
            )}
            <AnimatePresence>
              {talk && (
                <TalkPanel
                  key="talk"
                  state={voice.state}
                  level={voice.level}
                  caption={
                    voice.state === 'speaking'
                      ? messages.find((m) => m.messageId === voice.reading)
                          ?.content
                      : voice.state === 'thinking'
                        ? // the question (the last is its answer), once heard
                          messages
                            .at(-2)
                            ?.content.replace(t('assistant.voice.hearing'), '')
                        : undefined
                  }
                  onInterrupt={voice.stopSpeaking}
                  onEnd={endTalk}
                />
              )}
            </AnimatePresence>
            <Composer
              busy={busy}
              disabled={loading || talk || voice.state === 'listening'}
              seed={seed}
              autoFocus
              onSend={(text, images) => void send({ text, images })}
              onStop={talk ? endTalk : () => ctl.current?.abort()}
              lastQuestion={
                [...messages].reverse().find((m) => m.question)?.question
              }
              mic={
                talk
                  ? undefined
                  : {
                      listening: voice.state === 'listening',
                      level: voice.level,
                      onClick: () => void askByVoice(),
                    }
              }
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
