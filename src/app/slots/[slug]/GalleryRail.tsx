// src/app/slots/[slug]/GalleryRail.tsx
'use client';

// Horizontal review rail (spec decision #8): active card center stage,
// neighbors peek dimmer/smaller/angled from the edges; swipe with momentum
// snaps to a card; desktop gets visible prev/next buttons.
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

export function GalleryRail({
  count,
  activeIndex,
  onIndexChange,
  reduced,
  children,
}: {
  count: number;
  activeIndex: number;
  onIndexChange: (i: number) => void;
  reduced: boolean;
  children: (index: number) => React.ReactNode;
}) {
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));

  // Center by MEASURED px, not by a vw formula: each item is w-[70vw]
  // max-w-[320px], so once 70vw clamps to 320px the vw step no longer matches
  // the item width and the active card lands off-screen (>~457px viewport).
  // A ResizeObserver (not a one-shot layout read) is required: the rail mounts
  // during the reveal theater and its items start at width 0 until the flex
  // resolves — a single measure races that and leaves x=0 (track left-aligned,
  // active card off-center). The observer fires the moment real dimensions land
  // and on every subsequent resize.
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRef = useRef<HTMLDivElement>(null);
  const [{ containerWidth, itemWidth }, setDims] = useState({
    containerWidth: 0,
    itemWidth: 0,
  });
  useEffect(() => {
    // offsetWidth = untransformed layout box (getBoundingClientRect would fold
    // in the Framer scale animation and give a wrong step width).
    const measure = () =>
      setDims({
        containerWidth: containerRef.current?.offsetWidth ?? 0,
        itemWidth: itemRef.current?.offsetWidth ?? 0,
      });
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    if (itemRef.current) ro.observe(itemRef.current);
    return () => ro.disconnect();
  }, [count]);

  // Track offset that puts card i dead-center. itemWidth includes the px-2
  // gutter (part of the box), so the per-step distance is exactly itemWidth.
  const centerX = (i: number) =>
    itemWidth > 0 ? containerWidth / 2 - itemWidth / 2 - i * itemWidth : 0;

  // Two decoupled layers so drag and positioning never fight over one transform:
  //  • OUTER drag layer — captures the swipe gesture only; dragConstraints pins
  //    it at origin so it doesn't move (offset/velocity in onDragEnd are relative
  //    and still meaningful). Reading position off the drag node is what broke
  //    before (`drag` owns x, so an animate on the same node gets clamped).
  //  • INNER track — owns the resting position via the declarative animate={{ x }}
  //    prop (no drag on this node → nothing interrupts it; a mid-reveal remount
  //    can't strand a half-finished imperative spring).
  const targetX = centerX(activeIndex);

  return (
    <div className="relative flex w-full flex-col items-center gap-3">
      <div ref={containerRef} className="relative w-full overflow-hidden">
        <motion.div
          drag={count > 1 && !reduced ? 'x' : false}
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={0.18}
          onDragEnd={(_, info) => {
            if (info.offset.x < -60 || info.velocity.x < -400) {
              onIndexChange(clamp(activeIndex + 1));
            } else if (info.offset.x > 60 || info.velocity.x > 400) {
              onIndexChange(clamp(activeIndex - 1));
            }
          }}
          style={{ touchAction: 'pan-y' }}
        >
          <motion.div
            className="flex items-center"
            animate={{ x: targetX }}
            transition={
              reduced
                ? { duration: 0 }
                : { type: 'spring', stiffness: 260, damping: 30 }
            }
          >
            {Array.from({ length: count }, (_, i) => {
              const isActive = i === activeIndex;
              return (
                <motion.div
                  key={i}
                  ref={i === 0 ? itemRef : undefined}
                  // 70vw (was 78vw) leaves ~40px of neighbor inside a 390px
                  // viewport — the peek that makes swiping discoverable (spec
                  // decision #30). Origin anchors to the INNER edge so the
                  // 0.9 shrink can't pull that peek back off-screen.
                  className="w-[70vw] max-w-[320px] shrink-0 px-2"
                  style={{
                    transformOrigin:
                      i < activeIndex
                        ? '100% 50%'
                        : i > activeIndex
                          ? '0% 50%'
                          : '50% 50%',
                  }}
                  animate={{
                    scale: isActive ? 1 : 0.9,
                    opacity: isActive ? 1 : 0.55,
                    rotateY: reduced ? 0 : (i - activeIndex) * -14,
                  }}
                  transition={
                    reduced
                      ? { duration: 0 }
                      : { duration: 0.3, ease: 'easeOut' }
                  }
                  onClick={() => !isActive && onIndexChange(i)}
                >
                  {children(i)}
                </motion.div>
              );
            })}
          </motion.div>
        </motion.div>
        {/* desktop prev/next */}
        {count > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous card"
              onClick={() => onIndexChange(clamp(activeIndex - 1))}
              disabled={activeIndex === 0}
              className="absolute left-2 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white/70 hover:text-white disabled:opacity-30 sm:flex"
            >
              <ChevronLeft className="h-5 w-5" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Next card"
              onClick={() => onIndexChange(clamp(activeIndex + 1))}
              disabled={activeIndex === count - 1}
              className="absolute right-2 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white/70 hover:text-white disabled:opacity-30 sm:flex"
            >
              <ChevronRight className="h-5 w-5" aria-hidden />
            </button>
          </>
        )}
      </div>
      {count > 1 && (
        <p className={cn('text-[12px] font-medium text-white/50')}>
          {activeIndex + 1} of {count}
        </p>
      )}
    </div>
  );
}
