'use client';

import { Pill } from '@/components/ui/pill';
import { Panel } from '@/components/task-ui';
import { mytDate, num, rmAuto } from '@/lib/format';
import {
  chancePercent,
  drawCountdown,
  heroFirst,
  heroPrize,
  potTotal,
} from '@/lib/lucky-draw';
import type {
  LuckyDrawEventResult,
  LuckyDrawPage,
  LuckyDrawPrize,
} from '@/lib/data/schemas';
import type { EnterTarget } from './EnterSheet';
import {
  Figure,
  mytWhen,
  PersonChip,
  PrizeArt,
  TopEntrants,
} from './PrizeCard';
import { PrizeWheel } from './PrizeWheel';

type LuckyDrawEvent = NonNullable<LuckyDrawPage['event']>;

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

/** "Next: December Draw · starts 01 Dec 2026, 12:00 AM MYT" */
export function NextEventLine({
  next,
  className,
}: {
  next: NonNullable<LuckyDrawPage['next_event']>;
  className?: string;
}) {
  return (
    <p className={className}>
      Next: <span className="font-semibold text-white">{next.name}</span> ·
      starts {mytWhen(next.starts_at)}
    </p>
  );
}

/** A prize of the pot, at the front of the opened wheel. Nothing to enter:
 *  tickets go on the event. */
function PotPrizeDetails({ prize }: { prize: LuckyDrawPrize }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4">
      <h3 className="text-base leading-snug font-semibold text-white">
        {prize.title}
      </h3>
      <p className="font-heading mt-1 text-xl text-chase tabular-nums">
        {rmAuto(prize.value_myr)}
      </p>
      {prize.kind === 'credit' && (
        <p className="text-[11px] text-neutral-400">Bonus credit</p>
      )}
      <p className="mt-2 text-xs text-neutral-400">
        Part of the pot: the one winner takes it with every other prize.
      </p>
    </div>
  );
}

/** The pot's headline, my numbers and the one action. */
function PotPanel({
  event,
  prizes,
  nowMs,
  balance,
  drawing,
  onEnter,
}: {
  event: LuckyDrawEvent;
  prizes: LuckyDrawPrize[];
  nowMs: number | null;
  balance: number;
  drawing: boolean;
  onEnter: () => void;
}) {
  const notOpen = nowMs != null && nowMs < Date.parse(event.starts_at);
  return (
    <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4">
      <p className="text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">
        The pot
      </p>
      <p className="font-heading mt-0.5 text-3xl text-chase tabular-nums">
        {rmAuto(potTotal(prizes))}
      </p>
      <p className="mt-1 text-sm text-neutral-300">
        One winner takes every prize.
      </p>
      <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-400">
        <span>Draws {mytWhen(event.ends_at)}</span>
        {nowMs != null && !drawing && (
          <span className="rounded-full bg-neutral-800 px-2.5 py-1 font-semibold text-white tabular-nums">
            {drawCountdown(event.ends_at, nowMs)}
          </span>
        )}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Figure label="My tickets" value={num(event.my_tickets)} />
        <Figure
          label="My chance"
          value={chancePercent(event.my_tickets, event.total_tickets)}
        />
        <Figure label="Tickets in" value={num(event.total_tickets)} />
        <Figure label="Entrants" value={num(event.entrant_count)} />
      </div>

      <div className="mt-4">
        {drawing ? (
          <p className="rounded-full bg-neutral-800 py-3 text-center text-sm font-semibold text-neutral-300">
            Drawing…
          </p>
        ) : (
          <Pill
            size="lg"
            className="w-full"
            disabled={balance <= 0 || notOpen}
            onClick={onEnter}
          >
            {notOpen ? `Opens ${mytDate(event.starts_at)}` : 'Put tickets in'}
          </Pill>
        )}
      </div>
    </div>
  );
}

/** The result on the page after the draw: the winner with the card as the hero,
 *  everything they took, and what is next. No spin here: a result that arrives
 *  live spins on its own; this one offers the replay. */
