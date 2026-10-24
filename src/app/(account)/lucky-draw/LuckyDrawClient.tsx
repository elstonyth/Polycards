'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { pillVariants } from '@/components/ui/pill';
import { Panel, UnavailablePanel } from '@/components/task-ui';
import { TicketArt } from '@/components/TicketArt';
import { cn } from '@/lib/utils';
import { mytDate, num } from '@/lib/format';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { getLuckyDraw, getLuckyDrawResult } from '@/lib/actions/lucky-draw';
import type {
  LuckyDrawPage,
  LuckyDrawPrize,
  LuckyDrawResultDetail,
} from '@/lib/data/schemas';
import { EnterSheet, type Entered } from './EnterSheet';
import { MyTickets } from './MyTickets';
import { PrizeCard } from './PrizeCard';
import { PrizeWheel } from './PrizeWheel';
import { ResultDetail } from './ResultDetail';
import { ResultsList } from './ResultsList';
import { SpinOverlay } from './SpinOverlay';
import { TicketOpenIntro } from './TicketOpenIntro';

type TabKey = 'prizes' | 'results' | 'mine';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'prizes', label: 'Prizes' },
  { key: 'results', label: 'Results' },
  { key: 'mine', label: 'My tickets' },
];

// The spin moment (spec §10): from a prize's draw time until its result
// appears (or 5 minutes pass), the cheap per-prize result read is polled —
// never the whole page — every 5 s plus 0–2 s of jitter, so open tabs do not
// hit the draw minute in lockstep. One prize per tick, the one polled least
// recently, so a prize stuck undrawn cannot starve others sharing its draw
// time. When a prize's window closes without a result, the page is re-read
// once, so a tab left open does not say "Drawing…" forever.
const POLL_MS = 5000;
const POLL_JITTER_MS = 2000;
const POLL_WINDOW_MS = 5 * 60_000;

