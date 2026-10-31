'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Pill, pillVariants } from '@/components/ui/pill';
import { TicketArt } from '@/components/TicketArt';
import { cn } from '@/lib/utils';
import { num, rmAuto } from '@/lib/format';
import {
  chancePercent,
  drawCountdown,
  heroFirst,
  heroPrize,
  poolDay,
  poolLength,
  poolWhen,
  potTotal,
} from '@/lib/lucky-draw';
import type {
  LuckyDrawEventResult,
  LuckyDrawPage,
  LuckyDrawPrize,
} from '@/lib/data/schemas';
import type { EnterTarget } from './EnterSheet';
import { HowItWorks } from './HowItWorks';
import {
  PassDates,
  PoolClock,
  PoolPass,
  PoolShelf,
  PrizeZoom,
  type PoolPrize,
} from './PoolParts';
import { PersonChip, TopEntrants } from './PrizeCard';

type LuckyDrawEvent = NonNullable<LuckyDrawPage['event']>;
type NextEvent = NonNullable<LuckyDrawPage['next_event']>;

/** The event as the enter sheet reads a prize: the event's id and name, the
 *  hero's art, the pot's value and the event's tickets. */
export function potTarget(
  event: LuckyDrawEvent,
  prizes: LuckyDrawPrize[],
): EnterTarget {
  const hero = heroPrize(prizes);
  return {
    id: event.id,
    title: event.name,
    image: hero?.image ?? null,
    kind: hero?.kind ?? 'card',
    value_myr: potTotal(prizes),
    my_tickets: event.my_tickets,
    total_tickets: event.total_tickets,
  };
}

const prizeCount = (n: number) => `${num(n)} ${n === 1 ? 'prize' : 'prizes'}`;

const winnerTakes = (n: number) =>
  n === 1 ? 'One winner takes it.' : `One winner takes all ${num(n)} prizes.`;

/** The pool's status and its length, across the top of the stub. A phone on its
 *  side spends that line on the clock instead. */
function StubTop({
  status,
  live = false,
  length,
}: {
  status: string;
  live?: boolean;
  length?: string | null;
}) {
  return (
    <div className="flex items-center justify-between gap-3 short:hidden">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-neutral-950 px-3 py-1 text-xs font-semibold text-white">
        {live && (
          <span
            aria-hidden
            className="pool-pulse h-1.5 w-1.5 rounded-full bg-neutral-50"
          />
        )}
        {status}
      </span>
      {length && <span className="text-xs font-semibold">{length} pool</span>}
    </div>
  );
}

/** The pool's name and what it is worth, across the top of the dark half. */
function PoolWorth({
  name,
  prizes,
  caption,
}: {
  name: string;
  prizes: PoolPrize[];
  caption?: string;
}) {
  return (
    <div>
      {/* Off the smallest phones' first screen, so the total fits on it. */}
      <h2 className="text-sm font-semibold text-neutral-300 [@media(max-height:37.5rem)_and_(max-width:39.99rem)]:sr-only">
        {name}
      </h2>
      {/* No prizes to add up: a next pool read from a backend still deploying. */}
      {prizes.length > 0 && (
        <>
          <p className="font-heading mt-1 text-[clamp(1.6rem,8.2vw,2rem)] leading-none text-chase tabular-nums sm:text-[2.5rem] lg:text-[clamp(2.25rem,3vw,3rem)]">
            {rmAuto(potTotal(prizes))}
          </p>
          <p className="mt-1.5 text-sm text-white">
            {caption ?? winnerTakes(prizes.length)}
          </p>
        </>
      )}
    </div>
  );
}

/** The clock and the dates: one above the other where the stub is narrow, side
 *  by side across the wide stub of a tablet or a phone on its side. Centred in
 *  the tall stub of a desktop, and held in view when a long pool makes the stub
 *  taller than the window. */
