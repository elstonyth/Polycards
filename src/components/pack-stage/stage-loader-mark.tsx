import {
  LOGO_LETTERS,
  LOGO_MARK,
  LOGO_MARK_STROKE,
  LOGO_VIEWBOX,
} from '@/components/brand/polycards-logo-paths';
import {
  pathYExtent,
  splitSubpaths,
} from '@/components/loader/loader-timeline';
import { cn } from '@/lib/utils';
import styles from './pack-stage.module.css';

const MARK_STROKES = splitSubpaths(LOGO_MARK);

// The cut line sits just under the lowest ink (the y's descender); every
// letter starts a full letter-height below it, so it rises out of nothing.
const LETTER_EXTENTS = LOGO_LETTERS.map((letter) => pathYExtent(letter.d));
const INK_TOP = Math.min(...LETTER_EXTENTS.map((e) => e.minY));
const CUT_Y = Math.max(...LETTER_EXTENTS.map((e) => e.maxY)) + 1.5;

/** How far below its place each letter starts, in viewBox units (the CSS
 *  rise starts from exactly this). */
export const LOADER_TRAVEL = CUT_Y - INK_TOP + 1.5;

// Side padding on each letter's clip column so antialiased edges are never
// shaved.
const COLUMN_PAD = 1;

/**
 * The stage loader's overlay: the brand loader's look (the mark drawn on as a
 * line, then the letters rising from a cut line), drawn entirely by the
 * stylesheet from the first paint, so it needs no script to start. Its
 * timing is the brand loader's timeline (pack-stage.module.css, held to it by
 * stage-loader-mark.test.ts). `leaving` plays the exit: the cover fades while
 * the logo lifts and fades a touch sooner.
 */
export function StageLoaderMark({ leaving = false }: { leaving?: boolean }) {
  return (
    <div
      role="status"
      aria-label="Loading Polycards"
      data-leaving={leaving ? '' : undefined}
      className={cn(
        'fixed inset-0 z-[1000] flex items-center justify-center bg-neutral-950 text-white',
        styles.ldCover,
      )}
    >
      <span className="sr-only">Loading Polycards</span>
      <div className={cn('w-[60vw] max-w-[26rem]', styles.ldLogo)}>
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
                id={`stage-ld-l${i}`}
                clipPathUnits="userSpaceOnUse"
              >
                {/* Open at the top so the spring's overshoot never shaves an
                    ascender. */}
                <rect
                  x={letter.x0 - COLUMN_PAD}
                  y={-LOADER_TRAVEL}
                  width={letter.x1 - letter.x0 + COLUMN_PAD * 2}
                  height={CUT_Y + LOADER_TRAVEL}
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
            className={styles.ldMark}
          >
            {MARK_STROKES.map((d) => (
              <path key={d} d={d} pathLength={1} visibility="hidden" />
            ))}
          </g>
          <g fill="currentColor" className={styles.ldLetters}>
            {LOGO_LETTERS.map((letter, i) => (
              <g key={letter.x0} clipPath={`url(#stage-ld-l${i})`}>
                <path d={letter.d} />
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}

/**
 * How long the mark's CSS reveal has been running, in ms, read from the first
 * stroke's animation; null when the browser cannot say.
 */
export function markRevealElapsed(root: Element | null): number | null {
  const path = root?.querySelector('svg path');
  const anim = path?.getAnimations?.()[0];
  const start = anim?.startTime;
  return typeof start === 'number'
    ? Math.max(0, performance.now() - start)
    : null;
}
