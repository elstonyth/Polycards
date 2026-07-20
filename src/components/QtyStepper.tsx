'use client';

import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

type QtyStepperProps = {
  qty: number;
  onChange: (qty: number) => void;
  /** Upper bound for the + / MAX buttons. */
  max?: number;
  className?: string;
};

/**
 * Controlled quantity stepper — `− [n] + MAX`. Shared by the /repacks and /claw
 * pack cards (the live site shows it on both). The caller owns the qty state;
 * this component just clamps to [1, max] and reports the new value.
 */
export default function QtyStepper({
  qty,
  onChange,
  max = 10,
  className,
}: QtyStepperProps) {
  return (
    <div
      className={cn(
        // flex-wrap: the +/- buttons hold 28px now (shrink-0, for tap size), so
        // on a 320px screen the row's min-content exceeded a repack card and
        // pushed the page into horizontal scroll. Wrapping "Max" onto its own
        // line costs a few pixels of height and nothing else.
        'flex flex-wrap items-center gap-1 rounded-xl border border-white/10 bg-white/5 p-1',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onChange(Math.max(1, qty - 1))}
        disabled={qty <= 1}
        aria-label="Decrease quantity"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
      >
        <Minus className="h-3.5 w-3.5" aria-hidden />
      </button>
      <span className="min-w-[1.75rem] text-center text-[13px] font-semibold tabular-nums text-white">
        {qty}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, qty + 1))}
        disabled={qty >= max}
        aria-label="Increase quantity"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => onChange(max)}
        // min-h-6: the label is 10px, so padding alone left the box at 23px —
        // one pixel under the WCAG 2.2 AA target-size minimum.
        className="ml-auto flex min-h-6 items-center rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white/50 transition-colors hover:bg-white/10 hover:text-white"
      >
        Max
      </button>
    </div>
  );
}
