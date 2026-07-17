'use client';

import { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { X } from 'lucide-react';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { useCardPrice } from '@/lib/use-card-price';
import { CardDetail } from '@/components/cards/CardDetail';
import type { Rarity } from '@/lib/packs-data';

/** The minimum a grid knows about a card — enough to open the overlay
 *  INSTANTLY; the endpoint hydrates the rest (set/grade/history) via
 *  useCardPrice. `value` is the already-formatted "RM 4,850" string. */
export interface CardSeed {
  handle: string;
  name: string;
  image: string;
  slabImage: string | null;
  value: string;
  rarity: Rarity | null;
}

/**
 * Full-screen card detail overlay. Open = seed
 * present. The URL becomes /card/<handle> via pushState so the link is
 * shareable and browser Back closes the overlay; Esc/backdrop/Close call
 * history.back() so the two paths converge on one popstate. Direct visits to
 * /card/<handle> never see this component — the server page renders instead.
 */
export function CardDetailOverlay({
  seed,
  buybackPercent = null,
  onClose,
}: {
  seed: CardSeed | null;
  buybackPercent?: number | null;
  onClose: () => void;
}) {
  const handle = seed?.handle ?? null;
  const open = handle !== null;
  const reduced = usePrefersReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const detail = useCardPrice(handle, null);

  // onClose read through a ref so effects don't re-run on parent re-renders.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const close = () => onCloseRef.current();
  useModalA11y(panelRef, open, close);

  // Latest handle, readable from the open-keyed effect without depending on it.
  const handleRef = useRef(handle);
  useEffect(() => {
    handleRef.current = handle;
  });

  // URL sync. pushedRef distinguishes "closed by Back" (history already moved)
  // from "closed by Esc/Close" (we still owe a history.back()).
  const pushedRef = useRef(false);

  // One pushed history entry per open/close cycle. Keyed on `open` (null↔card
  // transitions only) so a card→card switch never tears this effect down —
  // that's what made back() race pushState.
  useEffect(() => {
    if (!open) return;
    window.history.pushState(
      { polycardsCardOverlay: true },
      '',
      `/card/${encodeURIComponent(handleRef.current ?? '')}`,
    );
    pushedRef.current = true;
    const onPop = () => {
      pushedRef.current = false;
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (pushedRef.current) {
        pushedRef.current = false;
        window.history.back();
      }
    };
  }, [open]);

  // Card→card switch while open: swap the URL in place — replaceState performs
  // no traversal, so there is nothing to race.
  useEffect(() => {
    if (handle && pushedRef.current) {
      window.history.replaceState(
        { polycardsCardOverlay: true },
        '',
        `/card/${encodeURIComponent(handle)}`,
      );
    }
  }, [handle]);

  if (!seed) return null;

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      className="glass-scrim fixed inset-0 z-[100] overflow-y-auto"
      onClick={close}
      role="presentation"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={seed.name}
        onClick={(e) => e.stopPropagation()}
        className="mx-auto flex min-h-full w-full flex-col px-fluid py-3 outline-none md:py-6"
      >
        <button
          type="button"
          onClick={close}
          className="mb-3 inline-flex w-fit items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10 md:mb-6"
        >
          <X className="h-4 w-4" aria-hidden /> Close
        </button>
        <motion.div
          initial={reduced ? false : { opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-1 items-center pb-4 md:pb-10"
        >
          <CardDetail
            seed={seed}
            detail={detail}
            buybackPercent={buybackPercent}
          />
        </motion.div>
      </div>
    </motion.div>
  );
}
