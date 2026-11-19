/**
 * Pack stage canvas band (pure, no three.js): the part of the stage host the
 * canvas needs to cover. See `stageBand`.
 */
import type { StageLayout } from '../contract';

/** How far above the centred art's centre the canvas band starts, in art heights. */
export const BAND_ABOVE_ART = 0.56;
/** How far below it the band ends: the art's lower half plus the float-in /
 *  sink drop (0.6 art heights, stage-pose), with a margin. */
export const BAND_BELOW_ART = 1.1;

/**
 * The band of the host (CSS px, from its top) where any pack can be seen, so
 * the canvas covers only that: from just above the centred art to below it by
 * the float-in and sink drop. Without a layout yet: the whole host.
 */
export function stageBand(
  hostH: number,
  layout: Readonly<Pick<StageLayout, 'cy' | 'artH'>> | null,
): { y: number; h: number } {
  const full = { y: 0, h: Math.max(0, Math.round(hostH)) };
  if (!layout || !(layout.artH > 0) || !(hostH > 0)) return full;
  const y = Math.max(0, Math.floor(layout.cy - BAND_ABOVE_ART * layout.artH));
  const bottom = Math.min(
    Math.round(hostH),
    Math.ceil(layout.cy + BAND_BELOW_ART * layout.artH),
  );
  return bottom - y > 0 ? { y, h: bottom - y } : full;
}
