// Vault buyback is flat; the pack's displayed instant rate applies only while
// the reveal countdown remains open. Marketing must name the context rather
// than present either percentage as the only rate.
import { FLAT_BUYBACK_PERCENT } from '@/lib/packs-data';

export const BUYBACK_RATE_LABEL = `${FLAT_BUYBACK_PERCENT}%`;
export const BUYBACK_EXPLANATION = `During the reveal countdown, sell at the pack's displayed instant buyback rate. Leaving the reveal or letting the timer expire changes buyback to ${BUYBACK_RATE_LABEL} of card value in your vault. Credit is added to your balance immediately.`;
