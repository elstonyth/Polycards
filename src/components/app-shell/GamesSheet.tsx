'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { X } from 'lucide-react';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { GLASS_SUBTLE, useLiquidGlass } from '@/lib/use-liquid-glass';
import { GAMES_EVENT } from './games';

/**
 * The game picker the Games tab opens (operator 2026-10-25): a bottom sheet
 * on phones, a centred dialog on desktop. Coin Flip is coming soon; Lucky Draw
 * has its own tab since 2026-10-30. Swipe down, tap outside, X or Escape closes
 * it.
 */
export function GamesSheet() {
  // Open on the page it was opened from: any navigation (browser back
  // included) closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const pathname = usePathname();
  // A navigation that bypasses close() (the back gesture, a redirect) must
  // still drop it, or the sheet reopens by itself on the next visit here.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpenOn(null);
  }
  // Run once the sheet has fully gone: its focus restore (useModalA11y) must
  // land first, or it pulls focus back out of whatever opens next.
  const afterClose = useRef<(() => void) | null>(null);
  const close = (then?: () => void) => {
    afterClose.current = then ?? null;
    setOpenOn(null);
  };

  useEffect(() => {
    const show = () => setOpenOn(window.location.pathname);
    window.addEventListener(GAMES_EVENT, show);
    return () => window.removeEventListener(GAMES_EVENT, show);
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence
        onExitComplete={() => {
          const then = afterClose.current;
          afterClose.current = null;
          if (then) window.setTimeout(then, 0);
        }}
      >
        {openOn === pathname && <Panel onClose={close} />}
      </AnimatePresence>
    </MotionConfig>
  );
}

function Panel({ onClose }: { onClose: (then?: () => void) => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, true, onClose);
  useLiquidGlass(panelRef, true, GLASS_SUBTLE);

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
      <motion.div
        aria-hidden
        className="absolute inset-0 bg-black/50"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={() => onClose()}
      />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="games-title"
        tabIndex={-1}
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 34, stiffness: 380 }}
        drag="y"
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.6 }}
        onDragEnd={(_, info) => {
          if (info.offset.y > 90 || info.velocity.y > 600) onClose();
        }}
        className="glass-panel relative w-full rounded-t-3xl border p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] outline-none sm:max-w-md sm:rounded-3xl"
      >
        <span
          aria-hidden
          className="mx-auto -mt-1 mb-4 block h-1 w-10 rounded-full bg-white/25 sm:hidden"
        />
        <div className="flex items-center justify-between">
          <h2 id="games-title" className="font-heading text-2xl text-white">
            GAMES
          </h2>
          <button
            type="button"
            onClick={() => onClose()}
            aria-label="Close"
            className="-mr-2 flex h-11 w-11 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <ul className="mt-4 grid grid-cols-2 gap-3">
          <li>
            <SoonTile
              title="COIN FLIP"
              art={
                <Image
                  src="/images/task/credits-coins.webp"
                  alt=""
                  width={104}
                  height={104}
                  className="h-auto w-[66%] max-w-[104px]"
                />
              }
            />
          </li>
        </ul>
      </motion.div>
    </div>
  );
}

/** A game that isn't on yet: greyed out and not tappable. */
function SoonTile({ title, art }: { title: string; art: ReactNode }) {
  return (
    <div
      aria-disabled="true"
      className="relative flex min-h-[14rem] flex-col sm:aspect-[4/5] justify-end overflow-hidden rounded-2xl border border-white/10 bg-neutral-900 p-3"
    >
      <span className="absolute top-3 left-3 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-neutral-300 uppercase">
        Soon
      </span>
      <span className="absolute inset-x-0 top-7 flex justify-center opacity-50 grayscale-[0.4]">
        {art}
      </span>
      <span className="font-heading text-lg leading-tight text-neutral-300">
        {title}
      </span>
      <span className="mt-0.5 text-xs text-neutral-500">Coming soon</span>
    </div>
  );
}
