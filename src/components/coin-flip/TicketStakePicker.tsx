'use client';

import { useEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { COIN_FLIP_MAX_TICKETS } from '@/lib/coin-flip';
import { num } from '@/lib/format';
import { TicketArt } from '@/components/TicketArt';
import { Pill } from '@/components/ui/pill';

const STEP =
  'flex size-11 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-neutral-200 transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-40';

/**
 * How many Lucky Draw tickets go into this flip, on top of any cards. 0 means
 * none. The caller keeps it within the balance, so a typed amount above the limit
 * lands on the limit.
 *
 * One line with an Add button until tickets are wanted: most flips have none, and
 * the call and Review have to stay within reach on a phone.
 */
export function TicketStakePicker({
  balance,
  value,
  disabled = false,
  onChange,
}: {
  balance: number;
  value: number;
  disabled?: boolean;
  onChange: (tickets: number) => void;
}) {
  // Holds the field open while it is empty mid-typing.
  const [editing, setEditing] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // Add and the last − remove the button just pressed, so focus moves on with it.
  const moveFocus = useRef(false);
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    const buttons = root.current?.querySelectorAll('button');
    // Add collapses to its one button; otherwise +, or − when + is at the limit.
    const next = value > 0 && !buttons?.[1]?.disabled ? 1 : 0;
    buttons?.[next]?.focus({ preventScroll: true });
  });
  const max = Math.min(balance, COIN_FLIP_MAX_TICKETS);
  const set = (next: number) => onChange(Math.max(0, Math.min(max, next)));
  const summary = (
    <>
      <TicketArt width={48} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">Add Lucky Draw tickets</p>
        <p className="mt-0.5 text-xs text-neutral-400 tabular-nums">
          You have {num(balance)}
        </p>
      </div>
    </>
  );
  if (value === 0 && !editing) {
    return (
      <div ref={root} className="flex items-center gap-3">
        {summary}
        <Pill
          variant="secondary"
          disabled={disabled}
          onClick={() => {
            moveFocus.current = true;
            set(1);
          }}
        >
          Add
        </Pill>
      </div>
    );
  }
  return (
    <div ref={root}>
      <div className="flex items-center gap-3">{summary}</div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          aria-label="One ticket fewer"
          disabled={disabled || value <= 0}
          onClick={() => {
            moveFocus.current = value === 1;
            set(value - 1);
          }}
          className={STEP}
        >
          <Minus size={16} aria-hidden />
        </button>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-label="Tickets to flip"
          placeholder="0"
          disabled={disabled}
          value={value === 0 ? '' : String(value)}
          onChange={(event) =>
            set(Number(event.target.value.replace(/\D/g, '')))
          }
          onFocus={(event) => {
            setEditing(true);
            event.target.select();
          }}
          onBlur={() => setEditing(false)}
          className="h-11 w-full min-w-0 flex-1 rounded-full border border-white/10 bg-neutral-950 text-center font-display text-lg tabular-nums text-white outline-none placeholder:text-neutral-500 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50"
        />
        <button
          type="button"
          aria-label="One ticket more"
          disabled={disabled || value >= max}
          onClick={() => set(value + 1)}
          className={STEP}
        >
          <Plus size={16} aria-hidden />
        </button>
        <Pill
          variant="secondary"
          disabled={disabled || value === max}
          onClick={() => set(max)}
        >
          Max
        </Pill>
      </div>
    </div>
  );
}
