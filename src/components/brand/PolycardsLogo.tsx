import {
  LOGO_LETTERS,
  LOGO_MARK,
  LOGO_MARK_STROKE,
  LOGO_VIEWBOX,
} from './polycards-logo-paths';

/**
 * The full Polycards logo (mark + wordmark) as inline vector art in the
 * surrounding text colour. Same 360x97 box as the original logo picture
 * (public/branding/polycards-logo.png at 1x), so it swaps in at the same aspect
 * ratio; size it with `className` (h-6 w-auto
 * etc.). No hooks or browser APIs, so it renders in server components too.
 */
export default function PolycardsLogo({
  className,
  title = 'Polycards',
}: {
  className?: string;
  /** Accessible name (aria-label only, so no native hover tooltip, like an img alt). */
  title?: string;
}) {
  return (
    <svg
      viewBox={LOGO_VIEWBOX}
      role="img"
      aria-label={title}
      focusable="false"
      fill="currentColor"
      className={className}
    >
      <path
        d={LOGO_MARK}
        fill="none"
        stroke="currentColor"
        strokeWidth={LOGO_MARK_STROKE.width}
        strokeLinejoin={LOGO_MARK_STROKE.linejoin}
        strokeLinecap={LOGO_MARK_STROKE.linecap}
      />
      {LOGO_LETTERS.map((letter) => (
        <path key={`${letter.char}-${letter.x0}`} d={letter.d} />
      ))}
    </svg>
  );
}
