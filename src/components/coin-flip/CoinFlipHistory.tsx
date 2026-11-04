'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState, type CSSProperties } from 'react';
import { Clock } from 'lucide-react';
import { getCoinFlipFeed, getCoinFlipHistory } from '@/lib/actions/coin-flip';
import type {
  CoinFlipFeedRound,
  CoinFlipHistory as History,
  CoinFlipRound,
} from '@/lib/coin-flip';
import {
  coinFlipTicketsLabel,
  coinSideLabel,
  type CoinSide,
} from '@/lib/coin-flip';
import { num, pullTime, rm } from '@/lib/format';
import { isOptimizableImage } from '@/lib/optimizable-image';
import { cn } from '@/lib/utils';
import { FramedAvatar } from '@/components/FramedAvatar';
import { TicketArt } from '@/components/TicketArt';
import { avatarForSeed } from '@/lib/avatar-seed';
import { Pill } from '@/components/ui/pill';
import { StaticCoin } from './StaticCoin';
import { TicketCount } from './TicketCount';

/**
 * The customer's own flips, in the pack page's Recent Pulls language
 * (PullHistory.tsx): tiles for how the coin landed, a strip of how the
 * rows shown landed, and rows of the same shape. The coin they called sits where a pack row has its avatar,
 * and the cards they put in sit where it has the slab.
 *
 * Color obeys the Signal Rule: chrome is neutral and only a win takes green. A
 * loss stays hairline-neutral with its cards dimmed, because they are gone.
 */
const VIEWS = [
  { id: 'everyone', label: 'Everyone' },
  { id: 'mine', label: 'Mine' },
] as const;
type View = (typeof VIEWS)[number]['id'];
// The Everyone view has no count or tally, and shows its latest rows unpaged.
type Shown = {
  rounds: (CoinFlipRound | CoinFlipFeedRound)[];
  count: number;
  totals: History['totals'] | null;
};
const segment = (on: boolean) =>
  cn(
    'flex min-h-10 items-center justify-center gap-1 rounded-full px-1 text-[12px] font-semibold transition-colors disabled:opacity-50',
    'outline-none focus-visible:ring-2 focus-visible:ring-white/40',
    on ? 'bg-neutral-50 text-neutral-950' : 'text-neutral-400 hover:text-white',
  );

// Latest results (owner 2026-11-04, a plain take on a baccarat bead plate): how
// each flip in the list below landed, in one row with the newest at the right,
// drawn bigger so it reads as the latest. Head and Tail are not outcomes, so
// neither takes green: Head is a solid bead, Tail an outlined one.
function Bead({
  side,
  size = 'md',
}: {
  side: CoinSide;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-bold leading-none',
        size === 'sm' && 'size-4 text-[9px]',
        size === 'md' && 'size-7 text-[11px]',
        size === 'lg' && 'size-10 text-sm',
        side === 'head'
          ? 'bg-neutral-100 text-neutral-950'
          : 'text-white ring-1 ring-white/45 ring-inset',
      )}
    >
      {side === 'head' ? 'H' : 'T'}
    </span>
  );
}

function LatestResults({ rounds }: { rounds: Shown['rounds'] }) {
  // Rows come newest first; the strip reads oldest to newest.
  const sides = rounds.flatMap((round) => round.landed_side ?? []).reverse();
  if (sides.length === 0) return null;
  return (
    <div className="rounded-2xl border border-white/10 bg-neutral-900 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <p className="text-sm font-semibold text-white">
          Latest results{' '}
          <span className="text-[12px] font-normal text-neutral-400">
            · newest on the right
          </span>
        </p>
        <p className="flex items-center gap-3 text-[12px] text-neutral-400">
          <span className="flex items-center gap-1.5">
            <Bead side="head" size="sm" />
            Head
          </span>
          <span className="flex items-center gap-1.5">
            <Bead side="tail" size="sm" />
            Tail
          </span>
        </p>
      </div>
      <div
        role="img"
        aria-label={`Latest results, oldest to newest: ${sides.map(coinSideLabel).join(', ')}`}
        // One row, packed to the right. On a phone the oldest beads run off the
        // left edge and fade; the list below holds every flip.
        className="flex items-center justify-end gap-1.5 overflow-hidden [mask-image:linear-gradient(to_left,black_80%,transparent)] @3xl:justify-start @3xl:[mask-image:none]"
      >
        {sides.map((side, i) => (
          <Bead
            key={i}
            side={side}
            size={i === sides.length - 1 ? 'lg' : 'md'}
          />
        ))}
      </div>
    </div>
  );
}

