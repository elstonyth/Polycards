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

// One 44px round hit area per control: the old 28px buttons were the smallest
// targets on the catalog. The press is a spring-curve scale, never a layout move.
const STEP =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-neutral-300 outline-none transition-[background-color,color,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-white/10 hover:text-white active:scale-[0.92] focus-visible:ring-2 focus-visible:ring-white/40 disabled:pointer-events-none disabled:opacity-35 motion-reduce:transition-[background-color,color] motion-reduce:active:scale-100';

/**
 * Controlled quantity stepper — `− [n] + MAX`, one pill. Used by the /slots
 * catalog pack cards (the /repacks and /claw routes that also carried it are
 * gone). The caller owns the qty state; this clamps to [1, max] and reports
 * the new value.
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
        'flex h-11 items-center rounded-full bg-white/[0.06] ring-1 ring-white/10',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onChange(Math.max(1, qty - 1))}
        disabled={qty <= 1}
        aria-label="Decrease quantity"
        className={STEP}
      >
        <Minus className="h-4 w-4" strokeWidth={1.5} aria-hidden />
      </button>
      <span className="min-w-5 text-center text-sm font-semibold tabular-nums text-white">
        {qty}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, qty + 1))}
        disabled={qty >= max}
        aria-label="Increase quantity"
        className={STEP}
      >
        <Plus className="h-4 w-4" strokeWidth={1.5} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => onChange(max)}
        className={cn(
          STEP,
          'ml-auto w-auto px-3 text-xs font-semibold uppercase tracking-[0.12em] text-neutral-400',
        )}
      >
        Max
      </button>
    </div>
  );
}