function DrawnPot({
  event,
  result,
  prizes,
  next,
  onOpenResult,
  onWatch,
}: {
  event: LuckyDrawEvent;
  result: LuckyDrawEventResult;
  prizes: LuckyDrawPrize[];
  next: LuckyDrawPage['next_event'];
  onOpenResult: () => void;
  onWatch: () => void;
}) {
  const shown = heroFirst(prizes);
  const hero = shown[0];
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4">
        <div className="flex gap-4">
          <span className="relative aspect-[5/7] w-28 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/[0.04] p-1.5 sm:w-36">
            <span className="relative block h-full w-full">
              <PrizeArt src={hero?.image ?? null} kind={hero?.kind} />
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">
              {result.winner ? 'Winner' : 'The draw'}
            </p>
            {result.winner ? (
              <>
                <PersonChip
                  person={result.winner}
                  size={36}
                  className="mt-1.5 text-base font-semibold text-white"
                />
                <p className="mt-1.5 text-xs text-neutral-400 tabular-nums">
                  {num(result.winner_tickets)} of {num(result.total_tickets)}{' '}
                  tickets · {num(result.entrant_count)}{' '}
                  {result.entrant_count === 1 ? 'entrant' : 'entrants'}
                </p>
              </>
            ) : (
              <p className="mt-1.5 text-sm text-neutral-300">
                No entries — nothing was drawn.
              </p>
            )}
            {event.my_tickets > 0 && (
              <p className="mt-2 text-xs text-neutral-400 tabular-nums">
                You put in {num(event.my_tickets)}{' '}
                {event.my_tickets === 1 ? 'ticket' : 'tickets'}.
              </p>
            )}
          </div>
        </div>
        <p className="font-heading mt-4 text-3xl text-chase tabular-nums">
          {rmAuto(potTotal(prizes))}
        </p>
        <p className="text-xs text-neutral-400">
          {result.winner ? 'Takes every prize' : 'The pot'}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {result.winner && (
            <Pill size="sm" onClick={onWatch}>
              Watch the draw
            </Pill>
          )}
          <Pill size="sm" variant="secondary" onClick={onOpenResult}>
            See result
          </Pill>
        </div>
      </div>

      <ul className="divide-y divide-white/5 overflow-hidden rounded-2xl border border-white/10 bg-neutral-900">
        {shown.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
            <span className="relative aspect-[5/7] w-10 shrink-0 overflow-hidden rounded-md border border-white/10 bg-white/[0.04] p-0.5">
              <span className="relative block h-full w-full">
                <PrizeArt src={p.image} kind={p.kind} />
              </span>
            </span>
            <span className="line-clamp-2 min-w-0 flex-1 text-sm font-semibold text-white">
              {p.title}
            </span>
            <span className="font-heading shrink-0 text-sm text-chase tabular-nums">
              {rmAuto(p.value_myr)}
            </span>
          </li>
        ))}
      </ul>

      {next && (
        <Panel>
          <NextEventLine next={next} className="text-sm text-neutral-300" />
        </Panel>
      )}
    </div>
  );
}

/** A one-winner event on /lucky-draw: one pot, one action, one draw. */
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
  if (event.result) {
    return (
      <DrawnPot
        event={event}
        result={event.result}
        prizes={page.prizes}
        next={page.next_event}
        onOpenResult={onOpenResult}
        onWatch={onWatch}
      />
    );
  }
  return (
    <>
      <PrizeWheel
        pot
        prizes={heroFirst(page.prizes)}
        nowMs={nowMs}
        details={(p) => <PotPrizeDetails prize={p} />}
        lead={
          <PotPanel
            event={event}
            prizes={page.prizes}
            nowMs={nowMs}
            balance={balance}
            drawing={drawing}
            onEnter={onEnter}
          />
        }
      />
      <TopEntrants
        top={event.top}
        totalTickets={event.total_tickets}
        className="mt-4 rounded-2xl border border-white/10 bg-neutral-900 p-4"
      />
    </>
  );
}
