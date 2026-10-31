'use client';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { Minus, Plus, X } from 'lucide-react';
import { Pill, pillVariants } from '@/components/ui/pill';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { GLASS_SUBTLE, useLiquidGlass } from '@/lib/use-liquid-glass';
import { cn } from '@/lib/utils';
import { num, rmAuto } from '@/lib/format';
import {
  enterLuckyDraw,
  enterLuckyDrawEvent,
  type EnterLuckyDrawResult,
} from '@/lib/actions/lucky-draw';
import {
  chancePercent,
  MAX_ENTRY_TICKETS,
  poolWhen,
  refusalCopy,
  tilePrice,
} from '@/lib/lucky-draw';
import type { LuckyDrawPrize } from '@/lib/data/schemas';
import { FramedArt } from './PoolParts';
import { PrizeArt } from './PrizeCard';

const noop = () => {};

export type Entered = Extract<EnterLuckyDrawResult, { entered: true }>;

/** What tickets go into: a prize, or a one-winner event dressed as its pot
 *  (the event's id and name, the hero's art, the pot's value and tickets). */
export type EnterTarget = Pick<
  LuckyDrawPrize,
  | 'id'
  | 'title'
  | 'image'
  | 'kind'
  | 'value_myr'
  | 'my_tickets'
  | 'total_tickets'
>;

const stepBtn =
  'flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-neutral-800 text-white transition-colors outline-none hover:bg-neutral-700 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-40';

/**
 * Pick how many tickets go on one prize (spec §5), or into a one-winner event's
 * pot: a stepper with Max, my chance after entering, then one confirm. Entries
 * are final, so the confirm locks while the entry is in flight and a refusal is
 * answered in words.
 */
