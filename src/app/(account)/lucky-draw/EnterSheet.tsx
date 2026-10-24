'use client';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { Minus, Plus, X } from 'lucide-react';
import { Pill, pillVariants } from '@/components/ui/pill';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { cn } from '@/lib/utils';
import { num, rmAuto } from '@/lib/format';
import {
  enterLuckyDraw,
  type EnterLuckyDrawResult,
} from '@/lib/actions/lucky-draw';
import {
  chancePercent,
  MAX_ENTRY_TICKETS,
  refusalCopy,
} from '@/lib/lucky-draw';
import type { LuckyDrawPrize } from '@/lib/data/schemas';
import { PrizeArt } from './PrizeCard';

export type Entered = Extract<EnterLuckyDrawResult, { entered: true }>;

const stepBtn =
  'flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-neutral-800 text-white transition-colors outline-none hover:bg-neutral-700 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-40';

/**
 * Pick how many tickets go on one prize (spec §5): a stepper with Max, my
 * chance after entering, then one confirm. Entries are final, so the confirm
 * locks while the entry is in flight and a refusal is answered in words.
 */
export function EnterSheet({
  prize,
  balance,
  onClose,
  onEntered,
}: {
  prize: LuckyDrawPrize;
  balance: number;
  onClose: () => void;
  onEntered: (prize: LuckyDrawPrize, tickets: number, res: Entered) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, true, onClose);
  const max = Math.max(0, Math.min(balance, MAX_ENTRY_TICKETS));
  const [amount, setAmount] = useState(Math.min(1, max));
  const [error, setError] = useState<{ text: string; topUp: boolean } | null>(
    null,
  );
  const [pending, startTransition] = useTransition();
  const clamp = (n: number) =>
    Math.max(1, Math.min(max, Number.isFinite(n) ? Math.trunc(n) : 1));
  const valid = amount >= 1 && amount <= max;

  const confirm = () =>
    startTransition(async () => {
      setError(null);
      const res = await enterLuckyDraw(prize.id, amount);
      if (!res.ok) setError({ text: res.error, topUp: false });
      else if (!res.entered) {
        setError({
          text: refusalCopy(res.reason),
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
        className="glass-panel max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl border p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none sm:max-w-md sm:rounded-2xl"
      >
        <div className="flex items-start gap-3">
          <span className="relative aspect-[5/7] w-14 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-white/[0.04] p-1">
            <span className="relative block h-full w-full">
              <PrizeArt src={prize.image} kind={prize.kind} sizes="56px" />
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="enter-sheet-title"
              className="text-base leading-snug font-semibold text-white"
            >
              Enter {prize.title}
            </h2>
            <p className="font-heading mt-0.5 text-lg text-chase tabular-nums">
              {rmAuto(prize.value_myr)}
            </p>
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

        <p className="mt-4 text-sm text-neutral-400">
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
            onClick={() => setAmount((n) => clamp(n - 1))}
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
            value={amount}
            disabled={pending || max === 0}
            onChange={(e) => setAmount(clamp(e.target.valueAsNumber))}
            className="font-heading h-12 min-w-0 flex-1 rounded-xl bg-neutral-800 px-3 text-center text-xl text-white tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          />
          <button
            type="button"
            className={stepBtn}
            aria-label="One ticket more"
            disabled={pending || amount >= max}
            onClick={() => setAmount((n) => clamp(n + 1))}
          >
            <Plus className="h-5 w-5" aria-hidden />
          </button>
          <button
            type="button"
            disabled={pending || max === 0}
            onClick={() => setAmount(max)}
            className={cn(pillVariants({ variant: 'secondary', size: 'lg' }))}
          >
            Max
          </button>
        </div>

        <p className="mt-3 text-sm text-neutral-400">
          My chance after entering:{' '}
          <span className="font-semibold text-white tabular-nums">
            {chancePercent(
              prize.my_tickets + amount,
              prize.total_tickets + amount,
            )}
          </span>
        </p>
        <p className="mt-1 text-xs leading-relaxed text-neutral-400">
          Entries are final — tickets on a prize can&rsquo;t be taken back.
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

        <Pill
          size="lg"
          className="mt-4 w-full"
          disabled={pending || !valid}
          onClick={confirm}
        >
          {pending
            ? 'Entering…'
            : `Enter ${num(amount)} ${amount === 1 ? 'ticket' : 'tickets'}`}
        </Pill>
      </div>
    </div>
  );
}
