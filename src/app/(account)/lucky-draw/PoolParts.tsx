'use client';

import { useRef, type CSSProperties, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { GLASS_SUBTLE, useLiquidGlass } from '@/lib/use-liquid-glass';
import { cn } from '@/lib/utils';
import { mytClock, rmAuto } from '@/lib/format';
import {
  countdownClock,
  drawCountdown,
  HOLO_STOPS,
  holoConic,
  holoSheet,
  poolDay,
  tilePrice,
} from '@/lib/lucky-draw';
import { PrizeArt } from './PrizeCard';

/** What the pool's pictures need of a prize: a live one or a next pool's. */
export type PoolPrize = {
  kind?: string;
  title: string;
  image: string | null;
  value_myr: number;
};

const CLOCK_UNITS = [
  ['d', 'Days'],
  ['h', 'Hrs'],
  ['m', 'Min'],
  ['s', 'Sec'],
] as const;

// The frame's soft glow, in its own foil (SpinWheel's).
const HOLO_FRAME_GLOW = `0 0 40px ${HOLO_STOPS[1]}2e, 0 0 90px ${HOLO_STOPS[0]}1c`;
const PEDESTAL = 'bg-[radial-gradient(90%_60%_at_50%_30%,#2a2a2e,#121214_70%)]';

/** A prize's art in its frame. Fills its parent, which sets the 5:7 shape. */
export function FramedArt({
  prize,
  holo = false,
  eager = false,
}: {
  prize: PoolPrize;
  holo?: boolean;
  eager?: boolean;
}) {
  const art = (
    <span
      className={cn(
        'relative block h-full w-full overflow-hidden p-[6%]',
        PEDESTAL,
        holo ? 'rounded-[10px]' : 'rounded-[11px] border border-white/15',
      )}
    >
      <span className="relative block h-full w-full">
        <PrizeArt src={prize.image} kind={prize.kind} eager={eager} />
      </span>
    </span>
  );
  return holo ? (
    <span
      className="holo-turn block h-full w-full rounded-[11px] p-[1.5px] [--holo-period:7s]"
      style={{ background: holoConic, boxShadow: HOLO_FRAME_GLOW }}
    >
      {art}
    </span>
  ) : (
    art
  );
}

/** The Lucky Draw's own object: a pool is a pass, cut like the ticket that buys
 *  into it. The foil stub carries the time, the dark half what it is worth, and
 *  it tears between them. Stands on its side on a desktop. */
export function PoolPass({
  stub,
  foil = true,
  children,
}: {
  stub: ReactNode;
  /** Off once tickets have closed: the stub goes plain. */
  foil?: boolean;
  children: ReactNode;
}) {
  return (
    <article className="lg:grid lg:grid-cols-[clamp(22rem,30%,30rem)_0_minmax(0,1fr)]">
      {/* No filter, transform or mask on the stub: the action inside it docks to
          the viewport on a phone, and any of those would trap it in here. */}
      <div
        className={cn(
          'relative flex flex-col rounded-t-[20px] p-4 text-neutral-950 short:p-3 lg:rounded-l-[20px] lg:rounded-tr-none lg:p-5',
          foil ? 'holo-turn [--holo-period:28s]' : 'bg-neutral-300',
        )}
        style={foil ? { background: holoSheet } : undefined}
      >
        <span
          aria-hidden
          className="pool-guilloche pointer-events-none absolute inset-0 rounded-[inherit]"
        />
        <div className="relative flex flex-1 flex-col">{stub}</div>
      </div>
      <div aria-hidden className="pool-perf pool-perf-split" />
      <div className="min-w-0 rounded-b-[20px] border border-t-0 border-white/10 bg-neutral-900 p-4 lg:rounded-tr-[20px] lg:rounded-bl-none lg:border-t lg:border-l-0 lg:p-5">
        {children}
      </div>
    </article>
  );
}

/** How many prizes sit across, by how many there are, so a row is never left
 *  half empty and a slab never outgrows the screen. A lone slab or a pair is held
 *  to a readable size in the middle. Index is the prize count; the last covers
 *  every longer pool. */
const SHELF_LAYOUT = [
  '',
  'mx-auto max-w-[14rem] grid-cols-1 lg:max-w-[18rem] xl:max-w-[min(18rem,max(8rem,(100dvh-26rem)*5/7))]',
  'mx-auto max-w-xl grid-cols-2 xl:max-w-[min(36rem,2*max(8rem,(100dvh-26rem)*5/7)+0.75rem)]',
  'grid-cols-3 max-[340px]:grid-cols-2',
  'grid-cols-2 sm:grid-cols-4',
  'grid-cols-3 max-[340px]:grid-cols-2 md:grid-cols-5 lg:grid-cols-3 xl:grid-cols-5',
  'grid-cols-3 max-[340px]:grid-cols-2 md:grid-cols-6 lg:grid-cols-3 xl:grid-cols-6',
  'grid-cols-3 max-[340px]:grid-cols-2 md:grid-cols-5 lg:grid-cols-4 xl:grid-cols-6',
];

/** Every prize with its picture and its price, the pool's full contents. */
export function PoolShelf({
  prizes,
  onZoom,
  compact = false,
  className,
}: {
  /** Hero first: it takes the foil frame. */
  prizes: PoolPrize[];
  onZoom: (prize: PoolPrize) => void;
  /** Four across on a phone: a preview, not the main event. */
  compact?: boolean;
  className?: string;
}) {
  const count = prizes.length;
  // Three or more across on a phone: a smaller price, so it stays whole.
  const dense = !compact && (count === 3 || count > 4);
  // One row on a desktop: held to the window's height too, so a laptop still
  // has the action on its first screen, whatever its screen's width.
  const oneRow = !compact && count >= 3 && count <= 6;
  return (
    <ul
      className={cn(
        'grid gap-x-3 gap-y-4',
        compact
          ? 'grid-cols-4 gap-x-2'
          : SHELF_LAYOUT[Math.min(count, SHELF_LAYOUT.length - 1)],
        oneRow &&
          'xl:max-w-[calc(var(--across)*max(8rem,(100dvh-26rem)*5/7)+(var(--across)-1)*0.75rem)]',
        className,
      )}
      style={oneRow ? ({ '--across': count } as CSSProperties) : undefined}
    >
      {prizes.map((p, i) => (
        <li key={i} className="min-w-0">
          <button
            type="button"
            onClick={() => onZoom(p)}
            aria-label={`See ${p.title}, ${rmAuto(p.value_myr)}`}
            className="group block w-full cursor-zoom-in rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <span
              className={cn(
                'block aspect-[5/7] w-full',
                !compact && 'pool-float',
              )}
              style={compact ? undefined : { animationDelay: `${-i * 0.9}s` }}
            >
              <span className="block h-full w-full transition-transform duration-200 ease-out group-hover:-translate-y-0.5 motion-reduce:transition-none">
                <FramedArt prize={p} holo={!compact && i === 0} eager={i < 4} />
              </span>
            </span>
            <span
              className={cn(
                'font-heading mt-2 block truncate text-chase tabular-nums',
                compact
                  ? 'text-xs'
                  : dense
                    ? 'text-sm sm:text-base'
                    : 'text-base xl:text-lg',
              )}
            >
              {rmAuto(tilePrice(p.value_myr))}
            </span>
            <span
              className={cn(
                'mt-0.5 line-clamp-2 leading-snug text-neutral-300',
                compact
                  ? 'text-[11px]'
                  : dense
                    ? 'text-xs'
                    : 'text-xs xl:text-sm',
              )}
            >
              {p.title}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A big clock to a real deadline, printed on the stub. A short pool has no
 *  days to count, so it drops that column and its digits grow. Digits are sized
 *  from the clock's own width (cqw), so they fill it on a folded phone and on a
 *  monitor alike. It says `ended` once the time is up. Null `nowMs` is the server
 *  render. */
export function PoolClock({
  label,
  to,
  nowMs,
  ended,
}: {
  label: string;
  to: string;
  nowMs: number | null;
  ended: string;
}) {
  const clock = nowMs == null ? null : countdownClock(to, nowMs);
  const over = nowMs != null && !clock;
  if (over) {
    return (
      <p className="font-heading mt-4 text-[clamp(1.6rem,8.2vw,2rem)] leading-none">
        {ended}
      </p>
    );
  }
  const units = CLOCK_UNITS.filter(([key]) => key !== 'd' || clock?.d !== '00');
  return (
    // The inner clock is the container, not the stub: the docked action lives in
    // the stub, and containment could trap a fixed element.
    <div className="mt-4 [container-type:inline-size] squat:mt-3 short:mt-2">
      <p className="text-sm font-semibold">{label}</p>
      <div
        role="timer"
        aria-label={
          nowMs == null ? undefined : `${label} ${drawCountdown(to, nowMs)}`
        }
        className={cn(
          'mt-1.5 grid divide-x divide-neutral-950/15',
          units.length === 4 ? 'grid-cols-4' : 'grid-cols-3',
        )}
      >
        {units.map(([key, unit]) => (
          <div key={key} className="pl-2.5 first:pl-0">
            <p
              // leading after the size: cn drops a leading that a size follows.
              className={cn(
                'font-heading tabular-nums',
                units.length === 4
                  ? 'text-[min(15cqw,5rem)] short:text-[min(13cqw,2.75rem)]'
                  : 'text-[min(19.5cqw,6.5rem)] short:text-[min(17cqw,3.5rem)]',
                'leading-none',
              )}
            >
              {clock?.[key] ?? '--'}
            </p>
            <p className="mt-1.5 text-[10px] font-semibold tracking-wide text-neutral-700 uppercase">
              {unit}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** When a pool runs, printed on the stub like a pass's two lines. A rule above
 *  where the clock is above it, beside it where the clock is beside it. A short
 *  phone keeps only the end: that is the date the player has to act by. */
export function PassDates({
  startsAt,
  endsAt,
  nowMs,
  startLabel,
  endLabel,
}: {
  startsAt: string;
  endsAt: string;
  nowMs: number | null;
  startLabel: string;
  endLabel: string;
}) {
  return (
    <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-neutral-950/15 pt-3 text-[13px] short:mt-0 short:border-t-0 short:border-l short:pt-0 short:pl-6 sm:mt-0 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-6 lg:mt-3 lg:border-t lg:border-l-0 lg:pt-3 lg:pl-0">
      <div className="contents squat:hidden">
        <dt className="text-neutral-700">{startLabel}</dt>
        <dd className="font-medium whitespace-nowrap text-neutral-800">
          {poolDay(startsAt, nowMs)}, {mytClock(startsAt)} MYT
        </dd>
      </div>
      <div className="contents">
        <dt className="text-neutral-700">{endLabel}</dt>
        <dd className="font-semibold whitespace-nowrap">
          {poolDay(endsAt, nowMs)}, {mytClock(endsAt)} MYT
        </dd>
      </div>
    </dl>
  );
}

/** One prize, large: a collector wants to read the slab. */
export function PrizeZoom({
  prize,
  onClose,
}: {
  prize: PoolPrize;
  onClose: () => void;
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
        aria-labelledby="prize-zoom-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="glass-panel max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl border p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none sm:max-w-sm sm:rounded-2xl"
      >
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mt-2 -mr-2 flex h-11 w-11 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="pool-zoom mx-auto aspect-[5/7] w-[62%] max-w-64 short:w-36">
          <FramedArt prize={prize} holo />
        </div>
        <h2
          id="prize-zoom-title"
          className="mt-5 text-center text-base leading-snug font-semibold text-white"
        >
          {prize.title}
        </h2>
        <p className="font-heading mt-1 text-center text-2xl text-chase tabular-nums">
          {rmAuto(prize.value_myr)}
        </p>
        {prize.kind === 'credit' && (
          <p className="text-center text-xs text-neutral-400">Bonus credit</p>
        )}
        <p className="mt-3 text-center text-sm leading-relaxed text-neutral-300">
          Part of the pool. The one winner takes it with every other prize.
        </p>
      </div>
    </div>
  );
}
