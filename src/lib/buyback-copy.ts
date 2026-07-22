// The one buyback percentage marketing copy is allowed to quote. Derived from
// FLAT_BUYBACK_PERCENT so the number can never drift from what selling pays.
//
// It is a FLOOR, not a ceiling: every vault sell pays the flat rate, and the
// in-window instant rate is floored at it (resolveBuybackRate takes
// max(pack.buyback_percent, FLAT_PERCENT)). So "up to 90%" understates it and
// "85-90%" is simply wrong: a card never sells back below this rate.
import { FLAT_BUYBACK_PERCENT } from '@/lib/packs-data';

export const BUYBACK_RATE_LABEL = `${FLAT_BUYBACK_PERCENT}%`;