function OutcomeBadge({ won }: { won: boolean }) {
  return (
    <span
      className={cn(
        'rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wide',
        won ? 'bg-buyback-fg text-neutral-950' : 'bg-neutral-700 text-white',
      )}
    >
      {won ? 'Won' : 'Lost'}
    </span>
  );
}

function LandedTile({ side, count }: { side: CoinSide; count: number }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-2xl border border-white/10 bg-neutral-900 px-4 py-3">
      <div className="min-w-0">
        <p className="font-heading text-3xl leading-none text-white tabular-nums">
          <span
            key={count}
            className="pull-row-in inline-block motion-reduce:animate-none"
          >
            {count}
          </span>
        </p>
        <p className="mt-2 text-[12px] text-neutral-400">
          Landed {coinSideLabel(side)}
        </p>
      </div>
      <StaticCoin side={side} className="size-10 shrink-0" />
    </div>
  );
}

// Front card first. The rest peek out behind it, so a bundle reads as a stack.
const STACK = [
  'right-0 z-20',
  'right-1.5 z-10 brightness-75',
  'right-3 brightness-50',
];

function StakedCards({ round, won }: { round: CoinFlipRound; won: boolean }) {
  const more = round.cards.length - 1;
  return (
    // Fixed width: the front card and the name beside it hold the same x on
    // every row, whether it staked one card or twenty.
    <span className="relative isolate h-[3.8rem] w-12 shrink-0">
      {round.cards.slice(0, STACK.length).map((card, i) => (
        <span
          key={card.pull_id}
          className={cn(
            'absolute top-0 aspect-[16/27] w-9',
            STACK[i],
            !won && 'opacity-60 saturate-50',
          )}
        >
          <Image
            src={card.image || '/images/app/polycards-card-back.webp'}
            alt=""
            fill
            sizes="36px"
            unoptimized={!isOptimizableImage(card.image || '/')}
            className="object-contain"
          />
        </span>
      ))}
      {more > 0 && (
        <span className="absolute right-0.5 bottom-0.5 z-30 rounded-full bg-neutral-950/90 px-1 py-0.5 text-[10px] font-bold leading-none text-white tabular-nums ring-1 ring-white/20">
          +{more}
        </span>
      )}
    </span>
  );
}

function StakedTickets({ tickets, won }: { tickets: number; won: boolean }) {
  return (
    <span className="relative isolate flex h-[3.8rem] w-12 shrink-0 items-center justify-center">
      <TicketArt
        width={48}
        className={cn('h-auto w-12', !won && 'opacity-60 saturate-50')}
      />
      <span className="absolute right-0 bottom-1 rounded-full bg-neutral-950/90 px-1 py-0.5 text-[10px] font-bold leading-none text-white tabular-nums ring-1 ring-white/20">
        ×{tickets}
      </span>
    </span>
  );
}

