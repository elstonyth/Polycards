/**
 * The Polycards logo (public/branding/polycards-logo.png) as vector paths, drawn in the
 * PNG's own 360x97 box so it drops in wherever the PNG is used.
 *
 * Rebuilt from the PNG's alpha channel by fitting geometric models, not by tracing:
 * - The mark is line art: one stroked path (render it with fill="none" and
 *   LOGO_MARK_STROKE), with round joins and softly rounded outer corners like the PNG. Strokes keep it one
 *   path and let a loader draw the mark on with stroke-dasharray.
 * - The letters are filled paths built from shared metrics (stem weight, x-height,
 *   baseline, ascender) with bowls as 4-node superellipses; the s is a smooth centreline
 *   offset by a varying half-width. One entry per letter so they can animate one by one.
 *   x0/x1 are each letter's horizontal ink extent in viewBox units (y and c touch).
 *
 * The numbers come from a numeric fit against the PNG (mean alpha difference under 0.4%
 * at 1x), so treat them as data rather than hand-tuning one letter in isolation.
 */

export const LOGO_VIEWBOX = '0 0 360 97';

/** The mark (viewBox x 0-55), as strokes: render with fill="none" and LOGO_MARK_STROKE. */
export const LOGO_MARK =
  'M11.12 9.51C11.33 9.27 11.77 9.07 12.09 9.07L44.64 9.07C44.96 9.07 45.4 9.27 45.62 9.5L47.37 11.38C47.59 11.62 47.77 12.08 47.77 12.4L47.77 21.35C47.77 21.67 47.96 22.12 48.19 22.34L51.56 25.59C51.79 25.81 51.98 26.26 51.98 26.58L51.98 68.74C51.98 69.06 51.8 69.52 51.58 69.75L45.84 75.71C45.62 75.94 45.18 76.16 44.85 76.19L12.09 79.93C11.77 79.97 11.31 79.82 11.06 79.61L2.73 72.39C2.48 72.17 2.28 71.74 2.28 71.42L2.28 20.17C2.28 19.84 2.46 19.38 2.67 19.14L11.12 9.51ZM11.51 9.07L11.51 80M2.28 19.58L11.51 23.23L46.62 23.23M11.51 61.95L47.05 23.89M2.28 72L11.51 65.97L50.1 69.14M11.51 80L28.44 67.67';

/** Stroke settings for LOGO_MARK, in viewBox units. */
export const LOGO_MARK_STROKE = {
  width: 4.26,
  linejoin: 'round',
  linecap: 'butt',
} as const;

export interface LogoLetter {
  /** The letter this path draws. */
  char: string;
  /** Filled path data (nonzero fill rule) in viewBox units. */
  d: string;
  /** Left edge of the letter's ink. */
  x0: number;
  /** Right edge of the letter's ink. */
  x1: number;
}

