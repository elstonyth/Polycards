/**
 * Pack stage: the focused pack view's lazily loaded chunk (plan-focus-ciao).
 * The spin chunk imports it on the first tap on a pack, on hover intent, or
 * at idle after itself; the first load never carries it.
 *
 * It builds the focus declaration (`StageFocusOn`) the runtime and the CSS
 * tiles read from the stage state: the pack's keys for this size, the focus
 * term and the spotlight.
 */
import type { FocusCtx, PackBackDetails, StageFocusOn } from './contract';
import { FOCUS_TERM } from './stage-compose';
import { spotAt } from './stage-focus';
import { focusKeys, focusStops, type FocusVariant } from './stage-focus-keys';

export { FOCUS_DURATIONS, FOCUS_WINDOW } from './stage-focus-keys';
export { blockAt, power1InOut } from './stage-focus';

/** A pack's stop list: a capsule, a pack with no pull odds, or a card pack. */
export function focusVariant(o: {
  capsule: boolean;
  back: PackBackDetails | null;
}): FocusVariant {
  if (o.capsule) return 'capsule';
  return o.back?.odds && o.back.odds.length > 0 ? 'sleeve' : 'noOdds';
}

/**
 * The declaration for pack `id` at `index` of the attached row. `slug` picks
 * its poses (a pack not in the table borrows 151's); `back` is printed only
 * for a card pack with pull odds.
 */
export function focusOnFor(o: {
  id: string;
  slug: string;
  index: number;
  desktop: boolean;
  capsule: boolean;
  back: PackBackDetails | null;
  panel: { w: number; h: number };
  anchorY: number;
}): StageFocusOn {
  const variant = focusVariant(o);
  const ctx: FocusCtx = {
    index: o.index,
    anchorY: o.anchorY,
    keys: focusKeys(o.slug, o.desktop, variant),
    panel: o.panel,
  };
  return {
    id: o.id,
    ctx,
    term: FOCUS_TERM,
    spot: spotAt,
    details: variant === 'sleeve' ? o.back : null,
  };
}

export { focusStops };
