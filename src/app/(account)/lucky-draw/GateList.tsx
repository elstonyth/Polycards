'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowDownUp, ChevronRight, X } from 'lucide-react';
import { useAuth } from '@/components/auth/AuthProvider';
import { readStamp } from '@/components/app-shell/create-unread-dot';
import { useDrawDot } from '@/components/app-shell/DrawDotProvider';
import { Pill, pillVariants } from '@/components/ui/pill';
import { TicketArt } from '@/components/TicketArt';
import { useDragScroll } from '@/lib/use-drag-scroll';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { GLASS_SUBTLE, useLiquidGlass } from '@/lib/use-liquid-glass';
import { cn } from '@/lib/utils';
import { num, rmAuto } from '@/lib/format';
import {
  chancePercent,
  countdownClock,
  drawCountdown,
  GATE_SORTS,
  heroFirst,
  heroPrize,
  holoSheet,
  LUCKY_DRAW_TIERS,
  newGateIds,
  POOL_TITLE,
  potTotal,
  sortGates,
  TIER_LABEL,
  TIER_VEIL,
  tilePrice,
  type GateSort,
  type LuckyDrawTier,
} from '@/lib/lucky-draw';
import type { LuckyDrawGate } from '@/lib/data/schemas';
import type { EnterTarget } from './EnterSheet';
import { HowItWorks } from './HowItWorks';
import { FramedArt, PrizeZoom, type PoolPrize } from './PoolParts';
import { TopEntrants } from './PrizeCard';

/** A gate as the enter sheet reads a prize: its id, the pool's title, the hero's
 *  art, the pot's value and the gate's tickets. */
export function gateTarget(gate: LuckyDrawGate): EnterTarget {
  const hero = heroPrize(gate.prizes);
  return {
    id: gate.id,
    title: POOL_TITLE,
    image: hero?.image ?? null,
    kind: hero?.kind ?? 'card',
    value_myr: potTotal(gate.prizes),
    my_tickets: gate.my_tickets,
    total_tickets: gate.total_tickets,
  };
}

const CLOCK_UNITS = [
  ['d', 'Days'],
  ['h', 'Hrs'],
  ['m', 'Min'],
  ['s', 'Sec'],
] as const;

// Prizes grow with the phone, kept small enough that a whole ticket and the top
// of the next fit between the page's controls and the tab bar (boss 2026-11-01:
// "看得完"). A wider ticket has the room for more.
const ART_HEIGHT = 'h-[clamp(6rem,15dvh,8rem)] sm:h-[clamp(8rem,20dvh,11rem)]';

/** The clock on the stub. Digits size from the stub's own width, so they fill it
 *  on a folded phone and on a monitor alike; a gate under a day drops its Days
 *  column and its digits grow. Null `nowMs` is the server render. */
