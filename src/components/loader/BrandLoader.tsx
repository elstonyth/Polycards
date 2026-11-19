'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  animate,
  motion,
  useMotionValue,
  useTransform,
  type MotionValue,
} from 'motion/react';
import {
  LOGO_LETTERS,
  LOGO_MARK,
  LOGO_MARK_STROKE,
  LOGO_VIEWBOX,
} from '@/components/brand/polycards-logo-paths';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import {
  DEFAULT_TIMINGS,
  cubicBezier,
  REVEAL_MS,
  leaveAtMs,
  letterOffset,
  pathYExtent,
  splitSubpaths,
  strokeProgress,
  type LoaderTimings,
} from './loader-timeline';

const MARK_STROKES = splitSubpaths(LOGO_MARK);

// The cut line sits just under the lowest ink (the y's descender); every letter starts
// a full letter-height below it, so it rises out of nothing.
const LETTER_EXTENTS = LOGO_LETTERS.map((letter) => pathYExtent(letter.d));
const INK_TOP = Math.min(...LETTER_EXTENTS.map((e) => e.minY));
const CUT_Y = Math.max(...LETTER_EXTENTS.map((e) => e.maxY)) + 1.5;
const TRAVEL = CUT_Y - INK_TOP + 1.5;
// Side padding on each letter's clip column so antialiased edges are never shaved.
const COLUMN_PAD = 1;

const exitEase = cubicBezier(0.4, 0, 0.2, 1);

export interface BrandLoaderProps {
  /** True once whatever the loader covers is ready to be seen. */
  ready: boolean;
  /** Called once, after the exit fade, when the loader has unmounted its overlay. */
  onDone?: () => void;
  /** Earliest exit in ms (default 1600, so the reveal always completes). */
  minMs?: number;
  /** Exit after this many ms even if `ready` never comes (default 6000). */
  maxMs?: number;
  /** Exit fade length in ms (default 400). */
  exitMs?: number;
  /**
   * Preview and capture only: freeze the reveal at this fraction of its timeline
   * (0..1) and never leave.
   */
  pinAt?: number;
}

/**
 * Full-screen brand loader: the Polycards mark draws itself, then the wordmark rises
 * letter by letter from below a cut line. Leaves once `ready` and the minimum time
 * have both passed, or at the maximum wait, whichever is first.
 */
export function BrandLoader({
  ready,
  onDone,
  minMs = DEFAULT_TIMINGS.minMs,
  maxMs = DEFAULT_TIMINGS.maxMs,
  exitMs = DEFAULT_TIMINGS.exitMs,
  pinAt,
}: BrandLoaderProps) {
  const reduced = usePrefersReducedMotion();
  const pinned = pinAt !== undefined;
  const clock = useMotionValue(pinned ? clampPin(pinAt) * REVEAL_MS : 0);
  const [leaving, setLeaving] = useState(false);
  const startRef = useRef<number | null>(null);
  const readyAtRef = useRef<number | null>(null);
  const onDoneRef = useRef(onDone);
  const doneCalledRef = useRef(false);
  const [gone, setGone] = useState(false);
  // Exit progress 0..1. A plain motion value runs on motion's JS frame loop (not
  // WAAPI), so the exit is frame-exact under a stepped clock, like the reveal.
  const exit = useMotionValue(0);
  const overlayOpacity = useTransform(exit, (p) => 1 - exitEase(p));
  const logoOpacity = useTransform(
    exit,
    (p) => 1 - exitEase(Math.min(1, p / 0.9)),
  );
  const logoY = useTransform(exit, (p) => -10 * exitEase(p));

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  // Reveal clock: pinned holds one frame, reduced motion jumps to the finished logo.
  useEffect(() => {
    if (pinned) {
      clock.set(clampPin(pinAt) * REVEAL_MS);
      return;
    }
    if (reduced) {
      clock.set(REVEAL_MS);
      return;
    }
    const controls = animate(clock, REVEAL_MS, {
      duration: (REVEAL_MS - clock.get()) / 1000,
      ease: 'linear',
    });
    return () => controls.stop();
  }, [clock, pinned, pinAt, reduced]);

  // Exit timer, measured from mount so re-renders or `ready` flipping never restart it.
  useEffect(() => {
    if (pinned || leaving) return;
    const now = performance.now();
    if (startRef.current === null) startRef.current = now;
    const elapsed = now - startRef.current;
    if (ready && readyAtRef.current === null) readyAtRef.current = elapsed;
    const timings: LoaderTimings = { minMs, maxMs, exitMs };
    const wait = Math.max(0, leaveAtMs(readyAtRef.current, timings) - elapsed);
    const id = window.setTimeout(() => setLeaving(true), wait);
    return () => window.clearTimeout(id);
  }, [ready, pinned, leaving, minMs, maxMs, exitMs]);

  // Exit: the overlay fades while the logo lifts slightly and fades a touch sooner
  // (no lift under reduced motion), then the overlay unmounts and onDone fires once.
  useEffect(() => {
    if (!leaving) return;
    const controls = animate(exit, 1, {
      duration: exitMs / 1000,
      ease: 'linear',
      onComplete: () => {
        setGone(true);
        if (doneCalledRef.current) return;
        doneCalledRef.current = true;
        onDoneRef.current?.();
      },
    });
    return () => controls.stop();
  }, [leaving, exit, exitMs]);

  if (gone) return null;

  // transition-none on both layers: the global reduced-motion backstop forces a
  // near-zero transition duration on every element, which would otherwise wrap each
  // per-frame opacity write in a CSS transition.

  return (
    <motion.div
      role="status"
      aria-label="Loading Polycards"
      data-brand-loader={pinned ? 'pinned' : 'live'}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-neutral-950 text-white transition-none"
      style={{ opacity: overlayOpacity }}
    >
      <span className="sr-only">Loading Polycards</span>
      <motion.div
        className="w-[60vw] max-w-[26rem] transition-none"
        style={{ opacity: logoOpacity, y: reduced ? 0 : logoY }}
      >
        <LogoReveal clock={clock} />
      </motion.div>
    </motion.div>
  );
}

