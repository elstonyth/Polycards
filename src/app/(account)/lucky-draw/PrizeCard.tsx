'use client';

import { Gift } from 'lucide-react';
import { FramedAvatar } from '@/components/FramedAvatar';
import { Pill } from '@/components/ui/pill';
import { cn } from '@/lib/utils';
import { mytClock, mytDate, num, rmAuto } from '@/lib/format';
import { chancePercent, drawCountdown } from '@/lib/lucky-draw';
import type {
  LuckyDrawEntry,
  LuckyDrawPerson,
  LuckyDrawPrize,
} from '@/lib/data/schemas';

const CREDIT_ART = '/images/task/credits-coins.webp';

/** "30 Nov 2026, 11:59 PM MYT" — every Lucky Draw time is Malaysia time. */
export const mytWhen = (iso: string): string =>
  `${mytDate(iso)}, ${mytClock(iso)} MYT`;

/** The prize's picture: the card slab or the admin's art, the credit coins
 *  for a credit prize without art, else a neutral gift. Fills its parent.
 *  A plain <img> (FramedAvatar's choice): the admin's image_url is free text,
 *  and next/image throws during render for a host outside remotePatterns. */
export function PrizeArt({
  src,
  kind,
  eager = false,
}: {
  src: string | null;
  kind?: string;
  /** First-screen art: the empty frame must not be what a player sees first. */
  eager?: boolean;
}) {
  const art = src ?? (kind === 'card' ? null : CREDIT_ART);
  return art ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={art}
      alt=""
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      className="absolute inset-0 h-full w-full object-contain"
    />
  ) : (
    <span className="flex h-full w-full items-center justify-center">
      <Gift className="h-1/3 w-1/3 text-neutral-500" aria-hidden />
    </span>
  );
}

export function PersonChip({
  person,
  size = 24,
  className,
}: {
  person: LuckyDrawPerson;
  size?: number;
  className?: string;
}) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <FramedAvatar
        src={person.avatar}
        frameSrc={person.frame}
        initial={person.who.charAt(0).toUpperCase() || '?'}
        size={size}
      />
      <span className="truncate">{person.who}</span>
    </span>
  );
}

export function Figure({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cn('rounded-xl bg-neutral-950/60 px-3 py-2', className)}>
      <p className="text-[10px] font-semibold tracking-wide text-neutral-400 uppercase">
        {label}
      </p>
      <p className="font-heading mt-0.5 text-base text-white tabular-nums">
        {value}
      </p>
    </div>
  );
}

/** The ranked entrants of a prize or a pot, top 10 from the backend. */
export function TopEntrants({
  top,
  totalTickets = 0,
  className,
}: {
  top: LuckyDrawEntry[];
  /** Tickets in the pot, newer than `top` right after your own entry. */
  totalTickets?: number;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">
        Top entrants
      </p>
      {top.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-400">
          {totalTickets > 0
            ? 'Updating the list…'
            : 'No entries yet — be the first.'}
        </p>
      ) : (
        <ol className="mt-2 space-y-1.5">
          {top.map((e, i) => (
            <li
              key={i}
              className="flex items-center gap-2 text-sm text-neutral-200"
            >
              <span className="w-5 shrink-0 text-right text-xs text-neutral-400 tabular-nums">
                {i + 1}
              </span>
              <PersonChip person={e.person} className="flex-1" />
              <span className="shrink-0 text-xs text-neutral-400 tabular-nums">
                {num(e.tickets)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * One prize of the live event (spec §5): art, value, draw time with a live
 * countdown, the totals, my tickets and chance, the top 10, and the Enter
 * button. A drawn prize shows its winner instead and opens its result.
 */
export function PrizeCard({
  prize,
  nowMs,
  opensAt,
  balance,
  onEnter,
  onOpenResult,
  art = true,
}: {
  prize: LuckyDrawPrize;
  /** Null until mounted: the countdown is client-only (hydration). */
  nowMs: number | null;
  /** The event's start; entering is refused before it. */
  opensAt: string;
  balance: number;
  onEnter: (prize: LuckyDrawPrize) => void;
  onOpenResult: (prizeId: string) => void;
  /** False beside the prize wheel, whose front card already shows the art. */
  art?: boolean;
}) {
  const { result } = prize;
  const closed = nowMs != null && nowMs >= Date.parse(prize.draw_at);
  const notOpen = nowMs != null && nowMs < Date.parse(opensAt);
  return (
    <li className="flex flex-col rounded-2xl border border-white/10 bg-neutral-900 p-4">
      <div className="flex gap-4">
        {art && (
          <span className="relative aspect-[5/7] w-24 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/[0.04] p-1.5 sm:w-28">
            <span className="relative block h-full w-full">
              <PrizeArt src={prize.image} kind={prize.kind} />
            </span>
          </span>
        )}
        <div className="min-w-0 flex-1">
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
            {result
              ? `Drawn ${mytWhen(result.drawn_at)}`
              : `Draws ${mytWhen(prize.draw_at)}`}
          </p>
          {!result && nowMs != null && (
            <p className="mt-1 inline-flex rounded-full bg-neutral-800 px-2.5 py-1 text-xs font-semibold text-white tabular-nums">
              {drawCountdown(prize.draw_at, nowMs)}
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <Figure label="Tickets in" value={num(prize.total_tickets)} />
        <Figure label="Entrants" value={num(prize.entrant_count)} />
        <Figure
          label="My chance"
          value={chancePercent(prize.my_tickets, prize.total_tickets)}
        />
      </div>
      <p className="mt-2 text-xs text-neutral-400">
        My tickets:{' '}
        <span className="font-semibold text-white tabular-nums">
          {num(prize.my_tickets)}
        </span>
      </p>

      <TopEntrants top={prize.top} className="mt-4" />

      <div className="mt-auto pt-4">
        {result ? (
          <button
            type="button"
            onClick={() => onOpenResult(prize.id)}
            className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-left transition-colors outline-none hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-white/40"
          >
            {result.winner ? (
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">
                  Winner
                </span>
                <PersonChip
                  person={result.winner}
                  className="mt-1 text-sm font-semibold text-white"
                />
              </span>
            ) : (
              <span className="flex-1 text-sm text-neutral-300">
                No entries — nothing was drawn.
              </span>
            )}
            <span className="shrink-0 text-xs font-semibold text-neutral-300">
              See result <span aria-hidden>&rarr;</span>
            </span>
          </button>
        ) : closed ? (
          <p className="rounded-full bg-neutral-800 py-3 text-center text-sm font-semibold text-neutral-300">
            Drawing…
          </p>
        ) : (
          <Pill
            size="lg"
            className="w-full"
            disabled={balance <= 0 || notOpen}
            aria-label={notOpen ? undefined : `Enter ${prize.title}`}
            onClick={() => onEnter(prize)}
          >
            {notOpen ? `Opens ${mytDate(opensAt)}` : 'Enter'}
          </Pill>
        )}
      </div>
    </li>
  );
}