function Row({
  round,
  paused,
  onOpen,
}: {
  round: CoinFlipRound | CoinFlipFeedRound;
  paused: boolean;
  onOpen?: (id: string) => void;
}) {
  // Set on the Everyone view: another player's flip, whose receipt is private.
  const player = 'who' in round ? round : null;
  const won = round.status === 'won';
  const called = coinSideLabel(round.chosen_side);
  const when = round.settled_at ? pullTime(round.settled_at) : '';
  const more = round.cards.length - 1;
  const cards = more === 0 ? 'card' : 'cards';
  // An aria-label REPLACES the content, so it carries everything the row shows.
  const hasCards = round.cards.length > 0;
  const staked = coinFlipTicketsLabel(round.tickets);
  const label = [
    `Called ${called}`,
    ...(hasCards
      ? [
          won
            ? `won ${rm(round.win_amount)}, ${cards} kept`
            : `lost, ${cards} worth ${rm(round.stake_amount)} forfeited`,
          round.card?.name + (more ? ` and ${more} more` : ''),
        ]
      : []),
    ...(round.tickets > 0
      ? [won ? `won ${staked}` : `lost, ${staked} gone`]
      : []),
    when,
  ].join(', ');
  const shell = cn(
    'flex w-full items-center gap-2 rounded-xl border bg-neutral-900 px-3 py-2.5 @sm:gap-3',
    won
      ? 'border-buyback-fg/45 shadow-[0_0_24px_-10px_rgba(47,191,110,0.55)]'
      : 'border-white/10',
  );
  const content = (
    <>
      {player ? (
        <FramedAvatar
          src={
            player.avatar_url ??
            (player.seed != null ? avatarForSeed(player.seed) : null)
          }
          initial={player.who.charAt(0).toUpperCase() || '?'}
          frameSrc={player.frame_url}
          size={36}
        />
      ) : (
        <StaticCoin
          side={round.chosen_side}
          className="size-8 shrink-0 @sm:size-10"
        />
      )}
      {/* Wraps rather than truncates, as a pack row does: a clipped call or time
          reads as broken, two short lines don't. */}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="text-sm font-semibold text-white [overflow-wrap:anywhere]">
            {player ? player.who : `Called ${called}`}
          </span>
          <OutcomeBadge won={won} />
        </span>
        {round.settled_at && (
          <span className="mt-0.5 block text-[12px] text-neutral-400 tabular-nums">
            {player && `Called ${called} · `}
            <time dateTime={round.settled_at}>{when}</time>
          </span>
        )}
      </span>
      {hasCards ? (
        <StakedCards round={round} won={won} />
      ) : (
        <StakedTickets tickets={round.tickets} won={won} />
      )}
      <span className="flex w-[6.5rem] shrink-0 flex-col items-end gap-1 @xs:w-[7.25rem] @sm:w-[7.75rem]">
        <span className="line-clamp-2 max-w-full text-right text-[11px] leading-tight text-neutral-300 [overflow-wrap:anywhere]">
          {hasCards ? round.card?.name : 'Lucky Draw tickets'}
        </span>
        {/* Never an RM minus: a loss takes cards or tickets, not Credit. Struck
            through, it reads as what left the Vault. A very large bundle wraps
            here rather than spilling over the cards. */}
        <span
          className={cn(
            'max-w-full text-right font-heading text-[13px] leading-tight tabular-nums [overflow-wrap:anywhere] @xs:text-[15px] @sm:text-base',
            won
              ? 'text-buyback-fg'
              : 'text-neutral-400 line-through decoration-neutral-500 decoration-1',
          )}
        >
          {!hasCards
            ? `${won ? '+' : ''}${num(round.tickets)}`
            : won
              ? `+${rm(round.win_amount)}`
              : rm(round.stake_amount)}
        </span>
        {hasCards && round.tickets > 0 && (
          <span
            className={cn(
              'text-right text-xs leading-none tabular-nums',
              won ? 'text-buyback-fg' : 'text-neutral-400',
            )}
          >
            {won ? '+' : ''}
            <TicketCount tickets={round.tickets} lost={!won} />
          </span>
        )}
      </span>
    </>
  );
  if (player) return <div className={shell}>{content}</div>;
  return (
    <Link
      href={`/vault/coin-flip?round=${encodeURIComponent(round.id)}`}
      aria-label={label}
      aria-disabled={paused || undefined}
      tabIndex={paused ? -1 : undefined}
      onClick={(event) => {
        if (paused) event.preventDefault();
        else if (
          onOpen &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          onOpen(round.id);
        }
      }}
      className={cn(
        shell,
        // A row cannot open while a toss is in the air: its result comes first.
        paused && 'pointer-events-none',
        'outline-none focus-visible:ring-2 focus-visible:ring-white/40',
        'transition-[background-color,transform] hover:bg-neutral-800 active:scale-[0.99]',
        'motion-reduce:transition-none motion-reduce:active:scale-100',
      )}
    >
      {content}
    </Link>
  );
}