function clampPin(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function LogoReveal({ clock }: { clock: MotionValue<number> }) {
  const clipBase = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <svg
      viewBox={LOGO_VIEWBOX}
      aria-hidden="true"
      focusable="false"
      className="block h-auto w-full overflow-visible"
    >
      <defs>
        {LOGO_LETTERS.map((letter, i) => (
          <clipPath
            key={letter.x0}
            id={`${clipBase}-l${i}`}
            clipPathUnits="userSpaceOnUse"
          >
            {/* Open at the top so the spring's overshoot never shaves an ascender. */}
            <rect
              x={letter.x0 - COLUMN_PAD}
              y={-TRAVEL}
              width={letter.x1 - letter.x0 + COLUMN_PAD * 2}
              height={CUT_Y + TRAVEL}
            />
          </clipPath>
        ))}
      </defs>
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={LOGO_MARK_STROKE.width}
        strokeLinejoin={LOGO_MARK_STROKE.linejoin}
        strokeLinecap={LOGO_MARK_STROKE.linecap}
      >
        {MARK_STROKES.map((d, i) => (
          <MarkStroke key={d} d={d} index={i} clock={clock} />
        ))}
      </g>
      <g fill="currentColor">
        {LOGO_LETTERS.map((letter, i) => (
          <g key={letter.x0} clipPath={`url(#${clipBase}-l${i})`}>
            <RisingLetter d={letter.d} index={i} clock={clock} />
          </g>
        ))}
      </g>
    </svg>
  );
}

function MarkStroke({
  d,
  index,
  clock,
}: {
  d: string;
  index: number;
  clock: MotionValue<number>;
}) {
  const ref = useRef<SVGPathElement>(null);
  // Written straight to the element on every clock change (no re-render). The
  // pathLength attribute normalises the dash to 0..1; once whole the dash is dropped
  // so a closed outline gets its mitred start corner back instead of two butt ends.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (t: number) => {
      const p = strokeProgress(index, t);
      el.setAttribute('stroke-dasharray', p >= 1 ? 'none' : `${p} 2`);
      el.setAttribute('visibility', p > 0 ? 'visible' : 'hidden');
    };
    apply(clock.get());
    return clock.on('change', apply);
  }, [clock, index]);
  // First paint (server, and before the effect runs): hidden unless already whole,
  // so nothing flashes and a pinned t=1 frame renders complete.
  const whole = strokeProgress(index, clock.get()) >= 1;
  return (
    <path
      ref={ref}
      d={d}
      pathLength={1}
      visibility={whole ? 'visible' : 'hidden'}
    />
  );
}

function RisingLetter({
  d,
  index,
  clock,
}: {
  d: string;
  index: number;
  clock: MotionValue<number>;
}) {
  // Offsets snap to exactly 0 at rest (see letterOffset), so edges end pixel-crisp.
  const y = useTransform(clock, (t) => letterOffset(index, t) * TRAVEL);
  return <motion.path d={d} style={{ y }} />;
}
