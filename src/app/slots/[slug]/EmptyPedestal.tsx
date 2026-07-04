'use client';

// Ghost outline of the NEXT reel column with a soft "+" (spec decision #12).
// Idle-only; the parent hides it during spin/reveal and at 3 reels.
import { Plus } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ITEM_H } from '@/lib/reel';
import { VISIBLE_CELLS } from '@/lib/vault-reel';

export function EmptyPedestal({
  cellSize,
  onAdd,
  visible,
  reduced,
}: {
  cellSize: number;
  onAdd: () => void;
  visible: boolean;
  reduced: boolean;
}) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.button
          type="button"
          onClick={onAdd}
          aria-label="Add a reel"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{
            duration: reduced ? 0.15 : 0.3,
            ease: [0.16, 1, 0.3, 1],
          }}
          className="flex items-center justify-center rounded-2xl border border-dashed border-amber-100/25 bg-white/[0.02] text-amber-100/50 transition-colors hover:border-amber-100/50 hover:text-amber-100/90"
          style={{
            height: `clamp(200px, calc(100dvh - 320px), ${ITEM_H * VISIBLE_CELLS}px)`,
            width: `${cellSize + 24}px`,
          }}
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-full border border-amber-100/30">
            <Plus className="h-5 w-5" aria-hidden />
          </span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