function GateClock({ to, nowMs }: { to: string; nowMs: number | null }) {
  const clock = nowMs == null ? null : countdownClock(to, nowMs);
  const units = CLOCK_UNITS.filter(([key]) => key !== 'd' || clock?.d !== '00');
  return (
    <div className="mt-3 [container-type:inline-size]">
      <p className="text-xs font-semibold">Gate closes in</p>
      <div
        role="timer"
        aria-label={
          nowMs == null
            ? undefined
            : `Gate closes in ${drawCountdown(to, nowMs)}`
        }
        className={cn(
          'mt-1.5 grid divide-x divide-neutral-950/15',
          units.length === 4 ? 'grid-cols-4' : 'grid-cols-3',
        )}
      >
        {units.map(([key, unit]) => (
          <div key={key} className="pl-[4cqw] first:pl-0">
            <p
              // leading after the size: cn drops a leading that a size follows.
              className={cn(
                'font-heading tabular-nums',
                units.length === 4
                  ? 'text-[min(17cqw,2.5rem)]'
                  : 'text-[min(23cqw,3.25rem)]',
                'leading-none',
              )}
            >
              {clock?.[key] ?? '--'}
            </p>
            <p className="mt-1 text-[9px] font-semibold tracking-wide text-neutral-700 uppercase">
              {unit}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Every prize of the gate: one stands alone, more swipe sideways, the pack
 *  page's Top Hits rail. A tap zooms; tickets go on the gate, never on a prize. */
function GatePrizes({
  prizes,
  onZoom,
}: {
  /** Hero first: it takes the foil frame. */
  prizes: LuckyDrawGate['prizes'];
  onZoom: (prize: PoolPrize) => void;
}) {
  const drag = useDragScroll<HTMLDivElement>();
  const [prize] = prizes;
  if (prize && prizes.length === 1) {
    return (
      <button
        type="button"
        onClick={() => onZoom(prize)}
        aria-label={`See ${prize.title}, ${rmAuto(prize.value_myr)}`}
        className="mt-2.5 block w-full cursor-zoom-in rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <span
          className={cn('pool-float mx-auto block aspect-[5/7]', ART_HEIGHT)}
        >
          <FramedArt prize={prize} holo eager />
        </span>
        <span className="mt-1.5 block truncate text-center text-[11px] text-neutral-300">
          {prize.title}
        </span>
      </button>
    );
  }
  return (
    <div
      {...drag}
      className="-mx-3 mt-2.5 flex cursor-grab snap-x gap-2 overflow-x-auto scroll-px-3 px-3 active:cursor-grabbing [-ms-overflow-style:none] [scrollbar-width:none] sm:-mx-4 sm:scroll-px-4 sm:px-4 [&::-webkit-scrollbar]:hidden"
    >
      {prizes.map((p, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onZoom(p)}
          aria-label={`See ${p.title}, ${rmAuto(p.value_myr)}`}
          className="shrink-0 cursor-zoom-in snap-start rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <span className={cn('block aspect-[5/7]', ART_HEIGHT)}>
            <FramedArt prize={p} holo={i === 0} eager={i < 3} />
          </span>
          {/* In a box the art's width: a long title must not widen the tile. */}
          <span className="flex w-0 min-w-full flex-col">
            <span className="font-heading mt-1 truncate text-xs text-chase tabular-nums">
              {rmAuto(tilePrice(p.value_myr))}
            </span>
            <span className="truncate text-[10px] leading-snug text-neutral-300">
              {p.title}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function Stat({
  label,
  short = label,
  children,
}: {
  label: string;
  /** For the smallest phones, where the full label would clip. */
  short?: string;
  children: ReactNode;
}) {
  return (
    <span className="block min-w-0">
      <span className="block truncate text-[10px] text-neutral-400 max-[359px]:hidden">
        {label}
      </span>
      <span className="hidden truncate text-[10px] text-neutral-400 max-[359px]:block">
        {short}
      </span>
      <span className="font-heading mt-0.5 flex items-center text-sm leading-tight text-white tabular-nums">
        {children}
      </span>
    </span>
  );
}

const STUB_ACTION =
  'h-10 w-full bg-neutral-950 px-2 text-[13px] text-white hover:bg-neutral-800 sm:h-11 sm:text-sm';

/** One gate, a pass torn top to bottom like the desktop page always was: on the
 *  foil its tier, its clock and the one action; on the dark half what it is
 *  worth and where the player stands. */
function GateTicket({
  gate,
  isNew,
  nowMs,
  balance,
  spinHref,
  onEnter,
  onGetTickets,
  onZoom,
  onPlayers,
}: {
  gate: LuckyDrawGate;
  isNew: boolean;
  nowMs: number | null;
  balance: number;
  spinHref: string | null;
  onEnter: () => void;
  onGetTickets: () => void;
  onZoom: (prize: PoolPrize) => void;
  onPlayers: () => void;
}) {
  const prizes = heroFirst(gate.prizes);
  const closed = nowMs != null && !countdownClock(gate.ends_at, nowMs);
  const tier = gate.tier as LuckyDrawTier | null;
  return (
    <article className="grid h-full grid-cols-[minmax(7.75rem,39%)_0_minmax(0,1fr)] lg:grid-cols-[clamp(15rem,30%,24rem)_0_minmax(0,1fr)]">
      {/* No filter or mask here: the foil is the surface itself. */}
      <div
        className={cn(
          'relative flex min-w-0 flex-col rounded-l-[20px] p-3 text-neutral-950 sm:p-4',
          closed ? 'bg-neutral-300' : 'holo-turn [--holo-period:28s]',
        )}
        style={
          closed
            ? undefined
            : { background: holoSheet(TIER_VEIL[tier ?? 'business']) }
        }
      >
        <span
          aria-hidden
          className="pool-guilloche pointer-events-none absolute inset-0 rounded-[inherit]"
        />
        <div className="relative flex flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <h2 className="font-heading text-[clamp(1.05rem,5.4vw,1.375rem)] leading-none">
              {tier ? TIER_LABEL[tier] : POOL_TITLE}
            </h2>
            {isNew && (
              <span className="rounded-full bg-neutral-950 px-1.5 py-0.5 text-[9px] leading-none font-semibold text-white">
                NEW
              </span>
            )}
          </div>
          {closed ? (
            <p className="font-heading mt-3 text-[clamp(1.05rem,5.4vw,1.375rem)] leading-tight">
              Gate is closed
            </p>
          ) : (
            <GateClock to={gate.ends_at} nowMs={nowMs} />
          )}
          <div className="mt-auto pt-3">
            {closed ? (
              <p className="text-xs leading-snug font-semibold">
                Drawing the winner…
              </p>
            ) : balance > 0 ? (
              <Pill size="sm" className={STUB_ACTION} onClick={onEnter}>
                {gate.my_tickets > 0 ? 'Add tickets' : 'Put tickets in'}
              </Pill>
            ) : spinHref ? (
              <Pill size="sm" className={STUB_ACTION} onClick={onGetTickets}>
                Get tickets
              </Pill>
            ) : (
              <Link
                href="/task"
                className={cn(
                  pillVariants({ variant: 'primary', size: 'sm' }),
                  STUB_ACTION,
                )}
              >
                Get tickets
              </Link>
            )}
          </div>
        </div>
      </div>
      <div aria-hidden className="pool-perf pool-perf-split" />
      <div className="min-w-0 rounded-r-[20px] border border-l-0 border-white/10 bg-neutral-900 p-3 sm:p-4">
        <p className="text-xs font-semibold text-neutral-300">{POOL_TITLE}</p>
        <p className="font-heading mt-0.5 truncate text-[clamp(1.0625rem,5.2vw,1.5rem)] leading-tight text-chase tabular-nums">
          {rmAuto(potTotal(prizes))}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-neutral-400">
          {prizes.length === 1
            ? 'One winner takes it'
            : `One winner takes all ${num(prizes.length)}`}
        </p>

        <GatePrizes prizes={prizes} onZoom={onZoom} />

        <div className="mt-2 grid grid-cols-3 gap-1.5 border-t border-white/10 pt-2">
          <Stat label="Your tickets" short="Yours">
            {num(gate.my_tickets)}
          </Stat>
          <Stat label="Your chance" short="Chance">
            {chancePercent(gate.my_tickets, gate.total_tickets)}
          </Stat>
          <button
            type="button"
            onClick={onPlayers}
            aria-label={`Players: ${num(gate.entrant_count)}. See the top 10`}
            className="-m-1 min-w-0 rounded-lg p-1 text-left transition-colors outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <Stat label="Players">
              {num(gate.entrant_count)}
              <ChevronRight
                className="ml-0.5 h-3.5 w-3.5 text-neutral-400"
                aria-hidden
              />
            </Stat>
          </button>
        </div>
      </div>
    </article>
  );
}

/** A small sheet from the bottom: who is in a gate, where tickets come from. */
function GateSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, true, onClose);
  useLiquidGlass(panelRef, true, GLASS_SUBTLE);
  return (
    <div
      className="glass-stage fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gate-sheet-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="glass-panel max-h-[80dvh] w-full overflow-y-auto rounded-t-2xl border p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none sm:max-w-sm sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2
            id="gate-sheet-title"
            className="font-heading text-[22px] leading-tight text-white"
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mt-2 -mr-2 flex h-11 w-11 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const chipClass = (on: boolean) =>
  cn(
    'h-9 shrink-0 rounded-full px-3.5 text-[13px] font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/40',
    on
      ? 'bg-neutral-50 text-neutral-950'
      : 'bg-neutral-800 text-neutral-300 hover:text-white',
  );

/** Which gates, in what order. A native select: the phone's own picker. */
function GateControls({
  tiers,
  tier,
  sort,
  onTier,
  onSort,
}: {
  /** The tiers running now: a chip that leads nowhere is clutter. */
  tiers: LuckyDrawTier[];
  tier: LuckyDrawTier | 'all';
  sort: GateSort;
  onTier: (tier: LuckyDrawTier | 'all') => void;
  onSort: (sort: GateSort) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <div
        role="group"
        aria-label="Filter by tier"
        className="-my-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tiers.length > 1 &&
          (['all', ...tiers] as const).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tier === t}
              onClick={() => onTier(t)}
              className={chipClass(tier === t)}
            >
              {t === 'all' ? 'All' : TIER_LABEL[t]}
            </button>
          ))}
      </div>
      <label className="relative flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-neutral-800 text-neutral-300 focus-within:ring-2 focus-within:ring-white/40 sm:w-auto sm:gap-1.5 sm:px-3.5">
        <ArrowDownUp className="h-4 w-4" aria-hidden />
        <span className="hidden text-[13px] font-semibold sm:inline">
          {GATE_SORTS[sort]}
        </span>
        {sort !== 'closing' && (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-neutral-50 sm:hidden"
          />
        )}
        <select
          aria-label="Sort gates"
          value={sort}
          onChange={(e) => onSort(e.target.value as GateSort)}
          className="absolute inset-0 cursor-pointer opacity-0"
        >
          {Object.entries(GATE_SORTS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** The gates new since the last visit, fixed for this visit: the next one falls
 *  back to the default sort. Then the Draw tab's dot is cleared, as the vault's. */
function useNewGates(gates: LuckyDrawGate[]): Set<string> {
  const { customer } = useAuth();
  const { latestAt, markSeen, refresh } = useDrawDot();
  const customerId = customer?.id ?? null;
  const [seenAt, setSeenAt] = useState<{ at: string | null } | null>(null);

  // Read after mount (localStorage has no server), before anything stamps it.
  useEffect(() => {
    if (!customerId) return;
    const id = window.setTimeout(
      () => setSeenAt({ at: readStamp('draw', customerId) }),
      0,
    );
    return () => window.clearTimeout(id);
  }, [customerId]);

  // Re-read first: a client-side nav can leave `latestAt` older than this page.
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    if (seenAt && latestAt) markSeen();
  }, [seenAt, latestAt, markSeen]);

  return useMemo(() => newGateIds(gates, seenAt?.at ?? null), [gates, seenAt]);
}

/** The Pool tab: every running gate, one ticket each, stacked on a phone. */
export function GateList({
  gates,
  nowMs,
  balance,
  spinHref,
  onEnter,
}: {
  gates: LuckyDrawGate[];
  nowMs: number | null;
  balance: number;
  /** Where to spin a capsule for tickets; null with none on sale. */
  spinHref: string | null;
  onEnter: (gate: LuckyDrawGate) => void;
}) {
  const [tier, setTier] = useState<LuckyDrawTier | 'all'>('all');
  const [sort, setSort] = useState<GateSort>('closing');
  const [zoom, setZoom] = useState<PoolPrize | null>(null);
  const [playersOf, setPlayersOf] = useState<LuckyDrawGate | null>(null);
  const [gettingTickets, setGettingTickets] = useState(false);
  const newIds = useNewGates(gates);

  const tiers = LUCKY_DRAW_TIERS.filter((t) => gates.some((g) => g.tier === t));
  // A chosen tier whose last gate has just been drawn falls back to all of them.
  const shownTier = tier !== 'all' && tiers.includes(tier) ? tier : 'all';
  const shown = sortGates(
    shownTier === 'all' ? gates : gates.filter((g) => g.tier === shownTier),
    sort,
    newIds,
  );

  return (
    <div className="space-y-3">
      {/* Nothing to choose between with one gate. */}
      {gates.length > 1 && (
        <GateControls
          tiers={tiers}
          tier={shownTier}
          sort={sort}
          onTier={setTier}
          onSort={setSort}
        />
      )}

      <ul className="grid gap-3 lg:grid-cols-[repeat(auto-fit,minmax(34rem,1fr))] lg:gap-4">
        {shown.map((gate) => (
          <li key={gate.id} className="min-w-0">
            <GateTicket
              gate={gate}
              isNew={newIds.has(gate.id)}
              nowMs={nowMs}
              balance={balance}
              spinHref={spinHref}
              onEnter={() => onEnter(gate)}
              onGetTickets={() => setGettingTickets(true)}
              onZoom={setZoom}
              onPlayers={() => setPlayersOf(gate)}
            />
          </li>
        ))}
      </ul>

      <HowItWorks at={balance > 0 ? 'enter' : 'collect'} className="pt-3" />

      {zoom && <PrizeZoom prize={zoom} onClose={() => setZoom(null)} />}
      {playersOf && (
        <GateSheet
          title={`${num(playersOf.entrant_count)} ${playersOf.entrant_count === 1 ? 'player' : 'players'}`}
          onClose={() => setPlayersOf(null)}
        >
          <TopEntrants
            top={playersOf.top}
            totalTickets={playersOf.total_tickets}
            className="mt-3"
          />
        </GateSheet>
      )}
      {gettingTickets && spinHref && (
        <GateSheet title="Get tickets" onClose={() => setGettingTickets(false)}>
          <p className="mt-1 text-sm text-neutral-400">
            From tasks or a capsule.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Link
              href="/task"
              className={pillVariants({ variant: 'secondary', size: 'lg' })}
            >
              Tasks
            </Link>
            <Link
              href={spinHref}
              className={pillVariants({ variant: 'secondary', size: 'lg' })}
            >
              Capsules
            </Link>
          </div>
        </GateSheet>
      )}
    </div>
  );
}

/** Nothing running: the ticket's outline, waiting. */
export function NoPool({
  spinHref,
  onSeeResults,
}: {
  spinHref: string | null;
  onSeeResults: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="rounded-[20px] border border-dashed border-white/15 px-4 py-8 text-center">
        <TicketArt width={96} className="mx-auto" />
        <p className="font-heading mt-3 text-[22px] leading-tight text-white">
          No pool running right now
        </p>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-neutral-400">
          The next one shows here with its prizes and its clock as soon as it
          opens. Tickets you hold carry over.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Link
            href="/task"
            className={pillVariants({ variant: 'primary', size: 'sm' })}
          >
            {spinHref ? 'Tasks' : 'Earn tickets'}
          </Link>
          {spinHref && (
            <Link
              href={spinHref}
              className={pillVariants({ variant: 'secondary', size: 'sm' })}
            >
              Capsules
            </Link>
          )}
          <Pill size="sm" variant="secondary" onClick={onSeeResults}>
            See past results
          </Pill>
        </div>
      </div>
      <HowItWorks at="collect" />
    </div>
  );
}