function StubTime({ children }: { children: React.ReactNode }) {
  return (
    <div className="short:grid short:grid-cols-[minmax(0,1fr)_auto] short:items-end short:gap-6 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:gap-6 lg:sticky lg:top-20 lg:my-auto lg:block">
      {children}
    </div>
  );
}

/** The pool's one action: docked over the tab bar on a phone (the pack page's
 *  buy bar), set into the stub on a desktop, and on a phone on its side, where a
 *  docked bar would leave no page to read. Set in, it sticks to the bottom of the
 *  window while the stub runs past it, so it is never below the fold. Except
 *  under 340px tall (the smallest phones sideways), where sticking would cover
 *  the clock, and a short scroll is the better trade. */
function PoolAction({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="px-fluid fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 flex items-center gap-3 border-t border-white/10 bg-neutral-950 py-2.5 squat:py-2 short:sticky short:bottom-[calc(4.25rem+env(safe-area-inset-bottom))] short:mt-2 [@media(max-height:21.25rem)]:static short:rounded-2xl short:border-0 short:px-3 short:py-1.5 lg:sticky lg:bottom-3 lg:flex-col lg:items-stretch lg:rounded-2xl lg:border-0 lg:p-4 xl:flex-row xl:items-center xl:px-3 xl:py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-white tabular-nums">{title}</p>
        {sub && (
          <p className="mt-0.5 text-xs text-neutral-400 max-[359px]:hidden short:hidden xl:hidden">
            {sub}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

const ACTION_PILL = 'shrink-0 squat:h-11 short:h-10 max-[340px]:px-4';
const EARN_TICKETS = cn(
  pillVariants({ variant: 'primary', size: 'lg' }),
  ACTION_PILL,
);

/** Dark pills, for the pale stub. */
const INK_PILL = 'bg-neutral-950 text-white hover:bg-neutral-800';
const INK_PILL_QUIET =
  'border border-neutral-950/30 bg-transparent text-neutral-950 hover:bg-neutral-950/10';

/** Where the player stands in this pool: under the prizes, or printed on the
 *  stub (`ink`) on a wide desktop, where the stub has the room and the prizes
 *  want the height. */
function PoolLedger({
  event,
  ink = false,
}: {
  event: LuckyDrawEvent;
  ink?: boolean;
}) {
  const rows = [
    ['Your tickets', num(event.my_tickets)],
    ['Your chance', chancePercent(event.my_tickets, event.total_tickets)],
    ['All tickets', num(event.total_tickets)],
    ['Entrants', num(event.entrant_count)],
  ];
  return (
    <dl
      className={cn(
        'grid grid-cols-2 gap-x-4 gap-y-3 border-t',
        ink
          ? 'mt-3 hidden border-neutral-950/15 pt-3 xl:grid'
          : 'mt-5 border-white/10 pt-4 sm:grid-cols-4 xl:hidden',
      )}
    >
      {rows.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt
            className={cn(
              'text-xs',
              ink ? 'text-neutral-700' : 'text-neutral-400',
            )}
          >
            {label}
          </dt>
          <dd
            className={cn(
              'font-heading mt-0.5 text-[clamp(0.95rem,4.6vw,1.125rem)] leading-tight [overflow-wrap:anywhere] tabular-nums',
              !ink && 'text-white',
            )}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The next pool as a smaller, plain pass: when it opens and everything in it,
 *  or a line saying it has not been set yet. */
function UpNext({
  next,
  nowMs,
  onZoom,
}: {
  next: LuckyDrawPage['next_event'];
  nowMs: number | null;
  onZoom: (prize: PoolPrize) => void;
}) {
  if (!next) {
    return (
      <section className="rounded-[20px] border border-dashed border-white/15 p-4">
        <h2 className="font-heading text-[22px] leading-tight text-white">
          Next pool
        </h2>
        <p className="mt-1 text-sm text-neutral-400">
          It shows here as soon as it is set. Tickets you keep carry over to it.
        </p>
      </section>
    );
  }
  const prizes = heroFirst(next.prizes);
  const length = poolLength(next.starts_at, next.ends_at);
  return (
    <section
      aria-label={`Next pool: ${next.name}`}
      className="@container rounded-[20px] border border-white/10 bg-neutral-900"
    >
      {/* Its own width decides, not the screen's: it is a column on a desktop. */}
      <div className="@3xl:grid @3xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h2 className="font-heading text-[22px] leading-tight text-white">
              Next pool
            </h2>
            {nowMs != null && (
              <span className="rounded-full bg-neutral-800 px-3 py-1 text-xs font-semibold text-white tabular-nums">
                {nowMs < Date.parse(next.starts_at)
                  ? `Opens in ${drawCountdown(next.starts_at, nowMs)}`
                  : 'Opening now…'}
              </span>
            )}
          </div>
          <p className="mt-2 text-base font-semibold text-white">{next.name}</p>
          <p className="mt-0.5 text-xs text-neutral-300">
            {length && `${length} pool. `}Opens{' '}
            {poolWhen(next.starts_at, nowMs)}.
          </p>
          {prizes.length > 0 && (
            <p className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="font-heading text-2xl leading-none text-chase tabular-nums">
                {rmAuto(potTotal(prizes))}
              </span>
              <span className="text-xs text-neutral-300">
                {prizeCount(prizes.length)}, one winner
              </span>
            </p>
          )}
        </div>
        {prizes.length > 0 && (
          <>
            <div aria-hidden className="pool-perf @3xl:hidden" />
            <div className="p-4 @3xl:border-l @3xl:border-dashed @3xl:border-white/15">
              <PoolShelf prizes={prizes} onZoom={onZoom} compact />
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/** Under the pass: the next pool and who has the most tickets in this one. */
function AfterPass({
  event,
  next,
  nowMs,
  onZoom,
}: {
  event: LuckyDrawEvent;
  next: LuckyDrawPage['next_event'];
  nowMs: number | null;
  onZoom: (prize: PoolPrize) => void;
}) {
  return (
    <div className="space-y-6 lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-6 lg:space-y-0">
      <UpNext next={next} nowMs={nowMs} onZoom={onZoom} />
      <TopEntrants
        top={event.top}
        totalTickets={event.total_tickets}
        className="rounded-[20px] border border-white/10 bg-neutral-900 p-4"
      />
    </div>
  );
}

/** The result on the page after the draw: the winner on the stub, the whole pool
 *  they took under it, then what is next. No spin here: a result that arrives
 *  live spins on its own; this one offers the replay. */
function DrawnPool({
  event,
  result,
  prizes,
  next,
  nowMs,
  onOpenResult,
  onWatch,
  onZoom,
}: {
  event: LuckyDrawEvent;
  result: LuckyDrawEventResult;
  prizes: LuckyDrawPrize[];
  next: LuckyDrawPage['next_event'];
  nowMs: number | null;
  onOpenResult: () => void;
  onWatch: () => void;
  onZoom: (prize: PoolPrize) => void;
}) {
  const shown = heroFirst(prizes);
  return (
    <div className="space-y-6">
      <PoolPass
        stub={
          <>
            <StubTop status="Drawn" />
            <div className="sm:flex sm:items-end sm:justify-between sm:gap-6 lg:sticky lg:top-20 lg:my-auto lg:block">
              <div className="min-w-0">
                {result.winner ? (
                  <>
                    <p className="mt-4 text-sm font-semibold">
                      Won {poolWhen(result.drawn_at, nowMs)} by
                    </p>
                    <PersonChip
                      person={result.winner}
                      size={44}
                      className="font-heading mt-2 text-[28px] leading-tight"
                    />
                    <p className="mt-2 text-xs text-neutral-800 tabular-nums">
                      Held {num(result.winner_tickets)} of{' '}
                      {num(result.total_tickets)} tickets ·{' '}
                      {num(result.entrant_count)}{' '}
                      {result.entrant_count === 1 ? 'entrant' : 'entrants'}
                    </p>
                  </>
                ) : (
                  <p className="font-heading mt-4 text-[28px] leading-tight">
                    Nobody put tickets in
                  </p>
                )}
                {event.my_tickets > 0 && (
                  <p className="mt-1 text-xs text-neutral-800 tabular-nums">
                    You put in {num(event.my_tickets)}{' '}
                    {event.my_tickets === 1 ? 'ticket' : 'tickets'}.
                  </p>
                )}
              </div>
              {/* The tall stub on a desktop has room; a phone has the time above. */}
              <div className="hidden lg:block">
                <PassDates
                  startsAt={event.starts_at}
                  endsAt={event.ends_at}
                  nowMs={nowMs}
                  startLabel="Opened"
                  endLabel="Closed"
                />
                <PoolLedger event={event} ink />
              </div>
              <div className="mt-4 flex shrink-0 flex-wrap gap-2">
                {result.winner && (
                  <Pill size="sm" className={INK_PILL} onClick={onWatch}>
                    Watch the draw
                  </Pill>
                )}
                <Pill
                  size="sm"
                  className={INK_PILL_QUIET}
                  onClick={onOpenResult}
                >
                  See result
                </Pill>
              </div>
            </div>
          </>
        }
      >
        <PoolWorth
          name={event.name}
          prizes={shown}
          caption={
            result.winner
              ? `${shown.length === 1 ? 'The prize' : `All ${num(shown.length)} prizes`} went to one winner.`
              : `${prizeCount(shown.length)}. Nothing was drawn.`
          }
        />
        <PoolShelf prizes={shown} onZoom={onZoom} className="mt-4" />
      </PoolPass>

      <AfterPass event={event} next={next} nowMs={nowMs} onZoom={onZoom} />
      <HowItWorks at="next" />
    </div>
  );
}

/** A one-winner event on /lucky-draw: one pool, one action, one draw. */
export function PotView({
  page,
  event,
  nowMs,
  drawing,
  balance,
  onEnter,
  onOpenResult,
  onWatch,
}: {
  page: LuckyDrawPage;
  event: LuckyDrawEvent;
  nowMs: number | null;
  /** The end has passed and no result has come yet. */
  drawing: boolean;
  balance: number;
  onEnter: () => void;
  onOpenResult: () => void;
  onWatch: () => void;
}) {
  const [zoom, setZoom] = useState<PoolPrize | null>(null);
  const prizes = heroFirst(page.prizes);
  const zoomed = zoom && (
    <PrizeZoom prize={zoom} onClose={() => setZoom(null)} />
  );

  if (event.result) {
    return (
      <>
        <DrawnPool
          event={event}
          result={event.result}
          prizes={page.prizes}
          next={page.next_event}
          nowMs={nowMs}
          onOpenResult={onOpenResult}
          onWatch={onWatch}
          onZoom={setZoom}
        />
        {zoomed}
      </>
    );
  }

  return (
    <div className="space-y-6 pb-24 short:pb-0 lg:pb-0">
      <PoolPass
        foil={!drawing}
        stub={
          <>
            <StubTop
              status={drawing ? 'Drawing now' : 'Open now'}
              live
              length={poolLength(event.starts_at, event.ends_at)}
            />
            <StubTime>
              <PoolClock
                label="Tickets close in"
                to={event.ends_at}
                nowMs={nowMs}
                ended="Tickets are closed"
              />
              <PassDates
                startsAt={event.starts_at}
                endsAt={event.ends_at}
                nowMs={nowMs}
                startLabel="Opened"
                endLabel={drawing ? 'Closed' : 'Closes'}
              />
              <PoolLedger event={event} ink />
            </StubTime>
            <div className="hidden pt-4 lg:block" />
            {drawing ? (
              <PoolAction
                title="Drawing the winner…"
                sub="The wheel spins here in about a minute"
              />
            ) : balance > 0 ? (
              <PoolAction
                title={`You have ${num(balance)} ${balance === 1 ? 'ticket' : 'tickets'}`}
                sub="Each one can win the whole pool"
              >
                <Pill size="lg" className={ACTION_PILL} onClick={onEnter}>
                  Put tickets in
                </Pill>
              </PoolAction>
            ) : (
              <PoolAction title="You have no tickets" sub="Tasks pay them out">
                <Link href="/task" className={EARN_TICKETS}>
                  Earn tickets
                </Link>
              </PoolAction>
            )}
          </>
        }
      >
        <PoolWorth name={event.name} prizes={prizes} />
        <PoolShelf prizes={prizes} onZoom={setZoom} className="mt-4" />
        <PoolLedger event={event} />
      </PoolPass>

      <AfterPass
        event={event}
        next={page.next_event}
        nowMs={nowMs}
        onZoom={setZoom}
      />

      <HowItWorks at={drawing ? 'draw' : 'enter'} />
      {zoomed}
    </div>
  );
}

/** No pool running, one scheduled: the coming pool gets the whole page, so a
 *  player can see what they are saving tickets for. */
export function UpcomingPool({
  next,
  balance,
  nowMs,
}: {
  next: NextEvent;
  balance: number;
  nowMs: number | null;
}) {
  const [zoom, setZoom] = useState<PoolPrize | null>(null);
  const prizes = heroFirst(next.prizes);
  return (
    <div className="space-y-6 pb-24 short:pb-0 lg:pb-0">
      <PoolPass
        stub={
          <>
            <StubTop
              status="Next pool"
              length={poolLength(next.starts_at, next.ends_at)}
            />
            <StubTime>
              <PoolClock
                label="Opens in"
                to={next.starts_at}
                nowMs={nowMs}
                ended="Opening now…"
              />
              {next.ends_at ? (
                <PassDates
                  startsAt={next.starts_at}
                  endsAt={next.ends_at}
                  nowMs={nowMs}
                  startLabel="Opens"
                  endLabel="Closes"
                />
              ) : (
                <p className="mt-3 border-t border-neutral-950/15 pt-3 text-sm font-semibold sm:mt-0 sm:border-t-0 sm:pt-0 lg:mt-3 lg:border-t lg:pt-3">
                  Opens {poolDay(next.starts_at, nowMs)}
                </p>
              )}
            </StubTime>
            <div className="hidden pt-4 lg:block" />
            <PoolAction
              title={
                balance > 0
                  ? `You have ${num(balance)} ${balance === 1 ? 'ticket' : 'tickets'} ready`
                  : 'You have no tickets yet'
              }
              sub={
                balance > 0
                  ? 'Put them in when it opens'
                  : 'Earn some before it opens'
              }
            >
              <Link href="/task" className={EARN_TICKETS}>
                Earn tickets
              </Link>
            </PoolAction>
          </>
        }
      >
        <PoolWorth name={next.name} prizes={prizes} />
        {prizes.length > 0 && (
          <PoolShelf prizes={prizes} onZoom={setZoom} className="mt-4" />
        )}
      </PoolPass>

      <HowItWorks at="collect" />
      {zoom && <PrizeZoom prize={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}

/** Nothing running and nothing scheduled: the pass's outline, waiting. */
export function NoPool({ onSeeResults }: { onSeeResults: () => void }) {
  return (
    <div className="space-y-6">
      <div className="rounded-[20px] border border-dashed border-white/15 px-4 py-8 text-center">
        <TicketArt width={96} className="mx-auto" />
        <p className="font-heading mt-3 text-[22px] leading-tight text-white">
          No pool running right now
        </p>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-neutral-400">
          The next one shows here with its prizes and its clock as soon as it is
          set. Tickets you hold carry over.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Link
            href="/task"
            className={pillVariants({ variant: 'primary', size: 'sm' })}
          >
            Earn tickets
          </Link>
          <Pill size="sm" variant="secondary" onClick={onSeeResults}>
            See past results
          </Pill>
        </div>
      </div>
      <HowItWorks at="collect" />
    </div>
  );
}