export function EnterSheet({
  prize,
  pot = false,
  pool = [],
  closesAt,
  nowMs = null,
  closed = false,
  balance,
  onClose,
  onEntered,
}: {
  prize: EnterTarget;
  /** `prize` is a one-winner event: post to the event's route, not a prize's. */
  pot?: boolean;
  /** Every prize the tickets go in for, hero first (a one-winner event). */
  pool?: LuckyDrawPrize[];
  /** When tickets close, so the player sees it before committing. */
  closesAt?: string;
  nowMs?: number | null;
  /** The countdown ran out while the sheet was open. */
  closed?: boolean;
  balance: number;
  onClose: () => void;
  onEntered: (prize: EnterTarget, tickets: number, res: Entered) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pending, startTransition] = useTransition();
  // Escape must not close the sheet while the entry is in flight.
  useModalA11y(panelRef, true, pending ? noop : onClose);
  // The panel's blur: .glass-panel is only the tint (TopUpSheet's pairing).
  useLiquidGlass(panelRef, true, GLASS_SUBTLE);
  const max = Math.max(0, Math.min(balance, MAX_ENTRY_TICKETS));
  // The field's own text: typing is never rewritten under the player's
  // fingers (entries are final). Clamped on blur; confirm stays off while
  // the number is out of range.
  const [raw, setRaw] = useState(String(Math.min(1, max)));
  const [error, setError] = useState<{ text: string; topUp: boolean } | null>(
    null,
  );
  const clamp = (n: number) =>
    Math.max(1, Math.min(max, Number.isFinite(n) ? Math.trunc(n) : 1));
  const typed = Number(raw);
  const amount = raw.trim() !== '' && Number.isInteger(typed) ? typed : 0;
  const valid = amount >= 1 && amount <= max;
  const setAmount = (n: number) => setRaw(String(clamp(n)));

  const confirm = () =>
    startTransition(async () => {
      setError(null);
      const res = await (pot ? enterLuckyDrawEvent : enterLuckyDraw)(
        prize.id,
        amount,
      );
      if (!res.ok) setError({ text: res.error, topUp: false });
      else if (!res.entered) {
        setError({
          text: refusalCopy(res.reason, pot),
          topUp: res.reason === 'no_topup',
        });
      } else onEntered(prize, amount, res);
    });

  return (
    <div
      className="glass-stage fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={pending ? undefined : onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="enter-sheet-title"
        aria-busy={pending}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="glass-panel max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl border p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none short:py-3 sm:max-w-md sm:rounded-2xl short:sm:max-w-3xl"
      >
        <div className="flex items-start gap-3">
          {!pot && (
            <span className="relative aspect-[5/7] w-14 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-white/[0.04] p-1">
              <span className="relative block h-full w-full">
                <PrizeArt src={prize.image} kind={prize.kind} />
              </span>
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2
              id="enter-sheet-title"
              className="text-base leading-snug font-semibold text-white"
            >
              {pot ? 'Put tickets in' : 'Enter'} {prize.title}
            </h2>
            {pot ? (
              <p className="mt-0.5 text-xs text-neutral-400">
                Each ticket can win the whole pool
              </p>
            ) : (
              <p className="font-heading mt-0.5 text-lg text-chase tabular-nums">
                {rmAuto(prize.value_myr)}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label="Close"
            className="-mt-2 -mr-2 flex h-11 w-11 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        {/* A phone on its side has no height to stack these: prizes beside the
            stepper, so the confirm stays in reach. */}
        <div
          className={cn(
            pot &&
              pool.length > 0 &&
              'short:grid short:grid-cols-2 short:items-start short:gap-5',
          )}
        >
          {pot && pool.length > 0 && (
            <div className="mt-3">
              <p className="flex items-baseline justify-between gap-3 text-sm font-semibold text-white">
                <span>
                  One winner takes{' '}
                  {pool.length === 1 ? 'it' : `all ${num(pool.length)}`}
                </span>
                <span className="font-heading text-lg text-chase tabular-nums">
                  {rmAuto(prize.value_myr)}
                </span>
              </p>
              {/* Every reward stays in view; a long pool scrolls down, in its own
                box, so the stepper and the confirm never go off screen. */}
              <ul
                className={cn(
                  'mt-2 grid max-h-[38dvh] gap-2 overflow-y-auto short:max-h-[62dvh]',
                  pool.length <= 3 ? 'grid-cols-3' : 'grid-cols-4',
                )}
              >
                {pool.map((p) => (
                  <li key={p.id} className="min-w-0">
                    <span className="block aspect-[5/7]">
                      <FramedArt prize={p} eager />
                    </span>
                    <span className="font-heading mt-1 block truncate text-xs text-chase tabular-nums">
                      {rmAuto(tilePrice(p.value_myr))}
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-neutral-300">
                      {p.title}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <p className="mt-4 text-sm text-neutral-400 short:mt-3">
              You have{' '}
              <span className="font-semibold text-white tabular-nums">
                {num(balance)}
              </span>{' '}
              {balance === 1 ? 'ticket' : 'tickets'}.
            </p>

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                className={stepBtn}
                aria-label="One ticket fewer"
                disabled={pending || amount <= 1}
                onClick={() => setAmount(amount - 1)}
              >
                <Minus className="h-5 w-5" aria-hidden />
              </button>
              <label className="sr-only" htmlFor="enter-tickets">
                Tickets to enter
              </label>
              <input
                id="enter-tickets"
                type="number"
                inputMode="numeric"
                min={1}
                max={max}
                step={1}
                value={raw}
                disabled={pending || max === 0}
                onChange={(e) => setRaw(e.target.value)}
                onBlur={() => setAmount(amount)}
                className="font-heading h-12 min-w-0 flex-1 rounded-xl bg-neutral-800 px-3 text-center text-xl text-white tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-white/40"
              />
              <button
                type="button"
                className={stepBtn}
                aria-label="One ticket more"
                disabled={pending || amount >= max}
                onClick={() => setAmount(amount + 1)}
              >
                <Plus className="h-5 w-5" aria-hidden />
              </button>
              <button
                type="button"
                disabled={pending || max === 0}
                onClick={() => setAmount(max)}
                className={cn(
                  pillVariants({ variant: 'secondary', size: 'lg' }),
                )}
              >
                Max
              </button>
            </div>

            <p className="mt-3 text-sm text-neutral-400">
              Your chance after this:{' '}
              <span className="font-semibold text-white tabular-nums">
                {chancePercent(
                  prize.my_tickets + (valid ? amount : 0),
                  prize.total_tickets + (valid ? amount : 0),
                )}
              </span>
            </p>
            {amount > max && (
              <p className="mt-1 text-xs text-red-400">
                You have {num(balance)} {balance === 1 ? 'ticket' : 'tickets'}.
              </p>
            )}
            <p className="mt-1 text-xs leading-relaxed text-neutral-400">
              {pot
                ? `${closesAt ? `Tickets close ${poolWhen(closesAt, nowMs)}. ` : ''}Entries are final: tickets you put in can’t be taken back.`
                : 'Entries are final — tickets on a prize can’t be taken back.'}
            </p>

            {error && (
              <div role="alert" className="mt-3 text-sm text-red-400">
                <p>{error.text}</p>
                {error.topUp && (
                  <Link
                    href="/wallet"
                    className={cn(
                      pillVariants({ variant: 'secondary', size: 'sm' }),
                      'mt-2',
                    )}
                  >
                    Top up
                  </Link>
                )}
              </div>
            )}

            {/* Stays on screen when a short phone has to scroll the sheet. */}
            <Pill
              size="lg"
              className="sticky bottom-0 mt-4 w-full short:mt-3"
              disabled={pending || !valid || closed}
              onClick={confirm}
            >
              {closed
                ? 'Tickets are closed'
                : pending
                  ? 'Entering…'
                  : `${pot ? 'Put in' : 'Enter'} ${num(amount)} ${amount === 1 ? 'ticket' : 'tickets'}`}
            </Pill>
          </div>
        </div>
      </div>
    </div>
  );
}