/** "Polycards", one filled path per letter, left to right. */
export const LOGO_LETTERS: readonly LogoLetter[] = [
  {
    char: 'P',
    d: 'M99.27 72.33V29.71H117.93C126.03 29.71 132.05 35.82 132.05 44.03C132.05 52.23 126.03 58.35 117.93 58.35H105.78V72.33ZM105.78 36.21V51.84H117.93C122.23 51.84 125.19 48.66 125.19 44.03C125.19 39.4 122.23 36.21 117.93 36.21Z',
    x0: 99.25,
    x1: 132.06,
  },
  {
    char: 'o',
    d: 'M133.09 57.17C133.09 48.07 139.8 41.3 148.82 41.3C157.83 41.3 164.54 48.07 164.54 57.17C164.54 66.27 157.83 73.04 148.82 73.04C139.8 73.04 133.09 66.27 133.09 57.17ZM139.6 57.17C139.6 62.93 143.36 66.9 148.82 66.9C154.27 66.9 158.03 62.93 158.03 57.17C158.03 51.41 154.27 47.44 148.82 47.44C143.36 47.44 139.6 51.41 139.6 57.17Z',
    x0: 133.06,
    x1: 164.56,
  },
  {
    char: 'l',
    d: 'M169.55 29.53H176.07V72.33H169.55Z',
    x0: 169.5,
    x1: 176.13,
  },
  {
    char: 'y',
    d: 'M205.35 42.09L212.12 42.09L194.25 84.67L187.48 84.67ZM179.93 42.09L186.7 42.09L197.63 68.53L194.23 76.65Z',
    x0: 179.94,
    x1: 212.13,
  },
  {
    char: 'c',
    d: 'M239.88 46.62C237.05 43.31 232.81 41.3 227.9 41.3C218.88 41.3 212.17 48.07 212.17 57.17C212.17 66.27 218.88 73.04 227.9 73.04C232.81 73.04 237.05 71.03 239.88 67.72L235.38 63.18C233.76 65.51 231.13 66.9 227.9 66.9C222.44 66.9 218.68 62.93 218.68 57.17C218.68 51.41 222.44 47.44 227.9 47.44C231.13 47.44 233.76 48.83 235.38 51.16Z',
    x0: 212.13,
    x1: 239.88,
  },
  {
    char: 'a',
    d: 'M241.78 57.17C241.78 47.81 248.15 41.3 257.32 41.3C264.4 41.3 272.4 49.71 272.4 57.17C272.4 64.63 264.4 73.04 257.32 73.04C248.15 73.04 241.78 66.53 241.78 57.17ZM248.24 57.17C248.24 62.83 252.12 66.9 257.5 66.9C262.95 66.9 266.83 62.85 266.83 57.17C266.83 51.49 262.95 47.44 257.5 47.44C252.12 47.44 248.24 51.51 248.24 57.17ZM266.63 42.09H273.14V72.33H266.63Z',
    x0: 241.75,
    x1: 273.19,
  },
  {
    char: 'r',
    d: 'M280.27 42.09H286.78V72.33H280.27ZM281.27 50.94H285.59C285.59 45.76 289.9 41.44 295.08 41.44H298.1V47.84H295.05C290.49 47.84 286.78 51.73 286.78 56.51H281.27Z',
    x0: 280.25,
    x1: 298.13,
  },
  {
    char: 'd',
    d: 'M300.06 57.17C300.06 47.81 306.43 41.3 315.6 41.3C322.68 41.3 330.68 49.71 330.68 57.17C330.68 64.63 322.68 73.04 315.6 73.04C306.43 73.04 300.06 66.53 300.06 57.17ZM306.52 57.17C306.52 62.83 310.4 66.9 315.77 66.9C321.23 66.9 325.11 62.85 325.11 57.17C325.11 51.49 321.23 47.44 315.77 47.44C310.4 47.44 306.52 51.51 306.52 57.17ZM324.9 29.53H331.42V72.33H324.9Z',
    x0: 300.06,
    x1: 331.44,
  },
  {
    char: 's',
    d: 'M359.34 45.66C355.38 42.76 353.51 41.32 348.22 41.34C343.91 41.36 339.68 42.87 337.82 47.05C337.31 48.19 337 49.48 337.02 50.74C337.07 54.88 339.73 57.45 343.45 58.73C344.78 59.19 346.16 59.46 347.51 59.83C348.84 60.19 352.59 60.81 353.37 62.05C353.67 62.52 353.7 63.13 353.7 63.67C353.7 66.29 351.1 67.2 348.85 67.19C344.37 67.18 342.88 65.73 339.73 62.97L335.74 67.66C340 71.36 343.01 72.95 348.85 72.96C354.48 72.97 359.89 69.91 359.9 63.67C359.9 62.05 359.58 60.41 358.76 59C356.74 55.53 352.68 54.88 349.14 53.91C347.71 53.53 344.52 52.96 343.66 51.66C343.48 51.38 343.44 51.06 343.43 50.74C343.39 47.92 345.74 47.2 348.22 47.19C351.78 47.17 352.9 48.24 355.57 50.24Z',
    x0: 335.75,
    x1: 359.94,
  },
];