export function CoinFlipHistory({
  refresh = 0,
  paused = false,
  onOpen,
  everyone = false,
}: {
  refresh?: number;
  paused?: boolean;
  /** Opens a row without leaving the page. Without it, a row is a plain link. */
  onOpen?: (id: string) => void;
  /** Adds every player's latest flips, shown first (owner 2026-11-04). */
  everyone?: boolean;
}) {
  const [view, setView] = useState<View>(everyone ? 'everyone' : 'mine');
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState<Shown | null>(null);
  // Which view and page the rows on screen belong to. The list re-enters once,
  // when the new rows land, and dims while they are on their way.
  const [shownScope, setShownScope] = useState('');
  const [error, setError] = useState('');
  // Bumped every 10s while Everyone is on screen, so it refetches in place.
  const [tick, setTick] = useState(0);
  const scope = `${view}:${page}`;
  useEffect(() => {
    if (paused) return;
    let active = true;
    const load: Promise<({ ok: true } & Shown) | { ok: false }> =
      view === 'everyone'
        ? getCoinFlipFeed().then((result) =>
            result.ok
              ? { ...result, count: result.rounds.length, totals: null }
              : result,
          )
        : getCoinFlipHistory(page);
    load
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setHistory(result);
          setShownScope(scope);
          setError('');
        } else setError('Could not load coin flip history.');
      })
      .catch(() => {
        if (active) setError('Could not load coin flip history.');
      });
    return () => {
      active = false;
    };
  }, [view, page, scope, refresh, paused, tick]);
  useEffect(() => {
    if (view !== 'everyone' || paused) return;
    const id = setInterval(() => {
      if (!document.hidden) setTick((n) => n + 1);
    }, 10_000);
    return () => clearInterval(id);
  }, [view, paused]);
  const pending = shownScope !== scope;
  const [shownView] = shownScope.split(':');
  return (
    <section
      aria-label="Coin flip history"
      className="@container mt-10 flex flex-col gap-4 border-t border-white/10 pt-6"
    >
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-white/50" aria-hidden />
        <h2 className="font-heading text-lg font-bold tracking-tight text-white">
          Coin flip history
        </h2>
      </div>
      {everyone && (
        <div
          role="group"
          aria-label="Whose flips"
          className="grid grid-cols-2 gap-1 rounded-full border border-white/10 bg-neutral-900 p-1 @2xl:max-w-xs"
        >
          {VIEWS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              disabled={paused}
              onClick={() => {
                setView(id);
                setPage(1);
              }}
              className={segment(view === id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {view === 'mine' &&
        history?.totals &&
        history.totals.head + history.totals.tail > 0 && (
          <div className="grid grid-cols-2 gap-3">
            <LandedTile side="head" count={history.totals.head} />
            <LandedTile side="tail" count={history.totals.tail} />
          </div>
        )}
      {/* Not over an error: the rows it describes are gone from view. */}
      {history && !error && <LatestResults rounds={history.rounds} />}
      {error ? (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      ) : !history ? (
        <p role="status" className="py-6 text-sm text-neutral-400">
          Loading flips…
        </p>
      ) : (
        <div
          aria-busy={pending}
          className={cn(
            'transition-opacity duration-300',
            pending && 'opacity-50',
          )}
        >
          {history.rounds.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-10 text-center text-[13px] text-white/60">
              {shownView === 'everyone'
                ? 'No flips yet.'
                : 'Your completed flips will appear here.'}
            </div>
          ) : (
            // Rows keep their keys, so a new flip drops in alone and the rest
            // never re-run. grid-cols-1: an implicit auto column would grow to
            // the rows' nowrap width and pan the whole page sideways on phones.
            <ol
              key={shownScope}
              className="grid grid-cols-1 gap-2 @3xl:grid-cols-2"
            >
              {history.rounds.map((round, i) => (
                <li
                  key={round.id}
                  className="pull-row-in motion-reduce:animate-none"
                  style={{ '--i': i } as CSSProperties}
                >
                  <Row round={round} paused={paused} onOpen={onOpen} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {history &&
        view === 'mine' &&
        shownView === 'mine' &&
        history.count > 10 && (
          <div className="flex items-center justify-between gap-3">
            <Pill
              variant="secondary"
              disabled={paused || pending || page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Pill>
            <span className="text-sm text-neutral-400">
              {page} / {Math.ceil(history.count / 10)}
            </span>
            <Pill
              variant="secondary"
              disabled={paused || pending || page * 10 >= history.count}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Pill>
          </div>
        )}
    </section>
  );
}