/** The /lucky-draw page: Prizes, Results and My tickets. */
export function LuckyDrawClient({
  initial,
  intro,
}: {
  initial: LuckyDrawPage | null;
  /** ?open=1 from the vault's tickets row: play the ticket intro once. */
  intro: boolean;
}) {
  const reduced = usePrefersReducedMotion();
  const [page, setPage] = useState(initial);
  const [tab, setTab] = useState<TabKey>('prizes');
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [entering, setEntering] = useState<LuckyDrawPrize | null>(null);
  const [detail, setDetail] = useState<LuckyDrawResultDetail | null>(null);
  const [spins, setSpins] = useState<LuckyDrawResultDetail[]>([]);
  const [playIntro, setPlayIntro] = useState(intro);
  const endIntro = useCallback(() => setPlayIntro(false), []);
  const pageRef = useRef(page);

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  // Mount-only clock: the server cannot know the viewer's clock, so the
  // countdowns render after hydration (ResetCountdown's rule).
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, []);

  // Drop ?open=1 so a refresh does not replay the intro.
  useEffect(() => {
    if (intro) window.history.replaceState(null, '', '/lucky-draw');
  }, [intro]);

  useEffect(() => {
    let live = true;
    let timer = 0;
    const polledAt = new Map<string, number>();
    const reread = new Set<string>();
    const poll = async () => {
      const now = Date.now();
      const undrawn = (pageRef.current?.prizes ?? []).filter((p) => !p.result);
      const lapsed = undrawn.filter(
        (p) =>
          !reread.has(p.id) && now >= Date.parse(p.draw_at) + POLL_WINDOW_MS,
      );
      if (lapsed.length > 0) {
        lapsed.forEach((p) => reread.add(p.id));
        const fresh = await getLuckyDraw();
        if (live && fresh) setPage(fresh);
        return;
      }
      const due = undrawn
        .filter((p) => {
          const at = Date.parse(p.draw_at);
          return now >= at && now < at + POLL_WINDOW_MS;
        })
        .sort(
          (a, b) => (polledAt.get(a.id) ?? 0) - (polledAt.get(b.id) ?? 0),
        )[0];
      if (due) {
        polledAt.set(due.id, now);
        const found = await getLuckyDrawResult(due.id);
        if (!live) return;
        if (found) {
          setPage(
            (prev) =>
              prev && {
                ...prev,
                prizes: prev.prizes.map((p) =>
                  p.id === found.result.prize_id
                    ? { ...p, result: found.result }
                    : p,
                ),
              },
          );
          // No entries: nothing to spin; the card shows it.
          if (found.ticket_index != null) setSpins((q) => [...q, found]);
        }
      }
    };
    const tick = async () => {
      // A failed read (network, deploy) must not end the polling.
      await poll().catch(() => undefined);
      if (live) {
        timer = window.setTimeout(
          tick,
          POLL_MS + Math.random() * POLL_JITTER_MS,
        );
      }
    };
    timer = window.setTimeout(tick, POLL_MS + Math.random() * POLL_JITTER_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, []);

  const openResult = async (prizeId: string) => {
    const found = await getLuckyDrawResult(prizeId);
    if (found) setDetail(found);
    else setNotice('Couldn’t load this result right now — try again.');
  };

  const onEntered = (prize: LuckyDrawPrize, tickets: number, res: Entered) => {
    setEntering(null);
    setNotice(
      `You’re in — ${num(tickets)} ${tickets === 1 ? 'ticket' : 'tickets'} on ${prize.title}.`,
    );
    const { balance, myTickets } = res;
    if (balance === undefined || myTickets === undefined) {
      // The entry went through but its numbers did not read: re-read.
      void getLuckyDraw().then((fresh) => fresh && setPage(fresh));
      return;
    }
    // Update locally from the enter response; the page is not re-fetched.
    setPage(
      (prev) =>
        prev && {
          ...prev,
          balance,
          prizes: prev.prizes.map((p) =>
            p.id === prize.id
              ? {
                  ...p,
                  my_tickets: myTickets,
                  total_tickets: p.total_tickets + tickets,
                  entrant_count: p.entrant_count + (p.my_tickets > 0 ? 0 : 1),
                }
              : p,
          ),
        },
    );
  };

  const balance = page?.balance ?? 0;
  const event = page?.event ?? null;

  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-heading text-3xl text-white">LUCKY DRAW</h1>
          {event && (
            <p className="mt-1 text-sm text-neutral-400">
              {event.name} · until {mytDate(event.ends_at)}
            </p>
          )}
        </div>
        {page && (
          <p className="flex shrink-0 items-center gap-1.5 rounded-full bg-neutral-800 py-2 pr-3.5 pl-3 text-sm font-semibold text-white">
            <TicketArt width={26} className="-my-1" />
            <span className="tabular-nums">{num(balance)}</span>
            <span className="sr-only">tickets</span>
          </p>
        )}
      </div>

      <div
        role="group"
        aria-label="Lucky Draw sections"
        className="mt-4 grid grid-cols-3 gap-1 rounded-full border border-white/10 bg-neutral-900 p-1"
      >
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              'flex min-h-11 items-center justify-center rounded-full px-2 text-[13px] font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/40 sm:text-sm',
              tab === key
                ? 'bg-neutral-50 text-neutral-950'
                : 'text-neutral-400 hover:text-white',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Always mounted: a live region added with its text is not announced. */}
      <div aria-live="polite">
        {notice && (
          <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-neutral-300">
            {notice}
          </p>
        )}
      </div>

      <div className="mt-4">
        {tab === 'results' ? (
          <ResultsList onOpen={openResult} />
        ) : tab === 'mine' ? (
          <MyTickets />
        ) : !page ? (
          <UnavailablePanel />
        ) : !event ? (
          <Panel className="text-center">
            <p className="text-sm text-neutral-300">
              The next Lucky Draw is coming soon.
            </p>
            <button
              type="button"
              onClick={() => setTab('results')}
              className={cn(
                pillVariants({ variant: 'secondary', size: 'sm' }),
                'mt-3',
              )}
            >
              See past results
            </button>
          </Panel>
        ) : (
          <>
            {balance <= 0 && (
              <Panel className="mb-4 flex items-center gap-3">
                <TicketArt width={44} className="shrink-0" />
                <p className="flex-1 text-sm text-neutral-300">
                  Earn tickets from tasks
                </p>
                <Link
                  href="/task"
                  className={pillVariants({ variant: 'primary', size: 'sm' })}
                >
                  Tasks
                </Link>
              </Panel>
            )}
            {page.prizes.length === 0 ? (
              <p className="text-sm text-neutral-400">
                Prizes for this Lucky Draw are on their way.
              </p>
            ) : (
              <PrizeWheel
                prizes={page.prizes}
                nowMs={nowMs}
                details={(p) => (
                  <ul aria-label="Selected prize">
                    <PrizeCard
                      key={p.id}
                      prize={p}
                      nowMs={nowMs}
                      opensAt={event.starts_at}
                      balance={balance}
                      onEnter={setEntering}
                      onOpenResult={openResult}
                      art={false}
                    />
                  </ul>
                )}
              />
            )}
          </>
        )}
      </div>

      <p className="mt-6 text-xs leading-relaxed text-neutral-400">
        Tickets come from tasks and Polycards gifts — they can&rsquo;t be
        bought. Entering needs at least one top-up, and entries are final. Card
        prizes go to your vault and sell back like task rewards; credit prizes
        are bonus credit for packs. Every winner is drawn from a seed fixed
        before entries open, so anyone can check it. All times are Malaysia time
        (MYT).
      </p>

      {entering && (
        <EnterSheet
          prize={entering}
          balance={balance}
          onClose={() => setEntering(null)}
          onEntered={onEntered}
        />
      )}
      {detail && (
        <ResultDetail
          detail={detail}
          onClose={() => setDetail(null)}
          onReplay={(d) => {
            setDetail(null);
            setSpins([d]);
          }}
        />
      )}
      {/* A live draw waits, queued, while the player is in a sheet. */}
      {spins[0] && !entering && !detail && (
        <SpinOverlay
          detail={spins[0]}
          queued={spins.length - 1}
          onNext={() => setSpins((q) => q.slice(1))}
          onClose={() => setSpins([])}
        />
      )}
      {/* After hydration only (nowMs is mount-only): server HTML must never
          ship a full-screen scrim, and reduced motion is known by then. */}
      {playIntro && !reduced && nowMs !== null && (
        <TicketOpenIntro onDone={endIntro} />
      )}
    </div>
  );
}
