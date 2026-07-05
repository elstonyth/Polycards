'use client';

// Odometer-style money display ("The Meter", spec decision #4). Each digit sits
// in a vertical 0-9 column that rolls to the new value; separators crossfade.
// direction 'up' = clunk+shimmer treatment, 'down' = quiet tick (sounds fired
// by the caller — this component is visual only).
import { type CSSProperties } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { rm } from '@/lib/format';
import { meterChars } from '@/lib/meter';
import { cn } from '@/lib/utils';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

export function Meter({
  value,
  direction,
  reduced,
  className,
}: {
  value: number;
  direction: 'up' | 'down' | null;
  reduced: boolean;
  className?: string;
}) {
  const cells = meterChars(rm(value));
  if (reduced) {
    return <span className={cn('tabular-nums', className)}>{rm(value)}</span>;
  }
  return (
    <span
      className={cn(
        'relative inline-flex items-baseline overflow-hidden tabular-nums',
        className,
      )}
    >
      {cells.map((cell, i) =>
        cell.digit ? (
          // The cell keeps `overflow: visible` and takes its baseline from an
          // invisible in-flow anchor glyph — an overflow-hidden inline-block
          // instead baselines at its box BOTTOM, which dropped the rolling
          // digits ~8px off the RM/decimal line (spec decision #32, measured).
          // The rolling 0-9 column lives in a SEPARATE absolutely-positioned
          // clip element, so clipping never touches the cell's baseline.
          <span
            key={`d-${i}`}
            className="relative inline-block leading-none"
            aria-hidden
          >
            <span className="invisible">{cell.char}</span>
            <span className="absolute inset-0 overflow-hidden">
              <motion.span
                className="absolute inset-x-0 top-0 flex flex-col items-center leading-none"
                animate={{ y: `-${Number(cell.char)}em` }}
                transition={{
                  duration: direction === 'down' ? 0.3 : 0.4,
                  ease: [0.16, 1, 0.3, 1],
                }}
              >
                {DIGITS.map((d) => (
                  <span key={d} className="h-[1em]">
                    {d}
                  </span>
                ))}
              </motion.span>
            </span>
          </span>
        ) : (
          <AnimatePresence key={`s-${i}`} mode="popLayout" initial={false}>
            <motion.span
              key={cell.char}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              aria-hidden
            >
              {cell.char}
            </motion.span>
          </AnimatePresence>
        ),
      )}
      {/* Warm shimmer sweep on upward rolls (spec: add = clunk + shimmer). */}
      {direction === 'up' && (
        <motion.span
          key={value}
          aria-hidden
          className="pointer-events-none absolute inset-0"
          initial={{ x: '-100%' }}
          animate={{ x: '100%' }}
          transition={{ duration: 0.45, ease: 'easeOut' }}
          style={
            {
              background:
                'linear-gradient(105deg, transparent 30%, rgba(255,220,150,0.35) 50%, transparent 70%)',
            } as CSSProperties
          }
        />
      )}
      <span className="sr-only">{rm(value)}</span>
    </span>
  );
}
