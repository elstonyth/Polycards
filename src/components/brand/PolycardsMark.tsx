import { LOGO_MARK, LOGO_MARK_STROKE } from './polycards-logo-paths';

/**
 * Viewboxes for the pack mark alone, in the full logo's own units.
 * - `tight`: the ink box (path bounds plus half the stroke), for icon use.
 * - `logo`: the mark's 57x81 slot in the logo, cropped at y=4. This is the box
 *   the old public/branding/polycards-mark.png was cut to, so a call site sized
 *   for that picture (h-7 w-auto etc.) keeps the same size and position.
 */
export const MARK_VIEWBOX = {
  tight: '0 6.9 54.3 75.3',
  logo: '0 4 57 81',
} as const;

/**
 * The Polycards pack mark (no wordmark) as inline vector art in the
 * surrounding text colour. Decorative by default (aria-hidden), like the old
 * `<img alt="">`; pass `title` to give it an accessible name. Size it with
 * `className` (h-6 w-auto etc.). No hooks, so it renders in server components.
 */
export default function PolycardsMark({
  className,
  box = 'tight',
  title,
}: {
  className?: string;
  box?: keyof typeof MARK_VIEWBOX;
  /** Accessible name; omit for a decorative mark. */
  title?: string;
}) {
  return (
    <svg
      viewBox={MARK_VIEWBOX[box]}
      fill="none"
      focusable="false"
      className={className}
      {...(title
        ? { role: 'img', 'aria-label': title }
        : { 'aria-hidden': true })}
    >
      <path
        d={LOGO_MARK}
        stroke="currentColor"
        strokeWidth={LOGO_MARK_STROKE.width}
        strokeLinejoin={LOGO_MARK_STROKE.linejoin}
        strokeLinecap={LOGO_MARK_STROKE.linecap}
      />
    </svg>
  );
}
