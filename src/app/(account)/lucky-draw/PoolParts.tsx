'use client';

import { useRef } from 'react';
import { X } from 'lucide-react';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { GLASS_SUBTLE, useLiquidGlass } from '@/lib/use-liquid-glass';
import { cn } from '@/lib/utils';
import { rmAuto } from '@/lib/format';
import { HOLO_STOPS, holoConic } from '@/lib/lucky-draw';
import type { LuckyDrawArtFrame } from '@/lib/data/schemas';
import { PrizeArt } from './PrizeCard';

/** What a gate's pictures need of a prize. */
export type PoolPrize = {
  kind?: string;
  title: string;
  image: string | null;
  frame?: LuckyDrawArtFrame;
  value_myr: number;
};

// The frame's soft glow, in its own foil (SpinWheel's).
const HOLO_FRAME_GLOW = `0 0 40px ${HOLO_STOPS[1]}2e, 0 0 90px ${HOLO_STOPS[0]}1c`;
const PEDESTAL = 'bg-[radial-gradient(90%_60%_at_50%_30%,#2a2a2e,#121214_70%)]';

/** A prize's art in its frame. Fills its parent, which sets the 5:7 shape. A card
 *  wears the Lucky Draw frame and needs nothing else round it; the rest, a credit
 *  prize or the admin's own art, sit on the pedestal. */
export function FramedArt({
  prize,
  holo = false,
  eager = false,
}: {
  prize: PoolPrize;
  holo?: boolean;
  eager?: boolean;
}) {
  if (prize.frame) {
    return (
      <span className="relative block h-full w-full">
        <PrizeArt
          src={prize.image}
          kind={prize.kind}
          eager={eager}
          frame={prize.frame}
          glowScale={holo ? 0.4 : 0.15}
        />
      </span>
    );
  }
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
