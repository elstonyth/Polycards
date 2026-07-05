// src/app/slots/[slug]/SlotControls.tsx
'use client';

import type { ReactNode } from 'react';
import { Sparkles, Info, Minus, Plus, Volume2, VolumeX } from 'lucide-react';

export function SlotControls({
  costLine,
  spinning,
  disabled,
  label,
  muted,
  onSpin,
  onToggleMute,
  onOpenOdds,
  onAddReel,
  onRemoveReel,
  addDisabled,
  removeDisabled,
}: {
  costLine: ReactNode;
  spinning: boolean;
  disabled: boolean;
  label: string;
  muted: boolean;
  onSpin: () => void;
  onToggleMute: () => void;
  onOpenOdds: () => void;
  /** Add/remove reel controls, now docked in the control row (spec decision #18). */
  onAddReel?: () => void;
  onRemoveReel?: () => void;
  addDisabled?: boolean;
  removeDisabled?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex w-full max-w-[420px] items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={onOpenOdds}
          className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Odds"
        >
          <Info className="h-5 w-5" aria-hidden />
        </button>

        {/* Control row order [Odds] [−] [Spin] [+] [Mute] (spec decision #20):
            (−) left of Spin, (+) right. aria-labels stay exact — QA + e2e target
            "Remove a reel" / "Add a reel". */}
        {onRemoveReel && (
          <button
            type="button"
            onClick={onRemoveReel}
            disabled={removeDisabled}
            aria-label="Remove a reel"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30"
          >
            <Minus className="h-5 w-5" aria-hidden />
          </button>
        )}

        <button
          type="button"
          onClick={onSpin}
          disabled={disabled}
          className="inline-flex h-14 flex-1 items-center justify-center gap-2 rounded-2xl bg-chase text-base font-bold text-neutral-950 transition-colors hover:bg-chase/90 disabled:opacity-50"
        >
          <Sparkles className="h-5 w-5" aria-hidden />
          {spinning ? 'Spinning…' : label}
        </button>

        {onAddReel && (
          <button
            type="button"
            onClick={onAddReel}
            disabled={addDisabled}
            aria-label="Add a reel"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30"
          >
            <Plus className="h-5 w-5" aria-hidden />
          </button>
        )}

        <button
          type="button"
          onClick={onToggleMute}
          aria-label={muted ? 'Unmute' : 'Mute'}
          aria-pressed={muted}
          className="inline-flex h-12 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-4 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          {muted ? (
            <VolumeX className="h-5 w-5" aria-hidden />
          ) : (
            <Volume2 className="h-5 w-5" aria-hidden />
          )}
        </button>
      </div>

      <div className="text-[12px] text-white/60">{costLine}</div>
    </div>
  );
}
