/**
 * Prize frames: the cosmetic frames a card wears because of how it was WON, not
 * what tier it is. One rule, in one place, with no React, so a server page can use
 * it too: this is what keeps a card wearing the same frame in the Lucky Draw, in the
 * winner's vault, in their history and on the card page opened from any of them.
 */

/** Frames that are not rarity tiers. Their art is in public/images/slab-frames and
 *  public/images/raw-frames, under this name. */
export type FrameVariant = 'prism' | 'lucky-draw';

/** The frame a won card wears, or none for a card pulled from a pack. */
export const prizeFrameVariant = (won: {
  challengePrize?: boolean;
  luckyDrawPrize?: boolean;
}): FrameVariant | undefined =>
  won.challengePrize ? 'prism' : won.luckyDrawPrize ? 'lucky-draw' : undefined;

const PRIZE_PARAM: Record<FrameVariant, string> = {
  prism: 'weekly',
  'lucky-draw': 'draw',
};

/** The card page, keeping the prize's frame: a reload or a shared link must not
 *  turn a prize back into its pack tier. */
export const prizeCardUrl = (handle: string, variant?: FrameVariant): string =>
  `/card/${encodeURIComponent(handle)}${variant ? `?prize=${PRIZE_PARAM[variant]}` : ''}`;

/** The frame a card page's `?prize=` asks for. Anything else: the tier frame. */
export function frameVariantFromParam(
  param: unknown,
): FrameVariant | undefined {
  if (param === PRIZE_PARAM.prism) return 'prism';
  if (param === PRIZE_PARAM['lucky-draw']) return 'lucky-draw';
  return undefined;
}
